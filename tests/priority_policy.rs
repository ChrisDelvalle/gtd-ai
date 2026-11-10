mod support;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{model::*, planning::evaluate, store::Store};
fn fixture() -> (TempDir, Store) {
    let d = TempDir::new().unwrap();
    let s = Store::open(d.path().join("policy.db")).unwrap();
    (d, s)
}
fn task(s: &mut Store, name: &str, fields: Value) -> Task {
    let mut v = json!({"request_id":name,"title":name,"status":"next","importance":"normal","estimated_minutes":30,"effort":"medium","reason":"Priority policy fixture"});
    v.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    s.capture(support::input(v)).unwrap().task
}
fn now() -> DateTime<Utc> {
    "2026-11-10T17:00:00Z".parse().unwrap()
}
fn key(t: &Task) -> String {
    evaluate(t, now()).key
}
#[test]
fn bounded_stakes_and_plan_tradeoffs() {
    let (_d, mut s) = fixture();
    let trivial = task(
        &mut s,
        "trivial",
        json!({"importance":"unimportant","due_date":"2026-11-01"}),
    );
    let critical = task(
        &mut s,
        "critical",
        json!({"importance":"critical","due_date":"2026-11-11"}),
    );
    let undated = task(&mut s, "undated", json!({"importance":"critical"}));
    let imminent = task(
        &mut s,
        "imminent",
        json!({"due_date":"2026-11-10","deadline_time":{"time":"13:00"}}),
    );
    let block = task(
        &mut s,
        "block",
        json!({"planned_start":{"date":"2026-11-10","time":"11:00"},"planned_finish":{"date":"2026-11-10","time":"14:00"}}),
    );
    let week = task(&mut s, "week", json!({"due_date":"2026-11-15"}));
    let normal = task(&mut s, "normal", json!({}));
    assert!(key(&critical) < key(&trivial));
    assert!(key(&imminent) < key(&undated));
    assert!(key(&week) < key(&block));
    assert!(key(&block) < key(&normal));
    assert!(key(&undated) < key(&trivial));
}
#[test]
fn secondary_constraints_and_active_finish_break_ties() {
    let (_d, mut s) = fixture();
    let a = task(
        &mut s,
        "a",
        json!({"start_by":{"date":"2026-11-10","time":"13:00"},"due_date":"2026-11-11"}),
    );
    let b = task(
        &mut s,
        "b",
        json!({"start_by":{"date":"2026-11-10","time":"13:00"},"due_date":"2026-11-14","planned_start":{"date":"2026-11-10","time":"11:00"},"planned_finish":{"date":"2026-11-10","time":"14:00"}}),
    );
    assert!(key(&a) < key(&b));
    let long = task(
        &mut s,
        "long",
        json!({"planned_start":{"date":"2026-11-10","time":"08:00"},"planned_finish":{"date":"2026-11-10","time":"17:00"}}),
    );
    let short = task(
        &mut s,
        "short",
        json!({"planned_start":{"date":"2026-11-10","time":"11:00"},"planned_finish":{"date":"2026-11-10","time":"13:00"}}),
    );
    assert!(key(&short) < key(&long));
    let mut duplicate = a.clone();
    duplicate.planning.start_by = duplicate.planning.deadline(duplicate.due_date.as_deref());
    let mut just_deadline = duplicate.clone();
    just_deadline.planning.start_by = None;
    assert_eq!(key(&duplicate), key(&just_deadline));
}
#[test]
fn project_fallback_is_derived_and_explicit_deadline_wins() {
    let (_d, mut s) = fixture();
    let p=s.create_project(support::input(json!({"request_id":"p","title":"Launch","due_date":"2090-01-03","reason":"Policy fixture"}))).unwrap().task;
    let a = task(&mut s, "inherits", json!({"project_id":p.id}));
    let b = task(
        &mut s,
        "explicit",
        json!({"project_id":p.id,"due_date":"2090-02-01"}),
    );
    let c = task(
        &mut s,
        "someday",
        json!({"project_id":p.id,"status":"someday"}),
    );
    let before = s.sync_state(SyncState::default()).unwrap();
    let rows = s
        .list(support::input(json!({"view":"all","sort":"effective_due"})))
        .unwrap();
    assert_eq!(
        rows.items.iter().map(|t| &t.id).collect::<Vec<_>>(),
        vec![&a.id, &b.id, &c.id]
    );
    let read = &rows.items[0];
    assert!(read.due_date.is_none());
    assert_eq!(read.version, a.version);
    let r = read.recommendation.as_ref().unwrap();
    assert_eq!(r.effective_deadline.as_ref().unwrap().date, "2090-01-03");
    assert_eq!(r.deadline_project.as_ref().unwrap().id, p.id);
    assert!(
        rows.items[2]
            .recommendation
            .as_ref()
            .unwrap()
            .effective_deadline
            .is_none()
    );
    let after = s
        .sync_state(support::input(json!({"cursor":before["checkpoint"]})))
        .unwrap();
    assert_eq!(after["changes"], json!([]));
    let raw = s
        .list(support::input(json!({"view":"all","sort":"due"})))
        .unwrap();
    assert_eq!(raw.items[0].id, b.id);
}
#[test]
fn started_is_late_then_older_wins_and_edits_do_not_reorder() {
    let (_d, mut s) = fixture();
    let a = task(&mut s, "older", json!({}));
    let b = task(&mut s, "started", json!({"started":true}));
    let c = task(&mut s, "higher", json!({"importance":"high"}));
    let rows = s.list(ListItems::default()).unwrap();
    assert_eq!(
        rows.items.iter().map(|t| &t.id).collect::<Vec<_>>(),
        vec![&c.id, &b.id, &a.id]
    );
    s.update(support::input(json!({"request_id":"stop","task_id":b.id,"expected_version":b.version,"started":false,"reason":"Test late tie"}))).unwrap();
    let rows = s.list(ListItems::default()).unwrap();
    assert_eq!(
        rows.items.iter().map(|t| &t.id).collect::<Vec<_>>(),
        vec![&c.id, &a.id, &b.id]
    );
}
