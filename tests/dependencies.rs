mod support;
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{model::*, store::Store};
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> T {
    support::input(v)
}
fn capture(s: &mut Store, key: &str, status: &str, deps: Vec<String>) -> Task {
    s.capture(decode(json!({"request_id":key,"title":key,"estimated_minutes":30,"effort":"medium","importance":"normal","status":status,"blocked_by":deps,"reason":"Disposable dependency fixture"}))).unwrap().task
}
fn get(s: &mut Store, id: &str) -> Task {
    s.list(decode(json!({"task_id":id,"include_deleted":true})))
        .unwrap()
        .items
        .remove(0)
}
fn edit(s: &mut Store, t: &Task, key: &str, patch: Value) -> MutationResult {
    let mut v = json!({"task_id":t.id,"expected_version":t.version,"request_id":key,"reason":"Fixture edit"});
    v.as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    s.update(decode(v)).unwrap()
}
fn undo(s: &mut Store, r: &MutationResult, key: &str) -> MutationResult {
    s.undo(decode(json!({"request_id":key,"change_id":r.change.id,"expected_version":r.task.version,"reason":"Undo fixture"}))).unwrap()
}
#[test]
fn readiness_manual_holds_grouped_undo_and_actual_progress() {
    let d = TempDir::new().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    let a = capture(&mut s, "a", "next", vec![]);
    let b = capture(&mut s, "b", "next", vec![a.id.clone()]);
    assert_eq!(b.status, Status::Blocked);
    assert!(!b.manual_block);
    assert_eq!(b.version, 1);
    let b = edit(&mut s, &b, "description", json!({"notes":"Human context"})).task;
    assert!(!b.manual_block);
    assert_eq!(b.status, Status::Blocked);
    let complete = edit(&mut s, &a, "complete-a", json!({"status":"done"}));
    let ready = get(&mut s, &b.id);
    assert_eq!(ready.status, Status::Next);
    assert_eq!(ready.version, b.version + 1);
    let reverted = undo(&mut s, &complete, "undo-a");
    assert_eq!(get(&mut s, &b.id).status, Status::Blocked);
    undo(&mut s, &reverted, "redo-a");
    assert_eq!(get(&mut s, &b.id).status, Status::Next);
    let current = get(&mut s, &a.id);
    edit(&mut s, &current, "reopen-a", json!({"status":"next"}));
    let current = get(&mut s, &b.id);
    let held = edit(&mut s, &current, "hold-b", json!({"status":"blocked"})).task;
    assert!(held.manual_block);
    let current = get(&mut s, &a.id);
    edit(&mut s, &current, "finish-a", json!({"status":"done"}));
    assert_eq!(get(&mut s, &b.id).status, Status::Blocked);
    let current = get(&mut s, &b.id);
    let released = edit(&mut s, &current, "release-b", json!({"status":"next"})).task;
    assert_eq!(released.status, Status::Next);
    assert!(!released.manual_block);
    let current = get(&mut s, &a.id);
    edit(&mut s, &current, "again-a", json!({"status":"next"}));
    let current = get(&mut s, &b.id);
    let started = edit(&mut s, &current, "start-b", json!({"started":true})).task;
    assert_eq!(started.status, Status::Blocked);
    let done = edit(&mut s, &started, "done-b", json!({"status":"done"})).task;
    assert_eq!(done.blocked_by, vec![a.id.clone()]);
    assert_eq!(get(&mut s, &a.id).status, Status::Next);
}
#[test]
fn multiple_prerequisites_held_states_cycles_and_protected_targets() {
    let d = TempDir::new().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    let a = capture(&mut s, "a", "next", vec![]);
    let b = capture(&mut s, "b", "next", vec![]);
    let c = capture(&mut s, "c", "next", vec![a.id.clone(), b.id.clone()]);
    let a = edit(&mut s, &a, "archive", json!({"archived":true})).task;
    assert_eq!(get(&mut s, &c.id).unresolved_blocker_ids.len(), 2);
    let a = edit(&mut s, &a, "done", json!({"status":"done"})).task;
    assert_eq!(
        get(&mut s, &c.id).unresolved_blocker_ids,
        vec![b.id.clone()]
    );
    for state in ["waiting", "inbox", "someday"] {
        let t = capture(&mut s, state, state, vec![b.id.clone()]);
        assert_eq!(serde_json::to_value(t.status).unwrap(), json!(state));
    }
    let b = edit(&mut s, &b, "done-b", json!({"status":"done"})).task;
    assert_eq!(get(&mut s, &c.id).status, Status::Next);
    assert!(s.update(decode(json!({"request_id":"cycle","task_id":a.id,"expected_version":a.version,"blocked_by":[c.id],"reason":"Cycle"}))).is_err());
    assert!(s.update(decode(json!({"request_id":"self","task_id":b.id,"expected_version":b.version,"blocked_by":[b.id],"reason":"Self"}))).is_err());
    let x = s
        .capture(decode(
            json!({"request_id":"x","title":"x","estimated_minutes":30,"effort":"medium","importance":"normal","reason":"Fixture"}),
        ))
        .unwrap();
    capture(&mut s, "dependent", "next", vec![x.task.id.clone()]);
    assert!(s.undo(decode(json!({"request_id":"delete-x","change_id":x.change.id,"expected_version":1,"reason":"Still referenced"}))).is_err());
}
#[test]
fn batches_settle_final_state_once_preserve_independent_undo_and_retries() {
    let d = TempDir::new().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    let a = capture(&mut s, "a", "next", vec![]);
    let b = capture(&mut s, "b", "next", vec![a.id.clone()]);
    let unrelated = capture(&mut s, "u", "next", vec![]);
    let args = json!({"request_id":"batch","operations":[{"operation":"update","task_id":a.id,"expected_version":1,"status":"done","reason":"Complete"},{"operation":"update","task_id":b.id,"expected_version":1,"notes":"Edited at the same time","reason":"Edit"},{"operation":"update","task_id":unrelated.id,"expected_version":1,"notes":"Independent","reason":"Edit"}]});
    let batch = s.apply_changes(decode(args.clone())).unwrap();
    assert_eq!(batch.results[1].task.status, Status::Next);
    assert_eq!(batch.results[1].task.version, 2);
    assert!(s.apply_changes(decode(args)).unwrap().replayed);
    undo(&mut s, &batch.results[2], "undo-independent");
    assert_eq!(get(&mut s, &b.id).status, Status::Next);
    undo(&mut s, &batch.results[0], "undo-group");
    assert_eq!(get(&mut s, &b.id).notes, "");
    assert_eq!(get(&mut s, &b.id).status, Status::Blocked);
    let a = get(&mut s, &a.id);
    let complete = edit(&mut s, &a, "complete2", json!({"status":"done"}));
    let b = get(&mut s, &b.id);
    edit(&mut s, &b, "later", json!({"notes":"Subsequent edit"}));
    assert!(s.undo(decode(json!({"request_id":"conflict","change_id":complete.change.id,"expected_version":complete.task.version,"reason":"Conflict"}))).is_err());
}
#[test]
fn inherited_priority_freezes_entire_graph_for_pagination_and_stops_at_holds() {
    let d = TempDir::new().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    let a = capture(&mut s, "prerequisite", "next", vec![]);
    let a = edit(
        &mut s,
        &a,
        "low",
        json!({"estimated_minutes":30,"effort":"medium","importance":"unimportant"}),
    )
    .task;
    let mid = capture(&mut s, "middle", "next", vec![a.id.clone()]);
    let target = capture(&mut s, "urgent", "next", vec![mid.id.clone()]);
    let target = edit(
        &mut s,
        &target,
        "critical",
        json!({"estimated_minutes":30,"effort":"medium","importance":"critical","due_date":"2020-01-01"}),
    )
    .task;
    let other = capture(&mut s, "other", "next", vec![]);
    let other = edit(
        &mut s,
        &other,
        "high",
        json!({"estimated_minutes":30,"effort":"medium","importance":"very_high"}),
    )
    .task;
    let list = s.list(decode(json!({"status":"next","limit":1}))).unwrap();
    assert_eq!(list.items[0].id, a.id);
    assert_eq!(
        list.items[0]
            .recommendation
            .as_ref()
            .unwrap()
            .source_task_id,
        Some(target.id.clone())
    );
    assert_eq!(list.items[0].planning.importance, a.planning.importance);
    let target = edit(&mut s, &target, "shelve", json!({"status":"someday"})).task;
    let page = s
        .list(decode(
            json!({"status":"next","limit":1,"cursor":list.next_cursor}),
        ))
        .unwrap();
    assert_eq!(page.items[0].id, other.id);
    assert_eq!(page.evaluated_at, list.evaluated_at);
    let fresh = s.list(decode(json!({"status":"next"}))).unwrap();
    assert_eq!(fresh.items[0].id, other.id);
    let reverse = s
        .list(decode(json!({"view":"all","blocked_by_id":mid.id})))
        .unwrap();
    assert_eq!(reverse.items[0].id, target.id);
}
#[test]
fn final_batch_graph_allows_edge_reversal_without_transient_cycle() {
    let d = TempDir::new().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    let a = capture(&mut s, "a", "next", vec![]);
    let b = capture(&mut s, "b", "next", vec![a.id.clone()]);
    let r=s.apply_changes(decode(json!({"request_id":"reverse","operations":[{"operation":"update","task_id":a.id,"expected_version":1,"blocked_by":[b.id],"reason":"Reverse edge"},{"operation":"update","task_id":b.id,"expected_version":1,"blocked_by":[],"reason":"Reverse edge"}]}))).unwrap();
    assert_eq!(r.results[0].task.status, Status::Blocked);
    assert_eq!(r.results[1].task.status, Status::Next);
}
#[test]
fn recurrence_defaults_preserve_specific_links_and_skipping_does_not_complete() {
    let d = TempDir::new().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    let series=s.create_recurrence(decode(json!({"request_id":"series","template":{"title":"Daily","estimated_minutes":30,"effort":"medium","importance":"normal","status":"next"},"rule":{"start_date":"2090-01-01","frequency":"daily","count":2},"reason":"Fixture"}))).unwrap();
    s.materialize_recurrences("2090-01-02").unwrap();
    let occurrences = s.list(decode(json!({"view":"all"}))).unwrap().items;
    let prerequisite = &occurrences[0];
    let target = capture(&mut s, "dependent", "next", vec![prerequisite.id.clone()]);
    let blocker = capture(&mut s, "ordinary", "next", vec![]);
    let specific = edit(
        &mut s,
        &occurrences[1],
        "specific-link",
        json!({"blocked_by":[blocker.id]}),
    )
    .task;
    let changed=s.update_recurrence(decode(json!({"request_id":"defaults","series_id":series.task.id,"expected_version":series.task.version,"scope":"all","action":"edit","template":{"title":"New title","status":"next"},"reason":"Edit defaults"}))).unwrap();
    assert_eq!(get(&mut s, &specific.id).blocked_by, vec![blocker.id]);
    assert_eq!(get(&mut s, &specific.id).status, Status::Blocked);
    let current = get(&mut s, &prerequisite.id);
    let skipped=s.update_recurrence(decode(json!({"request_id":"skip","series_id":series.task.id,"expected_version":changed.task.version,"scope":"this","action":"skip","original_date":current.occurrence.unwrap().original_date,"expected_occurrence_version":current.version,"reason":"Skip"}))).unwrap();
    assert_eq!(get(&mut s, &target.id).status, Status::Blocked);
    undo(&mut s, &skipped, "unskip-undo");
    let current = get(&mut s, &prerequisite.id);
    edit(
        &mut s,
        &current,
        "complete-occurrence",
        json!({"status":"done"}),
    );
    assert_eq!(get(&mut s, &target.id).status, Status::Next);
}
#[test]
fn migration_aliases_history_retry_and_guard() {
    use rusqlite::{Connection, params};
    let d = TempDir::new().unwrap();
    let path = d.path().join("db");
    let mut s = Store::open(&path).unwrap();
    let args = json!({"request_id":"legacy","title":"Later step","estimated_minutes":30,"effort":"medium","importance":"normal","status":"planned","reason":"Fixture"});
    let t = s.capture(decode(args.clone())).unwrap().task;
    assert!(t.manual_block);
    let cursor = s.list(decode(json!({"view":"all","limit":1}))).unwrap();
    drop(s);
    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE tasks SET document=json_remove(json_set(document,'$.status','planned'),'$.manual_block') WHERE id=?1",[&t.id]).unwrap();
    db.execute_batch("DROP TABLE IF EXISTS brief_exemptions;")
        .unwrap();
    db.pragma_update(None, "user_version", 7).unwrap();
    let old: String = db
        .query_row("SELECT response FROM requests WHERE id='legacy'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let history: String = db
        .query_row(
            "SELECT document FROM changes WHERE id=?1",
            [t.last_change_id],
            |r| r.get(0),
        )
        .unwrap();
    drop(db);
    let mut s = Store::open(&path).unwrap();
    let migrated = get(&mut s, &t.id);
    assert_eq!(migrated.status, Status::Blocked);
    assert!(migrated.manual_block);
    assert_eq!(migrated.version, t.version + 1);
    assert!(s.capture(decode(args)).unwrap().replayed);
    assert_eq!(
        s.list(decode(json!({"status":"planned"}))).unwrap().items[0].id,
        t.id
    );
    assert_eq!(
        serde_json::to_string(&decode::<Status>(json!("planned"))).unwrap(),
        "\"planned\""
    );
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        11
    );
    assert_eq!(
        old,
        db.query_row("SELECT response FROM requests WHERE id='legacy'", [], |r| r
            .get::<_, String>(0))
            .unwrap()
    );
    assert_eq!(
        history,
        db.query_row(
            "SELECT document FROM changes WHERE id=?1",
            params![t.last_change_id],
            |r| r.get::<_, String>(0)
        )
        .unwrap()
    );
    assert!(cursor.items[0].manual_block);
}
#[test]
fn automatic_changes_share_sync_transaction_and_concurrent_versions_are_checked() {
    use rusqlite::Connection;
    let d = TempDir::new().unwrap();
    let path = d.path().join("db");
    let mut s = Store::open(&path).unwrap();
    let a = capture(&mut s, "a", "next", vec![]);
    let b = capture(&mut s, "b", "next", vec![a.id.clone()]);
    let complete = edit(&mut s, &a, "completion", json!({"status":"done"}));
    let db = Connection::open(&path).unwrap();
    let batches: Vec<String> = db
        .prepare("SELECT DISTINCT batch_id FROM changes WHERE id>=?1")
        .unwrap()
        .query_map([complete.change.id], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(batches, vec!["completion"]);
    let mut other = Store::open(&path).unwrap();
    assert_eq!(other.update(decode(json!({"request_id":"stale","task_id":b.id,"expected_version":b.version,"notes":"Stale","reason":"Conflict"}))).unwrap_err().code(),"conflict");
    let current = get(&mut s, &b.id);
    assert_eq!(current.version, 2);
}

#[test]
fn strongest_source_never_adds_fanout_or_crosses_inactive_branches() {
    let d = TempDir::new().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    let root = capture(&mut s, "root", "next", vec![]);
    let root = edit(
        &mut s,
        &root,
        "low-root",
        json!({"estimated_minutes":30,"effort":"medium","importance":"unimportant"}),
    )
    .task;
    let urgent = capture(&mut s, "urgent-wait", "waiting", vec![root.id.clone()]);
    let urgent = edit(
        &mut s,
        &urgent,
        "urgency",
        json!({"estimated_minutes":30,"effort":"medium","importance":"high","due_date":"2000-01-01"}),
    )
    .task;
    let critical = capture(&mut s, "undated-critical", "next", vec![root.id.clone()]);
    let critical = edit(
        &mut s,
        &critical,
        "importance",
        json!({"estimated_minutes":30,"effort":"medium","importance":"critical"}),
    )
    .task;
    let ranked = get(&mut s, &root.id).recommendation.unwrap();
    assert_eq!(ranked.source_task_id, Some(urgent.id.clone()));
    assert_eq!(
        ranked.key.split(':').take(10).collect::<Vec<_>>(),
        get(&mut s, &urgent.id)
            .recommendation
            .unwrap()
            .key
            .split(':')
            .take(10)
            .collect::<Vec<_>>()
    );
    assert_eq!(get(&mut s, &root.id).due_date, None);
    for i in 0..5 {
        capture(
            &mut s,
            &format!("branch-{i}"),
            "next",
            vec![root.id.clone()],
        );
    }
    assert_eq!(
        get(&mut s, &root.id).recommendation.unwrap().key,
        ranked.key
    );
    edit(&mut s, &urgent, "archive-urgent", json!({"archived":true}));
    assert_eq!(
        get(&mut s, &root.id).recommendation.unwrap().source_task_id,
        Some(critical.id.clone())
    );
    for state in ["inbox", "someday", "done"] {
        let current = get(&mut s, &critical.id);
        edit(
            &mut s,
            &current,
            &format!("inactive-{state}"),
            json!({"status":state}),
        );
        assert_ne!(
            get(&mut s, &root.id).recommendation.unwrap().source_task_id,
            Some(critical.id.clone())
        );
    }
    let middle = capture(&mut s, "inactive-middle", "someday", vec![root.id.clone()]);
    let high = capture(&mut s, "behind-inactive", "next", vec![middle.id.clone()]);
    edit(
        &mut s,
        &high,
        "behind-high",
        json!({"estimated_minutes":30,"effort":"medium","importance":"critical","due_date":"2000-01-01"}),
    );
    assert_ne!(
        get(&mut s, &root.id).recommendation.unwrap().source_task_id,
        Some(high.id)
    );
}

#[test]
fn dependency_limits_invalid_targets_and_null_preservation_are_atomic() {
    let d = TempDir::new().unwrap();
    let mut s = Store::open(d.path().join("db")).unwrap();
    let a = capture(&mut s, "a", "next", vec![]);
    let b = capture(&mut s, "b", "next", vec![a.id.clone()]);
    let b = edit(
        &mut s,
        &b,
        "preserve-null",
        json!({"blocked_by":null,"notes":"Keep links"}),
    )
    .task;
    assert_eq!(b.blocked_by, vec![a.id.clone()]);
    for (key, ids) in [
        ("duplicate", vec![a.id.clone(), a.id.clone()]),
        ("missing", vec![uuid::Uuid::new_v4().to_string()]),
        (
            "too-many",
            (0..51).map(|_| uuid::Uuid::new_v4().to_string()).collect(),
        ),
    ] {
        assert!(s.update(decode(json!({"request_id":key,"task_id":b.id,"expected_version":b.version,"blocked_by":ids,"reason":"Invalid fixture"}))).is_err());
        assert_eq!(get(&mut s, &b.id).version, b.version);
    }
    let project = s
        .create_project(decode(
            json!({"request_id":"project","title":"Outcome","reason":"Fixture"}),
        ))
        .unwrap()
        .task;
    assert!(s.update(decode(json!({"request_id":"project-target","task_id":b.id,"expected_version":b.version,"blocked_by":[project.id],"reason":"Invalid project target"}))).is_err());
    let moved = edit(
        &mut s,
        &a,
        "cross-project",
        json!({"project_id":project.id}),
    )
    .task;
    assert_eq!(get(&mut s, &b.id).blocked_by, vec![moved.id]);
    let cleared = edit(&mut s, &b, "clear-links", json!({"blocked_by":[]})).task;
    assert_eq!(cleared.status, Status::Next);
    assert!(cleared.blocked_by.is_empty());
}
