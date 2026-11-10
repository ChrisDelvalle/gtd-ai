use std::sync::{Arc, Barrier};

use tempfile::TempDir;
use todo_mcp::{
    model::*,
    store::{Store, StoreError},
};

fn capture(key: &str) -> CaptureItem {
    CaptureItem {
        blocked_by: None,
        planning: todo_mcp::planning::PlanningPatch {
            importance: Some(todo_mcp::planning::Importance::Normal),
            estimated_minutes: Some(30),
            effort: Some(todo_mcp::task_planning::Effort::Medium),
            ..Default::default()
        },
        project_id: None,
        review_date: None,
        work_sessions: vec![],
        completion_result: None,
        request_id: key.into(),
        title: "[PILOT] Water the imaginary plant".into(),
        notes: "Synthetic task".into(),
        brief: Some("Water the imaginary plant.".into()),
        agent_notes: None,
        links: vec![],
        location: None,
        status: Status::Inbox,
        archived: None,
        due_date: Some("2026-10-03".into()),
        reason: "Synthetic test fixture".into(),
    }
}

fn update(task: &Task, key: &str) -> UpdateItem {
    UpdateItem {
        blocked_by: None,
        planning: Default::default(),
        project_id: None,
        clear_project: false,
        review_date: None,
        clear_review_date: false,
        work_sessions: None,
        completion_result: None,
        request_id: key.into(),
        task_id: task.id.clone(),
        expected_version: task.version,
        title: None,
        notes: None,
        brief: None,
        agent_notes: None,
        links: None,
        location: None,
        status: Some(Status::Done),
        archived: None,
        due_date: None,
        clear_due_date: false,
        reason: "Agent inference: synthetic completion test".into(),
    }
}

fn undo(change: &MutationResult, key: &str) -> UndoChange {
    UndoChange {
        request_id: key.into(),
        change_id: change.change.id,
        expected_version: change.task.version,
        reason: "Reverse synthetic test".into(),
    }
}

fn all() -> ListItems {
    ListItems {
        view: Some(TaskView::All),
        limit: Some(100),
        include_deleted: true,
        include_history: true,
        ..Default::default()
    }
}

#[test]
fn persistence_retries_conflicts_and_audit_survive_restart() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("todo.db");
    let captured = Store::open(&path)
        .unwrap()
        .capture(capture("capture-1"))
        .unwrap();
    let mut store = Store::open(&path).unwrap();
    let replay = store.capture(capture("capture-1")).unwrap();
    assert!(replay.replayed);
    assert_eq!(captured.task, replay.task);
    let edited = store.update(update(&captured.task, "edit-1")).unwrap();
    assert_eq!(edited.task.version, 2);
    let mut restarted = Store::open(&path).unwrap();
    assert!(
        restarted
            .update(update(&captured.task, "edit-1"))
            .unwrap()
            .replayed
    );
    assert!(matches!(
        restarted.update(update(&captured.task, "stale")),
        Err(StoreError::Conflict(_))
    ));
    let mut wrong = capture("capture-1");
    wrong.title = "Different intent".into();
    assert!(matches!(
        restarted.capture(wrong),
        Err(StoreError::RetryKeyConflict)
    ));
    let mut wrong_tool = update(&edited.task, "capture-1");
    wrong_tool.status = Some(Status::Waiting);
    assert!(matches!(
        restarted.update(wrong_tool),
        Err(StoreError::RetryKeyConflict)
    ));
    let state = restarted.list(all()).unwrap();
    assert_eq!(state.items.len(), 1);
    assert_eq!(state.history.len(), 2);
    assert_eq!(state.history[1].before.as_ref().unwrap(), &captured.task);
    assert_eq!(state.history[1].after, edited.task);
    assert!(state.history[1].reason.starts_with("Agent inference"));
}

#[test]
fn undo_restores_values_and_redo_preserves_monotonic_versions() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("todo.db")).unwrap();
    let first = store.capture(capture("first")).unwrap();
    let mut change = update(&first.task, "edit");
    change.title = Some("Changed title".into());
    change.notes = Some("".into());
    change.clear_due_date = true;
    let edited = store.update(change).unwrap();
    assert_eq!(edited.task.due_date, None);
    assert!(matches!(
        store.undo(UndoChange {
            expected_version: edited.task.version,
            ..undo(&first, "old")
        }),
        Err(StoreError::Conflict(_))
    ));
    let restored = store.undo(undo(&edited, "undo")).unwrap();
    assert_eq!(restored.task.version, 3);
    assert_eq!(restored.task.title, first.task.title);
    assert_eq!(restored.task.notes, first.task.notes);
    assert_eq!(restored.task.due_date, first.task.due_date);
    assert_eq!(restored.task.status, Status::Inbox);
    assert!(store.undo(undo(&edited, "undo")).unwrap().replayed);
    let redone = store.undo(undo(&restored, "redo")).unwrap();
    assert_eq!(redone.task.version, 4);
    assert_eq!(redone.task.status, Status::Done);
    assert_eq!(redone.task.due_date, None);
    assert_eq!(store.list(all()).unwrap().history.len(), 4);
}

