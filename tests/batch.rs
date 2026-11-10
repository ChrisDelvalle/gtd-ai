mod support;
use serde_json::{Value, json};
use std::sync::{Arc, Barrier};
use tempfile::TempDir;
use todo_mcp::{model::*, store::Store};

fn batch(key: &str, operations: Value) -> ApplyChanges {
    support::input(json!({"request_id":key,"operations":operations}))
}
fn capture(title: &str) -> Value {
    json!({"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":title,"reason":"Synthetic batch capture"})
}
fn edit(task: &Task, status: &str) -> Value {
    json!({"operation":"update","task_id":task.id,"expected_version":task.version,"status":status,"reason":"Synthetic batch edit"})
}
fn undo(result: &MutationResult) -> Value {
    json!({"operation":"undo","change_id":result.change.id,"expected_version":result.task.version,"reason":"Synthetic batch undo"})
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
fn mixed_batch_retry_restart_undo_redo_and_key_namespace() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.db");
    let mut store = Store::open(&path).unwrap().with_origin("mcp");
    let seed = store
        .apply_changes(batch("seed", json!([capture("A"), capture("B")])))
        .unwrap();
    let args = batch(
        "mixed",
        json!([
            edit(&seed.results[0].task, "done"),
            undo(&seed.results[1]),
            capture("C")
        ]),
    );
    let result = store.apply_changes(args.clone()).unwrap();
    assert_eq!(result.results.len(), 3);
    assert_eq!(result.results[0].task.status, Status::Done);
    assert!(result.results[1].task.deleted);
    assert_eq!(result.results[2].task.title, "C");
    assert!(result.results.iter().all(|r| r.change.origin == "mcp"));
    assert_eq!(store.list(all()).unwrap().history.len(), 5);
    drop(store);
    let mut store = Store::open(&path).unwrap().with_origin("mcp");
    let replay = store.apply_changes(args).unwrap();
    assert!(replay.replayed && replay.results.iter().all(|r| r.replayed));
    assert_eq!(
        replay
            .results
            .iter()
            .map(|r| r.task.clone())
            .collect::<Vec<_>>(),
        result
            .results
            .iter()
            .map(|r| r.task.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(store.list(all()).unwrap().history.len(), 5);
    let reversed = store
        .apply_changes(batch(
            "undo",
            Value::Array(result.results.iter().map(undo).collect()),
        ))
        .unwrap();
    assert_eq!(reversed.results[0].task.status, Status::Inbox);
    assert!(!reversed.results[1].task.deleted);
    assert!(reversed.results[2].task.deleted);
    let redone = store
        .apply_changes(batch(
            "redo",
            Value::Array(reversed.results.iter().map(undo).collect()),
        ))
        .unwrap();
    assert_eq!(redone.results[0].task.version, 4);
    assert_eq!(redone.results[0].task.status, Status::Done);
    assert_eq!(
        store
            .apply_changes(batch("mixed", json!([capture("different")])))
            .unwrap_err()
            .code(),
        "request_id_conflict"
    );
    let single: CaptureItem = serde_json::from_value(
        json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"mixed","title":"collision","reason":"test"}),
    )
    .unwrap();
    assert_eq!(
        store.capture(single).unwrap_err().code(),
        "request_id_conflict"
    );
    let single: CaptureItem = serde_json::from_value(
        json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"single","title":"single","reason":"test"}),
    )
    .unwrap();
    store.capture(single).unwrap();
    assert_eq!(
        store
            .apply_changes(batch("single", json!([capture("collision")])))
            .unwrap_err()
            .code(),
        "request_id_conflict"
    );
}

#[test]
fn failed_batches_roll_back_tasks_history_and_retry_records() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.db");
    let mut store = Store::open(&path).unwrap();
    let seed = store
        .apply_changes(batch("seed", json!([capture("A"), capture("B")])))
        .unwrap();
    let a = &seed.results[0].task;
    let b = &seed.results[1].task;
    let before = store.list(all()).unwrap();
    let mut stale = edit(b, "done");
    stale["expected_version"] = 99.into();
    let error = store
        .apply_changes(batch(
            "retry-after-rejection",
            json!([edit(a, "done"), stale]),
        ))
        .unwrap_err();
    assert_eq!(error.code(), "conflict");
    assert!(error.to_string().contains("Bulk change 2 failed"));
    let after = store.list(all()).unwrap();
    assert_eq!(after.items, before.items);
    assert_eq!(after.history.len(), 2);
    let mut duplicate = edit(a, "waiting");
    duplicate["expected_version"] = 2.into();
    let cases = [
        json!([edit(a, "done"), duplicate]),
        json!([capture("C"), capture("")]),
        json!([edit(a, "done"), edit(b, "inbox")]),
    ];
    for (i, ops) in cases.into_iter().enumerate() {
        assert!(
            store
                .apply_changes(batch(&format!("failed-{i}"), ops))
                .is_err()
        );
        assert_eq!(store.list(all()).unwrap().items, before.items);
        assert_eq!(store.list(all()).unwrap().history.len(), 2);
    }
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_second BEFORE INSERT ON changes WHEN NEW.id=4 BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    let args = batch(
        "retry-after-rejection",
        json!([edit(a, "done"), edit(b, "done")]),
    );
    assert_eq!(
        store.apply_changes(args.clone()).unwrap_err().code(),
        "storage_error"
    );
    assert_eq!(store.list(all()).unwrap().items, before.items);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM requests", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    conn.execute_batch("DROP TRIGGER fail_second;").unwrap();
    assert!(!store.apply_changes(args).unwrap().replayed);
    assert_eq!(store.list(all()).unwrap().history.len(), 4);
}

