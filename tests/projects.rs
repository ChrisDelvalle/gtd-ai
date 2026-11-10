mod support;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{model::*, projection, store::Store};

fn input<T: DeserializeOwned>(value: Value) -> T {
    support::input(value)
}

fn project(store: &mut Store, key: &str) -> MutationResult {
    store
        .create_project(input(
            json!({"request_id":key,"title":key,"reason":"Synthetic project fixture"}),
        ))
        .unwrap()
}

fn capture(store: &mut Store, key: &str, fields: Value) -> MutationResult {
    let mut args = json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":key,"title":key,"reason":"Synthetic task fixture"});
    args.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    store.capture(input(args)).unwrap()
}

fn edit(task: &Task, key: &str, fields: Value) -> UpdateItem {
    let mut args = json!({"request_id":key,"task_id":task.id,"expected_version":task.version,"reason":"Synthetic task update"});
    args.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    input(args)
}

fn project_edit(task: &Task, key: &str, fields: Value) -> UpdateProject {
    let mut args = json!({"request_id":key,"project_id":task.id,"expected_version":task.version,"reason":"Synthetic project update"});
    args.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    input(args)
}

fn undo(receipt: &MutationResult, key: &str) -> UndoChange {
    input(
        json!({"request_id":key,"change_id":receipt.change.id,"expected_version":receipt.task.version,"reason":"Synthetic undo"}),
    )
}

fn current(store: &mut Store, task: &Task) -> Task {
    store
        .list(input(json!({"task_id":task.id,"include_deleted":true})))
        .unwrap()
        .items
        .remove(0)
}

#[test]
fn project_lifecycle_is_explicit_atomic_and_replayable() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.db");
    let mut store = Store::open(&path).unwrap();
    let p = project(&mut store, "project");
    assert_eq!(p.task.entity_type, EntityType::Project);
    assert_eq!(p.task.status, Status::Active);
    let t = capture(
        &mut store,
        "step",
        json!({"status":"planned","project_id":p.task.id}),
    );
    assert_eq!(
        store
            .update_project(project_edit(&p.task, "premature", json!({"status":"done"})))
            .unwrap_err()
            .code(),
        "conflict"
    );
    assert_eq!(
        store
            .projects(input(json!({"project_id":p.task.id})))
            .unwrap()["projects"][0]["version"],
        1
    );
    let args: ApplyChanges = input(json!({"request_id":"complete-together","operations":[
        {"operation":"update_project","project_id":p.task.id,"expected_version":1,"status":"done","completion_result":"Outcome verified","reason":"Synthetic completion"},
        {"operation":"update","task_id":t.task.id,"expected_version":1,"status":"done","reason":"Synthetic completion"}
    ]}));
    let result = store.apply_changes(args.clone()).unwrap();
    assert_eq!(result.results[0].task.status, Status::Done);
    assert_eq!(result.results[1].task.status, Status::Done);
    assert_eq!(
        result.results[0].task.completion_result.as_deref(),
        Some("Outcome verified")
    );
    assert_eq!(
        store
            .undo(undo(&result.results[1], "invalid-reopen"))
            .unwrap_err()
            .code(),
        "conflict"
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let replay = store.apply_changes(args).unwrap();
    assert!(replay.replayed && replay.results.iter().all(|r| r.replayed));
    assert_eq!(replay.results[0].task, result.results[0].task);
    let undone = store.apply_changes(input(json!({"request_id":"undo-together","operations":[
        {"operation":"undo","change_id":result.results[1].change.id,"expected_version":2,"reason":"Synthetic reversal"},
        {"operation":"undo","change_id":result.results[0].change.id,"expected_version":2,"reason":"Synthetic reversal"}
    ]}))).unwrap();
    assert_eq!(undone.results[0].task.status, Status::Blocked);
    assert_eq!(undone.results[1].task.status, Status::Active);
    assert!(undone.results[1].task.completed_at.is_none());
}

