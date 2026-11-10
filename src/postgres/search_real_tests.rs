//! Actual pinned Meilisearch and PostgreSQL, both disposable and loopback-only.
use super::{
    tests::{fixture, principal},
    write_tests::{capture, input, patch, run},
    *,
};
use crate::{
    model::ListItems,
    store::{content::Policy, mutation::Operation},
};
use serde_json::{Value, json};
use std::{
    process::Command,
    thread,
    time::{Duration, Instant},
};
const IMAGE: &str = "getmeili/meilisearch:v1.54.3@sha256:e68913ab7d6f5b159529e472cfd362ce3c741fafd3c127961b2142abbe41b3c9";
struct EngineFixture {
    name: String,
    url: String,
    key: String,
    client: reqwest::blocking::Client,
}
impl Drop for EngineFixture {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", &self.name])
            .output();
    }
}
impl EngineFixture {
    fn start() -> Self {
        let name = format!("gtd-search-checkpoint-{}", Uuid::new_v4().simple());
        let key = Uuid::new_v4().simple().to_string();
        let out = Command::new("docker")
            .args([
                "run",
                "--detach",
                "--rm",
                "--pull",
                "never",
                "--name",
                &name,
                "--label",
                "gtd.environment=disposable-storage-checkpoint",
                "--publish",
                "127.0.0.1::7700",
                "--read-only",
                "--user",
                "1000:1000",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--memory",
                "512m",
                "--cpus",
                "1",
                "--pids-limit",
                "128",
                "--tmpfs",
                "/meili_data:rw,size=256m,uid=1000,gid=1000",
                "--tmpfs",
                "/tmp:rw,size=32m,uid=1000,gid=1000",
                "--env",
                "MEILI_MASTER_KEY",
                "--env",
                "MEILI_ENV=production",
                "--env",
                "MEILI_NO_ANALYTICS=true",
                "--env",
                "MEILI_MAX_INDEXING_MEMORY=128MiB",
                "--env",
                "MEILI_MAX_INDEXING_THREADS=1",
                IMAGE,
            ])
            .env("MEILI_MASTER_KEY", &key)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "Disposable Meilisearch could not start"
        );
        let mut fixture = Self {
            name,
            url: String::new(),
            key,
            client: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        };
        for _ in 0..50 {
            let out = Command::new("docker")
                .args(["port", &fixture.name, "7700/tcp"])
                .output()
                .unwrap();
            assert!(out.status.success());
            let binding = String::from_utf8(out.stdout).unwrap();
            if !binding.trim().is_empty() {
                let port: u16 = binding
                    .trim()
                    .strip_prefix("127.0.0.1:")
                    .expect("loopback only")
                    .parse()
                    .unwrap();
                fixture.url = format!("http://127.0.0.1:{port}");
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        assert!(!fixture.url.is_empty());
        for _ in 0..100 {
            if fixture
                .client
                .get(format!("{}/health", fixture.url))
                .send()
                .is_ok_and(|r| r.status().is_success())
            {
                return fixture;
            }
            thread::sleep(Duration::from_millis(100));
        }
        panic!("Disposable Meilisearch did not become healthy");
    }
    fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Value {
        let mut req = self
            .client
            .request(method, format!("{}{path}", self.url))
            .bearer_auth(&self.key);
        if let Some(body) = body {
            req = req.json(&body);
        }
        let response = req.send().unwrap();
        assert!(response.status().is_success());
        response.json().unwrap()
    }
    fn finish(&self, id: i64) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let task = self.api(reqwest::Method::GET, &format!("/tasks/{id}"), None);
            if task["status"] == "succeeded" {
                return;
            }
            assert!(
                task["status"] == "enqueued" || task["status"] == "processing",
                "search task failed"
            );
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(20));
        }
    }
}

