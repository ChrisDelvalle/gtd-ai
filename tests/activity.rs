use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{application::Application, diagnostics::Diagnostics, store::Store};
fn fixture() -> (TempDir, Application) {
    let d = TempDir::new().unwrap();
    let app = Application::new(
        Store::open(d.path().join("tasks.db")).unwrap(),
        Diagnostics::open(&d.path().join("logs.db"), "test").unwrap(),
    );
    (d, app)
}
fn capture(key: &str, status: &str) -> Value {
    json!({"request_id":key,"title":key,"brief":"Synthetic task.","agent_notes":"Disposable context.","importance":"normal","estimated_minutes":10,"effort":"low","status":status,"reason":"Fixture"})
}
async fn call(app: &Application, n: &str, v: Value) -> Value {
    app.execute_ui(n, v)
        .await
        .unwrap_or_else(|e| panic!("{n}: {e}"))
}
fn range() -> Value {
    let d = chrono::Utc::now()
        .with_timezone(&chrono_tz::America::New_York)
        .date_naive()
        .to_string();
    json!({"from":d,"through":d})
}
async fn chart(app: &Application, metric: &str) -> Value {
    let mut q = range();
    q["metric"] = json!(metric);
    call(app, "activity_summary", q).await
}
async fn undo(app: &Application, r: &Value, key: &str) -> Value {
    call(app,"undo_change",json!({"request_id":key,"change_id":r["change"]["id"],"expected_version":r["task"]["version"],"reason":"Fixture undo"})).await
}
#[tokio::test]
async fn completion_counts_history_corrections_and_snapshot_drilldowns() {
    let (_d, app) = fixture();
    let r = call(&app, "capture_item", capture("done", "done")).await;
    let original = chart(&app, "completed").await;
    assert_eq!(original["total"], 1);
    let history = call(&app, "list_changes", json!({"limit":1})).await;
    assert_eq!(history["changes"][0]["activity"]["category"], "completed");
    let undone = undo(&app, &r, "undo").await;
    assert_eq!(chart(&app, "completed").await["total"], 0);
    assert_eq!(chart(&app, "changes").await["total"], 2);
    let mut day = range();
    day["day"] = day["from"].clone();
    day["snapshot"] = original["snapshot"].clone();
    let frozen = call(&app, "activity_day", day).await;
    assert_eq!(frozen["total"], 1);
    assert_eq!(
        frozen["changes"][0]["activity"]["completion_eligible"],
        true
    );
    let redone = undo(&app, &undone, "redo").await;
    assert_eq!(chart(&app, "completed").await["total"], 1);
    let reopened=call(&app,"update_item",json!({"task_id":r["task"]["id"],"expected_version":redone["task"]["version"],"request_id":"reopen","reason":"Fixture","status":"next"})).await;
    assert_eq!(chart(&app, "completed").await["total"], 1);
    let complete=call(&app,"update_item",json!({"task_id":r["task"]["id"],"expected_version":reopened["task"]["version"],"request_id":"again","reason":"Fixture","status":"done","archived":true})).await;
    assert_eq!(chart(&app, "completed").await["total"], 1);
    assert_eq!(chart(&app, "changes").await["total"], 5);
    assert_eq!(complete["request_id"], "again");
}
#[tokio::test]
async fn frozen_history_pages_do_not_include_later_edits_or_different_audiences() {
    let (_d, app) = fixture();
    for i in 0..5 {
        call(&app, "capture_item", capture(&format!("task{i}"), "inbox")).await;
    }
    let first = call(&app, "list_changes", json!({"limit":2})).await;
    assert_eq!(first["changes"].as_array().unwrap().len(), 2);
    call(&app, "capture_item", capture("later", "inbox")).await;
    let mut ids = first["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_i64().unwrap())
        .collect::<Vec<_>>();
    let mut cursor = first["next_cursor"].clone();
    while !cursor.is_null() {
        let page = call(&app, "list_changes", json!({"limit":2,"cursor":cursor})).await;
        ids.extend(
            page["changes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["id"].as_i64().unwrap()),
        );
        cursor = page["next_cursor"].clone();
    }
    assert_eq!(ids, vec![5, 4, 3, 2, 1]);
    assert!(
        app.execute(
            "list_changes",
            json!({"limit":2,"cursor":first["next_cursor"]})
        )
        .await
        .is_err()
    );
    for bad in [
        json!({"days":0}),
        json!({"days":367}),
        json!({"days":7,"from":"2026-01-01"}),
        json!({"from":"2026-1-1"}),
        json!({"cursor":first["next_cursor"],"before_id":4}),
    ] {
        assert!(app.execute_ui("list_changes", bad).await.is_err());
    }
    assert!(
        call(&app, "list_changes", json!({"days":7})).await["changes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn request_results_preserve_receipts_freeze_records_and_never_fallback() {
    let (d, app) = fixture();
    let r = call(&app, "capture_item", capture("create", "inbox")).await;
    let db = rusqlite::Connection::open(d.path().join("tasks.db")).unwrap();
    let original: String = db
        .query_row("SELECT response FROM requests WHERE id='create'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let show = app
        .execute(
            "show_gtd",
            json!({"view":"results","from_request_ids":["create"]}),
        )
        .await
        .unwrap();
    assert_eq!(show["records"][0]["agent_notes"], "Disposable context.");
    assert_eq!(show["records"][0]["id"], r["task"]["id"]);
    let replay = call(&app, "capture_item", capture("create", "inbox")).await;
    assert!(replay["replayed"].as_bool().unwrap());
    assert_eq!(chart(&app, "changes").await["total"], 1);
    assert_eq!(
        original,
        db.query_row::<String, _, _>("SELECT response FROM requests WHERE id='create'", [], |r| r
            .get(0))
            .unwrap()
    );
    let deleted = undo(&app, &r, "remove").await;
    assert_eq!(deleted["task"]["deleted"], true);
    let results = call(
        &app,
        "request_results",
        json!({"from_request_ids":["create","remove"]}),
    )
    .await;
    assert_eq!(results["records"].as_array().unwrap().len(), 1);
    assert_eq!(results["records"][0]["deleted"], true);
    for bad in [
        json!({"from_request_ids":["unknown"]}),
        json!({"from_request_ids":[]}),
        json!({"from_request_ids":["create","create"]}),
    ] {
        assert!(app.execute_ui("request_results", bad).await.is_err());
    }
    assert!(app.execute("activity_summary", range()).await.is_err());
    assert_eq!(
        call(&app, "show_gtd", json!({"view":"charts"})).await["view"],
        "charts"
    );
}
#[tokio::test]
async fn recent_display_defaults_and_compact_prose_free_history() {
    let (_d, app) = fixture();
    for i in 0..7 {
        let mut q = capture(&format!("task{i}"), "done");
        q["notes"] = json!("x".repeat(10000));
        q["agent_notes"] = json!("y".repeat(10000));
        call(&app, "capture_item", q).await;
    }
    let show = call(&app, "show_tasks", json!({})).await;
    assert!(!show["items"].as_array().unwrap().is_empty());
    assert!(show["items"].as_array().unwrap().len() <= 5);
    assert_eq!(show["items"][0]["title"], "task6");
    assert!(!show["next_cursor"].is_null());
    let tasks = call(&app, "list_items", json!({})).await;
    assert!(tasks["items"].as_array().unwrap().is_empty());
    let h = call(&app, "list_changes", json!({"limit":100})).await;
    assert_eq!(h["changes"].as_array().unwrap().len(), 7);
    assert!(h["changes"][0]["after"].get("notes").is_none());
    assert!(h.to_string().len() < 32768);
    let mut q = range();
    q["metric"] = json!("changes");
    let c = call(&app, "activity_summary", q.clone()).await;
    q["snapshot"] = c["snapshot"].clone();
    q["day"] = q["from"].clone();
    assert_eq!(call(&app, "activity_day", q).await["total"], c["total"]);
}

#[tokio::test]
async fn mixed_batch_results_freeze_membership_and_record_revisions() {
    let (_d, app) = fixture();
    let mut task = capture("ignored", "next");
    task.as_object_mut().unwrap().remove("request_id");
    task["operation"] = json!("capture");
    let request = json!({"request_id":"mixed","operations":[task,
        {"operation":"create_project","title":"Project fixture","brief":"Deliver this fixture.","agent_notes":"Shared synthetic context.","reason":"Fixture"},
        {"operation":"create_recurrence","template":{"title":"Recurring fixture","brief":"Perform the fixture.","agent_notes":"Recurring context.","importance":"normal","estimated_minutes":10,"effort":"low","status":"next"},"rule":{"frequency":"daily","interval":1,"start_date":"2090-01-01"},"reason":"Fixture"}]});
    let committed = call(&app, "apply_changes", request.clone()).await;
    assert_eq!(committed["request_id"], "mixed");
    let first = call(
        &app,
        "request_results",
        json!({"from_request_ids":["mixed"],"limit":1}),
    )
    .await;
    let rows = committed["results"].as_array().unwrap();
    let task_id = rows[0]["entity_id"].clone();
    call(&app,"update_item",json!({"task_id":task_id,"expected_version":1,"request_id":"later-edit","title":"Later title","reason":"Fixture"})).await;
    let mut records = first["records"].as_array().unwrap().clone();
    let mut cursor = first["next_cursor"].clone();
    while !cursor.is_null() {
        let page = call(
            &app,
            "request_results",
            json!({"from_request_ids":["mixed"],"cursor":cursor,"limit":1}),
        )
        .await;
        records.extend(page["records"].as_array().unwrap().clone());
        cursor = page["next_cursor"].clone();
    }
    assert_eq!(records.len(), 3);
    assert_eq!(
        records.iter().find(|r| r["id"] == task_id).unwrap()["version"],
        1
    );
    assert!(records.iter().any(|r| r["entity_type"] == "project"));
    assert!(records.iter().any(|r| r["entity_type"] == "recurrence"));
    assert!(
        call(&app, "apply_changes", request).await["replayed"]
            .as_bool()
            .unwrap()
    );
    let latest = call(
        &app,
        "request_results",
        json!({"from_request_ids":["mixed","later-edit"]}),
    )
    .await;
    assert_eq!(latest["records"].as_array().unwrap().len(), 3);
    assert_eq!(latest["records"][0]["title"], "Later title");
    let history = call(&app, "list_changes", json!({"from_request_ids":["mixed"]})).await;
    assert_eq!(history["changes"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn automatic_readiness_does_not_count_but_is_available_in_day_details() {
    let (_d, app) = fixture();
    let a = call(&app, "capture_item", capture("prerequisite", "next")).await;
    let mut blocked = capture("dependent", "next");
    blocked["blocked_by"] = json!([a["task"]["id"]]);
    call(&app, "capture_item", blocked).await;
    call(&app,"update_item",json!({"task_id":a["task"]["id"],"expected_version":1,"request_id":"finish","status":"done","started":true,"due_date":"2090-01-01","reason":"Fixture"})).await;
    let c = chart(&app, "changes").await;
    assert_eq!(c["total"], 3);
    assert_eq!(c["automatic_count"], 1);
    assert_eq!(c["categories"]["completed"], 1);
    let mut day = range();
    day["day"] = day["from"].clone();
    day["metric"] = json!("changes");
    day["snapshot"] = c["snapshot"].clone();
    day["automatic"] = json!(true);
    let result = call(&app, "activity_day", day).await;
    assert_eq!(result["total"], 1);
    assert_eq!(result["changes"][0]["activity"]["automatic"], true);
}

#[tokio::test]
async fn recurrence_creation_and_scoped_defaults_classify_deliberate_and_automatic_changes() {
    let (_d, app) = fixture();
    let today = range()["from"].as_str().unwrap().to_owned();
    let defaults = json!({"title":"Daily fixture","brief":"Perform the fixture.","importance":"normal","estimated_minutes":10,"effort":"low","status":"next"});
    let created=call(&app,"create_recurrence",json!({"request_id":"series","template":defaults,"rule":{"frequency":"daily","interval":1,"start_date":today},"reason":"Fixture"})).await;
    let series = &created["series"];
    // Normal reads may materialize occurrences; the history read itself never does.
    call(&app, "list_items", json!({})).await;
    let before = chart(&app, "changes").await;
    assert_eq!(before["total"], 1);
    let mut replacement = defaults;
    replacement["due_offset_days"] = json!(2);
    let updated=call(&app,"update_recurrence",json!({"request_id":"schedule","series_id":series["id"],"expected_version":series["version"],"action":"edit","scope":"all","template":replacement,"reason":"Fixture"})).await;
    assert!(updated.get("series").is_some());
    let changes = call(
        &app,
        "list_changes",
        json!({"from_request_ids":["schedule"],"limit":100}),
    )
    .await;
    assert!(
        changes["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entity_type"] == "recurrence"
                && c["activity"]["category"] == "scheduling"
                && c["activity"]["automatic"] == false)
    );
    let first = call(&app, "list_changes", json!({"limit":100})).await;
    let second = call(&app, "list_changes", json!({"limit":100})).await;
    assert_eq!(first["changes"], second["changes"]);
}

#[tokio::test]
async fn day_pages_budget_the_nested_snapshot_and_keep_all_contributors() {
    let (_d, app) = fixture();
    for i in 0..35 {
        let mut q = capture(&format!("page-{i}"), "inbox");
        q["title"] = json!("Long readable title ".repeat(15));
        q["reason"] = json!("Recorded fixture context. ".repeat(25));
        call(&app, "capture_item", q).await;
    }
    let chart = chart(&app, "changes").await;
    let mut q = range();
    q["day"] = q["from"].clone();
    q["snapshot"] = chart["snapshot"].clone();
    q["metric"] = json!("changes");
    q["limit"] = json!(100);
    let mut seen = std::collections::BTreeSet::new();
    loop {
        let page = call(&app, "activity_day", q.clone()).await;
        assert!(serde_json::to_vec(&page).unwrap().len() <= 32768);
        for c in page["changes"].as_array().unwrap() {
            assert!(seen.insert(c["id"].as_i64().unwrap()));
        }
        if page["next_cursor"].is_null() {
            break;
        }
        q["cursor"] = page["next_cursor"].clone();
    }
    assert_eq!(seen.len(), 35);
}

#[tokio::test]
async fn result_sort_uses_frozen_records_and_continues_with_canonical_default() {
    let (_d, app) = fixture();
    let z = call(&app, "capture_item", capture("Zulu", "inbox")).await;
    call(&app, "capture_item", capture("Alpha", "inbox")).await;
    let q = json!({"from_request_ids":["Zulu","Alpha"],"limit":1});
    let initial = call(&app, "request_results", q.clone()).await;
    let mut next = q.clone();
    next["cursor"] = initial["next_cursor"].clone();
    next["sort"] = json!("result_order");
    assert_eq!(
        call(&app, "request_results", next).await["records"][0]["title"],
        "Zulu"
    );
    call(&app,"update_item",json!({"task_id":z["task"]["id"],"expected_version":1,"title":"Aardvark","reason":"Fixture","request_id":"rename"})).await;
    let mut sorted = q;
    sorted["sort"] = json!("title");
    sorted["snapshot"] = initial["snapshot"].clone();
    let first = call(&app, "request_results", sorted.clone()).await;
    assert_eq!(first["records"][0]["title"], "Alpha");
    sorted.as_object_mut().unwrap().remove("snapshot");
    sorted["cursor"] = first["next_cursor"].clone();
    assert_eq!(
        call(&app, "request_results", sorted).await["records"][0]["title"],
        "Zulu"
    );
}