#[test]
fn undo_capture_hides_it_and_can_be_reversed() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("todo.db")).unwrap();
    let first = store.capture(capture("first")).unwrap();
    let hidden = store.undo(undo(&first, "hide")).unwrap();
    assert!(hidden.task.deleted);
    assert!(store.list(ListItems::default()).unwrap().items.is_empty());
    assert!(matches!(
        store.update(update(&hidden.task, "hidden-update")),
        Err(StoreError::Conflict(_))
    ));
    assert!(store.capture(capture("first")).unwrap().replayed);
    let restored = store.undo(undo(&hidden, "restore")).unwrap();
    assert!(!restored.task.deleted);
    assert_eq!(restored.task.version, 3);
    assert_eq!(store.list(all()).unwrap().history.len(), 3);
}

#[test]
fn simultaneous_writers_cannot_lose_updates_or_duplicate_capture() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("todo.db");
    let first = Store::open(&path)
        .unwrap()
        .capture(capture("first"))
        .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|i| {
            let path = path.clone();
            let barrier = barrier.clone();
            let task = first.task.clone();
            std::thread::spawn(move || {
                let mut store = Store::open(path).unwrap();
                barrier.wait();
                store.update(update(&task, &format!("writer-{i}")))
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(StoreError::Conflict(_))))
            .count(),
        1
    );
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut store = Store::open(path).unwrap();
                barrier.wait();
                store.capture(capture("same-intent")).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results[0].task.id, results[1].task.id);
    assert_ne!(results[0].replayed, results[1].replayed);
    assert_eq!(
        Store::open(path)
            .unwrap()
            .list(all())
            .unwrap()
            .history
            .len(),
        3
    );
}

#[test]
fn invalid_inputs_and_noop_writes_leave_no_audit_or_retry_record() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("todo.db")).unwrap();
    for date in [
        "2026-02-30",
        "2026-2-02",
        "tomorrow",
        "2026-10-03T00:00:00Z",
    ] {
        let mut item = capture("invalid");
        item.due_date = Some(date.into());
        assert!(matches!(store.capture(item), Err(StoreError::Invalid(_))));
    }
    let mut empty = capture("invalid");
    empty.title = "   ".into();
    assert!(store.capture(empty).is_err());
    let mut reason = capture("invalid");
    reason.reason = "".into();
    assert!(store.capture(reason).is_err());
    let mut key = capture("not a valid key");
    key.reason = "Valid".into();
    assert!(store.capture(key).is_err());
    let first = store.capture(capture("invalid")).unwrap();
    let mut edit = update(&first.task, "update");
    edit.status = Some(Status::Inbox);
    assert!(store.update(edit.clone()).is_err());
    edit.status = Some(Status::Next);
    edit.clear_due_date = true;
    edit.due_date = Some("2026-11-01".into());
    assert!(store.update(edit.clone()).is_err());
    edit.clear_due_date = false;
    assert!(store.update(edit).is_ok());
    assert_eq!(store.list(all()).unwrap().history.len(), 2);
    assert!(
        store
            .list(ListItems {
                limit: Some(0),
                ..Default::default()
            })
            .is_err()
    );
}

#[test]
fn list_rejects_punctuation_search_and_preserves_history_pagination() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("todo.db")).unwrap();
    let mut special = capture("special");
    special.title = "100%_literal".into();
    let first = store.capture(special).unwrap();
    for i in 0..3 {
        store.capture(capture(&format!("item-{i}"))).unwrap();
    }
    assert_eq!(
        store
            .list(ListItems {
                query: Some("%_".into()),
                ..Default::default()
            })
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    let page = store
        .list(ListItems {
            limit: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.next_offset, Some(2));
    let page2 = store
        .list(ListItems {
            limit: Some(2),
            offset: 2,
            ..Default::default()
        })
        .unwrap();
    assert!(page2.next_offset.is_none());
    assert_ne!(page.items[0].id, page2.items[0].id);
    let edited = store.update(update(&first.task, "edit")).unwrap();
    store.undo(undo(&edited, "undo")).unwrap();
    let mut query = ListItems {
        task_id: Some(first.task.id),
        include_history: true,
        history_limit: Some(2),
        ..Default::default()
    };
    let page = store.list(query.clone()).unwrap();
    assert_eq!(page.history.len(), 2);
    query.history_after = page.next_history_after.unwrap();
    let next = store.list(query).unwrap();
    assert_eq!(next.history.len(), 1);
    assert_eq!(next.history[0].operation, "undo");
    assert!(next.next_history_after.is_none());
}

#[test]
fn failed_transaction_rolls_back_task_audit_and_retry_key() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("todo.db");
    let mut store = Store::open(&path).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_audit BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
    assert!(store.capture(capture("atomic")).is_err());
    assert!(store.list(all()).unwrap().items.is_empty());
    conn.execute_batch("DROP TRIGGER reject_audit;").unwrap();
    assert!(!store.capture(capture("atomic")).unwrap().replayed);
    assert!(conn.execute("DELETE FROM changes", []).is_err());
    assert!(
        conn.execute("UPDATE changes SET document = '{}'", [])
            .is_err()
    );
}