fn ready(store: &Store, account: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        store.index_once(&principal(account)).unwrap();
        if store.search_health(&principal(account)).unwrap()["ready"] == true {
            return;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
}
#[test]
#[ignore = "Manual worker/search integration; disposable PostgreSQL and Meilisearch only, no model calls"]
fn background_runner_publishes_new_writes_within_the_search_request_budget() {
    background_search_accounts(3);
}
#[test]
#[ignore = "Manual 100-account search check; resource-limited disposable containers, no production or models"]
fn background_runner_with_one_hundred_accounts() {
    background_search_accounts(100);
}
fn background_search_accounts(account_count: usize) {
    use std::sync::mpsc;
    struct Running {
        stop: Option<mpsc::Sender<()>>,
        thread: Option<thread::JoinHandle<()>>,
    }
    impl Drop for Running {
        fn drop(&mut self) {
            drop(self.stop.take());
            self.thread.take().unwrap().join().unwrap();
        }
    }
    let (_pg, mut admin, runtime, _a, _b) = fixture();
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let mut accounts = vec!["a".to_owned(), "b".to_owned()];
    for i in 2..account_count {
        let id = Uuid::new_v4();
        let subject = format!("fixture-{i}");
        admin.execute("INSERT INTO gtd.accounts(id,issuer,subject,username,enabled,enrollment) VALUES($1,$2,$3,$3,true,'active')",&[&id,&super::tests::ISSUER,&subject]).unwrap();
        admin
            .execute(
                "INSERT INTO gtd.account_state(account_id,identity) VALUES($1,$2)",
                &[&id, &Uuid::new_v4()],
            )
            .unwrap();
        accounts.push(subject);
    }
    let engine = EngineFixture::start();
    let store = Store::connect(runtime, Environment::Staging, 4)
        .unwrap()
        .with_search(SearchConfig::new(engine.url.clone(), engine.key.clone()).unwrap());
    for account in &accounts {
        run(&store, account, "capture", capture("initial-fixture"));
    }
    let started = Instant::now();
    let worker = store.background_worker();
    let (stop, stopped) = mpsc::channel();
    let running = Running {
        stop: Some(stop),
        thread: Some(thread::spawn(move || worker.run(stopped))),
    };
    loop {
        // Observe publication with one fixture-admin query, avoiding a polling
        // workload of 100 authenticated reads in the measurement itself.
        let published:i64=admin.query_one("SELECT count(*) FROM gtd.account_state a JOIN gtd.search_state s USING(account_id) WHERE s.key='active' AND (s.value::jsonb->>'high')::bigint=a.high",&[]).unwrap().get(0);
        if published == account_count as i64 {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "initial publication did not finish: {published}/{account_count}"
        );
        thread::sleep(Duration::from_millis(100));
    }
    let initial = started.elapsed();
    let mut timings = Vec::new();
    println!(
        "{}",
        json!({"scenario":"background-search-initial","accounts":account_count,"initial_ms":initial.as_millis()})
    );
    for account in [
        &accounts[0],
        &accounts[account_count / 2],
        &accounts[account_count - 1],
    ] {
        let record = run(&store, account, "capture", capture("recentquartz"));
        let started = Instant::now();
        // No explicit index_once/ready call: normal search must see the committed
        // write through the actual worker before its existing four-second limit.
        let found = store
            .list(&principal(account), input(json!({"query":"recentquartz"})))
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].id, record.task.id);
        timings.push(started.elapsed().as_millis());
    }
    drop(running);
    println!(
        "{}",
        json!({"scenario":"background-account-search","accounts":account_count,"initial_ms":initial.as_millis(),"write_to_search_ms":timings,"models":0})
    );
}
#[test]
#[ignore = "Manual real-engine search check; two disposable Docker containers, no production or model calls"]
fn actual_meilisearch_account_filters_and_complete_snapshot_pages() {
    let (_pg, mut admin, runtime, a, b) = fixture();
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let engine = EngineFixture::start();
    let store = Store::connect(runtime, Environment::Staging, 4)
        .unwrap()
        .with_search(SearchConfig::new(engine.url.clone(), engine.key.clone()).unwrap());
    // More than the engine's default 1,000-hit limit; create bounded atomic batches.
    for offset in (0..1050).step_by(50) {
        let operations: Vec<_> = (offset..offset + 50)
            .map(|i| {
                let mut task = capture(&format!("quartz-{i}"));
                task.as_object_mut().unwrap().remove("request_id");
                task["operation"] = json!("capture");
                task
            })
            .collect();
        store
            .execute(
                &principal("a"),
                Policy::Agent,
                "fixture",
                Operation::Batch(input(
                    json!({"request_id":format!("batch-{offset}"),"operations":operations}),
                )),
            )
            .unwrap();
    }
    let foreign = run(&store, "b", "capture", capture("quartz-private")).task;
    ready(&store, "a");
    ready(&store, "b");
    let first = store
        .list(
            &principal("a"),
            input(json!({"query":"quartz","limit":100})),
        )
        .unwrap();
    let old = first.items[0].clone();
    run(
        &store,
        "a",
        "update",
        patch(
            &old,
            "edit-after-first-page",
            json!({"title":"Renamed fixture"}),
        ),
    );
    ready(&store, "a");
    let mut all = first.items;
    let mut cursor = first.next_cursor;
    while let Some(next) = cursor {
        let page = store
            .list(
                &principal("a"),
                input(json!({"query":"quartz","limit":100,"cursor":next})),
            )
            .unwrap();
        all.extend(page.items);
        cursor = page.next_cursor;
    }
    assert_eq!(all.len(), 1050);
    assert_eq!(
        all.iter()
            .map(|t| &t.id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        1050
    );
    assert!(!all.iter().any(|t| t.id == foreign.id));
    let publication: Value = store
        .read(&principal("a"), |tx| {
            Ok(serde_json::from_str(
                &super::search::get(tx, "active")?.unwrap(),
            )?)
        })
        .unwrap();
    let index = publication["index"].as_str().unwrap();
    // Misindexed foreign content is excluded by the real engine filter.
    let mut doc = crate::search_engine::document(&foreign);
    doc["account_id"] = json!(b.to_string());
    let task = engine.api(
        reqwest::Method::POST,
        &format!("/indexes/{index}/documents"),
        Some(json!([doc])),
    );
    engine.finish(task["taskUid"].as_i64().unwrap());
    let result = store
        .list(
            &principal("a"),
            input(json!({"query":"private","view":"all"})),
        )
        .unwrap();
    assert!(result.items.is_empty());
    // A same-account but incorrect revision is rejected by the authoritative check.
    let mut doc = crate::search_engine::document(&old);
    doc["account_id"] = json!(a.to_string());
    doc["revision"] = json!(0);
    let task = engine.api(
        reqwest::Method::POST,
        &format!("/indexes/{index}/documents"),
        Some(json!([doc])),
    );
    engine.finish(task["taskUid"].as_i64().unwrap());
    assert!(matches!(
        store.list(&principal("a"), input(json!({"query":"quartz"}))),
        Err(Error::Business(crate::store::StoreError::SearchUnavailable))
    ));
    ready(&store, "a");
    let mut query: ListItems = input(json!({"query":"renamed","detail":"summary"}));
    query.agent_context = true;
    let result = store.list(&principal("a"), query).unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].id, old.id);
    assert_eq!(result.items[0].agent_notes, "Synthetic context only.");
}
