mod support;
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{store::Store, view::ViewRequest};
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> T {
    support::input(v)
}
#[test]
fn composed_home_matches_pages_and_preloads_only_requested_human_details() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let mut ids = vec![];
    for i in 0..10 {
        ids.push(store.capture(decode(json!({"request_id":format!("task-{i}"),"title":format!("Action {i}"),"status":"next","notes":"Human description","agent_notes":"PRIVATE_SENTINEL","importance":"normal","estimated_minutes":30,"effort":"medium","reason":"Fixture"}))).unwrap().task.id);
    }
    for (loading, preload) in [
        ("on-demand", 0),
        ("featured", 1),
        ("top-three", 3),
        ("look-ahead", 0),
    ] {
        let view = store
            .home_view(decode::<ViewRequest>(
                json!({"view":"home","review_on":"2026-10-09","loading":loading}),
            ))
            .unwrap();
        assert!(!view.to_string().contains("PRIVATE_SENTINEL"));
        assert_eq!(view["revision"], 10);
        assert!(view["data"]["remaining"].is_null());
        for section in ["next", "waiting", "someday", "reviewTasks"] {
            assert_eq!(view["data"][section]["evaluated_at"], view["evaluated_at"]);
        }
        let tasks = view["data"]["next"]["items"].as_array().unwrap();
        assert_eq!(tasks.len(), 7);
        for (i, t) in tasks.iter().enumerate() {
            assert_eq!(t["id"], ids[i]);
            assert_eq!(t.get("notes").is_some(), i < preload);
            assert!(
                t["omitted_fields"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("agent_notes"))
            );
        }
        let rest=store.list(decode(json!({"status":"next","group_recurrences":true,"limit":7,"cursor":view["data"]["next"]["next_cursor"]}))).unwrap();
        assert_eq!(rest.items.len(), 3);
        assert_eq!(rest.evaluated_at, view["evaluated_at"].as_str().unwrap());
        assert_eq!(rest.items[0].id, ids[7]);
    }
}
#[test]
fn empty_home_distinguishes_undisplayed_work_and_project_review() {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let request = || decode(json!({"review_on":"2026-10-09"}));
    assert!(store.home_view(request()).unwrap()["data"]["remaining"].is_null());
    store.capture(decode(json!({"request_id":"inbox","title":"Clarify","importance":"normal","estimated_minutes":10,"effort":"low","reason":"Fixture"}))).unwrap();
    assert_eq!(
        store.home_view(request()).unwrap()["data"]["remaining"],
        "inbox"
    );
    store.create_project(decode(json!({"request_id":"project","title":"Review outcome","review_date":"2020-01-01","reason":"Fixture"}))).unwrap();
    let view = store.home_view(request()).unwrap();
    assert!(view["data"]["remaining"].is_null());
    assert_eq!(
        view["data"]["reviewProjects"]["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .home_view(decode(json!({"review_on":"invalid"})))
            .is_err()
    );
}
#[tokio::test]
async fn search_wait_does_not_own_writer_or_ordinary_read_connection() {
    use std::time::Duration;
    use todo_mcp::{application::Application, diagnostics::Diagnostics};
    let dir = TempDir::new().unwrap();
    let key = dir.path().join("key");
    std::fs::write(&key, "fixture").unwrap();
    // This integration-test process owns its environment; the other tests never
    // search or inspect search configuration.
    unsafe {
        std::env::set_var("TODO_SEARCH_URL", "http://127.0.0.1:1");
        std::env::set_var("TODO_SEARCH_KEY_FILE", key);
    }
    let app = Application::new(
        Store::open(dir.path().join("db")).unwrap(),
        Diagnostics::open(&dir.path().join("log"), "fixture").unwrap(),
    );
    let search_app = app.clone();
    let search = tokio::spawn(async move {
        search_app
            .execute("list_items", json!({"query":"fictional"}))
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(app.store.try_lock().is_ok());
    let read = tokio::time::timeout(Duration::from_secs(1), app.execute("list_items", json!({})))
        .await
        .unwrap()
        .unwrap();
    assert!(read["items"].as_array().unwrap().is_empty());
    assert!(search.await.unwrap().is_err());
    unsafe {
        std::env::remove_var("TODO_SEARCH_URL");
        std::env::remove_var("TODO_SEARCH_KEY_FILE");
    }
}