#[test]
fn project_shelving_archiving_and_deletion_cannot_strand_actions() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let p = project(&mut store, "project");
    let t = capture(
        &mut store,
        "step",
        json!({"status":"next","project_id":p.task.id}),
    );
    for (key, patch) in [
        ("shelve", json!({"status":"someday"})),
        ("archive", json!({"archived":true})),
    ] {
        assert_eq!(
            store
                .update_project(project_edit(&p.task, key, patch))
                .unwrap_err()
                .code(),
            "conflict"
        );
    }
    assert_eq!(
        store.undo(undo(&p, "delete-project")).unwrap_err().code(),
        "conflict"
    );
    let t = store
        .update(edit(&t.task, "shelve-step", json!({"status":"someday"})))
        .unwrap();
    let p = store
        .update_project(project_edit(&p.task, "shelve", json!({"status":"someday"})))
        .unwrap();
    assert_eq!(
        store
            .update(edit(&t.task, "activate-step", json!({"status":"next"})))
            .unwrap_err()
            .code(),
        "conflict"
    );
    let t = store
        .update(edit(&t.task, "archive-step", json!({"archived":true})))
        .unwrap();
    let p = store
        .update_project(project_edit(&p.task, "archive", json!({"archived":true})))
        .unwrap();
    assert_eq!(
        store
            .update(edit(&t.task, "restore-step", json!({"archived":false})))
            .unwrap_err()
            .code(),
        "conflict"
    );
    let done = store
        .update(edit(
            &t.task,
            "complete-archived-step",
            json!({"status":"done"}),
        ))
        .unwrap();
    assert!(done.task.archived);
    assert_eq!(
        store.projects(input(json!({"archived":true}))).unwrap()["projects"][0]["id"],
        p.task.id
    );
    let standalone = store
        .update(edit(
            &done.task,
            "detach",
            json!({"clear_project":true,"archived":false}),
        ))
        .unwrap();
    assert!(standalone.task.project_id.is_none());
}

#[test]
fn task_and_project_tools_reject_wrong_record_types_and_invalid_membership() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let p = project(&mut store, "project");
    let t = capture(&mut store, "standalone", json!({}));
    assert_eq!(
        store
            .update(edit(&p.task, "task-tool", json!({"title":"wrong"})))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(
        store
            .update_project(project_edit(
                &t.task,
                "project-tool",
                json!({"title":"wrong"})
            ))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(
        store
            .update(edit(
                &t.task,
                "self-parent",
                json!({"project_id":t.task.id})
            ))
            .unwrap_err()
            .code(),
        "conflict"
    );
    assert_eq!(
        store
            .update(edit(
                &t.task,
                "missing-parent",
                json!({"project_id":uuid::Uuid::new_v4().to_string()})
            ))
            .unwrap_err()
            .code(),
        "conflict"
    );
    assert_eq!(
        store
            .update(edit(&t.task, "active-task", json!({"status":"active"})))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(
        store
            .update(edit(
                &t.task,
                "set-clear",
                json!({"project_id":p.task.id,"clear_project":true})
            ))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(current(&mut store, &t.task).version, 1);
}

#[test]
fn competing_project_completion_and_task_assignment_never_commit_an_invalid_pair() {
    use std::sync::{Arc, Barrier};
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.db");
    let mut store = Store::open(&path).unwrap();
    let p = project(&mut store, "project");
    let barrier = Arc::new(Barrier::new(2));
    let mut writer_a = Store::open(&path).unwrap();
    let mut writer_b = Store::open(&path).unwrap();
    let gate = barrier.clone();
    let project_id = p.task.id.clone();
    let completing = std::thread::spawn(move || {
        gate.wait();
        writer_a.update_project(project_edit(
            &p.task,
            "complete-project",
            json!({"status":"done"}),
        ))
    });
    let attaching = std::thread::spawn(move || {
        barrier.wait();
        writer_b.capture(input(json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"attach-task","title":"Concurrent task","project_id":project_id,"status":"next","reason":"Synthetic race"})))
    });
    let results = [completing.join().unwrap(), attaching.join().unwrap()];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .find_map(|r| r.as_ref().err())
            .unwrap()
            .code(),
        "conflict"
    );
    assert_eq!(
        store.changes(ListChanges::default()).unwrap().changes.len(),
        2
    );
}

