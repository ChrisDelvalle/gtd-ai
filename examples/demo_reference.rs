//! Rebuild browser-demo reference results using a disposable SQLite database.
//! Usage: TODO_ENVIRONMENT=test TODO_BENCHMARK_NOW=2026-11-06T18:00:00Z
//! cargo run --locked --features benchmark-clock --example demo_reference
#[cfg(not(feature = "benchmark-clock"))]
fn main() {
    eprintln!("Run with --features benchmark-clock and the documented test environment.");
    std::process::exit(1);
}
#[cfg(feature = "benchmark-clock")]
#[tokio::main]
async fn main() {
    use rusqlite::params;
    use serde_json::{Value, json};
    use std::path::Path;
    use todo_mcp::{application::Application, diagnostics::Diagnostics, store::Store};
    assert_eq!(std::env::var("TODO_ENVIRONMENT").as_deref(), Ok("test"));
    todo_mcp::clock::initialize().expect("disposable fixed clock");
    assert_eq!(todo_mcp::clock::timestamp(), "2026-11-06T18:00:00.000Z");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("web/demo/maya");
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let read = |kind: &str| -> Vec<Value> {
        manifest[kind]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|name| {
                serde_json::from_slice::<Vec<Value>>(
                    &std::fs::read(root.join(name.as_str().unwrap())).unwrap(),
                )
                .unwrap()
            })
            .collect()
    };
    let records = read("records");
    let changes = read("changes");
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("fictional.sqlite3");
    let store = Store::open(&path).unwrap();
    let mut c = rusqlite::Connection::open(&path).unwrap();
    let tx = c.transaction().unwrap();
    for t in &records {
        tx.execute(
            "INSERT INTO tasks(id,document) VALUES(?1,?2)",
            params![t["id"].as_str().unwrap(), t.to_string()],
        )
        .unwrap();
    }
    for change in &changes {
        let id = change["id"].as_i64().unwrap();
        let task = change["task_id"].as_str().unwrap();
        let kind = change["entity_type"].as_str().unwrap();
        tx.execute(
            "INSERT INTO changes(id,task_id,entity_type,document,token) VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                task,
                kind,
                change.to_string(),
                format!("demo-reference-{id}")
            ],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO revisions(seq,entity_id,entity_type,document) VALUES(?1,?2,?3,?4)",
            params![id, task, kind, change["after"].to_string()],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let app = Application::new(
        store,
        Diagnostics::open(&temp.path().join("diagnostics.sqlite3"), "demo-reference").unwrap(),
    );
    let mut queries = Vec::new();
    for status in ["next", "inbox", "waiting", "blocked", "someday", "done"] {
        let args = json!({"status":status,"limit":100,"detail":"full"});
        let mut next = args.clone();
        let mut rows = Vec::new();
        loop {
            let result = app.execute_ui("list_items", next.clone()).await.unwrap();
            rows.extend(
                result["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| json!({"id":t["id"],"source":t["recommendation"]["source_task_id"]})),
            );
            if result["next_cursor"].is_null() {
                break;
            }
            next["cursor"] = result["next_cursor"].clone();
        }
        queries.push(json!({"args":args,"rows":rows}));
    }
    let priority = app.execute_ui("priority_grid", json!({})).await.unwrap();
    let mut charts = Vec::new();
    for metric in ["completed", "changes"] {
        let args = json!({"from":"2025-11-09","through":"2026-11-07","metric":metric});
        let result = app
            .execute_ui("activity_summary", args.clone())
            .await
            .unwrap();
        charts.push(json!({"args":args,"days":result["days"],"total":result["total"],"categories":result["categories"],"automatic_count":result["automatic_count"]}));
    }
    let now = todo_mcp::clock::now();
    let rankings: Vec<Value> = records
        .iter()
        .map(|t| {
            let task: todo_mcp::model::Task = serde_json::from_value(t.clone()).unwrap();
            json!({"id":task.id,"key":todo_mcp::planning::evaluate(&task,now).key})
        })
        .collect();
    let events: Vec<Value> = changes
        .iter()
        .map(|c| {
            let change = serde_json::from_value(c.clone()).unwrap();
            serde_json::to_value(todo_mcp::activity::Event::from_change(&change)).unwrap()
        })
        .collect();
    println!(
        "{}",
        json!({"counts":priority["counts"],"queries":queries,"charts":charts,"rankings":rankings,"events":events})
    );
}
