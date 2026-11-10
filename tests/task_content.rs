use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{application::Application, diagnostics::Diagnostics, store::Store};
fn setup() -> (TempDir, Application) {
    let d = TempDir::new().unwrap();
    let a = Application::new(
        Store::open(d.path().join("db")).unwrap(),
        Diagnostics::open(&d.path().join("logs"), "test").unwrap(),
    );
    (d, a)
}
fn capture(key: &str) -> Value {
    json!({"request_id":key,"title":"Compare venue quotes","brief":"Compare the quotes and choose a venue.","notes":"Keep quiet access in the comparison.","agent_notes":"Quiet access matters for a family member; booking is not authorized.","importance":"normal","status":"next","estimated_minutes":60,"effort":"low","reason":"Disposable content fixture"})
}
async fn call(a: &Application, n: &str, v: Value) -> Value {
    a.execute(n, v).await.unwrap_or_else(|e| panic!("{n}: {e}"))
}
#[tokio::test]
async fn authoring_policy_and_inbox_clarification() {
    let (_d, a) = setup();
    let mut v = capture("one");
    v.as_object_mut().unwrap().remove("agent_notes");
    assert!(a.execute("capture_item", v.clone()).await.is_err());
    let task = a.execute_ui("capture_item", v).await.unwrap()["task"].clone();
    assert_eq!(task["brief"], "Compare the quotes and choose a venue.");
    let inbox=a.execute_ui("capture_item",json!({"request_id":"inbox","title":"Family photos","importance":"normal","reason":"Human capture"})).await.unwrap()["task"].clone();
    let patch = json!({"request_id":"clarify","task_id":inbox["id"],"expected_version":1,"status":"someday","brief":"Consider organizing the family photos.","reason":"Clarify fixture"});
    assert!(a.execute("update_item", patch.clone()).await.is_err());
    a.execute_ui("update_item", patch).await.unwrap();
    let mut bad = capture("missing-brief");
    bad.as_object_mut().unwrap().remove("brief");
    assert!(a.execute("capture_item", bad).await.is_err());
}
#[tokio::test]
async fn complete_context_is_paginated_and_cursors_are_audience_bound() {
    let (_d, a) = setup();
    for i in 0..3 {
        let mut v = capture(&format!("large-{i}"));
        v["notes"] = json!("x".repeat(10000));
        v["agent_notes"] = json!("🙂".repeat(10000));
        call(&a, "capture_item", v).await;
    }
    let page = call(
        &a,
        "list_items",
        json!({"view":"all","detail":"summary","include_agent_notes":false}),
    )
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["items"][0]["agent_notes"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        10000
    );
    assert_eq!(page["items"][0]["notes"].as_str().unwrap().len(), 10000);
    assert!(
        !page["items"][0]["detail_required"]
            .as_bool()
            .unwrap_or(false)
    );
    let cursor = page["next_cursor"].clone();
    assert!(
        a.execute_ui("list_items", json!({"view":"all","cursor":cursor}))
            .await
            .is_err()
    );
    let next = call(&a, "list_items", json!({"view":"all","cursor":cursor})).await;
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    let ui = a
        .execute_ui("list_items", json!({"view":"all"}))
        .await
        .unwrap();
    assert!(ui["items"][0].get("agent_notes").is_none());
}
#[tokio::test]
async fn patches_retries_atomicity_unicode_and_history() {
    let (_d, a) = setup();
    let v = capture("original");
    let r = call(&a, "capture_item", v.clone()).await;
    let id = &r["task"]["id"];
    assert_eq!(call(&a, "capture_item", v).await["replayed"], true);
    let good=call(&a,"update_item",json!({"request_id":"emoji","task_id":id,"expected_version":1,"brief":"🙂".repeat(600),"reason":"Boundary"})).await;
    assert!(a.execute("update_item",json!({"request_id":"too-long","task_id":id,"expected_version":2,"brief":"🙂".repeat(601),"reason":"Boundary"})).await.is_err());
    assert!(a.execute("update_item",json!({"request_id":"empty","task_id":id,"expected_version":2,"agent_notes":" ","reason":"Must not erase handoff"})).await.is_err());
    let before = call(&a, "list_items", json!({"task_id":id})).await;
    let bad = json!({"request_id":"batch","operations":[{"operation":"update","task_id":id,"expected_version":2,"title":"Changed","reason":"Atomic"},{"operation":"capture","title":"Invalid","importance":"normal","reason":"Atomic"}]});
    assert!(a.execute("apply_changes", bad).await.is_err());
    assert_eq!(
        call(&a, "list_items", json!({"task_id":id})).await["items"][0]["version"],
        before["items"][0]["version"]
    );
    let audit = call(
        &a,
        "list_changes",
        json!({"change_id":good["change"]["id"],"detail":"full"}),
    )
    .await;
    assert_eq!(
        audit["changes"][0]["before"]["brief"],
        "Compare the quotes and choose a venue."
    );
}
#[tokio::test]
async fn app_facade_uses_human_rules_without_a_caller_flag() {
    let (_d, a) = setup();
    let v =
        json!({"request_id":"human","title":"Milk","importance":"normal","reason":"Human capture"});
    assert!(a.execute("capture_item", v.clone()).await.is_err());
    let result = call(
        &a,
        "gtd_ui_write",
        json!({"operation":"capture_item","arguments":v}),
    )
    .await;
    assert!(result["task"]["id"].is_string());
    assert!(
        a.execute(
            "gtd_ui_read",
            json!({"operation":"capture_item","arguments":{}})
        )
        .await
        .is_err()
    );
    assert!(
        a.execute(
            "gtd_ui_write",
            json!({"operation":"capture_item","arguments":{},"human":true})
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn recurrence_brief_scope_and_complete_segment_reads() {
    let (_d, a) = setup();
    let s=call(&a,"create_recurrence",json!({"request_id":"series","template":{"title":"Weekly review","brief":"Review open commitments.","agent_notes":"A weekly check of the user's commitments.","importance":"normal","estimated_minutes":20,"effort":"low"},"rule":{"start_date":"2090-01-01","frequency":"daily","count":3},"reason":"Fixture"})).await;
    let id = &s["series"]["id"];
    let segments = call(
        &a,
        "list_occurrences",
        json!({"series_id":id,"segments_only":true}),
    )
    .await;
    assert_eq!(
        segments["segments"][0]["template"]["brief"],
        "Review open commitments."
    );
    call(&a,"update_recurrence",json!({"request_id":"split","series_id":id,"expected_version":1,"scope":"following","action":"edit","original_date":"2090-01-02","brief":"Review the changed commitments.","reason":"Fixture split"})).await;
    let segments = call(
        &a,
        "list_occurrences",
        json!({"series_id":id,"segments_only":true}),
    )
    .await;
    assert_eq!(segments["segments"].as_array().unwrap().len(), 2);
    call(&a,"update_recurrence",json!({"request_id":"repair-one","series_id":id,"expected_version":2,"scope":"segment","action":"edit","segment_from":"2090-01-01","brief":"Review the original commitments.","reason":"One segment only"})).await;
    let segments = call(
        &a,
        "list_occurrences",
        json!({"series_id":id,"segments_only":true}),
    )
    .await;
    assert_eq!(
        segments["segments"][1]["template"]["brief"],
        "Review the changed commitments."
    );
}

#[tokio::test]
async fn committed_legacy_retry_precedes_new_agent_validation() {
    let (_d, a) = setup();
    let old = json!({"request_id":"old-human-capture","title":"Inbox note","importance":"normal","reason":"Historical capture"});
    let saved = a.execute_ui("capture_item", old.clone()).await.unwrap();
    let replay = call(&a, "capture_item", old).await;
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["task"], saved["task"]);
    let empty = json!({"request_id":"clear-human","task_id":saved["task"]["id"],"expected_version":1,"agent_notes":"","brief":"","notes":"","reason":"Human clearing"});
    a.execute_ui("update_item", empty).await.unwrap_err(); // no change is not a new write
}

#[tokio::test]
async fn omitted_content_survives_rule_changes_independently_per_segment() {
    let (_d, a) = setup();
    let series=call(&a,"create_recurrence",json!({"request_id":"r","template":{"title":"Review","brief":"Review the first commitments.","agent_notes":"First shared context.","importance":"normal","estimated_minutes":15,"effort":"low"},"rule":{"start_date":"2090-01-01","frequency":"daily","count":6},"reason":"Fixture"})).await;
    let id = &series["series"]["id"];
    call(&a,"update_recurrence",json!({"request_id":"split-content","series_id":id,"expected_version":1,"action":"edit","scope":"following","original_date":"2090-01-03","template":{"title":"Review later work","brief":"Review the later commitments.","agent_notes":"Later shared context."},"reason":"Fixture"})).await;
    call(&a,"update_recurrence",json!({"request_id":"rule-only","series_id":id,"expected_version":2,"action":"edit","scope":"all","rule":{"start_date":"2090-01-01","frequency":"daily","interval":2,"count":6},"reason":"Change cadence only"})).await;
    let segments = call(
        &a,
        "list_occurrences",
        json!({"series_id":id,"segments_only":true}),
    )
    .await;
    assert_eq!(segments["segments"].as_array().unwrap().len(), 2);
    assert_eq!(
        segments["segments"][0]["template"]["brief"],
        "Review the first commitments."
    );
    assert_eq!(
        segments["segments"][1]["template"]["brief"],
        "Review the later commitments."
    );
    assert_eq!(
        segments["segments"][0]["template"]["agent_notes"],
        "First shared context."
    );
    assert_eq!(
        segments["segments"][1]["template"]["agent_notes"],
        "Later shared context."
    );
}

#[tokio::test]
async fn null_patches_sync_and_human_clear_keep_distinct_contracts() {
    let (_d, a) = setup();
    let created = call(&a, "capture_item", capture("sync")).await;
    let id = &created["task"]["id"];
    let snapshot = call(&a, "sync_state", json!({"limit":1})).await;
    assert_eq!(
        snapshot["records"][0]["agent_notes"],
        capture("x")["agent_notes"]
    );
    assert_eq!(snapshot["records"][0]["notes"], capture("x")["notes"]);
    let changed=call(&a,"update_item",json!({"request_id":"nulls","task_id":id,"expected_version":1,"title":"Compare two quotes","brief":null,"notes":null,"agent_notes":null,"reason":"Preserve all content"})).await;
    let delta = call(
        &a,
        "sync_state",
        json!({"limit":1,"cursor":snapshot["checkpoint"]}),
    )
    .await;
    for key in ["brief", "notes", "agent_notes"] {
        assert_eq!(delta["changes"][0]["after"][key], capture("x")[key]);
    }
    assert!(a.execute("update_item",json!({"request_id":"clear","task_id":id,"expected_version":2,"brief":"","reason":"Must not clear non-Inbox"})).await.is_err());
    let cleared=a.execute_ui("update_item",json!({"request_id":"human-clear","task_id":id,"expected_version":2,"agent_notes":"","reason":"Human clearing"})).await.unwrap();
    call(&a,"undo_change",json!({"request_id":"undo-human","change_id":cleared["change"]["id"],"expected_version":3,"reason":"Undo with historical handoff"})).await;
    assert_eq!(changed["task"]["version"], 2);
}

#[test]
fn local_url_limits_count_unicode_without_fetching() {
    let prefix = "https://example.com/";
    let good = format!("{prefix}{}", "é".repeat(2048 - prefix.chars().count()));
    assert!(todo_mcp::model::valid_resource_url(&good));
    assert!(!todo_mcp::model::valid_resource_url(&(good + "x")));
    assert!(!todo_mcp::model::valid_resource_url(
        "https://user:pass@example.com/"
    ));
    assert!(!todo_mcp::model::valid_resource_url("javascript:alert(1)"));
}
