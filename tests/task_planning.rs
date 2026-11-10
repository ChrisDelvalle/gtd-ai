mod support;
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{model::*, planning::evaluate, store::Store};
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> T {
    support::input(v)
}
fn fixture() -> (TempDir, Store) {
    let d = TempDir::new().unwrap();
    let s = Store::open(d.path().join("db")).unwrap();
    (d, s)
}
fn capture(s: &mut Store, key: &str, fields: Value) -> Task {
    let mut v = json!({"request_id":key,"title":key,"reason":"Disposable planning fixture","status":"next","importance":"normal","estimated_minutes":30,"effort":"medium"});
    v.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    s.capture(decode(v)).unwrap().task
}
fn edit(s: &mut Store, t: &Task, key: &str, fields: Value) -> MutationResult {
    let mut v = json!({"task_id":t.id,"expected_version":t.version,"request_id":key,"reason":"Fixture edit"});
    v.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    s.update(decode(v)).unwrap()
}
fn get(s: &mut Store, id: &str) -> Task {
    s.list(decode(json!({"task_id":id})))
        .unwrap()
        .items
        .remove(0)
}
fn m(day: &str, clock: &str) -> Value {
    json!({"date":day,"time":clock,"timezone":"America/New_York"})
}
#[test]
fn required_on_commitment_filters_and_completion_exceptions() {
    let (_d, mut s) = fixture();
    let t=s.capture(decode(json!({"request_id":"inbox","title":"Unclarified","importance":"normal","reason":"Fixture"}))).unwrap().task;
    assert!(s.update(decode(json!({"request_id":"bad","task_id":t.id,"expected_version":1,"status":"next","reason":"Clarify"}))).unwrap_err().to_string().contains("require estimated_minutes"));
    let completed = edit(&mut s, &t, "complete", json!({"status":"done"}));
    assert_eq!(completed.task.status, Status::Done);
    let a = capture(
        &mut s,
        "easy",
        json!({"estimated_minutes":20,"effort":"low"}),
    );
    capture(
        &mut s,
        "long",
        json!({"estimated_minutes":21,"effort":"low"}),
    );
    capture(
        &mut s,
        "hard",
        json!({"estimated_minutes":15,"effort":"high"}),
    );
    let v = s
        .list(decode(
            json!({"status":"next","max_estimated_minutes":20,"max_effort":"low"}),
        ))
        .unwrap();
    assert_eq!(
        v.items.iter().map(|t| &t.id).collect::<Vec<_>>(),
        vec![&a.id]
    );
    let zero = capture(
        &mut s,
        "zero",
        json!({"estimated_minutes":0,"effort":"trivial"}),
    );
    assert_eq!(
        s.list(decode(json!({"max_estimated_minutes":0})))
            .unwrap()
            .items[0]
            .id,
        zero.id
    );
}
#[test]
fn buffer_is_bounded_planning_cue_not_immediate() {
    let (_d, mut s) = fixture();
    let t = capture(
        &mut s,
        "buffered",
        json!({"due_date":"2026-10-10","deadline_time":{"time":"12:00"},"safety_buffer":{"value":2,"unit":"days"}}),
    );
    let target = t
        .planning
        .buffer_target(t.due_date.as_deref())
        .unwrap()
        .unwrap()
        .0;
    assert_eq!(target.date, "2026-10-08");
    assert_eq!(target.time.as_deref(), Some("12:00"));
    let now = "2026-10-08T17:00:00Z".parse().unwrap();
    let rank = evaluate(&t, now);
    assert!(rank.key.starts_with("2:"));
    assert!(rank.reason.contains("buffer target"));
    let active = capture(
        &mut s,
        "active-block",
        json!({"importance":"low","work_blocks":[{"start":m("2026-10-08","12:00"),"finish":m("2026-10-08","14:00")}]}),
    );
    assert!(evaluate(&active, now).key < rank.key);
    let changed = edit(&mut s, &t, "move", json!({"due_date":"2026-10-12"}));
    assert_eq!(
        changed
            .task
            .planning
            .buffer_target(Some("2026-10-12"))
            .unwrap()
            .unwrap()
            .0
            .date,
        "2026-10-10"
    );
    let cleared = edit(
        &mut s,
        &changed.task,
        "clear",
        json!({"clear_due_date":true}),
    );
    assert!(cleared.task.planning.safety_buffer.is_none());
}
#[test]
fn availability_combines_with_dependencies_and_holds() {
    let (_d, mut s) = fixture();
    let a = capture(&mut s, "a", json!({}));
    let t = capture(
        &mut s,
        "later",
        json!({"not_before":{"date":"2090-01-01"},"blocked_by":[a.id]}),
    );
    assert_eq!(t.status, Status::Blocked);
    assert!(!t.manual_block);
    let t = edit(
        &mut s,
        &t,
        "arrived",
        json!({"not_before":{"date":"2020-01-01"}}),
    )
    .task;
    assert_eq!(t.status, Status::Blocked);
    edit(&mut s, &a, "done-a", json!({"status":"done"}));
    let t = get(&mut s, &t.id);
    assert_eq!(t.status, Status::Next);
    let held = edit(&mut s, &t, "hold", json!({"status":"blocked"})).task;
    let held = edit(
        &mut s,
        &held,
        "date",
        json!({"not_before":{"date":"2020-01-02"}}),
    )
    .task;
    assert_eq!(held.status, Status::Blocked);
    assert!(held.manual_block);
}
#[test]
fn multiple_blocks_legacy_patch_filters_and_atomic_undo() {
    let (_d, mut s) = fixture();
    let t = capture(
        &mut s,
        "blocks",
        json!({"planned_start":m("2026-10-08","09:00"),"planned_finish":m("2026-10-08","10:00")}),
    );
    let mut blocks = t.planning.blocks();
    let first = blocks[0].id.clone();
    blocks.push(decode(json!({"id":"second","start":m("2026-10-09","12:00"),"finish":m("2026-10-09","13:00"),"calendar_event":{"url":"https://calendar.google.com/calendar/event?eid=example"}})));
    let r = edit(&mut s, &t, "add", json!({"work_blocks":blocks}));
    let r = edit(
        &mut s,
        &r.task,
        "legacy",
        json!({"planned_finish":m("2026-10-08","11:00")}),
    );
    assert_eq!(r.task.planning.blocks().len(), 2);
    assert_eq!(r.task.planning.blocks()[0].id, first);
    assert_eq!(r.task.planning.blocks()[1].id, "second");
    assert_eq!(
        s.list(decode(
            json!({"planned_from":"2026-10-09","planned_through":"2026-10-09"})
        ))
        .unwrap()
        .items[0]
            .id,
        t.id
    );
    assert_eq!(
        evaluate(&r.task, "2026-10-09T16:30:00Z".parse().unwrap()).reason,
        "Planned now"
    );
    assert!(s.update(decode(json!({"task_id":t.id,"expected_version":r.task.version,"request_id":"mixed","reason":"Invalid","work_blocks":[],"planned_start":m("2026-10-10","09:00")}))).is_err());
    let undone=s.undo(decode(json!({"request_id":"undo","change_id":r.change.id,"expected_version":r.task.version,"reason":"Fixture undo"}))).unwrap();
    assert_eq!(
        undone.task.planning.blocks()[0]
            .finish
            .as_ref()
            .unwrap()
            .time
            .as_deref(),
        Some("10:00")
    );
}
#[test]
fn buffer_calendar_days_and_hours_across_dst() {
    use todo_mcp::task_planning::SafetyBuffer;
    let deadline = decode(m("2026-03-09", "12:00"));
    let days: SafetyBuffer = decode(json!({"value":2,"unit":"days"}));
    let hours: SafetyBuffer = decode(json!({"value":48,"unit":"hours"}));
    assert_eq!(
        days.target(&deadline).unwrap().0.time.as_deref(),
        Some("12:00")
    );
    assert_eq!(
        hours.target(&deadline).unwrap().0.time.as_deref(),
        Some("11:00")
    );
    let shifted = days.target(&decode(m("2026-03-10", "02:30"))).unwrap();
    assert_eq!(shifted.0.time.as_deref(), Some("03:30"));
    assert!(shifted.1.is_some());
}
#[test]
fn recurrence_defaults_multiple_blocks_and_occurrence_overrides() {
    let (_d, mut s) = fixture();
    let args = json!({"request_id":"series","reason":"Fixture","rule":{"start_date":"2090-01-01","frequency":"daily","count":3},"template":{"title":"Repeat","importance":"normal","estimated_minutes":40,"effort":"high","not_before":{"offset_days":1},"due_offset_days":3,"safety_buffer":{"value":1,"unit":"days"},"work_blocks":[{"id":"a","start":{"offset_days":1,"time":"09:00"},"finish":{"offset_days":1,"time":"10:00"}},{"id":"b","start":{"offset_days":2,"time":"10:00"},"finish":{"offset_days":2,"time":"11:00"}}]}});
    let series = s.create_recurrence(decode(args)).unwrap();
    s.materialize_recurrences("2090-01-03").unwrap();
    let rows = s.list(decode(json!({"view":"all"}))).unwrap().items;
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .all(|t| t.status == Status::Blocked && t.planning.blocks().len() == 2)
    );
    let occurrence = &rows[0];
    let mut blocks = occurrence.planning.blocks();
    blocks[1].calendar_event = Some(decode(
        json!({"url":"https://calendar.google.com/calendar/event?eid=retained"}),
    ));
    let override_ = edit(
        &mut s,
        occurrence,
        "override",
        json!({"work_blocks":blocks,"estimated_minutes":55}),
    );
    let change=s.update_recurrence(decode(json!({"request_id":"rename-series","reason":"Older template client","series_id":series.task.id,"expected_version":series.task.version,"action":"edit","scope":"all","template":{"title":"New title"}}))).unwrap();
    let current = get(&mut s, &override_.task.id);
    assert_eq!(current.planning.estimated_minutes, Some(55));
    assert!(current.planning.blocks()[1].calendar_event.is_some());
    assert_eq!(
        change.task.recurrence.unwrap().segments[0]
            .template
            .planning
            .work_blocks
            .as_ref()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn availability_timer_empty_next_and_catch_up_are_audited_once() {
    let (d, mut s) = fixture();
    let t = capture(
        &mut s,
        "future",
        json!({"not_before":{"date":"2090-01-01"}}),
    );
    let next = s.list(decode(json!({"status":"next"}))).unwrap();
    assert!(next.items.is_empty());
    assert!(next.next_change_at.is_some());
    // Simulate an elapsed clock boundary in the stored fixture without sleeping.
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    let raw: String = c
        .query_row("SELECT document FROM tasks WHERE id=?1", [&t.id], |r| {
            r.get(0)
        })
        .unwrap();
    let mut v: Value = serde_json::from_str(&raw).unwrap();
    v["not_before"]["date"] = json!("2020-01-01");
    c.execute(
        "UPDATE tasks SET document=?1 WHERE id=?2",
        rusqlite::params![v.to_string(), t.id],
    )
    .unwrap();
    drop(c);
    let ready = get(&mut s, &t.id);
    assert_eq!(ready.status, Status::Next);
    assert_eq!(ready.version, t.version + 1);
    let again = get(&mut s, &t.id);
    assert_eq!(again.version, ready.version);
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    let operation: String = c
        .query_row(
            "SELECT json_extract(document,'$.operation') FROM changes WHERE id=?1",
            [ready.last_change_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(operation, "availability_status");
}
#[test]
fn migration_preserves_history_and_defaults_only_missing_committed_fields() {
    let (d, mut s) = fixture();
    let t = capture(
        &mut s,
        "legacy",
        json!({"planned_start":m("2090-01-01","09:00")}),
    );
    drop(s);
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    let raw: String = c
        .query_row("SELECT document FROM tasks WHERE id=?1", [&t.id], |r| {
            r.get(0)
        })
        .unwrap();
    let mut v: Value = serde_json::from_str(&raw).unwrap();
    for key in [
        "estimated_minutes",
        "effort",
        "work_blocks",
        "legacy_work_block_id",
    ] {
        v.as_object_mut().unwrap().remove(key);
    }
    c.execute(
        "UPDATE tasks SET document=?1 WHERE id=?2",
        rusqlite::params![v.to_string(), t.id],
    )
    .unwrap();
    c.execute_batch("DROP TABLE IF EXISTS brief_exemptions;")
        .unwrap();
    c.pragma_update(None, "user_version", 8).unwrap();
    let receipt: String = c
        .query_row("SELECT response FROM requests WHERE id='legacy'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let history: String = c
        .query_row(
            "SELECT document FROM changes WHERE id=?1",
            [t.last_change_id],
            |r| r.get(0),
        )
        .unwrap();
    drop(c);
    s = Store::open(d.path().join("db")).unwrap();
    let migrated = get(&mut s, &t.id);
    assert_eq!(migrated.planning.estimated_minutes, Some(30));
    assert_eq!(
        migrated.planning.effort,
        Some(todo_mcp::task_planning::Effort::Medium)
    );
    assert_eq!(migrated.planning.blocks().len(), 1);
    assert_eq!(migrated.version, t.version + 1);
    let c = rusqlite::Connection::open(d.path().join("db")).unwrap();
    assert_eq!(
        c.query_row("SELECT response FROM requests WHERE id='legacy'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        receipt
    );
    assert_eq!(
        c.query_row(
            "SELECT document FROM changes WHERE id=?1",
            [t.last_change_id],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        history
    );
}
#[test]
fn pagination_freezes_estimates_and_blocks_while_writes_conflict_and_retry() {
    let (_d, mut s) = fixture();
    let a = capture(&mut s, "a", json!({"estimated_minutes":10}));
    let b = capture(&mut s, "b", json!({"estimated_minutes":20}));
    let first = s
        .list(decode(
            json!({"status":"next","max_estimated_minutes":30,"limit":1,"sort":"created"}),
        ))
        .unwrap();
    assert_eq!(first.items[0].id, a.id);
    let args = json!({"task_id":b.id,"expected_version":b.version,"request_id":"increase","reason":"More work remains","estimated_minutes":60});
    s.update(decode(args.clone())).unwrap();
    assert!(s.update(decode(args)).unwrap().replayed);
    let frozen=s.list(decode(json!({"status":"next","max_estimated_minutes":30,"limit":1,"sort":"created","cursor":first.next_cursor}))).unwrap();
    assert_eq!(frozen.items[0].id, b.id);
    assert_eq!(frozen.items[0].planning.estimated_minutes, Some(20));
    assert_eq!(
        s.list(decode(json!({"status":"next","max_estimated_minutes":30})))
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(s.update(decode(json!({"task_id":b.id,"expected_version":b.version,"request_id":"stale","reason":"Stale","effort":"high"}))).is_err());
}

#[test]
fn deleting_designated_block_and_old_clients_never_reassign_another() {
    let (_d, mut s) = fixture();
    let t = capture(
        &mut s,
        "two",
        json!({"work_blocks":[{"id":"a","start":{"date":"2090-01-01"}},{"id":"b","start":{"date":"2090-01-02"}}]}),
    );
    let t = edit(
        &mut s,
        &t,
        "remove-first",
        json!({"work_blocks":[{"id":"b","start":{"date":"2090-01-02"}}]}),
    )
    .task;
    assert!(t.planning.planned_start.is_none());
    let t = edit(
        &mut s,
        &t,
        "legacy-new",
        json!({"planned_start":{"date":"2090-01-03"}}),
    )
    .task;
    assert_eq!(t.planning.blocks().len(), 2);
    assert_eq!(t.planning.blocks()[0].id, "b");
    assert_eq!(t.planning.blocks()[0].start.date, "2090-01-02");
    assert_eq!(t.planning.blocks()[1].id, "a");
    let t = edit(
        &mut s,
        &t,
        "omit",
        json!({"notes":"Revised description","work_blocks":null,"estimated_minutes":null}),
    )
    .task;
    assert_eq!(t.planning.blocks().len(), 2);
    assert_eq!(t.planning.estimated_minutes, Some(30));
    assert!(s.update(decode(json!({"task_id":t.id,"expected_version":t.version,"request_id":"clear-required","reason":"Invalid","clear_planning":["effort"]}))).is_err());
    let t = edit(
        &mut s,
        &t,
        "make-idea",
        json!({"status":"someday","clear_planning":["estimated_minutes","effort","work_blocks"]}),
    )
    .task;
    assert!(t.planning.blocks().is_empty());
    assert!(t.planning.effort.is_none());
}

#[test]
fn recurring_blocks_disclose_dst_changes_and_preserve_other_blocks_on_legacy_edits() {
    use todo_mcp::planning::RepeatPlanning;
    let original: RepeatPlanning = decode(
        json!({"work_blocks":[{"id":"a","start":{"offset_days":0,"time":"02:30"},"finish":{"offset_days":0,"time":"04:00"}},{"id":"b","start":{"offset_days":1,"time":"09:00"}}]}),
    );
    let merged = original.merge(&RepeatPlanning::default()).unwrap();
    let (p, adjustments) = merged.materialize("2027-03-14", None).unwrap();
    assert_eq!(p.blocks()[0].start.time.as_deref(), Some("03:30"));
    assert!(!adjustments.is_empty());
    let patch: RepeatPlanning = decode(json!({"planned_finish":{"offset_days":0,"time":"05:00"}}));
    let edited = patch.merge(&merged).unwrap();
    assert_eq!(edited.work_blocks.as_ref().unwrap().len(), 2);
    assert_eq!(edited.work_blocks.as_ref().unwrap()[1].id, "b");
    let remove: RepeatPlanning = decode(json!({"clear_planning":["planned_start"]}));
    let removed = remove.merge(&edited).unwrap();
    assert_eq!(removed.work_blocks.as_ref().unwrap().len(), 1);
    assert!(removed.planned_start.is_none());
    let orphan_finish: RepeatPlanning =
        decode(json!({"planned_finish":{"offset_days":1,"time":"11:00"}}));
    assert!(
        orphan_finish
            .merge(&removed)
            .unwrap_err()
            .contains("requires planned start")
    );
    let conflicting: RepeatPlanning = decode(
        json!({"clear_planning":["planned_start"],"planned_finish":{"offset_days":1,"time":"11:00"}}),
    );
    assert!(conflicting.merge(&edited).is_err());
}

#[test]
fn buffer_priority_inherits_one_whole_result_without_changing_estimates() {
    let (_d, mut s) = fixture();
    let prerequisite = capture(&mut s, "pre", json!({"importance":"unimportant"}));
    let commitment = capture(
        &mut s,
        "goal",
        json!({"importance":"high","due_date":"2090-01-08","safety_buffer":{"value":3660,"unit":"days"},"blocked_by":[prerequisite.id]}),
    );
    let ready = s
        .list(decode(json!({"status":"next"})))
        .unwrap()
        .items
        .remove(0);
    assert_eq!(
        ready.recommendation.unwrap().source_task_id,
        Some(commitment.id)
    );
    assert_eq!(ready.planning.importance, prerequisite.planning.importance);
    assert_eq!(ready.planning.estimated_minutes, Some(30));
}
