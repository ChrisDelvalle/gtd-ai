use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{application::Application, diagnostics::Diagnostics, store::Store};

fn legacy(path: &std::path::Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch("CREATE TABLE brief_exemptions(entity_id TEXT NOT NULL,segment_key TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),PRIMARY KEY(entity_id,segment_key)); PRAGMA user_version=10;").unwrap();
    db
}
fn app(path: &std::path::Path) -> Application {
    Application::new(
        Store::open(path).unwrap(),
        Diagnostics::open(&path.with_extension("logs"), "test").unwrap(),
    )
}
async fn fixture(a: &Application) -> Value {
    a.execute("capture_item", json!({"request_id":"fixture","title":"Read the quote","brief":"Read the quote before deciding.","agent_notes":"The quote is not accepted.","importance":"normal","status":"someday","reason":"Disposable fixture"})).await.unwrap()
}
fn bytes(db: &Connection, table: &str) -> Vec<Vec<rusqlite::types::Value>> {
    let mut stmt = db
        .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
        .unwrap();
    let n = stmt.column_count();
    stmt.query_map([], |row| (0..n).map(|i| row.get(i)).collect())
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[tokio::test]
async fn migration_refuses_every_retained_missing_brief_without_partial_cleanup() {
    for kind in [
        "task",
        "done",
        "archive",
        "project",
        "skipped",
        "old_segment",
    ] {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("db");
        let a = app(&path);
        let mut task = fixture(&a).await["task"].clone();
        // Read the actual stored record, since mutation responses are compact.
        let id = task["id"].as_str().unwrap().to_owned();
        task = a
            .execute("list_items", json!({"task_id":id}))
            .await
            .unwrap()["items"][0]
            .clone();
        let series = a.execute("create_recurrence", json!({"request_id":"series","template":{"title":"Review","brief":"Review current work.","agent_notes":"A recurring review.","importance":"normal","status":"someday"},"rule":{"start_date":"2090-01-01","frequency":"daily","count":4},"reason":"Fixture"})).await.unwrap();
        let sid = series["series"]["id"].as_str().unwrap();
        a.execute("update_recurrence",json!({"request_id":"split","series_id":sid,"expected_version":1,"scope":"following","action":"edit","original_date":"2090-01-03","brief":"Review later work.","reason":"Fixture"})).await.unwrap();
        drop(a);
        let db = legacy(&path);
        db.execute("INSERT INTO brief_exemptions VALUES(?1,'',1)", [&id])
            .unwrap();
        task["brief"] = json!(" ");
        match kind {
            "done" => task["status"] = json!("done"),
            "archive" => task["archived"] = json!(true),
            "project" => {
                task["entity_type"] = json!("project");
                task["status"] = json!("active");
            }
            "skipped" => {
                task["occurrence"] = json!({"series_id":sid,"original_date":"2090-01-01","scheduled_date":"2090-01-01","overrides":[],"skipped":true})
            }
            _ => {}
        }
        if kind == "old_segment" {
            db.execute("UPDATE tasks SET document=json_set(document,'$.recurrence.segments[0].template.brief','') WHERE id=?1",[sid]).unwrap();
        } else {
            db.execute(
                "UPDATE tasks SET document=?2 WHERE id=?1",
                params![id, task.to_string()],
            )
            .unwrap();
        }
        let tables = [
            "tasks",
            "changes",
            "revisions",
            "requests",
            "store_meta",
            "brief_exemptions",
            "search_state",
            "search_sessions",
        ];
        let before: Vec<_> = tables.iter().map(|t| bytes(&db, t)).collect();
        let error = Store::open(&path)
            .err()
            .expect("incomplete backfill must fail")
            .to_string();
        assert!(error.contains("Brief cleanup refused"), "{kind}: {error}");
        assert!(error.contains("0.17"));
        for (table, original) in tables.iter().zip(before) {
            assert_eq!(bytes(&db, table), original, "{kind}: {table}");
        }
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
    }
}

#[tokio::test]
async fn complete_cleanup_preserves_content_history_retries_and_invalidates_cursors() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("db");
    let a = app(&path);
    let original = fixture(&a).await;
    let snapshot = a.execute("sync_state", json!({})).await.unwrap();
    drop(a);
    let db = legacy(&path);
    db.execute(
        "INSERT INTO brief_exemptions VALUES(?1,'',0)",
        [original["task"]["id"].as_str().unwrap()],
    )
    .unwrap();
    let tables = ["tasks", "changes", "revisions", "requests", "action_groups"];
    let before: Vec<_> = tables.iter().map(|t| bytes(&db, t)).collect();
    let a = app(&path);
    for (table, original) in tables.iter().zip(before) {
        assert_eq!(bytes(&db, table), original, "{table}");
    }
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        11
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='brief_exemptions'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(
        a.execute("sync_state", json!({"cursor":snapshot["checkpoint"]}))
            .await
            .is_err()
    );
    assert_eq!(fixture(&a).await["replayed"], true);
    for operation in [
        "list_items",
        "list_projects",
        "list_occurrences",
        "show_tasks",
        "show_projects",
    ] {
        assert!(
            a.execute(operation, json!({"needs_brief":true}))
                .await
                .is_err()
        );
    }
    let read = a
        .execute("list_items", json!({"task_id":original["task"]["id"]}))
        .await
        .unwrap();
    assert!(read["items"][0].get("needs_brief").is_none());
    assert_eq!(read["items"][0]["brief"], "Read the quote before deciding.");
}

