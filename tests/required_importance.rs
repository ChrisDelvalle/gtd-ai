mod support;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{model::*, planning::Importance, server, store::Store};
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> T {
    support::input(v)
}
fn capture(key: &str, importance: Option<&str>) -> CaptureItem {
    let mut value = json!({"request_id":key,"title":key,"reason":"Disposable fixture"});
    if let Some(i) = importance {
        value["importance"] = i.into();
    }
    decode(value)
}
fn current(s: &mut Store, id: &str) -> Task {
    s.list(decode(json!({"task_id":id,"include_deleted":true})))
        .unwrap()
        .items
        .remove(0)
}
#[test]
fn required_creation_preserving_updates_clears_batches_retries_and_undo() {
    let dir = TempDir::new().unwrap();
    let mut s = Store::open(dir.path().join("db")).unwrap();
    assert_eq!(
        s.capture(capture("missing", None)).unwrap_err().code(),
        "invalid_input"
    );
    assert!(
        s.capture(decode(
            json!({"request_id":"null","title":"Null","estimated_minutes":30,"effort":"medium","importance":null,"reason":"test"})
        ))
        .is_err()
    );
    let c = s.capture(capture("new", Some("high"))).unwrap();
    assert!(s.capture(capture("new", Some("high"))).unwrap().replayed);
    let edit: UpdateItem = decode(
        json!({"request_id":"edit","task_id":c.task.id,"expected_version":1,"estimated_minutes":30,"effort":"medium","importance":null,"notes":"Description","reason":"Omit-preserving update"}),
    );
    let u = s.update(edit).unwrap();
    assert_eq!(u.task.planning.importance, Some(Importance::High));
    let bad = decode(
        json!({"request_id":"bad","task_id":c.task.id,"expected_version":2,"clear_planning":["importance"],"reason":"Invalid clear"}),
    );
    assert_eq!(s.update(bad).unwrap_err().code(), "invalid_input");
    let bad_batch = decode(
        json!({"request_id":"batch","operations":[{"operation":"update","task_id":c.task.id,"expected_version":2,"estimated_minutes":30,"effort":"medium","importance":"low","reason":"Change"},{"operation":"capture","title":"Missing","reason":"Invalid"}]}),
    );
    assert!(s.apply_changes(bad_batch).is_err());
    assert_eq!(current(&mut s, &c.task.id).version, 2);
    let changed=s.update(decode(json!({"request_id":"level","task_id":c.task.id,"expected_version":2,"estimated_minutes":30,"effort":"medium","importance":"critical","reason":"Explicit importance"}))).unwrap();
    let undo=s.undo(decode(json!({"request_id":"undo","change_id":changed.change.id,"expected_version":3,"reason":"Undo"}))).unwrap();
    assert_eq!(undo.task.planning.importance, Some(Importance::High));
    assert!(
        s.create_project(decode(
            json!({"request_id":"project","title":"Outcome","reason":"No project importance"})
        ))
        .unwrap()
        .task
        .planning
        .importance
        .is_none()
    );
}
#[test]
fn recurrence_requires_defaults_but_omission_preserves_each_segment_and_overrides() {
    let dir = TempDir::new().unwrap();
    let mut s = Store::open(dir.path().join("db")).unwrap();
    let mut args = json!({"request_id":"series","template":{"title":"Repeat"},"rule":{"start_date":"2090-01-01","frequency":"daily","count":3},"reason":"Fixture"});
    assert!(s.create_recurrence(decode(args.clone())).is_err());
    args["template"]["importance"] = "high".into();
    args["template"]["estimated_minutes"] = 30.into();
    args["template"]["effort"] = "medium".into();
    let c = s.create_recurrence(decode(args)).unwrap();
    s.materialize_recurrences("2090-01-03").unwrap();
    let tasks = s.list(decode(json!({"view":"all"}))).unwrap().items;
    assert!(
        tasks
            .iter()
            .all(|t| t.planning.importance == Some(Importance::High))
    );
    s.update(decode(json!({"request_id":"override","task_id":tasks[0].id,"expected_version":1,"estimated_minutes":30,"effort":"medium","importance":"critical","reason":"Override"}))).unwrap();
    let updated=s.update_recurrence(decode(json!({"request_id":"defaults","series_id":c.task.id,"expected_version":1,"scope":"all","action":"edit","template":{"title":"Renamed"},"reason":"Preserve importance"}))).unwrap();
    assert_eq!(
        updated.task.recurrence.as_ref().unwrap().segments[0]
            .template
            .planning
            .importance,
        Some(Importance::High)
    );
    assert_eq!(
        current(&mut s, &tasks[0].id).planning.importance,
        Some(Importance::Critical)
    );
    assert!(s.update_recurrence(decode(json!({"request_id":"clear-defaults","series_id":c.task.id,"expected_version":updated.task.version,"scope":"all","action":"edit","template":{"title":"Repeat","clear_planning":["importance"]},"reason":"Invalid"}))).is_err());
}
#[test]
fn creation_schemas_require_nonnullable_importance_including_batches() {
    let tools = server::tools();
    let schema = |name: &str| {
        serde_json::to_value(tools.iter().find(|t| t.name == name).unwrap()).unwrap()["inputSchema"]
            .clone()
    };
    let capture = schema("capture_item");
    assert!(
        capture["required"]
            .as_array()
            .unwrap()
            .contains(&json!("importance"))
    );
    assert_eq!(capture["properties"]["importance"]["type"], "string");
    let update = schema("update_item");
    assert!(
        !update["required"]
            .as_array()
            .unwrap()
            .contains(&json!("importance"))
    );
    assert!(
        !update["$defs"]["PlanningField"]["enum"]
            .as_array()
            .unwrap()
            .contains(&json!("importance"))
    );
    let create = schema("create_recurrence");
    assert!(
        create["$defs"]["NewTemplate"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("importance"))
    );
    let batch = schema("apply_changes");
    let variants = batch["$defs"]["BatchOperation"]["oneOf"]
        .as_array()
        .unwrap();
    let capture = variants
        .iter()
        .find(|v| v["properties"]["operation"]["const"] == "capture")
        .unwrap();
    assert!(
        capture["required"]
            .as_array()
            .unwrap()
            .contains(&json!("importance"))
    );
    assert!(
        batch["$defs"]["NewTemplate"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("importance"))
    );
}
#[test]
fn migration_appends_history_preserves_receipts_and_resets_old_snapshots() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("db");
    let mut s = Store::open(&path).unwrap();
    let c = s.capture(capture("legacy", Some("normal"))).unwrap();
    let assessed = s.capture(capture("assessed", Some("low"))).unwrap();
    let p = s
        .create_project(decode(
            json!({"request_id":"p","title":"Project","reason":"Fixture"}),
        ))
        .unwrap();
    let cursor = s
        .list(decode(json!({"view":"all","limit":1})))
        .unwrap()
        .next_cursor
        .unwrap();
    drop(s);
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "DROP TRIGGER changes_no_update; DROP TRIGGER revisions_no_update; DROP TABLE IF EXISTS brief_exemptions; PRAGMA user_version=6;",
    )
    .unwrap();
    db.execute(
        "UPDATE tasks SET document=json_remove(document,'$.importance') WHERE id=?1",
        [&c.task.id],
    )
    .unwrap();
    db.execute(
        "UPDATE changes SET document=json_remove(document,'$.after.importance') WHERE task_id=?1",
        [&c.task.id],
    )
    .unwrap();
    db.execute(
        "UPDATE revisions SET document=json_remove(document,'$.importance') WHERE entity_id=?1",
        [&c.task.id],
    )
    .unwrap();
    let legacy_args = capture("legacy", None);
    let mut receipt = serde_json::to_value(&c).unwrap();
    receipt["task"]
        .as_object_mut()
        .unwrap()
        .remove("importance");
    receipt["change"]["after"]
        .as_object_mut()
        .unwrap()
        .remove("importance");
    db.execute(
        "UPDATE requests SET request=?1,response=?2 WHERE id='legacy'",
        params![
            serde_json::to_string(&("capture_item", &legacy_args)).unwrap(),
            receipt.to_string()
        ],
    )
    .unwrap();
    db.execute_batch("CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are append-only'); END; CREATE TRIGGER changes_no_update BEFORE UPDATE ON changes BEGIN SELECT RAISE(ABORT, 'audit history is append-only'); END;").unwrap();
    let old_history: String = db
        .query_row(
            "SELECT document FROM changes WHERE id=?1",
            [c.change.id],
            |r| r.get(0),
        )
        .unwrap();
    let old_receipt: String = db
        .query_row("SELECT response FROM requests WHERE id='legacy'", [], |r| {
            r.get(0)
        })
        .unwrap();
    drop(db);
    let mut s = Store::open(&path).unwrap();
    let migrated = current(&mut s, &c.task.id);
    assert_eq!(migrated.planning.importance, Some(Importance::Normal));
    assert_eq!(migrated.version, c.task.version + 1);
    assert_eq!(current(&mut s, &assessed.task.id), assessed.task);
    let project: Task = serde_json::from_str(
        &Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT document FROM tasks WHERE id=?1",
                [&p.task.id],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(project, p.task);
    assert_eq!(
        s.list(decode(json!({"view":"all","limit":1,"cursor":cursor})))
            .unwrap_err()
            .code(),
        "reset_required"
    );
    assert!(s.capture(legacy_args).unwrap().replayed);
    assert!(s.undo(decode(json!({"request_id":"undo-migration","change_id":migrated.last_change_id,"expected_version":migrated.version,"reason":"Invalid"}))).is_err());
    drop(s);
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        11
    );
    assert_eq!(
        db.query_row(
            "SELECT document FROM changes WHERE id=?1",
            [c.change.id],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        old_history
    );
    assert_eq!(
        db.query_row("SELECT response FROM requests WHERE id='legacy'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        old_receipt
    );
    let count: i64 = db
        .query_row("SELECT count(*) FROM changes", [], |r| r.get(0))
        .unwrap();
    drop(db);
    drop(Store::open(&path).unwrap());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM changes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        count
    );
}

