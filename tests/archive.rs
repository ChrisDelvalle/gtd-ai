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
async fn update(app: &Application, task: &Value, patch: Value, key: &str) -> Value {
    let mut args = json!({"request_id":key,"task_id":task["id"],"expected_version":task["version"],"reason":"Archive regression"});
    args.as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    app.execute_ui("update_item", args).await.unwrap()
}
async fn undo(app: &Application, receipt: &Value, key: &str) -> Value {
    app.execute_ui("undo_change",json!({"request_id":key,"change_id":receipt["change"]["id"],"expected_version":receipt["task"]["version"],"reason":"Archive regression undo"})).await.unwrap()
}
#[tokio::test]
async fn archive_completion_reopen_undo_and_filters_are_independent() {
    let (_dir, app) = setup();
    let c = app.execute_ui("capture_item",json!({"estimated_minutes":30,"effort":"medium","importance":"normal","brief":"Complete the disposable archive fixture.","request_id":"create","title":"Archive fixture","status":"next","reason":"Test"})).await.unwrap();
    let a = update(&app, &c["task"], json!({"archived":true}), "archive").await;
    assert_eq!(a["task"]["status"], "next");
    assert_eq!(a["task"]["archived"], true);
    let d = update(&app, &a["task"], json!({"status":"done"}), "done").await;
    assert_eq!(d["task"]["archived"], true);
    for args in [
        json!({}),
        json!({"view":"active"}),
        json!({"status":"done"}),
        json!({"archived":false}),
    ] {
        assert_eq!(
            app.execute_ui("list_items", args).await.unwrap()["items"],
            json!([])
        );
    }
    for args in [
        json!({"archived":true}),
        json!({"archived":true,"status":"done"}),
        json!({"status":"archived"}),
        json!({"view":"all"}),
        json!({"task_id":d["task"]["id"]}),
    ] {
        let items = app.execute_ui("list_items", args).await.unwrap();
        assert_eq!(items["items"].as_array().unwrap().len(), 1);
        assert_eq!(items["items"][0]["status"], "done");
        assert_eq!(items["items"][0]["archived"], true);
    }
    let retry = update(&app, &a["task"], json!({"status":"done"}), "done").await;
    assert_eq!(retry["replayed"], true);
    let stale = app.execute_ui("update_item",json!({"request_id":"stale","task_id":a["task"]["id"],"expected_version":2,"archived":false,"reason":"Test"})).await;
    assert!(stale.is_err());
    let u = undo(&app, &d, "undo").await;
    assert_eq!(u["task"]["status"], "next");
    assert_eq!(u["task"]["archived"], true);
    let redo = undo(&app, &u, "redo").await;
    assert_eq!(redo["task"]["status"], "done");
    assert_eq!(redo["task"]["archived"], true);
    let reopened = update(&app, &redo["task"], json!({"status":"inbox"}), "reopen").await;
    assert_eq!(reopened["task"]["archived"], true);
    let restored = update(
        &app,
        &reopened["task"],
        json!({"archived":false}),
        "unarchive",
    )
    .await;
    assert_eq!(restored["task"]["status"], "inbox");
    assert_eq!(restored["task"]["archived"], false);
    assert_eq!(
        app.execute_ui("list_items", json!({})).await.unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[tokio::test]
async fn legacy_archive_alias_and_batch_preserve_workflow_and_validate_conflicts() {
    let (_dir, app) = setup();
    let c = app.execute_ui("capture_item",json!({"estimated_minutes":30,"effort":"medium","importance":"normal","brief":"Complete the disposable archive fixture.","request_id":"create","title":"Done before archive","status":"done","reason":"Test"})).await.unwrap();
    let a = update(&app, &c["task"], json!({"status":"archived"}), "legacy").await;
    assert_eq!(a["task"]["status"], "done");
    assert_eq!(a["task"]["archived"], true);
    let batch = app.execute_ui("apply_changes",json!({"request_id":"batch","operations":[
        {"operation":"update","task_id":a["task"]["id"],"expected_version":2,"status":"next","archived":false,"reason":"Test"},
        {"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","brief":"Complete the disposable archive fixture.","title":"Archived done","status":"done","archived":true,"reason":"Test"}]})).await.unwrap();
    let first = app
        .execute_ui(
            "list_items",
            json!({"task_id":batch["results"][0]["entity_id"]}),
        )
        .await
        .unwrap();
    let second = app
        .execute_ui(
            "list_items",
            json!({"task_id":batch["results"][1]["entity_id"]}),
        )
        .await
        .unwrap();
    assert_eq!(first["items"][0]["archived"], false);
    assert_eq!(first["items"][0]["version"], batch["results"][0]["version"]);
    assert_eq!(second["items"][0]["status"], "done");
    assert_eq!(second["items"][0]["archived"], true);
    for name in ["capture_item", "update_item"] {
        let args = json!({"request_id":format!("bad-{name}"),"status":"archived","archived":false,"reason":"Test"});
        let mut args = args.as_object().unwrap().clone();
        if name == "capture_item" {
            args.insert("title".into(), json!("Bad"));
        } else {
            args.insert("task_id".into(), c["task"]["id"].clone());
            args.insert("expected_version".into(), json!(3));
        }
        assert!(app.execute_ui(name, Value::Object(args)).await.is_err());
    }
    assert!(
        app.execute_ui("list_items", json!({"status":"archived","archived":false}))
            .await
            .is_err()
    );
}
#[test]
fn migrates_legacy_archives_without_rewriting_audit_or_versions_and_undo_remains_valid() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("v1.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../src/schema.sql")).unwrap();
    let mut originals = Vec::new();
    for (i, status) in ["done", "next", "inbox"].into_iter().enumerate() {
        let id = uuid::Uuid::new_v4().to_string();
        let before = json!({"estimated_minutes":30,"effort":"medium","importance":"normal","brief":"Complete the disposable archive fixture.","id":id,"title":"Legacy","notes":"Preserve","status":status,"due_date":null,"version":1,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","deleted":false,"last_change_id":0});
        let mut after = before.clone();
        after["status"] = json!("archived");
        after["version"] = json!(2);
        after["last_change_id"] = json!(i + 1);
        let change=json!({"id":i+1,"task_id":id,"operation":"update","reason":"Legacy archive","before":if i==2 {Value::Null} else {before},"after":after,"undoes_change_id":null,"created_at":"2026-10-01T00:00:00Z"}).to_string();
        db.execute(
            "INSERT INTO tasks VALUES (?1,?2)",
            rusqlite::params![id, after.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO changes VALUES (?1,?2,?3)",
            rusqlite::params![i as i64 + 1, id, change],
        )
        .unwrap();
        originals.push(change);
    }
    let retry = "{\"original\":\"receipt\"}";
    db.execute(
        "INSERT INTO requests VALUES ('old','unchanged',?1)",
        [retry],
    )
    .unwrap();
    drop(db);
    let mut store = Store::open(&path).unwrap();
    let list = store
        .list(ListItems {
            archived: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(list.items.len(), 3);
    for task in &list.items {
        assert!(task.archived);
        assert_eq!(task.version, 2);
    }
    assert_eq!(
        list.items
            .iter()
            .filter(|t| t.status == Status::Done)
            .count(),
        1
    );
    assert_eq!(
        list.items
            .iter()
            .filter(|t| t.status == Status::Next)
            .count(),
        1
    );
    assert_eq!(
        list.items
            .iter()
            .filter(|t| t.status == Status::Inbox)
            .count(),
        1
    );
    let done = list
        .items
        .iter()
        .find(|t| t.status == Status::Done)
        .unwrap();
    let undone = store
        .undo(UndoChange {
            request_id: "undo-old".into(),
            change_id: done.last_change_id,
            expected_version: 2,
            reason: "Test".into(),
        })
        .unwrap();
    assert!(!undone.task.archived);
    assert_eq!(undone.task.status, Status::Done);
    let redo = store
        .undo(UndoChange {
            request_id: "redo-old".into(),
            change_id: undone.change.id,
            expected_version: 3,
            reason: "Test".into(),
        })
        .unwrap();
    assert!(redo.task.archived);
    assert_eq!(redo.task.status, Status::Done);
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    for (i, original) in originals.iter().enumerate() {
        let saved: String = db
            .query_row(
                "SELECT document FROM changes WHERE id=?1",
                [i as i64 + 1],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(&saved, original);
    }
    assert_eq!(
        db.query_row("SELECT response FROM requests WHERE id='old'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        retry
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        11
    );
    drop(db);
    assert_eq!(
        Store::open(path)
            .unwrap()
            .list(ListItems {
                archived: Some(true),
                ..Default::default()
            })
            .unwrap()
            .items
            .len(),
        3
    );
}
