//! Exercise the real executable over newline-delimited MCP stdio, including restart.
mod support;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};

use serde_json::{Value, json};
use tempfile::TempDir;

struct Client {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<Value>,
    next_id: u64,
}

impl Client {
    fn start(db: &std::path::Path) -> Self {
        Self::start_mode(db, false)
    }

    fn start_mode(db: &std::path::Path, compatibility: bool) -> Self {
        Self::start_config(db, compatibility, true)
    }

    fn start_config(db: &std::path::Path, compatibility: bool, widget: bool) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_todo-mcp"))
            .args(["--db", db.to_str().unwrap()])
            .env("TODO_WIDGET_PROBE", "0")
            .env("TODO_WIDGET_ENABLED", if widget { "1" } else { "0" })
            .env("TODO_WIDGET_COMPAT", if compatibility { "1" } else { "0" })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let line = line.unwrap();
                let message =
                    serde_json::from_str(&line).expect("stdout must contain only MCP JSON");
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
        };
        let initialized = client.request(
            "initialize",
            json!({
                "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": {"name":"todo-pilot-test", "version":"1"}
            }),
        );
        assert_eq!(initialized["result"]["serverInfo"]["name"], "todo-mcp");
        assert!(
            !initialized["result"]["instructions"]
                .as_str()
                .unwrap()
                .contains("todo.home")
        );
        assert!(
            initialized["result"]["instructions"]
                .as_str()
                .unwrap()
                .contains("authoritative")
        );
        client.send(json!({"jsonrpc":"2.0", "method":"notifications/initialized"}));
        client
    }

    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}));
        loop {
            let reply = self
                .replies
                .recv_timeout(Duration::from_secs(15))
                .expect("MCP response timed out or server disconnected");
            if reply["id"] == id {
                return reply;
            }
        }
    }

    fn tool(&mut self, name: &str, arguments: Value) -> Value {
        self.request(
            "tools/call",
            json!({"name":name,"arguments":support::operation(name,arguments)}),
        )
    }
}

#[test]
fn text_only_clients_can_page_read_context_edit_and_recover_conflicts() {
    fn text_result(response: Value) -> Value {
        let result = &response["result"];
        let decoded: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(decoded, result["structuredContent"]);
        decoded
    }
    let dir = TempDir::new().unwrap();
    let mut client = Client::start(&dir.path().join("text-only.db"));
    let notes = "Unicode 文, quotes \" and newline\n".repeat(200);
    for i in 0..2 {
        text_result(client.tool(
            "capture_item",
            json!({
                "request_id":format!("text-capture-{i}"), "title":format!("Fixture {i}"),
                "importance":"normal", "notes":notes, "agent_notes":"Current handoff 文",
                "reason":"Disposable text transport regression"
            }),
        ));
    }
    let page = text_result(client.tool("list_items", json!({"limit":1})));
    let task = &page["items"][0];
    assert_eq!(task["notes"], notes);
    assert_eq!(task["agent_notes"], "Current handoff 文");
    assert!(page["next_cursor"].is_string());
    let next = text_result(client.tool(
        "list_items",
        json!({"limit":1,"cursor":page["next_cursor"]}),
    ));
    assert_ne!(next["items"][0]["id"], task["id"]);
    let args = json!({"task_id":task["id"],"expected_version":task["version"],
        "request_id":"text-edit","title":"Renamed using text","reason":"Text-only edit"});
    let edited = text_result(client.tool("update_item", args.clone()));
    assert_eq!(edited["task"]["title"], "Renamed using text");
    let replay = text_result(client.tool("update_item", args.clone()));
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["task"], edited["task"]);
    let mut stale = args;
    stale["request_id"] = json!("stale-text-edit");
    let conflict = text_result(client.tool("update_item", stale));
    assert_eq!(conflict["code"], "conflict");
    let shown = text_result(client.tool("show_tasks", json!({"task_id":task["id"]})));
    assert_eq!(shown["items"][0]["version"], edited["task"]["version"]);
    let history = text_result(client.tool("list_changes", json!({"task_id":task["id"]})));
    assert_eq!(history["changes"][0]["id"], edited["change"]["id"]);
    let undone = text_result(client.tool("undo_change", json!({"change_id":edited["change"]["id"],
        "expected_version":edited["task"]["version"],"request_id":"text-undo","reason":"Text-only undo"})));
    assert_eq!(undone["task"]["title"], task["title"]);
    let sync = text_result(client.tool("sync_state", json!({"limit":1})));
    assert!(sync["next_cursor"].is_string());
    text_result(client.tool(
        "sync_state",
        json!({"limit":1,"cursor":sync["next_cursor"]}),
    ));
    let ui = client.tool(
        "gtd_ui_read",
        json!({"operation":"list_items","arguments":{"detail":"summary"}}),
    );
    assert_eq!(ui["result"]["isError"], false);
    assert!(
        !ui["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(&notes)
    );
    assert!(
        serde_json::from_str::<Value>(ui["result"]["content"][0]["text"].as_str().unwrap())
            .is_err()
    );
}