#[test]
fn planned_and_review_views_preserve_distinct_gtd_meanings() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let p = project(&mut store, "project");
    let planned = capture(
        &mut store,
        "planned",
        json!({"status":"planned","project_id":p.task.id}),
    );
    capture(&mut store, "next", json!({"status":"next"}));
    capture(
        &mut store,
        "review",
        json!({"status":"someday","review_date":"2026-10-03","due_date":"2026-10-10"}),
    );
    capture(
        &mut store,
        "future",
        json!({"status":"someday","review_date":"2026-10-04"}),
    );
    capture(
        &mut store,
        "done",
        json!({"status":"done","review_date":"2026-10-02"}),
    );
    capture(
        &mut store,
        "archived",
        json!({"status":"next","archived":true,"review_date":"2026-10-02"}),
    );
    let active = store.list(ListItems::default()).unwrap();
    assert_eq!(
        active.items.iter().map(|t| t.status).collect::<Vec<_>>(),
        vec![Status::Next, Status::Blocked]
    );
    let exact_next = store.list(input(json!({"status":"next"}))).unwrap();
    assert!(exact_next.items.iter().all(|t| t.status == Status::Next));
    let review = store
        .list(input(json!({"review_on":"2026-10-03"})))
        .unwrap();
    assert_eq!(review.items.len(), 1);
    assert_eq!(review.items[0].status, Status::Someday);
    assert_eq!(review.items[0].due_date.as_deref(), Some("2026-10-10"));
    let summary = store.projects(ListProjects::default()).unwrap();
    assert_eq!(summary["projects"][0]["task_counts"]["blocked"], 1);
    assert_eq!(summary["projects"][0]["needs_next_action"], true);
    store
        .update(edit(
            &planned.task,
            "external-wait",
            json!({"status":"waiting"}),
        ))
        .unwrap();
    assert_eq!(
        store.projects(ListProjects::default()).unwrap()["projects"][0]["needs_next_action"],
        false
    );
}