#[tokio::test]
async fn historical_missing_brief_undo_fails_atomically_after_cleanup() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("db");
    let a = app(&path);
    let task = fixture(&a).await["task"].clone();
    let edit = a.execute("update_item",json!({"request_id":"repair","task_id":task["id"],"expected_version":1,"brief":"Read the quote and compare the cost.","reason":"Fixture repair"})).await.unwrap();
    drop(a);
    let db = legacy(&path);
    // Model an immutable v10 repair whose historical before-image had no brief.
    db.execute_batch("DROP TRIGGER changes_no_update;").unwrap();
    db.execute(
        "UPDATE changes SET document=json_remove(document,'$.before.brief') WHERE id=?1",
        [edit["change"]["id"].as_i64().unwrap()],
    )
    .unwrap();
    db.execute_batch("CREATE TRIGGER changes_no_update BEFORE UPDATE ON changes BEGIN SELECT RAISE(ABORT,'audit history is append-only'); END;").unwrap();
    let a = app(&path);
    let before = bytes(&db, "tasks");
    let history = bytes(&db, "changes");
    let receipts = bytes(&db, "requests");
    let result = a.execute("undo_change",json!({"request_id":"undo-invalid","change_id":edit["change"]["id"],"expected_version":2,"reason":"Fixture undo"})).await;
    assert!(result.unwrap_err().to_string().contains("brief"));
    assert_eq!(bytes(&db, "tasks"), before);
    assert_eq!(bytes(&db, "changes"), history);
    assert_eq!(bytes(&db, "requests"), receipts);
}

#[tokio::test]
async fn inbox_and_deleted_records_need_no_backfill_but_old_incomplete_databases_do() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("db");
    let a = app(&path);
    let result = fixture(&a).await;
    drop(a);
    let db = legacy(&path);
    db.execute(
        "UPDATE tasks SET document=json_remove(document,'$.brief')",
        [],
    )
    .unwrap();
    db.pragma_update(None, "user_version", 9).unwrap();
    assert!(Store::open(&path).is_err());
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
    db.execute(
        "UPDATE tasks SET document=json_set(document,'$.status','inbox')",
        [],
    )
    .unwrap();
    drop(Store::open(&path).unwrap());
    db.execute("UPDATE tasks SET document=json_set(document,'$.status','done','$.deleted',json('true')) WHERE id=?1",[result["task"]["id"].as_str().unwrap()]).unwrap();
    db.pragma_update(None, "user_version", 10).unwrap();
    assert!(Store::open(&path).is_ok());
}