#[test]
fn backup_is_consistent_and_refuses_existing_destinations() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("todo.db")).unwrap();
    store.capture(capture("first")).unwrap();
    let backup = dir.path().join("backup.db");
    store.backup(&backup).unwrap();
    store.capture(capture("second")).unwrap();
    let state = Store::open(&backup).unwrap().list(all()).unwrap();
    assert_eq!(state.items.len(), 1);
    assert_eq!(state.history.len(), 1);
    assert!(store.backup(&backup).is_err());
}

#[test]
fn incremental_backup_finishes_while_another_connection_keeps_writing() {
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    };
    use std::{thread, time::Duration};
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("source.db");
    let backup = dir.path().join("backup.db");
    let store = Store::open(&path).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE backup_fixture(payload BLOB); INSERT INTO backup_fixture VALUES(zeroblob(8388608)); INSERT INTO search_state(key,value) VALUES('backup-fixture','0');").unwrap();
    drop(conn);
    let stop = Arc::new(AtomicBool::new(false));
    let writes = Arc::new(AtomicU64::new(0));
    let (ready_tx, ready_rx) = mpsc::channel();
    let writer = {
        let stop = stop.clone();
        let writes = writes.clone();
        thread::spawn(move || {
            let conn = rusqlite::Connection::open(path).unwrap();
            conn.busy_timeout(Duration::from_secs(2)).unwrap();
            ready_tx.send(()).unwrap();
            while !stop.load(Ordering::Relaxed) {
                conn.execute("UPDATE search_state SET value=CAST(value AS INTEGER)+1 WHERE key='backup-fixture'", []).unwrap();
                writes.fetch_add(1, Ordering::Relaxed);
                thread::sleep(Duration::from_millis(2));
            }
        })
    };
    ready_rx.recv().unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let copy = backup.clone();
    let worker = thread::spawn(move || done_tx.send(store.backup(copy)).unwrap());
    let completed = done_rx.recv_timeout(Duration::from_secs(5));
    // Release the writer even on regression, so the failed test does not leave
    // an unbounded background copy or tear down its files while it is running.
    stop.store(true, Ordering::Relaxed);
    writer.join().unwrap();
    worker.join().unwrap();
    completed
        .expect("backup must finish without waiting for writers to stop")
        .unwrap();
    assert!(writes.load(Ordering::Relaxed) > 1);
    let copy = rusqlite::Connection::open(backup).unwrap();
    assert_eq!(
        copy.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        copy.query_row("SELECT length(payload) FROM backup_fixture", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        8_388_608
    );
}

#[test]
fn due_filters_global_history_and_legacy_origin() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("todo.db");
    let mut store = Store::open(&path).unwrap().with_origin("website");
    let first = store.capture(capture("dated")).unwrap();
    let mut undated = capture("undated");
    undated.due_date = None;
    store.capture(undated).unwrap();
    assert_eq!(
        store
            .list(ListItems {
                due_through: Some("2026-10-03".into()),
                ..Default::default()
            })
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(
        store
            .list(ListItems {
                undated: true,
                ..Default::default()
            })
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(
        store
            .list(ListItems {
                undated: true,
                due_from: Some("2026-10-01".into()),
                ..Default::default()
            })
            .is_err()
    );
    let page = store
        .changes(ListChanges {
            limit: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.changes[0].origin, "website");
    let second = store
        .changes(ListChanges {
            before_id: page.next_before_id,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(second.changes[0].id, first.change.id);
    let mut legacy = serde_json::to_value(first.change).unwrap();
    legacy.as_object_mut().unwrap().remove("origin");
    assert_eq!(
        serde_json::from_value::<Change>(legacy).unwrap().origin,
        "unknown"
    );
}