#[test]
fn completion_results_dates_and_sessions_survive_corrections_reopen_and_undo() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let t = capture(
        &mut store,
        "task",
        json!({"status":"next","due_date":"2026-10-10","review_date":"2026-10-03","work_sessions":[{"url":"https://calendar.google.com/calendar/event?eid=synthetic","label":"Work session"}]}),
    );
    assert_eq!(
        store
            .update(edit(
                &t.task,
                "early-result",
                json!({"completion_result":"Not done"})
            ))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    let done = store
        .update(edit(
            &t.task,
            "done",
            json!({"status":"done","completion_result":"Selected option A"}),
        ))
        .unwrap();
    let time = done.task.completed_at.clone().unwrap();
    let corrected = store
        .update(edit(
            &done.task,
            "correction",
            json!({"completion_result":"Selected option B"}),
        ))
        .unwrap();
    assert_eq!(corrected.task.completed_at.as_deref(), Some(time.as_str()));
    let reopened = store
        .update(edit(&corrected.task, "reopen", json!({"status":"next"})))
        .unwrap();
    assert!(reopened.task.completed_at.is_none() && reopened.task.completion_result.is_none());
    assert_eq!(reopened.task.work_sessions, t.task.work_sessions);
    let restored = store.undo(undo(&reopened, "undo-reopen")).unwrap();
    assert_eq!(restored.task.completed_at.as_deref(), Some(time.as_str()));
    assert_eq!(
        restored.task.completion_result.as_deref(),
        Some("Selected option B")
    );
    let cleared=store.update(edit(&restored.task,"clear-fields",json!({"clear_due_date":true,"clear_review_date":true,"work_sessions":[],"completion_result":""}))).unwrap();
    assert!(
        cleared.task.due_date.is_none()
            && cleared.task.review_date.is_none()
            && cleared.task.work_sessions.is_empty()
            && cleared.task.completion_result.is_none()
    );
    assert_eq!(cleared.task.completed_at, Some(time));
    assert_eq!(
        store
            .update(edit(
                &cleared.task,
                "bad-review",
                json!({"review_date":"2026-02-30"})
            ))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(
        store
            .update(edit(
                &cleared.task,
                "bad-url",
                json!({"work_sessions":[{"url":"javascript:alert(1)"}]})
            ))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
}

#[test]
fn stable_task_cursor_does_not_skip_or_duplicate_records_after_writes() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.db");
    let mut reader = Store::open(&path).unwrap();
    let a = capture(&mut reader, "A", json!({"status":"next"}));
    let b = capture(&mut reader, "B", json!({"status":"next"}));
    let c = capture(&mut reader, "C", json!({"status":"next"}));
    let first = reader
        .list(input(json!({"status":"next","limit":1})))
        .unwrap();
    assert_eq!(first.items[0].id, a.task.id);
    let mut writer = Store::open(&path).unwrap();
    writer
        .update(edit(&b.task, "complete-B", json!({"status":"done"})))
        .unwrap();
    writer
        .update(edit(&c.task, "move-C", json!({"due_date":"2026-01-01"})))
        .unwrap();
    capture(
        &mut writer,
        "new-task",
        json!({"status":"next","due_date":"2025-01-01"}),
    );
    let cursor = first.next_cursor.unwrap();
    assert_eq!(
        reader
            .list(input(json!({"status":"done","limit":1,"cursor":cursor})))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    let second = reader
        .list(input(json!({"status":"next","limit":1,"cursor":cursor})))
        .unwrap();
    assert_eq!(second.items[0], b.task);
    let third = reader
        .list(input(
            json!({"status":"next","limit":1,"cursor":second.next_cursor}),
        ))
        .unwrap();
    assert_eq!(third.items[0], c.task);
    assert!(third.next_cursor.is_none());
}

#[test]
fn snapshot_and_feed_are_independent_bounded_and_transaction_aware() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.db");
    let mut reader = Store::open(&path).unwrap();
    let p = project(&mut reader, "project");
    let a = capture(
        &mut reader,
        "A",
        json!({"project_id":p.task.id,"status":"next"}),
    );
    let b = capture(&mut reader, "B", json!({"status":"someday"}));
    let initial = reader.sync_state(input(json!({"limit":1}))).unwrap();
    let mut records = initial["records"].as_array().unwrap().clone();
    let mut writer = Store::open(&path).unwrap();
    let batch=writer.apply_changes(input(json!({"request_id":"concurrent","operations":[
        {"operation":"update","task_id":a.task.id,"expected_version":1,"status":"done","reason":"Synthetic"},
        {"operation":"undo","change_id":b.change.id,"expected_version":1,"reason":"Synthetic"},
        {"operation":"update_project","project_id":p.task.id,"expected_version":1,"status":"done","reason":"Synthetic"}
    ]}))).unwrap();
    let mut page = initial;
    while !page["next_cursor"].is_null() {
        page = reader
            .sync_state(input(json!({"cursor":page["next_cursor"],"limit":1})))
            .unwrap();
        records.extend(page["records"].as_array().unwrap().clone());
    }
    assert_eq!(records.len(), 3);
    assert!(records.iter().all(|r| r["version"] == 1));
    assert!(records.iter().any(|r| r["id"] == b.task.id));
    let checkpoint = page["checkpoint"].clone();
    let first = reader
        .sync_state(input(json!({"cursor":checkpoint,"limit":1})))
        .unwrap();
    assert_eq!(first["changes"][0]["id"], batch.results[0].change.id);
    assert_eq!(first["changes"][0]["transaction_end"], false);
    assert_eq!(first["changes"][0]["transaction_id"], "concurrent");
    let second = reader
        .sync_state(input(json!({"cursor":first["next_cursor"],"limit":1})))
        .unwrap();
    assert_eq!(second["changes"][0]["after"]["deleted"], true);
    let third = reader
        .sync_state(input(json!({"cursor":second["next_cursor"],"limit":1})))
        .unwrap();
    assert_eq!(third["changes"][0]["transaction_end"], true);
    assert_eq!(third["changes"][0]["entity_type"], "project");
    let repeated = reader
        .sync_state(input(json!({"cursor":checkpoint,"limit":1})))
        .unwrap();
    assert_eq!(repeated["changes"], first["changes"]);
    assert_eq!(repeated["complete"], first["complete"]);
    let idle = reader
        .sync_state(input(json!({"cursor":third["checkpoint"]})))
        .unwrap();
    assert_eq!(idle["changes"], json!([]));
    assert_eq!(idle["complete"], true);
}

#[test]
fn checkpoint_from_different_or_restored_history_requires_reset() {
    let dir = TempDir::new().unwrap();
    let mut original = Store::open(dir.path().join("original.db")).unwrap();
    capture(&mut original, "A", json!({}));
    let backup = dir.path().join("backup.db");
    original.backup(&backup).unwrap();
    capture(&mut original, "B", json!({}));
    let old = original.sync_state(SyncState::default()).unwrap()["checkpoint"].clone();
    let mut restored = Store::open(&backup).unwrap();
    assert_eq!(
        restored
            .sync_state(input(json!({"cursor":old})))
            .unwrap_err()
            .code(),
        "reset_required"
    );
    capture(&mut restored, "branch-B", json!({}));
    assert_eq!(
        restored
            .sync_state(input(json!({"cursor":old})))
            .unwrap_err()
            .code(),
        "reset_required"
    );
    let mut foreign = Store::open(dir.path().join("other.db")).unwrap();
    assert_eq!(
        foreign
            .sync_state(input(json!({"cursor":old})))
            .unwrap_err()
            .code(),
        "reset_required"
    );
    assert_eq!(
        restored
            .sync_state(input(json!({"cursor":"bad"})))
            .unwrap_err()
            .code(),
        "reset_required"
    );
}

#[test]
fn concurrent_new_writes_cannot_extend_an_in_progress_change_traversal() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.db");
    let mut store = Store::open(&path).unwrap();
    let empty = store.sync_state(SyncState::default()).unwrap();
    for key in ["A", "B", "C"] {
        capture(&mut store, key, json!({}));
    }
    let first = store
        .sync_state(input(json!({"cursor":empty["checkpoint"],"limit":1})))
        .unwrap();
    let mut writer = Store::open(&path).unwrap();
    let later = capture(&mut writer, "D", json!({}));
    let second = store
        .sync_state(input(json!({"cursor":first["next_cursor"],"limit":1})))
        .unwrap();
    let third = store
        .sync_state(input(json!({"cursor":second["next_cursor"],"limit":1})))
        .unwrap();
    assert_eq!(third["changes"][0]["id"], 3);
    assert!(third["next_cursor"].is_null());
    let after = store
        .sync_state(input(json!({"cursor":third["checkpoint"],"limit":1})))
        .unwrap();
    assert_eq!(after["changes"].as_array().unwrap().len(), 1);
    assert_eq!(after["changes"][0]["id"], later.change.id);
}

