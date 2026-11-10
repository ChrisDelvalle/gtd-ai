mod support;
use chrono::{Duration, Utc};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{model::*, recurrence_model::*, store::Store};

fn input<T: DeserializeOwned>(value: Value) -> T {
    support::input(value)
}
fn fixture() -> (TempDir, Store) {
    let dir = TempDir::new().unwrap();
    let store = Store::open(dir.path().join("recurrence-audit.db")).unwrap();
    (dir, store)
}
fn template(title: &str) -> Value {
    json!({"estimated_minutes":30,"effort":"medium","importance":"normal","title":title,"status":"next","due_offset_days":2,"review_offset_days":-1})
}
fn create(store: &mut Store, key: &str, rule: Value) -> MutationResult {
    store.create_recurrence(input(json!({"request_id":key,"template":template(key),"rule":rule,"reason":"Synthetic recurrence audit"}))).unwrap()
}
fn edit(series: &Task, key: &str, fields: Value) -> UpdateRecurrence {
    let mut args = json!({"request_id":key,"series_id":series.id,"expected_version":series.version,"scope":"all","action":"edit","reason":"Synthetic recurrence audit"});
    args.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    input(args)
}
fn occurrence(store: &mut Store, series: &Task, date: &str, key: &str) -> Task {
    store
        .update_recurrence(edit(
            series,
            key,
            json!({"scope":"this","original_date":date,"scheduled_date":date}),
        ))
        .unwrap()
        .task
}
fn current(store: &mut Store, task: &Task) -> Task {
    store
        .list(input(json!({"task_id":task.id,"include_deleted":true})))
        .unwrap()
        .items
        .remove(0)
}
fn scheduled(store: &mut Store, series: &Task) -> Vec<String> {
    store
        .list_occurrences(input(
            json!({"series_id":series.id,"from":"2090-01-01","through":"2091-01-01","limit":100}),
        ))
        .unwrap()["occurrences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["scheduled_date"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn offset_extreme_is_rejected_without_panicking_or_writing() {
    let (_dir, mut store) = fixture();
    let result = store.create_recurrence(input(json!({"request_id":"overflow","rule":{"start_date":"2090-01-01","frequency":"daily","count":3},"template":{"estimated_minutes":30,"effort":"medium","importance":"normal","title":"Overflow","due_offset_days":i32::MIN},"reason":"Synthetic bounds check"})));
    assert_eq!(result.unwrap_err().code(), "invalid_input");
    assert!(
        store.list_occurrences(ListOccurrences::default()).unwrap()["series_list"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn completed_occurrence_defaults_cannot_reopen_or_corrupt_completion_history() {
    let (_dir, mut store) = fixture();
    let series = create(
        &mut store,
        "completed-series",
        json!({"start_date":"2090-01-01","frequency":"daily","count":3}),
    )
    .task;
    let task = occurrence(&mut store, &series, "2090-01-01", "materialize");
    let completed = store.update(input(json!({"request_id":"complete","task_id":task.id,"expected_version":task.version,"status":"done","completion_result":"Verified outcome","reason":"Synthetic completion"}))).unwrap().task;
    let invalid = store.update_recurrence(edit(&series,"completed-defaults",json!({"scope":"this","original_date":"2090-01-01","expected_occurrence_version":completed.version,"template":template("Changed title")})));
    assert_eq!(invalid.unwrap_err().code(), "invalid_input");
    assert_eq!(current(&mut store, &task), completed);
    let moved = store.update_recurrence(edit(&series,"move-completed",json!({"scope":"this","original_date":"2090-01-01","expected_occurrence_version":completed.version,"scheduled_date":"2090-01-09"}))).unwrap().task;
    assert_eq!(moved.status, Status::Done);
    assert_eq!(moved.completed_at, completed.completed_at);
    assert_eq!(moved.completion_result, completed.completion_result);
}

#[test]
fn rescheduling_moves_only_inherited_dates_and_retains_the_exception() {
    let (_dir, mut store) = fixture();
    let series = create(
        &mut store,
        "date-series",
        json!({"start_date":"2090-01-01","frequency":"daily","count":4}),
    )
    .task;
    let task = occurrence(&mut store, &series, "2090-01-01", "materialize");
    let moved = store.update_recurrence(edit(&series,"move",json!({"scope":"this","original_date":"2090-01-01","expected_occurrence_version":task.version,"scheduled_date":"2090-01-10"}))).unwrap().task;
    assert_eq!(moved.due_date.as_deref(), Some("2090-01-12"));
    assert_eq!(moved.review_date.as_deref(), Some("2090-01-09"));
    let explicit = store.update(input(json!({"request_id":"deadline","task_id":task.id,"expected_version":moved.version,"due_date":"2090-02-01","reason":"Synthetic deadline exception"}))).unwrap().task;
    let moved = store.update_recurrence(edit(&series,"move-again",json!({"scope":"this","original_date":"2090-01-01","expected_occurrence_version":explicit.version,"scheduled_date":"2090-01-11"}))).unwrap().task;
    assert_eq!(moved.due_date.as_deref(), Some("2090-02-01"));
    assert_eq!(moved.review_date.as_deref(), Some("2090-01-10"));
    let replaced = store.update_recurrence(edit(&series,"replace-defaults",json!({"scope":"this","original_date":"2090-01-01","expected_occurrence_version":moved.version,"template":template("An explicit override"),"scheduled_date":"2090-01-15"}))).unwrap().task;
    assert_eq!(replaced.due_date.as_deref(), Some("2090-01-17"));
    assert_eq!(replaced.review_date.as_deref(), Some("2090-01-14"));
    assert_eq!(
        replaced
            .occurrence
            .as_ref()
            .unwrap()
            .overrides
            .iter()
            .filter(|field| *field == "scheduled_date")
            .count(),
        1
    );
    let replaced = store.update_recurrence(edit(&series,"replace-only",json!({"scope":"this","original_date":"2090-01-01","expected_occurrence_version":replaced.version,"template":template("Another title")}))).unwrap().task;
    assert!(
        replaced
            .occurrence
            .as_ref()
            .unwrap()
            .overrides
            .contains(&"scheduled_date".to_owned())
    );
}

#[test]
fn defaults_only_edits_preserve_later_rule_segments_and_count_anchors() {
    let (_dir, mut store) = fixture();
    let series = create(
        &mut store,
        "segmented",
        json!({"start_date":"2090-01-01","frequency":"daily","count":5}),
    )
    .task;
    let series = store.update_recurrence(edit(&series,"weekly-following",json!({"scope":"following","original_date":"2090-01-03","rule":{"start_date":"2090-01-03","frequency":"weekly","count":3}}))).unwrap().task;
    let expected = vec![
        "2090-01-01",
        "2090-01-02",
        "2090-01-03",
        "2090-01-10",
        "2090-01-17",
    ];
    assert_eq!(scheduled(&mut store, &series), expected);
    let series = store
        .update_recurrence(edit(
            &series,
            "all-title",
            json!({"template":template("All new title")}),
        ))
        .unwrap()
        .task;
    assert_eq!(scheduled(&mut store, &series), expected);
    assert_eq!(series.recurrence.as_ref().unwrap().segments.len(), 2);
    let series = store.update_recurrence(edit(&series,"following-title",json!({"scope":"following","original_date":"2090-01-02","template":template("Later title")}))).unwrap().task;
    assert_eq!(scheduled(&mut store, &series), expected);
    let segments = &series.recurrence.as_ref().unwrap().segments;
    assert_eq!(segments.len(), 3);
    assert_eq!(segments[1].rule.start_date, "2090-01-01");
    assert_eq!(segments[1].rule.count, Some(5));
    assert_eq!(segments[2].rule.frequency, Frequency::Weekly);
    assert_eq!(segments[0].template.title, "All new title");
    assert_eq!(segments[1].template.title, "Later title");
    assert_eq!(segments[2].template.title, "Later title");
}

#[test]
fn rule_rewrite_cannot_silently_reuse_an_occurrence_identity() {
    let (_dir, mut store) = fixture();
    let series = create(
        &mut store,
        "identity-series",
        json!({"start_date":"2090-01-02","frequency":"daily","count":10}),
    )
    .task;
    let tasks = ["2090-01-02", "2090-01-03", "2090-01-04"]
        .map(|date| occurrence(&mut store, &series, date, date));
    let result = store.update_recurrence(edit(
        &series,
        "backward-rule",
        json!({"rule":{"start_date":"2090-01-01","frequency":"daily","count":10}}),
    ));
    assert_eq!(result.unwrap_err().code(), "conflict");
    for task in tasks {
        assert_eq!(current(&mut store, &task), task);
    }
    assert_eq!(
        scheduled(&mut store, &series).first().unwrap(),
        "2090-01-02"
    );
}

#[test]
fn worker_limit_applies_across_series_and_catches_up_without_duplicates() {
    let (_dir, mut store) = fixture();
    let one = create(
        &mut store,
        "one",
        json!({"start_date":"2090-01-01","frequency":"daily","count":150}),
    )
    .task;
    let two = create(
        &mut store,
        "two",
        json!({"start_date":"2090-01-01","frequency":"daily","count":150}),
    )
    .task;
    assert_eq!(store.materialize_recurrences("2090-03-31").unwrap(), 100);
    assert_eq!(store.materialize_recurrences("2090-03-31").unwrap(), 80);
    assert_eq!(store.materialize_recurrences("2090-03-31").unwrap(), 0);
    for series in [one, two] {
        let mut cursor = Value::Null;
        let mut rows = vec![];
        loop {
            let page = store.list_occurrences(input(json!({"series_id":series.id,"from":"2090-01-01","through":"2090-03-31","limit":100,"cursor":cursor}))).unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() <= todo_mcp::projection::PAGE_BYTES);
            rows.extend(page["occurrences"].as_array().unwrap().clone());
            cursor = page["next_cursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(rows.len(), 90);
        assert!(rows.iter().all(|row| row["preview"] == false));
        let unique = rows
            .iter()
            .map(|row| row["original_date"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), 90);
    }
}

#[test]
fn following_requires_a_real_occurrence_identity() {
    let (_dir, mut store) = fixture();
    let series = create(
        &mut store,
        "weekly",
        json!({"start_date":"2090-01-01","frequency":"weekly","count":4}),
    )
    .task;
    let result = store.update_recurrence(edit(
        &series,
        "not-an-occurrence",
        json!({"scope":"following","original_date":"2090-01-03","template":template("Later")}),
    ));
    assert_eq!(result.unwrap_err().code(), "invalid_input");
    assert_eq!(
        scheduled(&mut store, &series),
        vec!["2090-01-01", "2090-01-08", "2090-01-15", "2090-01-22"]
    );
}

#[test]
fn controls_wait_for_elapsed_work_and_cannot_resume_an_ended_series() {
    let (_dir, mut store) = fixture();
    let today = Utc::now()
        .with_timezone(&chrono_tz::America::New_York)
        .date_naive();
    let series = create(&mut store,"backlog",json!({"start_date":(today-Duration::days(110)).to_string(),"frequency":"daily","count":120})).task;
    for action in ["pause", "end"] {
        let result = store.update_recurrence(edit(&series, action, json!({"action":action})));
        assert_eq!(result.unwrap_err().code(), "conflict");
    }
    let rewrite = store.update_recurrence(edit(
        &series,
        "rewrite",
        json!({"rule":{"start_date":today.to_string(),"frequency":"weekly"}}),
    ));
    assert_eq!(rewrite.unwrap_err().code(), "conflict");
    assert_eq!(
        store.materialize_recurrences(&today.to_string()).unwrap(),
        11
    );
    let paused = store
        .update_recurrence(edit(&series, "pause-caught-up", json!({"action":"pause"})))
        .unwrap()
        .task;
    let ended = store
        .update_recurrence(edit(&paused, "end-paused", json!({"action":"end"})))
        .unwrap()
        .task;
    assert_eq!(
        store
            .update_recurrence(edit(&ended, "resume-ended", json!({"action":"resume"})))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(
        store
            .materialize_recurrences(&(today + Duration::days(8)).to_string())
            .unwrap(),
        0
    );
}

#[test]
fn series_listing_and_occurrence_continuations_remain_snapshot_stable() {
    let (_dir, mut store) = fixture();
    let first = create(
        &mut store,
        "first",
        json!({"start_date":"2090-01-01","frequency":"daily","count":4}),
    )
    .task;
    let second = create(
        &mut store,
        "second",
        json!({"start_date":"2090-01-01","frequency":"daily","count":4}),
    )
    .task;
    let page = store.list_occurrences(input(json!({"limit":1}))).unwrap();
    assert_eq!(page["series_list"][0]["id"], first.id);
    let _third = create(
        &mut store,
        "third",
        json!({"start_date":"2090-01-01","frequency":"daily","count":4}),
    );
    let next = store
        .list_occurrences(input(json!({"cursor":page["next_cursor"],"limit":1})))
        .unwrap();
    assert_eq!(next["series_list"][0]["id"], second.id);
    assert_eq!(next["complete"], true);
    let page = store
        .list_occurrences(input(json!({"series_id":first.id,"limit":1})))
        .unwrap();
    let mut cursor: Value = serde_json::from_str(page["next_cursor"].as_str().unwrap()).unwrap();
    assert_eq!(cursor["from"], page["from"]);
    store
        .update_recurrence(edit(
            &first,
            "changed-after-page",
            json!({"template":template("Changed later")}),
        ))
        .unwrap();
    let next = store
        .list_occurrences(input(
            json!({"series_id":first.id,"cursor":page["next_cursor"],"limit":1}),
        ))
        .unwrap();
    assert_eq!(next["occurrences"][0]["scheduled_date"], "2090-01-02");
    assert_eq!(next["series"]["title"], "first");
    assert_eq!(next["from"], page["from"]);
    cursor["from"] = json!("2089-01-01");
    let tampered = store.list_occurrences(input(
        json!({"series_id":first.id,"cursor":serde_json::to_string(&cursor).unwrap(),"limit":1}),
    ));
    assert_eq!(tampered.unwrap_err().code(), "invalid_input");
}

#[test]
fn large_series_state_is_explicitly_omitted_but_retrievable() {
    let (_dir, mut store) = fixture();
    let series = store.create_recurrence(input(json!({"request_id":"large","rule":{"start_date":"2090-01-01","frequency":"daily","count":100},"template":{"estimated_minutes":30,"effort":"medium","importance":"normal","title":"Large","notes":"界".repeat(9000)},"reason":"Synthetic large record"}))).unwrap().task;
    let page = store
        .list_occurrences(input(
            json!({"series_id":series.id,"from":"2090-01-01","limit":100}),
        ))
        .unwrap();
    assert!(serde_json::to_vec(&page).unwrap().len() <= todo_mcp::projection::PAGE_BYTES);
    assert_eq!(page["series_omitted"], true);
    assert_eq!(page["series_detail"]["change_id"], series.last_change_id);
    let history = store
        .changes(input(
            json!({"change_id":page["series_detail"]["change_id"],"detail":"full"}),
        ))
        .unwrap();
    assert_eq!(
        history.changes[0]
            .after
            .recurrence
            .as_ref()
            .unwrap()
            .segments[0]
            .template
            .notes,
        "界".repeat(9000)
    );
}

#[test]
fn adopting_existing_task_preserves_identity_and_is_atomic_replayable_and_undoable() {
    let (_dir, mut store) = fixture();
    let original = store.capture(input(json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"capture","title":"Existing task","notes":"Original notes","reason":"Synthetic capture"}))).unwrap().task;
    let args: CreateRecurrence = input(
        json!({"request_id":"adopt","task_id":original.id,"expected_task_version":original.version,"template":template("Repeating task"),"rule":{"start_date":"2090-01-01","frequency":"daily","count":3},"reason":"Synthetic adoption"}),
    );
    let result = store.create_recurrence(args.clone()).unwrap();
    let adopted = current(&mut store, &original);
    assert_eq!(adopted.id, original.id);
    assert_eq!(adopted.version, original.version + 1);
    assert_eq!(adopted.created_at, original.created_at);
    assert_eq!(
        adopted.occurrence.as_ref().unwrap().original_date,
        "2090-01-01"
    );
    assert_eq!(
        adopted.occurrence.as_ref().unwrap().series_id,
        result.task.id
    );
    assert_eq!(adopted.due_date.as_deref(), Some("2090-01-03"));
    assert!(store.create_recurrence(args).unwrap().replayed);
    assert_eq!(current(&mut store, &original), adopted);
    let undone = store.undo(input(json!({"request_id":"undo-adoption","change_id":result.change.id,"expected_version":result.task.version,"reason":"Synthetic adoption reversal"}))).unwrap();
    let restored = current(&mut store, &original);
    assert!(restored.occurrence.is_none());
    assert_eq!(restored.title, original.title);
    assert_eq!(restored.notes, original.notes);
    assert!(
        store.list_occurrences(ListOccurrences::default()).unwrap()["series_list"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let redone = store.undo(input(json!({"request_id":"redo-adoption","change_id":undone.change.id,"expected_version":undone.task.version,"reason":"Synthetic adoption restoration"}))).unwrap();
    let adopted = current(&mut store, &original);
    assert_eq!(
        adopted.occurrence.as_ref().unwrap().series_id,
        result.task.id
    );
    assert_eq!(store.materialize_recurrences("2090-01-03").unwrap(), 2);
    assert_eq!(store.undo(input(json!({"request_id":"undo-with-later-children","change_id":redone.change.id,"expected_version":redone.task.version,"reason":"Synthetic retained-child guard"}))).unwrap_err().code(),"conflict");
    assert_eq!(current(&mut store, &original), adopted);
    let mut second: CreateRecurrence = input(
        json!({"request_id":"adopt-again","task_id":original.id,"expected_task_version":adopted.version,"template":template("Another"),"rule":{"start_date":"2090-01-01","frequency":"daily"},"reason":"Synthetic double adoption"}),
    );
    assert_eq!(
        store.create_recurrence(second.clone()).unwrap_err().code(),
        "conflict"
    );
    second.task_id = None;
    assert_eq!(
        store.create_recurrence(second).unwrap_err().code(),
        "invalid_input"
    );
    assert_eq!(
        store.list_occurrences(ListOccurrences::default()).unwrap()["series_list"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn project_transitions_consider_every_effective_segment_without_blocking_exhausted_ones() {
    let (_dir, mut store) = fixture();
    let a = store
        .create_project(input(
            json!({"request_id":"project-a","title":"A","reason":"Synthetic project"}),
        ))
        .unwrap()
        .task;
    let b = store
        .create_project(input(
            json!({"request_id":"project-b","title":"B","reason":"Synthetic project"}),
        ))
        .unwrap()
        .task;
    let mut defaults = template("Project series");
    defaults["project_id"] = json!(a.id);
    let series = store.create_recurrence(input(json!({"request_id":"project-series","template":defaults,"rule":{"start_date":"2090-01-01","frequency":"daily","count":4},"reason":"Synthetic project recurrence"}))).unwrap().task;
    defaults["project_id"] = json!(b.id);
    let series = store
        .update_recurrence(edit(
            &series,
            "later-project",
            json!({"scope":"following","original_date":"2090-01-03","template":defaults}),
        ))
        .unwrap()
        .task;
    let finish_a = json!({"request_id":"finish-a","project_id":a.id,"expected_version":a.version,"status":"done","reason":"Synthetic project finish"});
    assert_eq!(
        store
            .update_project(input(finish_a.clone()))
            .unwrap_err()
            .code(),
        "conflict"
    );
    assert_eq!(store.materialize_recurrences("2090-01-02").unwrap(), 2);
    let tasks = store
        .list(input(json!({"project_id":a.id,"view":"all"})))
        .unwrap()
        .items;
    assert_eq!(tasks.len(), 2);
    for task in tasks {
        store.update(input(json!({"request_id":format!("complete-{}",task.id),"task_id":task.id,"expected_version":task.version,"status":"done","reason":"Synthetic completion"}))).unwrap();
    }
    store.update_project(input(finish_a)).unwrap();
    assert_eq!(store.materialize_recurrences("2090-01-04").unwrap(), 2);
    assert_eq!(
        store
            .list(input(json!({"project_id":b.id})))
            .unwrap()
            .items
            .len(),
        2
    );
    assert_eq!(series.project_id.as_ref(), Some(&b.id));
    // The final segment's outer project field must not make a finite schedule
    // block project completion after all of its actual work is complete.
    let tasks = store
        .list(input(json!({"project_id":b.id,"view":"all"})))
        .unwrap()
        .items;
    for task in tasks {
        store.update(input(json!({"request_id":format!("complete-{}",task.id),"task_id":task.id,"expected_version":task.version,"status":"done","reason":"Synthetic completion"}))).unwrap();
    }
    store.update_project(input(json!({"request_id":"finish-b","project_id":b.id,"expected_version":b.version,"status":"done","reason":"Synthetic finite-series finish"}))).unwrap();
    assert_eq!(store.materialize_recurrences("2091-01-01").unwrap(), 0);
}

#[test]
fn skipped_and_undone_occurrences_reserve_their_original_identity() {
    let (_dir, mut store) = fixture();
    let series = create(
        &mut store,
        "skip-series",
        json!({"start_date":"2090-01-01","frequency":"daily","count":1}),
    )
    .task;
    assert_eq!(
        store
            .update_recurrence(edit(
                &series,
                "unskip-never-skipped",
                json!({"scope":"this","action":"unskip","original_date":"2090-01-01"})
            ))
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    let skipped = store
        .update_recurrence(edit(
            &series,
            "skip",
            json!({"scope":"this","action":"skip","original_date":"2090-01-01"}),
        ))
        .unwrap();
    let undone = store.undo(input(json!({"request_id":"undo-skip","change_id":skipped.change.id,"expected_version":skipped.task.version,"reason":"Synthetic occurrence removal"}))).unwrap();
    assert!(current(&mut store, &skipped.task).deleted);
    assert_eq!(store.materialize_recurrences("2090-01-01").unwrap(), 0);
    assert!(
        store
            .list_occurrences(input(
                json!({"series_id":series.id,"from":"2090-01-01","through":"2090-01-01"})
            ))
            .unwrap()["occurrences"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let restored = store.undo(input(json!({"request_id":"restore-skip","change_id":undone.change.id,"expected_version":undone.task.version,"reason":"Synthetic occurrence restoration"}))).unwrap();
    assert!(restored.task.occurrence.as_ref().unwrap().skipped);
    let unskipped = store.update_recurrence(edit(&series,"unskip",json!({"scope":"this","action":"unskip","original_date":"2090-01-01","expected_occurrence_version":restored.task.version}))).unwrap();
    assert_eq!(unskipped.task.id, skipped.task.id);
    assert!(!unskipped.task.occurrence.as_ref().unwrap().skipped);
    assert_eq!(store.materialize_recurrences("2090-01-01").unwrap(), 0);
}

#[test]
fn calendar_preview_and_adoption_use_real_rule_dates_and_count_from_the_start() {
    let (_dir, mut store) = fixture();
    let page = store.list_occurrences(input(json!({"rule":{"start_date":"2090-01-01","frequency":"weekly","weekdays":["MO"],"count":3},"from":"2090-01-03","through":"2090-02-01"}))).unwrap();
    let dates = page["occurrences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["scheduled_date"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(dates, vec!["2090-01-09", "2090-01-16"]);
    let original = store.capture(input(json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"weekday-task","title":"Weekly action","reason":"Synthetic adoption"}))).unwrap().task;
    let series = store.create_recurrence(input(json!({"request_id":"weekday-adopt","task_id":original.id,"expected_task_version":original.version,"template":template("Weekly action"),"rule":{"start_date":"2090-01-01","frequency":"weekly","weekdays":["MO"],"count":3},"reason":"Synthetic weekday adoption"}))).unwrap().task;
    assert_eq!(
        current(&mut store, &original)
            .occurrence
            .unwrap()
            .original_date,
        "2090-01-02"
    );
    assert_eq!(
        scheduled(&mut store, &series),
        vec!["2090-01-02", "2090-01-09", "2090-01-16"]
    );
    let monthly = store.list_occurrences(input(json!({"rule":{"start_date":"2090-01-31","frequency":"monthly","count":3},"from":"2090-01-01","through":"2090-06-01"}))).unwrap();
    let dates = monthly["occurrences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["scheduled_date"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(dates, vec!["2090-01-31", "2090-03-31", "2090-05-31"]);
}
