mod support;
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{model::*, planning::*, store::Store};
fn input<T: DeserializeOwned>(v: Value) -> T {
    support::input(v)
}
fn fixture() -> (TempDir, Store) {
    let d = TempDir::new().unwrap();
    let s = Store::open(d.path().join("test.db")).unwrap();
    (d, s)
}
fn capture(s: &mut Store, title: &str, fields: Value) -> Task {
    let mut v = json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":title,"title":title,"status":"next","reason":"Isolated planning fixture"});
    v.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    s.capture(input(v)).unwrap().task
}
fn edit(s: &mut Store, t: &Task, key: &str, fields: Value) -> MutationResult {
    let mut v = json!({"request_id":key,"task_id":t.id,"expected_version":t.version,"reason":"Isolated planning edit"});
    v.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    s.update(input(v)).unwrap()
}
fn current(s: &mut Store, id: &str) -> Task {
    s.list(input(json!({"task_id":id})))
        .unwrap()
        .items
        .remove(0)
}
fn moment(date: &str, time: Option<&str>) -> Value {
    json!({"date":date,"time":time,"timezone":"America/New_York"})
}
fn fixed() -> DateTime<Utc> {
    "2026-10-07T14:00:00Z".parse().unwrap()
}

#[test]
fn importance_and_timing_order_examples() {
    let (_d, mut s) = fixture();
    let high = capture(
        &mut s,
        "important",
        json!({"estimated_minutes":30,"effort":"medium","importance":"very_high"}),
    );
    let distant = capture(
        &mut s,
        "distant",
        json!({"estimated_minutes":30,"effort":"medium","importance":"low","due_date":"2026-10-12"}),
    );
    let soon = capture(
        &mut s,
        "soon",
        json!({"estimated_minutes":30,"effort":"medium","importance":"normal","due_date":"2026-10-08","deadline_time":{"time":"12:00"}}),
    );
    let high2 = capture(
        &mut s,
        "high",
        json!({"estimated_minutes":30,"effort":"medium","importance":"high"}),
    );
    let block = capture(
        &mut s,
        "block",
        json!({"estimated_minutes":30,"effort":"medium","importance":"high","planned_start":moment("2026-10-07",Some("09:00")),"planned_finish":moment("2026-10-07",Some("11:00"))}),
    );
    let imminent = capture(
        &mut s,
        "imminent",
        json!({"estimated_minutes":30,"effort":"medium","importance":"low","due_date":"2026-10-07","deadline_time":{"time":"11:00"}}),
    );
    let key = |t: &Task| evaluate(t, fixed()).key;
    assert!(key(&high) < key(&distant));
    assert!(key(&soon) < key(&high2));
    assert!(key(&high) < key(&block));
    assert!(key(&imminent) < key(&block));
    let normal = capture(
        &mut s,
        "normal",
        json!({"estimated_minutes":30,"effort":"medium","importance":"normal"}),
    );
    let default = capture(&mut s, "default", json!({}));
    assert_eq!(key(&normal), key(&default));
    assert_eq!(evaluate(&default, fixed()).reason, "Normal importance");
    let noon = capture(
        &mut s,
        "noon",
        json!({"due_date":"2026-10-07","deadline_time":{"time":"12:00"}}),
    );
    let all_day = capture(&mut s, "day", json!({"due_date":"2026-10-07"}));
    assert!(key(&noon) < key(&all_day));
    assert!(!evaluate(&all_day, fixed()).reason.contains("overdue"));
    assert!(
        evaluate(&all_day, "2026-10-08T04:00:00Z".parse().unwrap())
            .reason
            .contains("overdue")
    );
    let expired = evaluate(&block, "2026-10-07T15:00:00Z".parse().unwrap());
    assert_ne!(expired.reason, "Planned now");
}
#[test]
fn time_boundaries_and_start_confirmation() {
    let (_d, mut s) = fixture();
    let t = capture(
        &mut s,
        "start",
        json!({"start_by":moment("2026-10-07",Some("12:00")),"estimated_minutes":30,"effort":"medium","importance":"high"}),
    );
    assert!(evaluate(&t, fixed()).reason.contains("Start by"));
    let before = evaluate(&t, "2026-10-07T13:59:59Z".parse().unwrap());
    assert!(evaluate(&t, fixed()).key < before.key);
    let started = edit(&mut s, &t, "start-confirm", json!({"started":true})).task;
    assert_eq!(started.planning.start_by, t.planning.start_by);
    assert!(started.planning.started_at.is_none());
    assert_eq!(started.status, Status::Next);
    assert!(!evaluate(&started, fixed()).reason.contains("Start by"));
    let reset = edit(&mut s, &started, "start-reset", json!({"started":false})).task;
    assert!(evaluate(&reset, fixed()).key < evaluate(&started, fixed()).key);
    let dated = edit(
        &mut s,
        &reset,
        "start-actual",
        json!({"started_at":moment("2026-01-02",None)}),
    );
    assert!(dated.task.planning.started);
    let undo=s.undo(input(json!({"request_id":"undo-start","change_id":dated.change.id,"expected_version":dated.task.version,"reason":"Test undo"}))).unwrap();
    assert!(!undo.task.planning.started);
}
#[test]
fn one_off_dst_requires_real_unambiguous_times() {
    for (day, clock, fragment) in [
        ("2026-03-08", "02:30", "does not exist"),
        ("2026-11-01", "01:30", "occurs twice"),
    ] {
        let m: Moment = input(moment(day, Some(clock)));
        assert!(m.bound(false).unwrap_err().contains(fragment));
    }
    let mut m: Moment = input(moment("2026-11-01", Some("01:30")));
    m.utc_offset_minutes = Some(-240);
    assert_eq!(
        m.bound(false).unwrap().to_rfc3339(),
        "2026-11-01T05:30:00+00:00"
    );
    m.utc_offset_minutes = Some(-300);
    assert_eq!(
        m.bound(false).unwrap().to_rfc3339(),
        "2026-11-01T06:30:00+00:00"
    );
    m.timezone = "Not/AZone".into();
    assert!(m.bound(false).is_err());
    let date_only: Moment = input(moment("2026-03-08", None));
    assert_eq!(
        (date_only.bound(true).unwrap() - date_only.bound(false).unwrap()).num_hours(),
        23
    );
}
#[test]
fn old_clients_preserve_planning_and_clear_is_explicit() {
    let (_d, mut s) = fixture();
    let t = capture(
        &mut s,
        "compat",
        json!({"estimated_minutes":30,"effort":"medium","importance":"critical","due_date":"2090-05-01","deadline_time":{"time":"12:00"},"start_by":moment("2090-04-30",None),"agent_notes":"Keep context"}),
    );
    let edit1 = edit(
        &mut s,
        &t,
        "legacy",
        json!({"notes":"Clear human description"}),
    );
    assert_eq!(edit1.task.planning, t.planning);
    let edit2 = edit(
        &mut s,
        &edit1.task,
        "nulls",
        json!({"estimated_minutes":30,"effort":"medium","importance":null,"start_by":null,"notes":"Second edit"}),
    );
    assert_eq!(edit2.task.planning, t.planning);
    let clear = edit(
        &mut s,
        &edit2.task,
        "clear",
        json!({"clear_planning":["start_by"],"clear_due_date":true}),
    );
    assert_eq!(
        clear.task.planning,
        Planning {
            importance: Some(Importance::Critical),
            estimated_minutes: Some(30),
            effort: Some(todo_mcp::task_planning::Effort::Medium),
            ..Planning::default()
        }
    );
    assert_eq!(clear.task.agent_notes, "Keep context");
    let replay: UpdateItem = input(
        json!({"request_id":"clear","task_id":edit2.task.id,"expected_version":edit2.task.version,"clear_planning":["start_by"],"clear_due_date":true,"reason":"Isolated planning edit"}),
    );
    assert!(s.update(replay).unwrap().replayed);
    let bad: UpdateItem = input(
        json!({"request_id":"bad","task_id":clear.task.id,"expected_version":clear.task.version,"estimated_minutes":30,"effort":"medium","importance":"high","clear_planning":["importance"],"reason":"Invalid clear"}),
    );
    assert!(s.update(bad).is_err());
    assert!(
        serde_json::from_value::<CaptureItem>(
            json!({"title":"wrong","request_id":"x","reason":"x","made_up":true})
        )
        .is_err()
    );
}
#[test]
fn blocks_validate_and_queries_match_overnight_overlap() {
    let (_d, mut s) = fixture();
    let t = capture(
        &mut s,
        "overnight",
        json!({"planned_start":moment("2090-05-01",Some("23:00")),"planned_finish":moment("2090-05-02",Some("01:00")),"due_date":"2090-04-01"}),
    );
    let r = s
        .list(input(
            json!({"planned_from":"2090-05-02","planned_through":"2090-05-02"}),
        ))
        .unwrap();
    assert_eq!(r.items[0].id, t.id);
    assert!(
        s.list(input(json!({"planned_from":"2090-05-03"})))
            .unwrap()
            .items
            .is_empty()
    );
    let bad: UpdateItem = input(
        json!({"request_id":"finish-first","task_id":t.id,"expected_version":t.version,"planned_finish":moment("2090-04-01",Some("01:00")),"reason":"Invalid block"}),
    );
    assert!(s.update(bad).is_err());
    assert_eq!(current(&mut s, &t.id).version, t.version);
}
#[test]
fn pagination_freezes_time_and_records_and_returns_global_boundary() {
    let (_d, mut s) = fixture();
    let a = capture(
        &mut s,
        "a",
        json!({"estimated_minutes":30,"effort":"medium","importance":"high"}),
    );
    let b = capture(
        &mut s,
        "b",
        json!({"estimated_minutes":30,"effort":"medium","importance":"low","planned_start":moment("2090-01-01",Some("12:00"))}),
    );
    let page = s.list(input(json!({"limit":1}))).unwrap();
    assert_eq!(page.items[0].id, a.id);
    assert!(page.next_change_at.is_some());
    edit(
        &mut s,
        &b,
        "b-important",
        json!({"estimated_minutes":30,"effort":"medium","importance":"critical"}),
    );
    let next = s
        .list(input(json!({"limit":1,"cursor":page.next_cursor})))
        .unwrap();
    assert_eq!(page.evaluated_at, next.evaluated_at);
    assert_eq!(next.items[0].planning.importance, Some(Importance::Low));
    assert_eq!(
        s.list(input(json!({"sort":"importance"}))).unwrap().items[0].id,
        b.id
    );
}
fn series(s: &mut Store) -> Task {
    s.create_recurrence(input(json!({"request_id":"repeat","rule":{"start_date":"2090-03-01","frequency":"daily","count":20},"template":{"title":"Repeat","due_offset_days":0,"estimated_minutes":30,"effort":"medium","importance":"high","deadline_time":{"time":"02:30"},"planned_start":{"offset_days":0,"time":"23:00"},"planned_finish":{"offset_days":1,"time":"01:00"}},"reason":"Test recurrence"}))).unwrap().task
}
#[test]
fn recurrence_defaults_preserve_omissions_overrides_and_started_is_individual() {
    let (_d, mut s) = fixture();
    let series = series(&mut s);
    s.materialize_recurrences("2090-03-03").unwrap();
    let first = s
        .list(input(json!({"sort":"created"})))
        .unwrap()
        .items
        .remove(0);
    let special = edit(
        &mut s,
        &first,
        "override",
        json!({"estimated_minutes":30,"effort":"medium","importance":"critical","started":true}),
    );
    s.update_recurrence(input(json!({"request_id":"edit-series","series_id":series.id,"expected_version":series.version,"scope":"all","action":"edit","template":{"title":"Updated","due_offset_days":0},"reason":"Old client edits ordinary defaults"}))).unwrap();
    let now = current(&mut s, &special.task.id);
    assert_eq!(now.planning.importance, Some(Importance::Critical));
    assert!(now.planning.started);
    assert!(now.planning.planned_finish.is_some());
    let rows = s.list(input(json!({"sort":"created"}))).unwrap().items;
    assert!(
        rows.iter()
            .skip(1)
            .all(|t| !t.planning.started && t.planning.importance == Some(Importance::High))
    );
    let read = s
        .list_occurrences(input(json!({"series_id":series.id})))
        .unwrap();
    assert_eq!(
        read["series"]["recurrence"]["segments"][0]["template"]["importance"],
        "high"
    );
}
#[test]
fn repeat_dst_adjustments_are_visible_and_do_not_duplicate_occurrences() {
    let rp: RepeatPlanning = input(json!({"start_by":{"offset_days":0,"time":"02:30"}}));
    let (p, notes) = rp.materialize("2026-03-08", None).unwrap();
    assert_eq!(p.start_by.unwrap().time.as_deref(), Some("03:30"));
    assert_eq!(notes.len(), 1);
    let rp: RepeatPlanning = input(json!({"start_by":{"offset_days":0,"time":"01:30"}}));
    let (p, notes) = rp.materialize("2026-11-01", None).unwrap();
    assert_eq!(p.start_by.unwrap().utc_offset_minutes, Some(-240));
    assert_eq!(notes.len(), 1);
    let (_d, mut s) = fixture();
    let t=s.create_recurrence(input(json!({"request_id":"dst","rule":{"start_date":"2090-03-01","frequency":"daily","count":20},"template":{"estimated_minutes":30,"effort":"medium","importance":"normal","title":"DST","start_by":{"offset_days":0,"time":"02:30"}},"reason":"Preview adjustment"}))).unwrap().task;
    let preview = s
        .list_occurrences(input(
            json!({"series_id":t.id,"from":"2090-03-01","limit":20}),
        ))
        .unwrap();
    assert!(preview["occurrences"].as_array().unwrap().iter().any(|r| {
        r["timing_adjustments"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
    }));
    s.materialize_recurrences("2090-03-20").unwrap();
    assert_eq!(s.materialize_recurrences("2090-03-20").unwrap(), 0);
}
#[test]
fn invalid_planning_rolls_back_the_whole_batch() {
    let (_d, mut s) = fixture();
    let t = capture(&mut s, "atomic", json!({}));
    let result=s.apply_changes(input(json!({"request_id":"batch","operations":[{"operation":"update","task_id":t.id,"expected_version":t.version,"estimated_minutes":30,"effort":"medium","importance":"high","reason":"First"},{"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Invalid","planned_finish":moment("2090-01-01",None),"reason":"Invalid"}]})));
    assert!(result.is_err());
    assert_eq!(current(&mut s, &t.id).version, t.version);
}

#[test]
fn adoption_preserves_unmentioned_planning_but_new_occurrences_are_unstarted() {
    let (_d, mut s) = fixture();
    let task = capture(
        &mut s,
        "Adopt",
        json!({"estimated_minutes":30,"effort":"medium","importance":"very_high","started":true,"planned_start":moment("2090-04-01",Some("13:00")),"planned_finish":moment("2090-04-01",Some("14:00"))}),
    );
    let series=s.create_recurrence(input(json!({"request_id":"adopt","task_id":task.id,"expected_task_version":task.version,"rule":{"start_date":"2090-04-01","frequency":"daily","count":2},"template":{"estimated_minutes":30,"effort":"medium","importance":"very_high","title":"Adopt"},"reason":"Legacy adoption"}))).unwrap().task;
    let kept = current(&mut s, &task.id);
    assert_eq!(kept.planning, task.planning);
    s.materialize_recurrences("2090-04-02").unwrap();
    let rows = s.list(input(json!({"view":"all"}))).unwrap().items;
    let second = rows.iter().find(|t| t.id != task.id).unwrap();
    assert!(!second.planning.started);
    assert_eq!(second.planning.importance, Some(Importance::VeryHigh));
    assert_eq!(second.occurrence.as_ref().unwrap().series_id, series.id);
}

#[test]
fn raw_preview_includes_resolved_timing_without_writing() {
    let (_d, mut s) = fixture();
    let result=s.list_occurrences(input(json!({"from":"2026-03-08","rule":{"start_date":"2026-03-08","frequency":"daily","count":1},"template":{"estimated_minutes":30,"effort":"medium","importance":"normal","title":"Preview","start_by":{"offset_days":0,"time":"02:30"}}}))).unwrap();
    assert_eq!(
        result["occurrences"][0]["planning"]["start_by"]["time"],
        "03:30"
    );
    assert_eq!(
        result["occurrences"][0]["timing_adjustments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        s.list(input(json!({"view":"all"})))
            .unwrap()
            .items
            .is_empty()
    );
}

#[test]
fn repeats_reject_future_dst_inversions_without_partial_writes() {
    let (_d, mut s) = fixture();
    let value = json!({"request_id":"dst-block","reason":"Test future clock change","rule":{"start_date":"2027-03-12","frequency":"daily","interval":1,"count":4},"template":{"estimated_minutes":30,"effort":"medium","importance":"normal","title":"Early block","status":"next","planned_start":{"offset_days":0,"time":"02:30"},"planned_finish":{"offset_days":0,"time":"03:00"}}});
    let error = s
        .create_recurrence(input(value.clone()))
        .unwrap_err()
        .to_string();
    assert!(error.contains("2027-03-14"), "{error}");
    assert!(error.contains("finish"), "{error}");
    assert_eq!(
        s.list_occurrences(input(json!({}))).unwrap()["series_list"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let mut valid = value;
    valid["template"]["planned_finish"]["time"] = json!("04:00");
    let series = s.create_recurrence(input(valid)).unwrap().task;
    let preview = s
        .list_occurrences(input(
            json!({"series_id":series.id,"from":"2027-03-14","through":"2027-03-14"}),
        ))
        .unwrap();
    assert_eq!(
        preview["occurrences"][0]["planning"]["planned_start"]["time"],
        "03:30"
    );
    assert_eq!(
        preview["occurrences"][0]["planning"]["planned_finish"]["time"],
        "04:00"
    );
    assert!(
        !preview["occurrences"][0]["timing_adjustments"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn planning_changes_reach_history_sync_and_survive_retry_and_undo() {
    let (_dir, mut store) = fixture();
    let task = capture(&mut store, "draft-application", json!({}));
    let checkpoint = store.sync_state(SyncState::default()).unwrap()["checkpoint"].clone();
    let fields = json!({"estimated_minutes":30,"effort":"medium","importance":"high","due_date":"2027-04-16","deadline_time":{"time":"12:00","timezone":"America/New_York"},"start_by":moment("2027-04-15",None),"planned_start":moment("2027-04-14",Some("14:00")),"planned_finish":moment("2027-04-14",Some("15:00")),"review_date":"2027-04-13","started":true});
    let change = edit(&mut store, &task, "conversational-update", fields.clone());
    let replay = edit(&mut store, &task, "conversational-update", fields);
    assert!(replay.replayed);
    assert_eq!(replay.change.id, change.change.id);
    assert!(change.change.before.as_ref().unwrap().planning.importance == Some(Importance::Normal));
    assert_eq!(change.change.after.planning, change.task.planning);
    let feed = store
        .sync_state(input(json!({"cursor":checkpoint})))
        .unwrap();
    let after = &feed["changes"][0]["after"];
    assert_eq!(after["importance"], "high");
    assert_eq!(after["planned_finish"]["time"], "15:00");
    assert_eq!(after["started"], true);
    assert!(after["started_at"].is_null());
    assert_eq!(
        store
            .list(input(json!({"view":"all"})))
            .unwrap()
            .items
            .len(),
        1
    );
    let undo=store.undo(input(json!({"request_id":"undo-planning","change_id":change.change.id,"expected_version":change.task.version,"reason":"Restore previous planning"}))).unwrap();
    assert_eq!(undo.task.planning, task.planning);
    assert_eq!(undo.task.due_date, task.due_date);
}