#[test]
fn projections_are_explicit_and_preserve_full_originals_on_demand() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let t = capture(
        &mut store,
        "Unicode",
        json!({"notes":"🧭".repeat(10_000),"links":[{"url":"https://example.test/context","label":"Context"}]}),
    );
    let full = projection::record(&t.task, Detail::Full);
    let summary = projection::record(&t.task, Detail::Summary);
    assert_eq!(full["notes"].as_str().unwrap().chars().count(), 10_000);
    assert!(summary.get("notes").is_none());
    assert_eq!(summary["has_notes"], true);
    assert!(
        summary["omitted_fields"]
            .as_array()
            .unwrap()
            .contains(&json!("notes"))
    );
    let bounded = projection::page_record(&t.task, Detail::Full, false);
    assert_eq!(bounded["detail_required"], true);
    assert_eq!(bounded["detail"], "summary");
    let explicit = projection::page_record(&t.task, Detail::Full, true);
    assert_eq!(explicit, full);
    let receipt = projection::mutation(&t);
    assert!(receipt["change"].get("after").is_none());
    assert!(receipt["task"].get("notes").is_none());
    assert_eq!(
        projection::change(&t.change, Detail::Full)["after"]["notes"],
        full["notes"]
    );
}

#[test]
fn migration_preserves_legacy_audit_and_retry_while_indexing_snapshots() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("legacy.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../src/schema.sql")).unwrap();
    db.execute_batch("PRAGMA user_version=2;").unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let task = json!({"id":id,"title":"Legacy done","notes":"Preserve","status":"done","archived":false,"due_date":null,"version":1,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","deleted":false,"last_change_id":1});
    let change = json!({"id":1,"task_id":id,"operation":"capture","reason":"Legacy","before":null,"after":task,"undoes_change_id":null,"created_at":"2026-10-01T00:00:00Z"});
    db.execute(
        "INSERT INTO tasks VALUES(?1,?2)",
        rusqlite::params![id, task.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO changes VALUES(1,?1,?2)",
        rusqlite::params![id, change.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO requests VALUES('old','original','{\"receipt\":\"original-response\"}')",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE tasks SET document=json_set(document,'$.brief','Complete the legacy fixture.')",
        [],
    )
    .unwrap();
    drop(db);
    let mut store = Store::open(&path).unwrap();
    let t = &store.list(input(json!({"task_id":id}))).unwrap().items[0];
    assert_eq!(t.version, 2);
    assert!(t.completed_at.is_none() && t.completion_result.is_none() && t.project_id.is_none());
    let snapshot = store.sync_state(SyncState::default()).unwrap();
    assert_eq!(snapshot["records"][0]["id"], id);
    assert!(snapshot["checkpoint"].is_string());
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT document FROM changes WHERE id=1", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        change.to_string()
    );
    assert_eq!(
        db.query_row("SELECT response FROM requests WHERE id='old'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "{\"receipt\":\"original-response\"}"
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        11
    );
    assert!(
        db.execute("UPDATE changes SET token='tamper' WHERE id=1", [])
            .is_err()
    );
    assert!(db.execute("DELETE FROM revisions", []).is_err());
}

#[test]
fn pre_project_capture_retry_keeps_its_original_receipt_after_migration() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("legacy-retry.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../src/schema.sql")).unwrap();
    db.execute_batch("PRAGMA user_version=2;").unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let task = json!({"id":id,"title":"Legacy done","notes":"Preserve","status":"done","archived":false,"due_date":null,"version":1,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","deleted":false,"last_change_id":1});
    let change = json!({"id":1,"task_id":id,"operation":"capture","reason":"Legacy","before":null,"after":task,"undoes_change_id":null,"created_at":"2026-10-01T00:00:00Z"});
    let receipt = json!({"task":task,"change":change,"replayed":false});
    // This is the pre-project CaptureItem serializer's exact field order.
    let request = r#"["capture_item",{"request_id":"legacy","title":"Legacy done","notes":"Preserve","status":"done","due_date":null,"reason":"Legacy"}]"#;
    db.execute(
        "INSERT INTO tasks VALUES(?1,?2)",
        rusqlite::params![id, task.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO changes VALUES(1,?1,?2)",
        rusqlite::params![id, change.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO requests VALUES('legacy',?1,?2)",
        rusqlite::params![request, receipt.to_string()],
    )
    .unwrap();
    db.execute(
        "UPDATE tasks SET document=json_set(document,'$.brief','Complete the legacy fixture.')",
        [],
    )
    .unwrap();
    drop(db);
    let mut store = Store::open(&path).unwrap();
    let result = store.capture(serde_json::from_value(json!({"request_id":"legacy","title":"Legacy done","notes":"Preserve","status":"done","reason":"Legacy"})).unwrap()).unwrap();
    assert!(result.replayed);
    assert_eq!(result.task.id, id);
    assert!(result.task.completed_at.is_none());
    assert_eq!(
        store.changes(ListChanges::default()).unwrap().changes.len(),
        2
    );
}

#[test]
fn project_input_schemas_reject_unknown_and_output_only_fields() {
    assert!(
        serde_json::from_value::<CreateProject>(
            json!({"request_id":"new","title":"Project","reason":"Synthetic","has_notes":false})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<UpdateProject>(json!({"request_id":"edit","project_id":uuid::Uuid::new_v4().to_string(),"expected_version":1,"reason":"Synthetic","title":"Changed","task_counts":{}})).is_err());
    assert!(serde_json::from_value::<ApplyChanges>(json!({"request_id":"batch","operations":[{"operation":"create_project","title":"Project","reason":"Synthetic","has_notes":false}]})).is_err());
}

#[test]
fn full_record_history_continuation_must_make_progress() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let t = capture(&mut store, "large", json!({"notes":"🧭".repeat(10_000)}));
    let result = store
        .list(input(json!({"task_id":t.task.id,"include_history":true})))
        .unwrap();
    assert!(
        !result.history.is_empty() || result.next_history_after.is_none(),
        "An empty history page must not repeat the same continuation forever: {:?}",
        result.next_history_after
    );
}

#[tokio::test]
async fn serialized_list_budget_includes_the_filter_bound_cursor() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let mut ids = Vec::new();
    for i in 0..50 {
        ids.push(
            capture(
                &mut store,
                &format!("task-{i}"),
                json!({"title":"🧭".repeat(500)}),
            )
            .task
            .id,
        );
    }
    let diagnostics =
        todo_mcp::diagnostics::Diagnostics::open(&dir.path().join("diagnostics.db"), "test")
            .unwrap();
    let app = todo_mcp::application::Application::new(store, diagnostics);
    let result = app
        .execute_ui("list_items", json!({"task_ids":ids,"limit":50}))
        .await
        .unwrap();
    let bytes = serde_json::to_vec(&result).unwrap().len();
    assert!(
        bytes <= projection::PAGE_BYTES,
        "Serialized response is {bytes} bytes, exceeding the {} byte page budget",
        projection::PAGE_BYTES
    );
    assert!(result["next_cursor"].is_string());
}

#[test]
fn serialized_project_budget_includes_counts_and_cursor() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    for i in 0..70 {
        let p=store.create_project(input(json!({"request_id":format!("project-{i}"),"title":"p".repeat(100),"reason":"Synthetic"}))).unwrap();
        for (j, status) in ["next", "planned", "waiting", "inbox", "done", "someday"]
            .iter()
            .enumerate()
        {
            capture(
                &mut store,
                &format!("task-{i}-{j}"),
                json!({"status":status,"project_id":p.task.id}),
            );
        }
    }
    let result = store.projects(input(json!({"limit":100}))).unwrap();
    let bytes = serde_json::to_vec(&result).unwrap().len();
    assert!(
        bytes <= projection::PAGE_BYTES,
        "Serialized project response is {bytes} bytes, exceeding the {} byte page budget",
        projection::PAGE_BYTES
    );
    assert!(result["next_cursor"].is_string());
}

#[test]
fn all_projects_view_includes_lifecycles_and_archive_with_explicit_filter_validation() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let active = project(&mut store, "active");
    for (key, status, archived) in [
        ("someday", "someday", false),
        ("done", "done", false),
        ("archive", "active", true),
    ] {
        store.create_project(input(json!({"request_id":key,"title":key,"status":status,"archived":archived,"reason":"Synthetic project view"}))).unwrap();
    }
    let removed = project(&mut store, "removed");
    store.undo(undo(&removed, "remove-project")).unwrap();
    let defaults = store.projects(ListProjects::default()).unwrap();
    assert_eq!(defaults["projects"].as_array().unwrap().len(), 1);
    assert_eq!(defaults["projects"][0]["id"], active.task.id);
    for (args, count) in [
        (json!({"view":"all"}), 4),
        (json!({"view":"all","archived":false}), 3),
        (json!({"view":"all","archived":true}), 1),
        (json!({"view":"all","include_deleted":true}), 5),
        (json!({"status":"done"}), 1),
        (json!({"status":"someday"}), 1),
    ] {
        let page = store.projects(input(args)).unwrap();
        assert_eq!(page["projects"].as_array().unwrap().len(), count);
    }
    for view in ["all", "active"] {
        assert_eq!(
            store
                .projects(input(json!({"view":view,"status":"done"})))
                .unwrap_err()
                .code(),
            "invalid_input"
        );
    }
    let mut seen = std::collections::HashSet::new();
    let mut cursor = Value::Null;
    loop {
        let page = store
            .projects(input(json!({"view":"all","limit":1,"cursor":cursor})))
            .unwrap();
        for item in page["projects"].as_array().unwrap() {
            assert!(seen.insert(item["id"].as_str().unwrap().to_owned()));
        }
        cursor = page["next_cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(seen.len(), 4);
}

#[test]
fn archived_project_counts_archive_separately_from_workflow_and_excludes_tombstones() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let p = project(&mut store, "project");
    let mut tasks = Vec::new();
    for status in ["next", "planned", "done"] {
        tasks.push(capture(
            &mut store,
            status,
            json!({"status":status,"project_id":p.task.id}),
        ));
    }
    let removed = capture(&mut store, "removed", json!({"project_id":p.task.id}));
    store.undo(undo(&removed, "remove-task")).unwrap();
    let mut operations = vec![
        json!({"operation":"update_project","project_id":p.task.id,"expected_version":1,"archived":true,"reason":"Synthetic archive"}),
    ];
    operations.extend(tasks.iter().map(|t|json!({"operation":"update","task_id":t.task.id,"expected_version":1,"archived":true,"reason":"Synthetic archive"})));
    store
        .apply_changes(input(
            json!({"request_id":"archive-together","operations":operations}),
        ))
        .unwrap();
    let page = store
        .projects(input(json!({"project_id":p.task.id})))
        .unwrap();
    let item = &page["projects"][0];
    assert_eq!(item["task_counts"], json!({"archived":3}));
    assert_eq!(item["needs_next_action"], false);
    let done = &tasks[2].task;
    let archived_done = current(&mut store, done);
    store
        .update(edit(
            &archived_done,
            "reopen-archived",
            json!({"status":"next"}),
        ))
        .unwrap();
    assert_eq!(
        store
            .projects(input(json!({"project_id":p.task.id})))
            .unwrap()["projects"][0]["task_counts"],
        json!({"archived":3})
    );
}

#[test]
fn work_session_summaries_do_not_expose_full_context() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let item = capture(
        &mut store,
        "review-paper",
        json!({"title":"Review the proposal","status":"next","due_date":"2026-10-05","work_sessions":[{"url":"https://calendar.google.com/calendar/event?eid=reserved-research-block","label":"Focused research appointment"}]}),
    );
    capture(&mut store, "unrelated", json!({"title":"Unrelated task"}));
    let diagnostics =
        todo_mcp::diagnostics::Diagnostics::open(&dir.path().join("logs.db"), "test").unwrap();
    let app = todo_mcp::application::Application::new(store, diagnostics);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    // Engine-backed label and URL matching is covered in search_meili.rs.
    let page = runtime
        .block_on(app.execute_ui(
            "list_items",
            json!({"due_from":"2026-10-04","due_through":"2026-10-06"}),
        ))
        .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["id"], item.task.id);
    assert_eq!(page["items"][0]["work_session_count"], 1);
    assert!(page["items"][0].get("work_sessions").is_none());
}

#[test]
fn public_task_schemas_offer_only_task_states_and_project_schemas_keep_active() {
    fn values(node: &Value, root: &Value) -> std::collections::HashSet<String> {
        if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
            return values(
                root.pointer(reference.strip_prefix('#').unwrap()).unwrap(),
                root,
            );
        }
        let mut result = std::collections::HashSet::new();
        if let Some(items) = node.get("enum").and_then(Value::as_array) {
            result.extend(items.iter().filter_map(Value::as_str).map(str::to_owned));
        }
        for key in ["anyOf", "oneOf", "allOf"] {
            if let Some(items) = node.get(key).and_then(Value::as_array) {
                for item in items {
                    result.extend(values(item, root));
                }
            }
        }
        result
    }
    let tools = todo_mcp::server::tools();
    for name in ["capture_item", "update_item", "list_items", "show_tasks"] {
        let tool = tools
            .iter()
            .map(|t| serde_json::to_value(t).unwrap())
            .find(|t| t["name"] == name)
            .unwrap();
        let schema = &tool["inputSchema"];
        let states = values(&schema["properties"]["status"], schema);
        assert!(
            !states.contains("active"),
            "{name} advertises a project-only state"
        );
        for expected in [
            "inbox", "next", "waiting", "blocked", "someday", "done", "archived",
        ] {
            assert!(states.contains(expected), "{name} is missing {expected}");
        }
    }
    for name in [
        "create_project",
        "update_project",
        "list_projects",
        "show_projects",
    ] {
        let tool = tools
            .iter()
            .map(|t| serde_json::to_value(t).unwrap())
            .find(|t| t["name"] == name)
            .unwrap();
        let schema = &tool["inputSchema"];
        let states = values(&schema["properties"]["status"], schema);
        assert_eq!(
            states,
            ["active", "someday", "done"]
                .into_iter()
                .map(str::to_owned)
                .collect::<std::collections::HashSet<_>>()
        );
    }
    fn batch_task_states(
        node: &Value,
        root: &Value,
        found: &mut Vec<std::collections::HashSet<String>>,
    ) {
        if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
            batch_task_states(
                root.pointer(reference.strip_prefix('#').unwrap()).unwrap(),
                root,
                found,
            );
            return;
        }
        let tag = &node["properties"]["operation"];
        let name = tag.get("const").and_then(Value::as_str).or_else(|| {
            tag.get("enum")
                .and_then(Value::as_array)
                .and_then(|v| v.first())
                .and_then(Value::as_str)
        });
        if matches!(name, Some("capture" | "update")) {
            found.push(values(&node["properties"]["status"], root));
        }
        for key in ["oneOf", "anyOf", "allOf"] {
            if let Some(items) = node.get(key).and_then(Value::as_array) {
                for item in items {
                    batch_task_states(item, root, found);
                }
            }
        }
    }
    let bulk = tools
        .iter()
        .map(|t| serde_json::to_value(t).unwrap())
        .find(|t| t["name"] == "apply_changes")
        .unwrap();
    let schema = &bulk["inputSchema"];
    let mut variants = Vec::new();
    batch_task_states(
        &schema["properties"]["operations"]["items"],
        schema,
        &mut variants,
    );
    assert_eq!(variants.len(), 2);
    for states in variants {
        assert!(states.contains("blocked") && !states.contains("active"));
    }
}
