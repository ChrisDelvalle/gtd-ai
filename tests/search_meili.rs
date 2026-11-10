//! Optional real-engine contract tests, isolated by a fresh SQLite store identity.
//! Run against a disposable local Meilisearch with:
//! GTD_TEST_MEILI_URL=http://127.0.0.1:17700 \
//! GTD_TEST_MEILI_KEY_FILE=/path/to/key cargo test --test search_meili -- --ignored --test-threads=1
//! Normal cargo test does not require Meilisearch. Search state-machine regressions
//! run independently against synthetic HTTP in tests/search.rs.
mod support;
use reqwest::{Method, blocking::Client};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use todo_mcp::{
    application::Application, diagnostics::Diagnostics, model::*, projection, store::Store,
};

static ENV: Mutex<()> = Mutex::new(());
fn input<T: DeserializeOwned>(value: Value) -> T {
    support::input(value)
}
struct Fixture {
    store: Store,
    dir: tempfile::TempDir,
    client: Client,
    url: String,
    token: String,
    prefix: String,
    previous: [Option<OsString>; 2],
    _guard: MutexGuard<'static, ()>,
}
impl Fixture {
    fn new() -> Self {
        let guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let url = std::env::var("GTD_TEST_MEILI_URL")
            .expect("Set GTD_TEST_MEILI_URL to a disposable local Meilisearch");
        let parsed = url::Url::parse(&url).expect("Invalid disposable test URL");
        assert!(matches!(
            parsed.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]")
        ));
        let key_file = std::env::var_os("GTD_TEST_MEILI_KEY_FILE")
            .expect("Set GTD_TEST_MEILI_KEY_FILE for the disposable test engine");
        let token = std::fs::read_to_string(&key_file).expect("Cannot read disposable engine key");
        let previous = [
            std::env::var_os("TODO_SEARCH_URL"),
            std::env::var_os("TODO_SEARCH_KEY_FILE"),
        ];
        unsafe {
            std::env::set_var("TODO_SEARCH_URL", &url);
            std::env::set_var("TODO_SEARCH_KEY_FILE", &key_file);
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.db");
        let store = Store::open(&path).unwrap();
        let identity: String = Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT value FROM store_meta WHERE key='identity'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        Self {
            store,
            dir,
            url: url.trim_end_matches('/').into(),
            token: token.trim().into(),
            prefix: format!("gtd_{}_v1_", identity.replace('-', "")),
            previous,
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            _guard: guard,
        }
    }
    fn api(&self, method: Method, path: &str) -> Value {
        let response = self
            .client
            .request(method, format!("{}{path}", self.url))
            .bearer_auth(&self.token)
            .send()
            .expect("Disposable engine request failed");
        assert!(
            response.status().is_success(),
            "Disposable engine status {}",
            response.status()
        );
        response.json().expect("Invalid disposable engine JSON")
    }
    fn wait_task(&self, uid: i64) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let result = self.api(Method::GET, &format!("/tasks/{uid}"));
            match result["status"].as_str() {
                Some("succeeded") => return,
                Some("enqueued" | "processing") => {}
                _ => panic!("Disposable engine task did not succeed"),
            }
            assert!(
                Instant::now() < deadline,
                "Disposable engine task timed out"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn ready(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            self.store.index_once().unwrap();
            if self.store.search_health()["ready"] == true {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "Search worker did not publish its generation"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn capture(&mut self, fields: Value) -> Task {
        let mut args = json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":uuid::Uuid::new_v4().to_string(),"title":"Synthetic search task","reason":"Disposable Meili regression"});
        args.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        self.store.capture(input(args)).unwrap().task
    }
    fn project(&mut self, title: &str) -> Task {
        self.store.create_project(input(json!({"request_id":uuid::Uuid::new_v4().to_string(),"title":title,"reason":"Disposable Meili regression"}))).unwrap().task
    }
    fn update(&mut self, task: &Task, fields: Value) -> Task {
        let mut args = json!({"request_id":uuid::Uuid::new_v4().to_string(),"task_id":task.id,"expected_version":task.version,"reason":"Disposable Meili update"});
        args.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        self.store.update(input(args)).unwrap().task
    }
    fn list(&mut self, args: Value) -> ListResult {
        self.store.list(input(args)).unwrap()
    }
    fn app(&self) -> Application {
        Application::new(
            Store::open(self.dir.path().join("tasks.db")).unwrap(),
            Diagnostics::open(&self.dir.path().join("diagnostics.db"), "test").unwrap(),
        )
    }
    fn active(&self) -> Value {
        let raw: String = Connection::open(self.dir.path().join("tasks.db"))
            .unwrap()
            .query_row(
                "SELECT value FROM search_state WHERE key='active'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Delete only indexes belonging to this freshly created store identity.
        if let Ok(response) = self
            .client
            .get(format!("{}/indexes?limit=1000", self.url))
            .bearer_auth(&self.token)
            .send()
            && let Ok(value) = response.json::<Value>()
            && let Some(indexes) = value["results"].as_array()
        {
            for index in indexes {
                if let Some(uid) = index["uid"]
                    .as_str()
                    .filter(|uid| uid.starts_with(&self.prefix))
                {
                    let _ = self
                        .client
                        .delete(format!("{}/indexes/{uid}", self.url))
                        .bearer_auth(&self.token)
                        .send();
                }
            }
        }
        for (name, value) in ["TODO_SEARCH_URL", "TODO_SEARCH_KEY_FILE"]
            .into_iter()
            .zip(&self.previous)
        {
            unsafe {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

#[test]
#[ignore = "requires explicitly configured disposable local Meilisearch"]
fn forgiving_matching_preserves_all_words_title_priority_and_exact_filters() {
    let mut f = Fixture::new();
    let project = f.project("Café orchestra project");
    let notes = f.capture(json!({"title":"Prepare paperwork","notes":"Café orchestra rehearsal"}));
    let title = f.capture(json!({"title":"Café orchestra rehearsal","status":"next","due_date":"2026-10-04","project_id":project.id}));
    let waiting = f.capture(
        json!({"title":"Café orchestra rehearsal","status":"waiting","due_date":"2026-10-05"}),
    );
    let archived = f.capture(json!({"title":"Café orchestra rehearsal","archived":true}));
    f.ready();
    for query in ["cafe orchestra", "orchestra cafe", "orchstra", "rehear"] {
        let page = f.list(json!({"query":query}));
        assert!(page.items.iter().any(|t| t.id == title.id), "{query}");
        assert!(
            !page
                .items
                .iter()
                .any(|t| t.id == archived.id || t.id == project.id)
        );
    }
    let page = f.list(json!({"query":"cafe orchestra"}));
    let rank = |id: &str| page.items.iter().position(|t| t.id == id).unwrap();
    assert!(
        rank(&title.id) < rank(&notes.id),
        "Title matches should outrank notes matches"
    );
    assert!(
        f.list(json!({"query":"cafe nonexistentingredient"}))
            .items
            .is_empty()
    );
    let exact = f.list(json!({"query":"orchstra","status":"next","due_from":"2026-10-04","due_through":"2026-10-04","project_id":project.id}));
    assert_eq!(
        exact.items.iter().map(|t| &t.id).collect::<Vec<_>>(),
        vec![&title.id]
    );
    let selected = f.list(json!({"query":"cafe","task_ids":[waiting.id]}));
    assert_eq!(selected.items[0].id, waiting.id);
    assert_eq!(selected.items.len(), 1);
    assert_eq!(
        f.list(json!({"query":"cafe","archived":true})).items[0].id,
        archived.id
    );
    let projects = f
        .store
        .projects(input(json!({"query":"orchestra cafe"})))
        .unwrap();
    assert_eq!(projects["projects"].as_array().unwrap().len(), 1);
    assert_eq!(projects["projects"][0]["id"], project.id);
}

#[test]
#[ignore = "requires explicitly configured disposable local Meilisearch"]
fn agent_working_documents_are_searchable_below_human_content_without_preview_leakage() {
    let mut f = Fixture::new();
    let working =
        f.capture(json!({"title":"Plan a review","agent_notes":"Café orchestra rehearsal"}));
    let notes = f.capture(json!({"title":"Read the proposal","notes":"Café orchestra rehearsal"}));
    let title = f.capture(json!({"title":"Café orchestra rehearsal"}));
    let project = f.store.create_project(input(json!({"request_id":"notes-project","title":"Finish the proposal","agent_notes":"Café orchestra project evidence","reason":"Disposable agent-note search"}))).unwrap().task;
    f.ready();
    let page = f.list(json!({"query":"orchestra cafe"}));
    let rank = |id: &str| page.items.iter().position(|t| t.id == id).unwrap();
    assert!(rank(&title.id) < rank(&notes.id));
    assert!(rank(&notes.id) < rank(&working.id));
    let app = f.app();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let response = runtime
        .block_on(app.execute_ui(
            "list_items",
            json!({"query":"orchestra cafe","task_ids":[working.id],"detail":"full"}),
        ))
        .unwrap();
    assert_eq!(response["items"][0]["has_agent_notes"], true);
    assert!(response["items"][0].get("agent_notes").is_none());
    assert!(!response.to_string().contains("Café orchestra rehearsal"));
    let projects = runtime
        .block_on(app.execute_ui(
            "list_projects",
            json!({"query":"evidence cafe","detail":"full"}),
        ))
        .unwrap();
    assert_eq!(projects["projects"][0]["id"], project.id);
    assert!(projects["projects"][0].get("agent_notes").is_none());
    let complete = runtime.block_on(app.execute("list_items", json!({"task_ids":[working.id],"query":"orchestra cafe","detail":"summary","include_agent_notes":false}))).unwrap();
    assert_eq!(complete["items"][0]["agent_notes"], working.agent_notes);
    assert_eq!(complete["items"][0]["notes"], working.notes);
    assert_eq!(complete["items"][0]["brief"], working.brief);
    f.update(
        &working,
        json!({"agent_notes":"Replacement sapphire evidence"}),
    );
    f.ready();
    assert!(
        f.list(json!({"query":"orchestra cafe"}))
            .items
            .iter()
            .all(|t| t.id != working.id)
    );
    assert_eq!(
        f.list(json!({"query":"sapphire evidence"})).items[0].id,
        working.id
    );
}

#[test]
#[ignore = "requires explicitly configured disposable local Meilisearch"]
fn long_notes_context_and_completion_fields_are_searchable_with_compact_summaries() {
    let mut f = Fixture::new();
    let task = f.capture(json!({"title":"Review the proposal","brief":"Confirm zirconium delivery.","status":"next","due_date":"2026-10-05",
        "notes":format!("{} ultramarine", "ordinary ".repeat(1000)),
        "links":[{"url":"https://example.com/form?ticket=blue%20cedar","label":"Application"}],
        "location":"10 Main St, New York",
        "work_sessions":[{"url":"https://calendar.google.com/calendar/event?eid=reserved-research-block","label":"Focused research appointment"}]}));
    let completed = f.capture(json!({"title":"Finished experiment","status":"done","completion_result":"Crystalline specimen delivered"}));
    f.capture(json!({"title":"Unrelated task"}));
    f.ready();
    let app = f.app();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for query in [
        "ultramarine",
        "zirconium",
        "Application",
        "example.com/form",
        "Main St",
        "Focused research",
        "reserved-research-block",
        "blue cedar",
    ] {
        let page = runtime
            .block_on(app.execute_ui(
                "list_items",
                json!({"query":query,"due_from":"2026-10-04","due_through":"2026-10-06"}),
            ))
            .unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 1, "{query}");
        let item = &page["items"][0];
        assert_eq!(item["id"], task.id);
        assert_eq!(item["link_count"], 1);
        assert_eq!(item["work_session_count"], 1);
        assert_eq!(item["has_location"], true);
        for field in ["notes", "links", "work_sessions", "location"] {
            assert!(item.get(field).is_none());
        }
    }
    let full = runtime
        .block_on(app.execute_ui("list_items", json!({"task_id":task.id})))
        .unwrap();
    assert_eq!(full["items"][0]["notes"], task.notes);
    assert_eq!(
        f.list(json!({"query":"crystalline","status":"done"})).items[0].id,
        completed.id
    );
}

#[test]
#[ignore = "requires explicitly configured disposable local Meilisearch"]
fn query_limits_reject_dropped_words_and_punctuation_without_placeholder_results() {
    let mut f = Fixture::new();
    let terms = "amber birch cobalt delta elm fox grove harbor iris jade";
    let task = f.capture(json!({"title":terms}));
    f.ready();
    assert_eq!(f.list(json!({"query":terms})).items[0].id, task.id);
    for query in [
        format!("{terms} kestrel"),
        "a/b/c/d/e/f/g/h/i/j/k".into(),
        "%_".into(),
        "\"amber\"".into(),
        "amber -birch".into(),
    ] {
        assert_eq!(
            f.store
                .list(input(json!({"query":query})))
                .unwrap_err()
                .code(),
            "invalid_input"
        );
    }
    // Long words and punctuation must never drop a required term or turn a
    // request into an empty/placeholder search.
    for query in [
        "я".repeat(500),
        format!("amber {}", "я".repeat(490)),
        format!("{} amber", "я".repeat(490)),
        "amber!nonexistentingredient".into(),
        "amber/nonexistentingredient".into(),
        "amber&nonexistentingredient".into(),
        "amber,-nonexistentingredient".into(),
        "amber|nonexistentingredient".into(),
    ] {
        match f.store.list(input(json!({"query":query}))) {
            Ok(page) => assert!(
                page.items.is_empty(),
                "A required term was dropped: {query}"
            ),
            Err(error) => assert_eq!(error.code(), "invalid_input"),
        }
    }
}

#[test]
#[ignore = "requires explicitly configured disposable local Meilisearch"]
fn a_fresh_search_waits_for_its_starting_database_checkpoint() {
    let mut f = Fixture::new();
    f.capture(json!({"title":"Existing orchard"}));
    f.ready();
    let previous = f.active()["high"].as_i64().unwrap();
    let fresh = f.capture(json!({"title":"Fresh marigold"}));
    let path = f.dir.path().join("tasks.db");
    let worker = thread::spawn(move || {
        let mut store = Store::open(path).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            store.index_once().unwrap();
            if store.search_health()["ready"] == true {
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(100));
        }
    });
    let started = Instant::now();
    let result = f.list(json!({"query":"marigold"}));
    worker.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].id, fresh.id);
    assert!(f.active()["high"].as_i64().unwrap() > previous);
}

#[test]
#[ignore = "requires explicitly configured disposable local Meilisearch"]
fn large_result_sets_freeze_ranking_and_revisions_across_updates_and_rebuilds() {
    let mut f = Fixture::new();
    let mut tasks = Vec::new();
    for start in (0..1005).step_by(50) {
        let operations: Vec<_> = (start..(start+50).min(1005)).map(|i| json!({"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":format!("Saffron orchard {i}"),"reason":"Disposable bulk fixture"})).collect();
        tasks.extend(
            f.store
                .apply_changes(input(
                    json!({"request_id":format!("seed-{start}"),"operations":operations}),
                ))
                .unwrap()
                .results
                .into_iter()
                .map(|r| r.task),
        );
    }
    f.ready();
    let initial = f.active();
    let first = f.list(json!({"query":"saffron","limit":100}));
    let changed = tasks
        .iter()
        .find(|t| !first.items.iter().any(|v| v.id == t.id))
        .unwrap()
        .clone();
    f.update(&changed, json!({"title":"Replacement vermilion"}));
    let appended = f.capture(json!({"title":"Saffron new orchard"}));
    f.ready();
    assert!(f.active()["high"].as_i64().unwrap() > initial["high"].as_i64().unwrap());
    let mut page = first;
    let mut frozen = Vec::new();
    loop {
        frozen.extend(page.items);
        let Some(cursor) = page.next_cursor else {
            break;
        };
        page = f.list(json!({"query":"saffron","limit":100,"cursor":cursor}));
    }
    assert_eq!(frozen.len(), 1005);
    assert_eq!(
        frozen
            .iter()
            .map(|t| &t.id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        1005
    );
    assert_eq!(
        frozen.iter().find(|t| t.id == changed.id).unwrap().version,
        changed.version
    );
    assert_eq!(
        frozen.iter().find(|t| t.id == changed.id).unwrap().title,
        changed.title
    );
    assert!(!frozen.iter().any(|t| t.id == appended.id));
    assert!(
        f.list(json!({"query":"saffron","task_id":changed.id}))
            .items
            .is_empty()
    );
    assert_eq!(f.list(json!({"query":"vermilion"})).items[0].id, changed.id);
    let active = f.active();
    let uid = f.api(
        Method::DELETE,
        &format!("/indexes/{}", active["index"].as_str().unwrap()),
    )["taskUid"]
        .as_i64()
        .unwrap();
    f.wait_task(uid);
    f.ready();
    assert_eq!(f.active()["high"], active["high"]);
    assert_eq!(f.list(json!({"query":"vermilion"})).items[0].id, changed.id);
}

#[test]
#[ignore = "requires explicitly configured disposable local Meilisearch"]
fn serialized_search_page_budget_includes_query_and_filter_bound_cursor() {
    let mut f = Fixture::new();
    let query = "alphabetical ".repeat(10).trim().to_owned();
    let title = format!("{} {}", query, "🧭".repeat(370));
    let mut ids = Vec::new();
    for _ in 0..50 {
        ids.push(f.capture(json!({"title":title})).id);
    }
    f.ready();
    let app = f.app();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = runtime
        .block_on(app.execute(
            "list_items",
            json!({"task_ids":ids,"query":query,"limit":50}),
        ))
        .unwrap();
    assert!(serde_json::to_vec(&result).unwrap().len() <= projection::PAGE_BYTES);
    assert!(result["next_cursor"].is_string());
}
