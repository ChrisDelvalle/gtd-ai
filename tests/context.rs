use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{application::Application, diagnostics::Diagnostics, model::*, store::Store};
fn setup() -> (TempDir, Application) {
    let dir = TempDir::new().unwrap();
    let app = Application::new(
        Store::open(dir.path().join("tasks.db")).unwrap(),
        Diagnostics::open(&dir.path().join("logs.db"), "test").unwrap(),
    );
    (dir, app)
}
async fn capture(app: &Application) -> Value {
    app.execute_ui("capture_item", json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"create", "title":"Resource task","brief":"Review the linked resource.", "links":[{"url":"https://example.com/form", "label":"Application"}], "location":"10 Main St, New York", "reason":"Test"})).await.unwrap()
}
async fn full(app: &Application, id: &Value) -> Value {
    app.execute_ui("list_items", json!({"task_id":id}))
        .await
        .unwrap()["items"][0]
        .clone()
}
#[tokio::test]
async fn context_summaries_edits_retries_conflicts_undo_redo() {
    let (_dir, app) = setup();
    let created = capture(&app).await;
    let id = &created["task"]["id"];
    let original = full(&app, id).await;
    // Engine-backed context matching is covered in search_meili.rs.
    let list = app.execute_ui("list_items", json!({})).await.unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["items"][0]["link_count"], 1);
    assert_eq!(list["items"][0]["has_location"], true);
    assert!(list["items"][0].get("links").is_none());
    assert!(list["items"][0].get("location").is_none());
    let args = json!({"request_id":"clear","task_id":id,"expected_version":1,"links":[],"location":"","reason":"Clear fields"});
    let cleared = app.execute_ui("update_item", args.clone()).await.unwrap();
    let cleared_full = full(&app, id).await;
    assert_eq!(cleared_full["links"], json!([]));
    assert!(cleared_full["location"].is_null());
    assert_eq!(cleared["task"]["link_count"], 0);
    assert_eq!(cleared["task"]["has_location"], false);
    let retried = app.execute_ui("update_item", args.clone()).await.unwrap();
    assert_eq!(retried["replayed"], true);
    assert_eq!(retried["task"], cleared["task"]);
    let mut stale = args;
    stale["request_id"] = json!("stale");
    assert!(app.execute_ui("update_item", stale).await.is_err());
    let undone=app.execute_ui("undo_change",json!({"request_id":"undo","change_id":cleared["change"]["id"],"expected_version":2,"reason":"Undo"})).await.unwrap();
    let undone_full = full(&app, id).await;
    assert_eq!(undone_full["links"], original["links"]);
    assert_eq!(undone_full["location"], original["location"]);
    let redone=app.execute_ui("undo_change",json!({"request_id":"redo","change_id":undone["change"]["id"],"expected_version":3,"reason":"Redo"})).await.unwrap();
    let redone_full = full(&app, id).await;
    assert_eq!(redone_full["links"], json!([]));
    assert!(redone_full["location"].is_null());
    assert_eq!(redone["task"]["version"], redone_full["version"]);
}
#[tokio::test]
async fn batch_validation_is_atomic_and_unrelated_edits_preserve_context() {
    let (_dir, app) = setup();
    let c = capture(&app).await;
    let original = full(&app, &c["task"]["id"]).await;
    let updated=app.execute_ui("update_item",json!({"request_id":"done","task_id":c["task"]["id"],"expected_version":1,"status":"done","links":null,"location":null,"reason":"Test"})).await.unwrap();
    let updated_full = full(&app, &c["task"]["id"]).await;
    assert_eq!(updated_full["links"], original["links"]);
    assert_eq!(updated_full["location"], original["location"]);
    assert_eq!(updated["task"]["version"], updated_full["version"]);
    for url in [
        "javascript:alert(1)",
        "data:text/html,bad",
        "//example.com",
        "https://user:pass@example.com/",
        "https://example.com/\nfoo",
    ] {
        let result=app.execute_ui("apply_changes",json!({"request_id":format!("invalid-{}",url.len()),"operations":[{"operation":"update","task_id":c["task"]["id"],"expected_version":2,"location":"Elsewhere","reason":"Test"},{"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Invalid","links":[{"url":url}],"reason":"Test"}]})).await;
        assert!(result.is_err());
    }
    let full = app
        .execute_ui("list_items", json!({"task_id":c["task"]["id"]}))
        .await
        .unwrap();
    assert_eq!(full["items"][0]["location"], original["location"]);
    for extra in [
        json!({"links":vec![json!({"url":"https://example.com"});21]}),
        json!({"location":"a".repeat(1001)}),
        json!({"links":[{"url":"https://example.com","label":"a".repeat(121)}]}),
    ] {
        let mut a = json!({"request_id":"limit","title":"Invalid","reason":"Test"});
        a.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(app.execute_ui("capture_item", a).await.is_err());
    }
    let bulk=app.execute_ui("apply_changes",json!({"request_id":"bulk","operations":[{"operation":"update","task_id":c["task"]["id"],"expected_version":2,"links":[{"url":"https://example.org","label":"New"}],"location":"Updated","reason":"Test"},{"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Bulk context","links":[{"url":"https://example.net"}],"location":"Park","reason":"Test"}]})).await.unwrap();
    let first = app
        .execute_ui(
            "list_items",
            json!({"task_id":bulk["results"][0]["entity_id"]}),
        )
        .await
        .unwrap();
    let second = app
        .execute_ui(
            "list_items",
            json!({"task_id":bulk["results"][1]["entity_id"]}),
        )
        .await
        .unwrap();
    assert_eq!(first["items"][0]["location"], "Updated");
    assert_eq!(second["items"][0]["links"][0]["url"], "https://example.net");
}
#[tokio::test]
async fn legacy_documents_and_pre_upgrade_retry_receipts_remain_compatible() {
    let dir = TempDir::new().unwrap();
    let db = rusqlite::Connection::open(dir.path().join("tasks.db")).unwrap();
    db.execute_batch(include_str!("../src/schema.sql")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    // Construct a real legacy database before migration, rather than rewriting
    // a current record while leaving its immutable revision projection stale.
    let old = json!({"id":id,"title":"Legacy","notes":"","status":"inbox","due_date":null,"version":1,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","deleted":false,"last_change_id":1});
    let change = json!({"id":1,"task_id":id,"operation":"capture","reason":"Test","before":null,"after":old,"undoes_change_id":null,"created_at":"2026-10-01T00:00:00Z"});
    db.execute(
        "INSERT INTO tasks(id,document) VALUES (?1,?2)",
        rusqlite::params![id, old.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO changes(id,task_id,document) VALUES (1,?1,?2)",
        rusqlite::params![id, change.to_string()],
    )
    .unwrap();
    let old_args = json!({"request_id":"legacy","title":"Legacy","notes":"","status":"inbox","due_date":null,"reason":"Test"});
    let input: CaptureItem = serde_json::from_value(old_args.clone()).unwrap();
    let serialized = serde_json::to_string(&("capture_item", input)).unwrap();
    assert_eq!(
        serialized,
        r#"["capture_item",{"request_id":"legacy","title":"Legacy","notes":"","status":"inbox","due_date":null,"reason":"Test"}]"#
    );
    let response = json!({"task":old,"change":change,"replayed":false});
    db.execute(
        "INSERT INTO requests(id,request,response) VALUES (?1,?2,?3)",
        rusqlite::params!["legacy", serialized, response.to_string()],
    )
    .unwrap();
    drop(db);
    let app = Application::new(
        Store::open(dir.path().join("tasks.db")).unwrap(),
        Diagnostics::open(&dir.path().join("logs.db"), "test").unwrap(),
    );
    let retry = app.execute_ui("capture_item", old_args).await.unwrap();
    assert_eq!(retry["replayed"], true);
    assert_eq!(retry["task"]["link_count"], 0);
    assert_eq!(retry["task"]["has_location"], false);
    let latest = app
        .execute_ui("list_items", json!({"task_id":id,"include_history":true}))
        .await
        .unwrap();
    assert_eq!(latest["items"][0]["links"], json!([]));
    assert_eq!(latest["history"].as_array().unwrap().len(), 2);
    let history = app
        .execute_ui("list_changes", json!({"change_id":1,"detail":"full"}))
        .await
        .unwrap();
    assert!(history["changes"][0]["after"]["location"].is_null());
    let db = rusqlite::Connection::open(dir.path().join("tasks.db")).unwrap();
    assert_eq!(
        db.query_row("SELECT response FROM requests WHERE id='legacy'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        response.to_string()
    );
    assert_eq!(
        db.query_row("SELECT document FROM changes WHERE id=1", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        change.to_string()
    );
}
