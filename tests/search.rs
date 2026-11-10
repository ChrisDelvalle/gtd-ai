//! Synthetic HTTP search projection tests. No external service or production data.
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use todo_mcp::store::Store;

static ENV: Mutex<()> = Mutex::new(());
#[path = "support/search_mock.rs"]
mod search_mock;
use search_mock::Mock;
struct Fixture {
    temp: tempfile::TempDir,
    path: PathBuf,
    store: Store,
    mock: Mock,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("store.db");
        let key = temp.path().join("test-key");
        std::fs::write(&key, "synthetic-key").unwrap();
        let mock = Mock::start();
        unsafe {
            std::env::set_var("TODO_SEARCH_URL", &mock.url);
            std::env::set_var("TODO_SEARCH_KEY_FILE", key);
        }
        let store = Store::open(&path).unwrap();
        Self {
            temp,
            path,
            store,
            mock,
        }
    }
    fn capture(&mut self, title: &str) -> String {
        self.store.capture(serde_json::from_value(json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":uuid::Uuid::new_v4().to_string(),"title":title,"brief":"Review this search fixture.","reason":"Synthetic search test"})).unwrap()).unwrap().task.id
    }
    fn ready(&mut self) {
        for _ in 0..100 {
            self.store.index_once().unwrap();
            if self.store.search_health()["ready"] == true {
                return;
            }
        }
        panic!("worker did not publish the index");
    }
    fn state(&self, key: &str) -> Option<String> {
        use rusqlite::OptionalExtension;
        Connection::open(&self.path)
            .unwrap()
            .query_row("SELECT value FROM search_state WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .unwrap()
    }
    fn list(
        &mut self,
        args: Value,
    ) -> Result<todo_mcp::model::ListResult, todo_mcp::store::StoreError> {
        self.store.list(serde_json::from_value(args).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.temp.path();
        unsafe {
            std::env::remove_var("TODO_SEARCH_URL");
            std::env::remove_var("TODO_SEARCH_KEY_FILE");
        }
    }
}

#[test]
fn pending_task_survives_restart_without_resubmission() {
    let _env = ENV.lock().unwrap();
    let mut f = Fixture::new();
    f.capture("Durable apple");
    f.mock.state.lock().unwrap().hold = true;
    f.store.index_once().unwrap();
    let pending = f.state("inflight").unwrap();
    for _ in 0..3 {
        f.store.index_once().unwrap();
    }
    assert_eq!(f.mock.state.lock().unwrap().tasks.len(), 1);
    assert_eq!(pending, f.state("inflight").unwrap());
    f.store = Store::open(&f.path).unwrap();
    f.mock.state.lock().unwrap().hold = false;
    f.ready();
    assert_eq!(f.list(json!({"query":"apple"})).unwrap().items.len(), 1);
}
#[test]
fn lost_index_rebuilds_without_a_new_sqlite_change() {
    let _env = ENV.lock().unwrap();
    let mut f = Fixture::new();
    let id = f.capture("Recover orange");
    f.ready();
    let checkpoint = f.store.search_health()["store_checkpoint"].clone();
    f.mock.state.lock().unwrap().indices.clear();
    f.store.index_once().unwrap();
    assert_eq!(f.store.search_health()["ready"], false);
    f.ready();
    assert_eq!(f.store.search_health()["store_checkpoint"], checkpoint);
    assert_eq!(f.list(json!({"query":"orange"})).unwrap().items[0].id, id);
}
#[test]
fn query_validation_uses_tokens_and_rejects_operators_before_engine_access() {
    let _env = ENV.lock().unwrap();
    let mut f = Fixture::new();
    for query in [
        "%_",
        "\"quoted phrase\"",
        "word -excluded",
        "one two three four five six seven eight nine ten eleven",
        "a/b/c/d/e/f/g/h/i/j/k",
    ] {
        let error = f.list(json!({"query":query})).unwrap_err();
        assert_eq!(error.code(), "invalid_input", "{query}");
    }
    assert!(f.mock.state.lock().unwrap().tasks.is_empty());
    assert!(f.mock.state.lock().unwrap().searches.is_empty());
}
#[test]
fn paging_freezes_all_matches_beyond_engine_default_limit() {
    let _env = ENV.lock().unwrap();
    let mut f = Fixture::new();
    for start in (0..1001).step_by(50) {
        let operations: Vec<_> = (start..(start+50).min(1001)).map(|i| json!({"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":format!("Needle {i}"),"reason":"Synthetic search test"})).collect();
        f.store
            .apply_changes(
                serde_json::from_value(
                    json!({"request_id":format!("seed-{start}"),"operations":operations}),
                )
                .unwrap(),
            )
            .unwrap();
    }
    f.ready();
    let mut result = f.list(json!({"query":"needle","limit":100})).unwrap();
    let mut ids: Vec<_> = result.items.iter().map(|t| t.id.clone()).collect();
    while let Some(cursor) = result.next_cursor {
        result = f
            .list(json!({"query":"needle","limit":100,"cursor":cursor}))
            .unwrap();
        ids.extend(result.items.iter().map(|t| t.id.clone()));
    }
    assert_eq!(ids.len(), 1001);
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 1001);
    assert_eq!(
        f.mock.state.lock().unwrap().searches,
        vec![(0, 1000), (1000, 1000)]
    );
}
#[test]
fn document_batches_bound_payload_bytes_without_skipping_records() {
    let _env = ENV.lock().unwrap();
    let mut f = Fixture::new();
    let notes = "🧪".repeat(10_000);
    for i in 0..40 {
        f.store
            .capture(
                serde_json::from_value(json!({
                    "estimated_minutes":30,"effort":"medium","importance":"normal",
                    "request_id":format!("large-{i}"),
                    "title":format!("Needle {i}"),
                    "notes":notes,
                    "reason":"Synthetic search test"
                }))
                .unwrap(),
            )
            .unwrap();
    }
    f.ready();
    {
        let state = f.mock.state.lock().unwrap();
        let batches: Vec<_> = state
            .tasks
            .values()
            .filter(|t| t.path.ends_with("/documents"))
            .collect();
        assert_eq!(batches.len(), 2);
        assert!(
            batches
                .iter()
                .all(|t| serde_json::to_vec(&t.body).unwrap().len() <= 1024 * 1024)
        );
        assert_eq!(
            batches
                .iter()
                .map(|t| t.body.as_array().unwrap().len())
                .sum::<usize>(),
            40
        );
    }
    // Response-size safeguards may shorten pages independently of the requested limit.
    let mut page = f.list(json!({"query":"needle","limit":100})).unwrap();
    let mut count = page.items.len();
    while let Some(cursor) = page.next_cursor {
        page = f
            .list(json!({"query":"needle","limit":100,"cursor":cursor}))
            .unwrap();
        count += page.items.len();
    }
    assert_eq!(count, 40);
}
#[test]
fn published_snapshot_and_frozen_cursor_survive_new_generation_and_gc() {
    let _env = ENV.lock().unwrap();
    let mut f = Fixture::new();
    f.capture("Pear first");
    f.capture("Pear second");
    f.ready();
    let old: Value = serde_json::from_str(&f.state("active").unwrap()).unwrap();
    let first = f.list(json!({"query":"pear","limit":1})).unwrap();
    let cursor = first.next_cursor.unwrap();
    let new_id = f.capture("Pear third");
    f.mock.state.lock().unwrap().hold = true;
    f.store.index_once().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&f.state("active").unwrap()).unwrap(),
        old
    );
    let started = Instant::now();
    assert_eq!(
        f.list(json!({"query":"pear"})).unwrap_err().code(),
        "search_unavailable"
    );
    assert!(started.elapsed() < Duration::from_millis(4500));
    f.mock.state.lock().unwrap().hold = false;
    f.ready();
    f.store.index_once().unwrap();
    assert!(
        f.mock
            .state
            .lock()
            .unwrap()
            .indices
            .contains_key(old["index"].as_str().unwrap())
    );
    Connection::open(&f.path)
        .unwrap()
        .execute(
            "UPDATE search_state SET value=?1 WHERE key=?2",
            params![
                (chrono::Utc::now().timestamp() - 601).to_string(),
                format!("generation:{}", old["index"].as_str().unwrap())
            ],
        )
        .unwrap();
    f.store.index_once().unwrap();
    f.store.index_once().unwrap();
    assert!(
        !f.mock
            .state
            .lock()
            .unwrap()
            .indices
            .contains_key(old["index"].as_str().unwrap())
    );
    let second = f
        .list(json!({"query":"pear","limit":1,"cursor":cursor}))
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert_ne!(second.items[0].id, new_id);
    assert_ne!(second.items[0].id, first.items[0].id);
}
#[test]
fn expired_query_sessions_are_removed_on_an_unchanged_store() {
    let _env = ENV.lock().unwrap();
    let mut f = Fixture::new();
    f.capture("Plum");
    f.ready();
    Connection::open(&f.path)
        .unwrap()
        .execute(
            "INSERT INTO search_sessions VALUES('expired','test','plum',1,0,'[]')",
            [],
        )
        .unwrap();
    f.store.index_once().unwrap();
    let count: i64 = Connection::open(&f.path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM search_sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn lost_lease_cannot_publish_a_completed_generation() {
    let _env = ENV.lock().unwrap();
    let mut f = Fixture::new();
    f.capture("Fence apple");
    for _ in 0..20 {
        let job = f
            .state("inflight")
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        if job
            .as_ref()
            .is_some_and(|j| j["phase"] == "Documents" && !j["pending"].is_null())
        {
            break;
        }
        f.store.index_once().unwrap();
    }
    f.mock.state.lock().unwrap().stats_fence = Some(f.path.clone());
    assert_eq!(
        f.store.index_once().unwrap_err().code(),
        "search_unavailable"
    );
    assert!(f.state("active").is_none());
    assert_eq!(f.store.search_health()["ready"], false);
}
#[test]
fn indexing_wait_and_http_share_one_search_deadline() {
    let _env = ENV.lock().unwrap();
    let mut f = Fixture::new();
    f.capture("Deadline apple");
    f.ready();
    let index = serde_json::from_str::<Value>(&f.state("active").unwrap()).unwrap()["index"]
        .as_str()
        .unwrap()
        .to_owned();
    Connection::open(&f.path)
        .unwrap()
        .execute("INSERT INTO search_state VALUES('repair',?1)", [index])
        .unwrap();
    f.mock.state.lock().unwrap().delay = Duration::from_millis(1800);
    let path = f.path.clone();
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(3000));
        Connection::open(path)
            .unwrap()
            .execute("DELETE FROM search_state WHERE key='repair'", [])
            .unwrap();
    });
    let started = Instant::now();
    assert_eq!(
        f.list(json!({"query":"apple"})).unwrap_err().code(),
        "search_unavailable"
    );
    assert!(started.elapsed() < Duration::from_millis(4500));
    release.join().unwrap();
}
