//! Demo is a distinct persisted store environment, never a relabeled test or live DB.
//! Environment variables are scoped to child processes, so parallel tests stay isolated.
use serde_json::{Value, json};
mod support;
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};
use tempfile::TempDir;

struct Client {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<Value>,
    next_id: u64,
    initialized: Value,
}
impl Client {
    fn start(db: &Path, environment: Option<&str>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_todo-mcp"));
        command
            .args(["--db", db.to_str().unwrap()])
            .env_remove("TODO_ENVIRONMENT")
            .env_remove("TODO_SEARCH_URL")
            .env_remove("TODO_SEARCH_KEY_FILE")
            .env("TODO_LOG_DB_PATH", db.with_extension("diagnostics.sqlite3"))
            .env("TODO_WIDGET_ENABLED", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(value) = environment {
            command.env("TODO_ENVIRONMENT", value);
        }
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let message =
                    serde_json::from_str(&line.unwrap()).expect("MCP stdout must be JSON");
                if sender.send(message).is_err() {
                    break;
                }
            }
        });
        let mut client = Self {
            child,
            stdin,
            replies,
            next_id: 0,
            initialized: Value::Null,
        };
        client.initialized = client.request("initialize", json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"demo-isolation-test","version":"1"}}));
        writeln!(
            client.stdin,
            "{}",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .unwrap();
        client.stdin.flush().unwrap();
        client
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        writeln!(
            self.stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":self.next_id,"method":method,"params":params})
        )
        .unwrap();
        self.stdin.flush().unwrap();
        loop {
            let reply = self
                .replies
                .recv_timeout(Duration::from_secs(10))
                .expect("MCP server did not respond");
            if reply["id"] == self.next_id {
                return reply;
            }
        }
    }
    fn call(&mut self, name: &str, arguments: Value) -> Value {
        let response = self.request("tools/call", json!({"name":name,"arguments":arguments}));
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn stored_environment(path: &Path) -> String {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT value FROM store_meta WHERE key='environment'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn demo_is_explicit_and_labeled_while_test_and_default_production_remain_distinct() {
    let temp = TempDir::new().unwrap();
    for (environment, expected, prefix) in [
        (None, "production", ""),
        (Some("test"), "test", "TEST MODE"),
        (Some("demo"), "demo", "DEMO MODE"),
    ] {
        let path = temp.path().join(format!("{expected}.sqlite3"));
        let mut client = Client::start(&path, environment);
        let guidance = client.initialized["result"]["instructions"]
            .as_str()
            .unwrap();
        if prefix.is_empty() {
            assert!(!guidance.contains("DEMO MODE"));
            assert!(!guidance.contains("TEST MODE"));
        } else {
            assert!(guidance.starts_with(prefix));
        }
        let captured = client.call("capture_item", json!({"estimated_minutes":30,"effort":"medium","brief":"Complete the disposable environment fixture.","importance":"normal","request_id":"environment-capture","agent_notes":"Disposable environment fixture.","title":"Prepare a fictional weekend outing","status":"next","reason":"Environment isolation regression"}));
        assert_ne!(captured["isError"], true, "{captured}");
        assert_eq!(captured["structuredContent"]["environment"], expected);
        let text = captured["content"][0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decoded, captured["structuredContent"]);
        assert_eq!(decoded["environment"], expected);
        let listed = client.call("list_items", json!({}));
        assert_eq!(listed["structuredContent"]["environment"], expected);
        assert_eq!(
            listed["structuredContent"]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(stored_environment(&path), expected);
        drop(client);
        let mut reopened = Client::start(&path, environment);
        let again = reopened.call("list_items", json!({}));
        assert_eq!(
            again["structuredContent"]["items"][0]["id"],
            captured["structuredContent"]["task"]["id"]
        );
    }
}

#[test]
fn no_environment_can_open_or_relabel_a_database_from_another_environment() {
    let temp = TempDir::new().unwrap();
    for source in ["production", "test", "demo"] {
        let path = temp.path().join(format!("{source}.sqlite3"));
        drop(Client::start(&path, Some(source)));
        for target in ["production", "test", "demo"] {
            if source == target {
                continue;
            }
            let destination = temp
                .path()
                .join(format!("forbidden-{source}-as-{target}.sqlite3"));
            let result = Command::new(env!("CARGO_BIN_EXE_todo-mcp"))
                .args([
                    "--db",
                    path.to_str().unwrap(),
                    "--backup",
                    destination.to_str().unwrap(),
                ])
                .env("TODO_ENVIRONMENT", target)
                .output()
                .unwrap();
            assert!(!result.status.success(), "{source} opened as {target}");
            assert!(
                String::from_utf8_lossy(&result.stderr).contains("database environment mismatch")
            );
            assert!(!destination.exists());
            assert_eq!(stored_environment(&path), source);
        }
    }
}

#[test]
fn unrecognized_environment_is_rejected_instead_of_falling_back_to_production() {
    let temp = TempDir::new().unwrap();
    for environment in ["DEMO", "development", "", "demo/test"] {
        let path = temp
            .path()
            .join(format!("invalid-{}.sqlite3", uuid::Uuid::new_v4()));
        let result = Command::new(env!("CARGO_BIN_EXE_todo-mcp"))
            .args(["--db", path.to_str().unwrap()])
            .env("TODO_ENVIRONMENT", environment)
            .env("TODO_LOG_DB_PATH", temp.path().join("diagnostics.sqlite3"))
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("invalid environment"));
        let db = rusqlite::Connection::open(path).unwrap();
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(
            version, 0,
            "Rejected initialization must roll back schema writes"
        );
    }
}

#[test]
fn stale_demo_or_test_mcp_metadata_cannot_capture_in_production() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("production.sqlite3");
    let mut client = Client::start(&path, None);
    let arguments = json!({"estimated_minutes":30,"effort":"medium","brief":"Complete the disposable environment fixture.","importance":"normal","request_id":"guarded-capture","agent_notes":"Disposable environment fixture.","title":"Only write after environment confirmation","reason":"Environment guard regression"});
    for expected in [
        json!("demo"),
        json!("test"),
        json!("unknown"),
        json!(42),
        Value::Null,
    ] {
        let reply = client.request("tools/call", json!({"name":"capture_item","arguments":arguments,"_meta":{"gtd/expectedEnvironment":expected}}));
        assert_eq!(reply["result"]["isError"], true, "{reply}");
        let error = &reply["result"]["structuredContent"];
        assert_eq!(error["code"], "environment_changed");
        assert_eq!(error["environment"], "production");
        assert_eq!(error["retryable"], false);
    }
    let history = client.call("list_changes", json!({}));
    assert_eq!(
        history["structuredContent"]["changes"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let list = client.call("list_items", json!({"view":"all","include_deleted":true}));
    assert_eq!(
        list["structuredContent"]["items"].as_array().unwrap().len(),
        0
    );
    let saved = client.request("tools/call", json!({"name":"capture_item","arguments":arguments,"_meta":{"gtd/expectedEnvironment":"production","progressToken":"capture"}}));
    assert_ne!(saved["result"]["isError"], true, "{saved}");
    assert_eq!(saved["result"]["structuredContent"]["replayed"], false);
    let replayed = client.call("capture_item", arguments);
    assert_eq!(replayed["structuredContent"]["replayed"], true);
}

#[test]
fn matching_mcp_environment_metadata_works_in_each_isolated_mode() {
    let temp = TempDir::new().unwrap();
    for environment in ["test", "demo"] {
        let mut client = Client::start(
            &temp.path().join(format!("{environment}.sqlite3")),
            Some(environment),
        );
        let arguments = json!({"estimated_minutes":30,"effort":"medium","brief":"Complete the disposable environment fixture.","importance":"normal","request_id":"matching-capture","agent_notes":"Disposable environment fixture.","title":"A sample action","reason":"Matching environment guard regression"});
        let saved = client.request("tools/call", json!({"name":"capture_item","arguments":arguments,"_meta":{"gtd/expectedEnvironment":environment}}));
        assert_ne!(saved["result"]["isError"], true, "{saved}");
        assert_eq!(
            saved["result"]["structuredContent"]["environment"],
            environment
        );
        let refused_read = client.request("tools/call", json!({"name":"list_items","arguments":{},"_meta":{"gtd/expectedEnvironment":"production"}}));
        assert_eq!(refused_read["result"]["isError"], true);
        assert_eq!(
            refused_read["result"]["structuredContent"]["code"],
            "environment_changed"
        );
        assert_eq!(
            refused_read["result"]["structuredContent"]["environment"],
            environment
        );
    }
}