#[test]
fn migration_fills_series_segments_and_undo_restores_legacy_tombstones_with_importance() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("db");
    let mut s = Store::open(&path).unwrap();
    let series = s.create_recurrence(decode(json!({"request_id":"repeat","template":{"title":"Repeat","estimated_minutes":30,"effort":"medium","importance":"normal"},"rule":{"start_date":"2090-01-01","frequency":"daily","count":2},"reason":"Fixture"}))).unwrap();
    let task = s.capture(capture("removed", Some("normal"))).unwrap();
    let removed = s.undo(decode(json!({"request_id":"remove","change_id":task.change.id,"expected_version":1,"reason":"Fixture tombstone"}))).unwrap();
    drop(s);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TRIGGER changes_no_update; DROP TABLE IF EXISTS brief_exemptions; PRAGMA user_version=6;")
        .unwrap();
    db.execute("UPDATE tasks SET document=json_remove(document,'$.importance','$.recurrence.segments[0].template.importance') WHERE id=?1",[&series.task.id]).unwrap();
    db.execute(
        "UPDATE tasks SET document=json_remove(document,'$.importance') WHERE id=?1",
        [&task.task.id],
    )
    .unwrap();
    db.execute(
        "UPDATE changes SET document=json_remove(document,'$.before.importance') WHERE id=?1",
        [removed.change.id],
    )
    .unwrap();
    db.execute_batch("CREATE TRIGGER changes_no_update BEFORE UPDATE ON changes BEGIN SELECT RAISE(ABORT, 'audit history is append-only'); END;").unwrap();
    let tombstone: String = db
        .query_row(
            "SELECT document FROM tasks WHERE id=?1",
            [&task.task.id],
            |r| r.get(0),
        )
        .unwrap();
    drop(db);
    let mut s = Store::open(&path).unwrap();
    let read = s
        .list_occurrences(decode(
            json!({"series_id":series.task.id,"from":"2090-01-01"}),
        ))
        .unwrap();
    assert_eq!(
        read["series"]["recurrence"]["segments"][0]["template"]["importance"],
        "normal"
    );
    assert_eq!(
        Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT document FROM tasks WHERE id=?1",
                [&task.task.id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        tombstone
    );
    let restored=s.undo(decode(json!({"request_id":"restore","change_id":removed.change.id,"expected_version":2,"reason":"Restore legacy record"}))).unwrap();
    assert!(!restored.task.deleted);
    assert_eq!(restored.task.planning.importance, Some(Importance::Normal));
    s.materialize_recurrences("2090-01-02").unwrap();
    assert!(
        s.list(decode(json!({"view":"all"})))
            .unwrap()
            .items
            .iter()
            .all(|t| t.planning.importance.is_some())
    );
}