#[test]
fn chatgpt_compatibility_resource_matches_discovery_and_preserves_standard_resource() {
    let dir = TempDir::new().unwrap();
    let mut client = Client::start_mode(&dir.path().join("todo.db"), true);
    let listed = client.request("tools/list", json!({}));
    assert!(!listed.to_string().contains("todo.home"));
    let tools = listed["result"]["tools"].as_array().unwrap();
    let show = tools.iter().find(|t| t["name"] == "show_tasks").unwrap();
    let uri = "ui://private-gtd/tasks-chatgpt-v1.html";
    assert_eq!(show["_meta"]["ui"]["resourceUri"], uri);
    assert_eq!(show["_meta"]["openai/outputTemplate"], uri);
    assert!(
        tools
            .iter()
            .all(|tool| tool["_meta"]["openai/widgetAccessible"]
                == tool["name"].as_str().unwrap().starts_with("gtd_ui_"))
    );
    let listed = client.request("resources/list", json!({}));
    assert_eq!(listed["result"]["resources"][0]["uri"], uri);
    assert_eq!(
        listed["result"]["resources"][0]["mimeType"],
        "text/html+skybridge"
    );
    let read = client.request("resources/read", json!({"uri":uri}));
    let content = &read["result"]["contents"][0];
    assert_eq!(content["mimeType"], "text/html+skybridge");
    assert!(
        content["text"]
            .as_str()
            .unwrap()
            .contains("data-bridge=\"chatgpt\"")
    );
    assert_eq!(
        content["_meta"]["openai/widgetCSP"]["connect_domains"],
        json!([])
    );
    let standard = client.request(
        "resources/read",
        json!({"uri":"ui://private-gtd/tasks-v2.html"}),
    );
    assert_eq!(
        standard["result"]["contents"][0]["mimeType"],
        "text/html;profile=mcp-app"
    );
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn backup_refuses_missing_source_without_creating_an_empty_database() {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("missing.sqlite3");
    let destination = dir.path().join("backup.sqlite3");
    let result = Command::new(env!("CARGO_BIN_EXE_todo-mcp"))
        .arg("--db")
        .arg(&source)
        .arg("--backup")
        .arg(&destination)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("source database does not exist"));
    assert!(!source.exists());
    assert!(!destination.exists());
}

