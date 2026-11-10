//! Opt-in native workflow measurements. No host credentials, production data,
//! browser, identity provider or live model calls. Not an HTTP/UI benchmark.
use super::{
    legacy::{Snapshot, Source},
    tests::{ISSUER, fixture_with_budget, principal},
    write_tests::{capture, input},
    *,
};
use crate::{
    model::{ListItems, MutationResult},
    store::content::Policy,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Instant,
};

enum Backend<'a> {
    Sqlite(crate::store::Store),
    Postgres(&'a Store, Principal),
}
impl Backend<'_> {
    fn home(&mut self) -> Value {
        let request = input(json!({"review_on":"2026-10-16","loading":"top-three"}));
        match self {
            Self::Sqlite(s) => s.home_view(request).unwrap(),
            Self::Postgres(s, p) => s.home_view(p, request).unwrap(),
        }
    }
    fn list(&mut self, value: Value) -> Value {
        let query: ListItems = input(value);
        let result = match self {
            Self::Sqlite(s) => s.list(query.clone()).unwrap(),
            Self::Postgres(s, p) => s.list(p, query.clone()).unwrap(),
        };
        crate::view::task_list(&result, &query)
    }
    fn change(&mut self, create: bool, value: Value) -> Value {
        let result: MutationResult = match self {
            Self::Sqlite(s) => {
                if create {
                    s.capture(input(value)).unwrap()
                } else {
                    s.update(input(value)).unwrap()
                }
            }
            Self::Postgres(s, p) => input(
                s.execute(
                    p,
                    Policy::Human,
                    "website",
                    if create {
                        WriteOperation::Capture(input(value))
                    } else {
                        WriteOperation::Update(input(value))
                    },
                )
                .unwrap(),
            ),
        };
        crate::projection::mutation(&result)
    }
}