#[test]
fn simultaneous_batches_never_duplicate_or_partially_overwrite() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.db");
    let barrier = Arc::new(Barrier::new(2));
    let mut stores = vec![Store::open(&path).unwrap(), Store::open(&path).unwrap()];
    let mut handles = Vec::new();
    for mut store in stores.drain(..) {
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            store
                .apply_changes(batch("same-key", json!([capture("A"), capture("B")])))
                .unwrap()
        }));
    }
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.replayed).count(), 1);
    let tasks = results[0]
        .results
        .iter()
        .map(|r| r.task.clone())
        .collect::<Vec<_>>();
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for (i, status) in ["done", "waiting"].into_iter().enumerate() {
        let mut store = Store::open(&path).unwrap();
        let barrier = barrier.clone();
        let tasks = tasks.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            store.apply_changes(batch(
                &format!("race-{i}"),
                json!([edit(&tasks[0], status), edit(&tasks[1], status)]),
            ))
        }));
    }
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let state = Store::open(&path).unwrap().list(all()).unwrap();
    assert_eq!(state.items.len(), 2);
    assert_eq!(state.history.len(), 4);
    assert!(
        state
            .items
            .iter()
            .all(|t| t.version == 2 && t.status == state.items[0].status)
    );
}

#[test]
fn selected_ids_remain_bounded_paginated_and_never_widen_an_empty_selection() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let result = store
        .apply_changes(batch(
            "seed",
            json!([capture("A"), capture("B"), capture("C")]),
        ))
        .unwrap();
    let ids: Vec<_> = result
        .results
        .iter()
        .take(2)
        .map(|r| r.task.id.clone())
        .collect();
    let first = store
        .list(ListItems {
            task_ids: Some(ids.clone()),
            limit: Some(1),
            include_history: true,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.history.len(), 1);
    assert_eq!(first.next_offset, Some(1));
    let second = store
        .list(ListItems {
            task_ids: Some(ids.clone()),
            offset: 1,
            limit: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(second.items[0].id, ids[1]);
    assert_eq!(second.next_offset, None);
    for bad in [vec![], vec![ids[0].clone(); 2], vec!["invalid".into()]] {
        assert!(
            store
                .list(ListItems {
                    task_ids: Some(bad),
                    ..Default::default()
                })
                .is_err()
        );
    }
    assert!(
        store
            .list(ListItems {
                task_id: Some(ids[0].clone()),
                task_ids: Some(ids),
                ..Default::default()
            })
            .is_err()
    );
    assert!(store.apply_changes(batch("empty", json!([]))).is_err());
    assert!(
        store
            .apply_changes(batch("large", json!(vec![capture("too many"); 51])))
            .is_err()
    );
    let max = store
        .apply_changes(batch("max", json!(vec![capture("bounded"); 50])))
        .unwrap();
    assert_eq!(max.results.len(), 50);
    let huge = json!({"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"big","notes":"x".repeat(10000),"reason":"test"});
    assert!(
        store
            .apply_changes(batch("bytes", json!(vec![huge; 14])))
            .is_err()
    );
    let first = store.list(all()).unwrap();
    assert!(!first.history.is_empty() && first.history.len() <= 50);
    assert!(first.next_history_after.is_some());
    let mut before_id = None;
    let mut ids = std::collections::HashSet::new();
    loop {
        let page = store
            .changes(ListChanges {
                before_id,
                ..Default::default()
            })
            .unwrap();
        assert!(page.changes.len() <= 20);
        for change in page.changes {
            assert!(ids.insert(change.id));
        }
        match page.next_before_id {
            Some(next) => before_id = Some(next),
            None => break,
        }
    }
    assert_eq!(ids.len(), 53); // Three initial captures plus the successful 50-operation batch.
}