#[test]
fn real_mcp_stdio_roundtrip_restart_errors_and_undo() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("todo.db");
    let mut client = Client::start(&db);
    let listed = client.request("tools/list", json!({}));
    assert!(!listed.to_string().contains("todo.home"));
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 18);
    for tool in tools {
        assert_eq!(
            tool["annotations"]["readOnlyHint"],
            ["list_changes", "list_occurrences", "show_gtd",]
                .contains(&tool["name"].as_str().unwrap())
        );
        assert_eq!(tool["annotations"]["openWorldHint"], false);
        if !tool["name"].as_str().unwrap().starts_with("gtd_ui_") {
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
    }
    let widget = client.request(
        "resources/read",
        json!({"uri":"ui://private-gtd/tasks-v2.html"}),
    );
    assert_eq!(
        widget["result"]["contents"][0]["mimeType"],
        "text/html;profile=mcp-app"
    );
    let html = widget["result"]["contents"][0]["text"].as_str().unwrap();
    assert!(html.contains("<script>"));
    let probe = client.request(
        "resources/read",
        json!({"uri":"ui://private-gtd/connection-probe-v1.html"}),
    );
    let content = &probe["result"]["contents"][0];
    assert_eq!(content["uri"], "ui://private-gtd/connection-probe-v1.html");
    assert_eq!(content["mimeType"], "text/html;profile=mcp-app");
    assert!(content["text"].as_str().unwrap().len() < 10_000);
    assert!(content["text"].as_str().unwrap().contains("ui/initialize"));
    let missing = client.request(
        "resources/read",
        json!({"uri":"ui://private-gtd/missing.html"}),
    );
    assert_eq!(missing["error"]["code"], -32602);
    let show = tools.iter().find(|t| t["name"] == "show_tasks").unwrap();
    assert_eq!(
        show["_meta"]["ui"]["resourceUri"],
        "ui://private-gtd/tasks-v2.html"
    );
    let capture = json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"protocol-capture", "title":"[PILOT] Imaginary plant", "reason":"Synthetic connection test"});
    let response = client.tool("capture_item", capture.clone());
    assert_eq!(response["result"]["isError"], false);
    let first = response["result"]["structuredContent"].clone();
    let task_id = first["task"]["id"].clone();
    drop(client); // Simulate a hard restart after the server acknowledged a commit.
    let mut client = Client::start(&db);
    let retried = client.tool("capture_item", capture);
    assert_eq!(retried["result"]["structuredContent"]["replayed"], true);
    assert_eq!(
        retried["result"]["structuredContent"]["task"],
        first["task"]
    );
    let edit = json!({"request_id":"protocol-update", "task_id":task_id, "expected_version":1, "status":"done", "due_date":"2026-10-04", "reason":"Agent judgment on synthetic data"});
    let changed = client.tool("update_item", edit.clone());
    let change = changed["result"]["structuredContent"].clone();
    assert_eq!(change["task"]["version"], 2);
    let mut stale = edit;
    stale["request_id"] = json!("protocol-stale");
    let failed = client.tool("update_item", stale);
    assert_eq!(failed["result"]["isError"], true);
    assert_eq!(failed["result"]["structuredContent"]["code"], "conflict");
    let invalid = client.tool(
        "capture_item",
        json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"bad", "title":"Missing reason"}),
    );
    assert!(invalid.get("error").is_some() || invalid["result"]["isError"] == true);
    let unknown = client.tool("capture_item", json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"bad", "title":"Unknown property", "reason":"test", "execute_shell":"no"}));
    assert!(unknown.get("error").is_some() || unknown["result"]["isError"] == true);
    let restored = client.tool("undo_change", json!({"request_id":"protocol-undo", "change_id":change["change"]["id"], "expected_version":2, "reason":"Undo synthetic edit"}));
    assert_eq!(
        restored["result"]["structuredContent"]["task"]["status"],
        "inbox"
    );
    let audit = client.tool(
        "list_items",
        json!({"task_id":task_id, "include_history":true}),
    );
    assert_eq!(
        audit["result"]["structuredContent"]["history"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    client.child.kill().unwrap();
    client.child.wait().unwrap();
    assert!(
        client.replies.recv_timeout(Duration::from_secs(2)).is_err(),
        "a disconnected service must never return success"
    );
}

#[test]
fn disabled_cards_keep_tools_and_text_data_without_launch_metadata() {
    let dir = TempDir::new().unwrap();
    // Legacy selection flags must not override the explicit UI disable switch.
    let mut client = Client::start_config(&dir.path().join("todo.db"), true, false);
    let listed = client.request("tools/list", json!({}));
    assert!(!listed.to_string().contains("todo.home"));
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 18);
    assert!(
        tools
            .iter()
            .all(|tool| tool["_meta"]["ui"].get("resourceUri").is_none())
    );
    let resources = client.request("resources/list", json!({}));
    assert_eq!(resources["result"]["resources"], json!([]));
    let capture = client.tool("capture_item", json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"fallback-capture","title":"Synthetic text fallback","reason":"Verify text-only mode"}));
    assert_eq!(capture["result"]["isError"], false);
    let shown = client.tool("show_tasks", json!({}));
    assert_eq!(
        shown["result"]["structuredContent"]["items"][0]["title"],
        "Synthetic text fallback"
    );
    assert!(!shown["result"]["content"].as_array().unwrap().is_empty());
    // Bundles are retained for explicit reads and future opt-in diagnosis.
    let widget = client.request(
        "resources/read",
        json!({"uri":"ui://private-gtd/tasks-v2.html"}),
    );
    assert!(
        widget["result"]["contents"][0]["text"]
            .as_str()
            .unwrap()
            .contains("<script>")
    );
}

#[test]
fn shared_application_opener_is_read_only_and_validates_destinations() {
    let dir = TempDir::new().unwrap();
    let mut client = Client::start(&dir.path().join("todo.db"));
    for view in ["home", "repeating", "review", "activity", "charts", "help"] {
        let result = client.tool("show_gtd", json!({"view":view}));
        assert_eq!(result["result"]["structuredContent"]["view"], view);
        assert_eq!(result["result"]["structuredContent"]["app"], "gtd");
    }
    assert_eq!(
        client.tool("show_gtd", json!({}))["result"]["structuredContent"]["view"],
        "home"
    );
    for input in [
        json!({"view":"health"}),
        json!({"series_id":"bad"}),
        json!({"view":"repeating","series_id":"bad"}),
    ] {
        assert_eq!(client.tool("show_gtd", input)["result"]["isError"], true);
    }
    let changes = client.tool("list_changes", json!({}));
    assert_eq!(changes["result"]["structuredContent"]["changes"], json!([]));
}