#[derive(Default)]
struct Measurements {
    steps: BTreeMap<&'static str, Vec<(f64, usize)>>,
    flows: Vec<f64>,
}
impl Measurements {
    fn step(&mut self, name: &'static str, operation: impl FnOnce() -> Value) -> Value {
        let start = Instant::now();
        let value = operation();
        let bytes = serde_json::to_vec(&value).unwrap().len();
        self.steps
            .entry(name)
            .or_default()
            .push((start.elapsed().as_secs_f64() * 1000.0, bytes));
        value
    }
    fn merge(&mut self, other: Self) {
        self.flows.extend(other.flows);
        for (name, rows) in other.steps {
            self.steps.entry(name).or_default().extend(rows);
        }
    }
    fn report(&self) -> Value {
        json!({"flow_ms":distribution(self.flows.clone()),"steps":self.steps.iter().map(|(name,rows)|
            (*name,json!({"ms":distribution(rows.iter().map(|r|r.0).collect()),
                "response_bytes":distribution(rows.iter().map(|r|r.1 as f64).collect())}))).collect::<BTreeMap<_,_>>()})
    }
}
fn distribution(mut values: Vec<f64>) -> Value {
    assert!(!values.is_empty());
    values.sort_by(f64::total_cmp);
    let percentile = |p: f64| values[((values.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    json!({"n":values.len(),"median":percentile(0.5),"p95":percentile(0.95),"max":values[values.len()-1]})
}
fn container_counter(name: &str, path: &str, key: Option<&str>) -> Option<u64> {
    let result = std::process::Command::new("docker")
        .args(["exec", name, "cat", path])
        .output()
        .ok()?;
    if !result.status.success() {
        return None;
    }
    let text = String::from_utf8(result.stdout).ok()?;
    match key {
        None => text.trim().parse().ok(),
        Some(key) => text.lines().find_map(|line| {
            let (name, value) = line.split_once(' ')?;
            (name == key).then(|| value.parse().ok()).flatten()
        }),
    }
}
fn workflow(backend: &mut Backend<'_>, key: &str) -> Measurements {
    let mut m = Measurements::default();
    let start = Instant::now();
    let home = m.step("home", || backend.home());
    assert!(home["data"]["next"]["items"].as_array().unwrap().len() >= 3);
    // The first three bodies arrived in Home. Inspect a fourth ready task;
    // do not manufacture three extra requests for already preloaded records.
    let list = m.step("next", || {
        backend.list(json!({"status":"next","limit":20,"detail":"summary"}))
    });
    let id = list["items"][3]["id"].as_str().unwrap().to_owned();
    let detail = m.step("detail", || {
        backend.list(json!({"task_id":id,"limit":1,"detail":"full"}))
    });
    let task = &detail["items"][0];
    let edited=m.step("edit",||backend.change(false,json!({"request_id":format!("{key}-edit"),"task_id":id,
        "expected_version":task["version"],"notes":"Complete the synthetic workflow.\n\nConfirm its saved result.","reason":"Synthetic benchmark"})));
    let captured = m.step("inbox_capture", || {
        backend.change(
            true,
            json!({"request_id":format!("{key}-capture"),
        "title":"Synthetic follow-up","importance":"normal","reason":"Synthetic benchmark"}),
        )
    });
    assert!(!captured["replayed"].as_bool().unwrap());
    m.step("clarify",||backend.change(false,json!({"request_id":format!("{key}-clarify"),"task_id":captured["task"]["id"],
        "expected_version":captured["task"]["version"],"status":"next","brief":"Carry out the synthetic follow-up.",
        "estimated_minutes":15,"effort":"low","reason":"Synthetic benchmark"})));
    m.step("complete",||backend.change(false,json!({"request_id":format!("{key}-complete"),"task_id":id,
        "expected_version":edited["task"]["version"],"status":"done","reason":"Synthetic benchmark"})));
    m.step("home_after_write", || backend.home());
    m.flows.push(start.elapsed().as_secs_f64() * 1000.0);
    m
}
fn seed(path: &std::path::Path) -> Snapshot {
    let mut old = crate::store::Store::open(path).unwrap();
    assert_eq!(
        old.environment(),
        "test",
        "Fixture must not use a production environment marker"
    );
    let projects=(0..5).map(|i| old.create_project(input(json!({"request_id":format!("p-{i}"),"title":format!("Synthetic project {i}"),
        "brief":"Deliver the fixture outcome.","notes":"Synthetic project instructions.","agent_notes":"Fixture only.","reason":"Fixture"}))).unwrap().task.id).collect::<Vec<_>>();
    let mut tasks = Vec::new();
    for i in 0..200 {
        let mut value = capture(&format!("seed-{i}"));
        value["project_id"] = json!(projects[i % 5]);
        value["status"] = json!(if i % 10 < 6 {
            "next"
        } else {
            ["waiting", "someday", "inbox", "blocked"][i % 10 - 6]
        });
        value["importance"] = json!(["normal", "high", "low", "very_high"][i % 4]);
        value["notes"] = json!(
            "Complete the synthetic action.\n\nSupporting context for this disposable account. "
                .repeat(6)
        );
        value["agent_notes"] = json!(
            "Synthetic handoff: preserve the current commitment and its explicit constraints. "
                .repeat(6)
        );
        if i % 9 == 0 {
            value["due_date"] = json!("2090-01-01");
        }
        if i % 11 == 0 {
            value["review_date"] = json!("2020-01-01");
        }
        tasks.push(old.capture(input(value)).unwrap().task);
    }
    for i in (10..200).step_by(10) {
        old.update(input(json!({"request_id":format!("dep-{i}"),"task_id":tasks[i].id,"expected_version":tasks[i].version,
            "blocked_by":[tasks[i-1].id],"reason":"Fixture"}))).unwrap();
    }
    let db = rusqlite::Connection::open(path).unwrap();
    let identity: String = db
        .query_row(
            "SELECT value FROM store_meta WHERE key='identity'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(db);
    drop(old);
    Snapshot::open(
        path,
        &Source {
            identity: identity.parse().unwrap(),
            environment: "test".into(),
        },
    )
    .unwrap()
}

#[test]
#[ignore = "Manual native backend measurements; fresh synthetic Docker database only, no model calls"]
fn native_workflow_capacity() {
    assert_eq!(
        std::env::var("GTD_NATIVE_WORKFLOW_BENCH").as_deref(),
        Ok("1")
    );
    let started = Instant::now();
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.sqlite3");
    let snapshot = seed(&source);
    let mut phases = Vec::new();
    let source_size = std::fs::metadata(&source).unwrap().len();
    // Same initial data and 24 sequential flows as the one-account PG phase.
    let baseline = root.path().join("baseline.sqlite3");
    std::fs::copy(&source, &baseline).unwrap();
    let mut backend = Backend::Sqlite(crate::store::Store::open(&baseline).unwrap());
    backend.home();
    let mut measurements = Measurements::default();
    for round in 0..24 {
        measurements.merge(workflow(&mut backend, &format!("sqlite-{round}")));
    }
    drop(backend);
    phases.push(json!({"backend":"sqlite","accounts":1,"concurrent_sessions":1,"measurements":measurements.report()}));
    for (accounts, concurrency, repeats) in [(1, 1, 24), (3, 3, 8), (100, 10, 2)] {
        // Fresh database per phase: prior workloads cannot inflate a later
        // account's history, change its ranking or warm its statement cache.
        let (container, mut admin, runtime, _, b) = fixture_with_budget("1g", "1g");
        admin
            .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
            .unwrap();
        let store = Store::connect(runtime, Environment::Staging, 8).unwrap();
        let mut subjects = vec!["a".to_owned(), "b".to_owned()];
        if accounts == 1 {
            admin
                .execute("DELETE FROM gtd.account_state WHERE account_id=$1", &[&b])
                .unwrap();
            admin
                .execute("DELETE FROM gtd.accounts WHERE id=$1", &[&b])
                .unwrap();
            subjects.pop();
        }
        for i in 2..accounts {
            let id = Uuid::new_v4();
            let name = format!("benchmark-{i}");
            admin.execute("INSERT INTO gtd.accounts(id,issuer,subject,username,enabled,enrollment) VALUES($1,$2,$3,$3,true,'active')",&[&id,&ISSUER,&name]).unwrap();
            admin
                .execute(
                    "INSERT INTO gtd.account_state(account_id,identity) VALUES($1,$2)",
                    &[&id, &Uuid::new_v4()],
                )
                .unwrap();
            subjects.push(name);
        }
        let seed_start = Instant::now();
        for subject in &subjects {
            assert!(!snapshot.import(&store, &principal(subject)).unwrap());
        }
        let seed_seconds = seed_start.elapsed().as_secs_f64();
        let analyze_start = Instant::now();
        admin.batch_execute("ANALYZE gtd.tasks, gtd.revisions, gtd.changes, gtd.requests, gtd.dependencies, gtd.accounts, gtd.account_state, gtd.search_state").unwrap();
        let analyze_seconds = analyze_start.elapsed().as_secs_f64();
        // Warm prepared code/data paths before timing, without mutating records.
        for subject in &subjects[..accounts] {
            Backend::Postgres(&store, principal(subject)).home();
        }
        let next = AtomicUsize::new(0);
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let barrier = std::sync::Barrier::new(concurrency);
        let combined = Mutex::new(Measurements::default());
        let cpu_before = container_counter(
            container.name(),
            "/sys/fs/cgroup/cpu.stat",
            Some("usage_usec"),
        );
        let phase_start = Instant::now();
        thread::scope(|scope| {
            for _ in 0..concurrency {
                scope.spawn(|| {
                    barrier.wait();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        if index >= accounts {
                            break;
                        }
                        let mut backend = Backend::Postgres(&store, principal(&subjects[index]));
                        for repetition in 0..repeats {
                            assert!(
                                started.elapsed().as_secs() < 300,
                                "Benchmark deadline exceeded"
                            );
                            let running = active.fetch_add(1, Ordering::SeqCst) + 1;
                            peak.fetch_max(running, Ordering::SeqCst);
                            let result = workflow(
                                &mut backend,
                                &format!("pg-{accounts}-{index}-{repetition}"),
                            );
                            active.fetch_sub(1, Ordering::SeqCst);
                            combined.lock().unwrap().merge(result);
                        }
                    }
                });
            }
        });
        let measurements = combined.into_inner().unwrap();
        assert_eq!(measurements.flows.len(), accounts * repeats);
        assert_eq!(peak.load(Ordering::Relaxed), concurrency);
        let seconds = phase_start.elapsed().as_secs_f64();
        let cpu_after = container_counter(
            container.name(),
            "/sys/fs/cgroup/cpu.stat",
            Some("usage_usec"),
        );
        let cpu_seconds = cpu_before
            .zip(cpu_after)
            .map(|(before, after)| after.saturating_sub(before) as f64 / 1_000_000.0);
        let peak_memory = container_counter(container.name(), "/sys/fs/cgroup/memory.peak", None);
        let database_bytes: i64 = admin
            .query_one("SELECT pg_database_size(current_database())", &[])
            .unwrap()
            .get(0);
        let stats = std::process::Command::new("docker")
            .args([
                "stats",
                "--no-stream",
                "--format",
                "{{json .}}",
                container.name(),
            ])
            .output()
            .unwrap();
        assert!(stats.status.success());
        let stats: Value = serde_json::from_slice(&stats.stdout).unwrap();
        let rows = admin
            .query("SELECT count(*) FROM gtd.tasks GROUP BY account_id", &[])
            .unwrap();
        assert_eq!(rows.len(), accounts);
        for row in rows {
            assert_eq!(
                row.get::<_, i64>(0),
                snapshot.report().counts["tasks"] as i64 + repeats as i64
            );
        }
        phases.push(json!({"backend":"postgres","accounts":accounts,"concurrent_sessions":concurrency,
            "peak_parallel_flows":peak.load(Ordering::Relaxed),"pool_size":8,"seed_seconds":seed_seconds,"analyze_seconds":analyze_seconds,"seconds":seconds,"database_bytes":database_bytes,
            "database_memory_after_phase":stats["MemUsage"],"flows_per_second":measurements.flows.len() as f64/seconds,
            "database_cpu_seconds":cpu_seconds,"database_peak_bytes_including_seed":peak_memory,
            "measurements":measurements.report()}));
    }
    let report = json!({"scope":"native-storage-workflows","recorded_at":chrono::Utc::now().to_rfc3339(),
        "release_build":!cfg!(debug_assertions),"source_counts":snapshot.report().counts,"source_sqlite_bytes":source_size,
        "postgres_cpu_limit":1,"postgres_memory_limit_bytes":1073741824_u64,"model_calls":0,
        "network":"local Docker loopback only","plan_statistics":"analyzed-after-seeding","timing_includes":"storage, business rules, projection and JSON serialization",
        "excludes":["OIDC","HTTP","frontend","internet RTT","search index and lag","recurrence catch-up"],
        "phases":phases,"total_seconds":started.elapsed().as_secs_f64()});
    println!("GTD_NATIVE_WORKFLOW_RESULT={report}");
}
