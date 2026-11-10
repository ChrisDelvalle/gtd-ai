//! Manual, credential-free release comparison. Fresh loopback Docker database only.
use super::{
    tests::{fixture_with_budget, principal},
    write_tests::{capture, input, patch, run},
    *,
};
use crate::model::{ListChanges, MutationResult};
use serde_json::{Value, json};
use std::time::Instant;
fn stats(mut v: Vec<f64>) -> Value {
    v.sort_by(f64::total_cmp);
    json!({"n":v.len(),"median":v[(v.len()-1)/2],"p95":v[((v.len() as f64*0.95).ceil() as usize-1).min(v.len()-1)],"max":v[v.len()-1]})
}
fn samples(mut f: impl FnMut(usize) -> Value) -> Value {
    let mut times = Vec::new();
    let mut sizes = Vec::new();
    for i in 0..30 {
        let now = Instant::now();
        let value = f(i);
        times.push(now.elapsed().as_secs_f64() * 1000.0);
        sizes.push(value.to_string().len() as f64);
    }
    json!({"milliseconds":stats(times),"bytes":stats(sizes)})
}

#[test]
#[ignore = "Manual widget workload with only disposable PostgreSQL accounts"]
fn widget_snapshot_capacity() {
    assert_eq!(std::env::var("GTD_ACTIVITY_BENCH").as_deref(), Ok("1"));
    let (container, mut admin, runtime, _, _) = fixture_with_budget("1g", "1g");
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let store = Store::connect(runtime, Environment::Staging, 8).unwrap();
    let day = crate::clock::now()
        .with_timezone(&chrono_tz::America::New_York)
        .date_naive();
    let week = day - chrono::Days::new(363);
    let snapshot = |store: &Store, who: &Principal, token: Option<&str>| {
        store.view_snapshot(who, input(json!({
            "query":{"view":"home","arguments":{"review_on":day.to_string(),"loading":"top-three"}},
            "token":token
        }))).unwrap()
    };
    let mut subjects = vec!["a".to_owned(), "b".to_owned()];
    let mut targets = Vec::new();
    let mut report = Vec::new();
    for (accounts, active) in [(3, 3), (100, 10)] {
        let from = subjects.len() as i32;
        let to = accounts - 1;
        admin.execute(
            "WITH inserted AS (
                INSERT INTO gtd.accounts(id,issuer,subject,username,enabled,enrollment)
                SELECT gen_random_uuid(),$1,'widget-'||i,'widget-'||i,true,'active'
                FROM generate_series($2::integer,$3::integer) AS i RETURNING id
             ) INSERT INTO gtd.account_state(account_id,identity) SELECT id,gen_random_uuid() FROM inserted",
            &[&super::tests::ISSUER, &from, &to],
        ).unwrap();
        subjects.extend((from..=to).map(|i| format!("widget-{i}")));
        for subject in &subjects[targets.len()..active] {
            let who = principal(subject);
            let ops = (0..25)
                .map(|n| {
                    let mut task = capture(&format!("seed-{n}"));
                    task.as_object_mut().unwrap().remove("request_id");
                    task["operation"] = json!("capture");
                    task["notes"] = json!("Synthetic working notes. ".repeat(95));
                    task
                })
                .collect::<Vec<_>>();
            let batch: crate::model::BatchResult = input(
                store
                    .execute(
                        &who,
                        crate::store::content::Policy::Agent,
                        "test",
                        WriteOperation::Batch(input(json!({"request_id":"seed","operations":ops}))),
                    )
                    .unwrap(),
            );
            targets.push(batch.results[0].task.clone());
        }
        let barrier = std::sync::Barrier::new(active);
        let started = Instant::now();
        let runs = std::thread::scope(|scope| {
            subjects[..active]
                .iter()
                .zip(&mut targets)
                .map(|(subject, task)| {
                    let barrier = &barrier;
                    let store = &store;
                    let snapshot = &snapshot;
                    scope.spawn(move || {
                        let who = principal(subject);
                        barrier.wait();
                        let mut flows = Vec::new();
                        for step in 0..4 {
                            let start = Instant::now();
                            let home = snapshot(store, &who, None);
                            let token = home["token"].as_str().unwrap();
                            assert_eq!(snapshot(store, &who, Some(token))["kind"], "unchanged");
                            let change = patch(
                                task,
                                &format!("widget-{accounts}-{step}"),
                                json!({"title":format!("Measured {accounts} / {step}")}),
                            );
                            *task = run(store, subject, "update", change).task;
                            assert_eq!(snapshot(store, &who, Some(token))["kind"], "full");
                            store.activity_summary(&who, input(json!({
                            "from":week.to_string(),"through":day.to_string(),"metric":"changes"
                        }))).unwrap();
                            flows.push(start.elapsed().as_secs_f64() * 1000.);
                        }
                        flows
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .flat_map(|job| job.join().unwrap())
                .collect()
        });
        let memory = std::process::Command::new("docker")
            .args([
                "exec",
                container.name(),
                "cat",
                "/sys/fs/cgroup/memory.peak",
            ])
            .output()
            .unwrap();
        report.push(json!({
            "accounts":accounts,"active":active,"records_per_active_account":25,
            "flow_ms":stats(runs),"seconds":started.elapsed().as_secs_f64(),
            "postgres_peak_bytes":String::from_utf8_lossy(&memory.stdout).trim().parse::<u64>().ok()
        }));
    }
    println!("GTD_WIDGET_CAPACITY={}", json!(report));
}
#[test]
#[ignore = "Manual activity comparison; synthetic isolated Docker, no model or production access"]
fn activity_release_measurements() {
    assert_eq!(std::env::var("GTD_ACTIVITY_BENCH").as_deref(), Ok("1"));
    let (container, mut admin, runtime, account, _) = fixture_with_budget("1g", "1g");
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
    let p = principal("a");
    let mut tasks = Vec::new();
    for i in 0..100 {
        let mut q = capture(&format!("seed-{i}"));
        q["notes"] = json!("Human context. ".repeat(150));
        q["agent_notes"] = json!("Agent context. ".repeat(150));
        tasks.push(run(&store, "a", "capture", q).task);
    }
    let rounds = std::env::var("GTD_ACTIVITY_BENCH_REVISIONS")
        .ok()
        .map(|s| s.parse::<usize>().unwrap())
        .unwrap_or(2000);
    // Group fixture edits so preparation does not rebuild the dependency
    // graph thousands of times before the timed read comparisons.
    for start in (0..rounds).step_by(25) {
        let mut operations = Vec::new();
        let mut indices = Vec::new();
        for i in start..(start + 25).min(rounds) {
            let n = i % tasks.len();
            let mut args = patch(
                &tasks[n],
                "unused",
                json!({
                    "title":format!("Synthetic record {n} revision {i}")
                }),
            );
            args.as_object_mut().unwrap().remove("request_id");
            args["operation"] = json!("update");
            operations.push(args);
            indices.push(n);
        }
        let batch: crate::model::BatchResult = input(
            store
                .execute(
                    &p,
                    crate::store::content::Policy::Agent,
                    "test",
                    WriteOperation::Batch(input(json!({
                        "request_id":format!("seed-batch-{start}"),"operations":operations
                    }))),
                )
                .unwrap(),
        );
        for (n, result) in indices.into_iter().zip(batch.results) {
            tasks[n] = result.task;
        }
    }
    let first = Instant::now();
    let home = store
        .home_view(
            &p,
            input(json!({"review_on":"2026-11-04","loading":"top-three"})),
        )
        .unwrap();
    let cold =
        json!({"milliseconds":first.elapsed().as_secs_f64()*1000.0,"bytes":home.to_string().len()});
    let warm = samples(|_| {
        store
            .home_view(
                &p,
                input(json!({"review_on":"2026-11-04","loading":"top-three"})),
            )
            .unwrap()
    });
    let history = samples(|_| {
        crate::projection::changes(
            &store
                .changes(
                    &p,
                    ListChanges {
                        limit: Some(100),
                        ..Default::default()
                    },
                )
                .unwrap(),
            crate::model::Detail::Summary,
        )
    });
    let writes = samples(|i| {
        let r: MutationResult = run(
            &store,
            "a",
            "update",
            patch(
                &tasks[0],
                &format!("measured-{i}"),
                json!({"title":format!("Measured edit {i}")}),
            ),
        );
        tasks[0] = r.task.clone();
        serde_json::to_value(r).unwrap()
    });
    let mut report = json!({"compatibility":COMPATIBILITY,"seed_revisions":rounds+100,"home_first":cold,"home_warm":warm,"history":history,"write":writes});
    report["exact_task"] = samples(|_| {
        let args: crate::model::ListItems = input(json!({"task_id":tasks[0].id,"detail":"full"}));
        crate::view::task_list(&store.list(&p, args.clone()).unwrap(), &args)
    });
    let (snapshot_load, rank_reuse) = store
        .read(&p, |tx| {
            use super::read_snapshot::Snapshot;
            let high = tx.high();
            let snapshot = Snapshot::load(tx, high, crate::clock::timestamp())?;
            let load = samples(|_| {
                std::hint::black_box(Snapshot::load(tx, high, crate::clock::timestamp()).unwrap());
                Value::Null
            });
            let rerank = samples(|_| {
                std::hint::black_box(snapshot.graph.rankings(crate::clock::now()));
                Value::Null
            });
            Ok((load, rerank))
        })
        .unwrap();
    report["snapshot_load"] = snapshot_load;
    report["rerank_with_reused_graph"] = rank_reuse;
    let date = chrono::Utc::now()
        .with_timezone(&chrono_tz::America::New_York)
        .date_naive()
        .to_string();
    report["chart"] = samples(|_| {
        store
            .activity_summary(
                &p,
                input(json!({"from":date,"through":date,"metric":"changes"})),
            )
            .unwrap()
    });
    let q: crate::activity::ChartQuery =
        input(json!({"from":date,"through":date,"metric":"changes"}));
    let window = crate::activity::Range {
        from: Some(date.clone()),
        through: Some(date.clone()),
        days: None,
    }
    .resolve(chrono_tz::America::New_York, &crate::clock::timestamp())
    .unwrap();
    let baseline = || {
        store
            .read(&p, |tx| {
                let events = tx.range_events(tx.high(), &window)?;
                Ok(crate::activity::counts(&events, &Default::default(), &q, &window).unwrap())
            })
            .unwrap()
    };
    let full = || {
        store
            .view_snapshot(
                &p,
                crate::view::SnapshotRequest {
                    query: crate::view::SnapshotQuery::Charts(q.clone()),
                    token: None,
                    reuse_home_notes: false,
                    sparse_chart: false,
                },
            )
            .unwrap()
    };
    let seed = full();
    assert_eq!(seed["data"]["days"], baseline()["days"]);
    assert_eq!(
        seed["data"]["automatic_count"],
        baseline()["automatic_count"]
    );
    let token = seed["token"].as_str().unwrap().to_owned();
    report["chart_decode_baseline"] = samples(|_| baseline());
    report["chart_snapshot_full"] = samples(|_| full());
    report["chart_snapshot_unchanged"] = samples(|_| {
        let result = store
            .view_snapshot(
                &p,
                crate::view::SnapshotRequest {
                    query: crate::view::SnapshotQuery::Charts(q.clone()),
                    token: Some(token.clone()),
                    reuse_home_notes: false,
                    sparse_chart: false,
                },
            )
            .unwrap();
        assert_eq!(result["kind"], "unchanged");
        result
    });
    report["chart_index_plan"] = store.read(&p, |tx| {
        let rows = tx.tx.query(
            "EXPLAIN (ANALYZE, BUFFERS) SELECT category, count(*) FROM gtd.activity_events
             WHERE account_id=$1 AND occurred_at >= $2::text::timestamptz AND occurred_at <= $3::text::timestamptz
             GROUP BY category", &[&account, &window.start, &window.evaluated_at],
        )?;
        Ok(json!(rows.into_iter().map(|row| row.get::<_, String>(0)).collect::<Vec<_>>()))
    }).unwrap();
    report["projection_bytes"] = json!(
        admin
            .query_one("SELECT pg_total_relation_size('gtd.activity_events')", &[])
            .unwrap()
            .get::<_, i64>(0)
    );
    let peak = std::process::Command::new("docker")
        .args([
            "exec",
            container.name(),
            "cat",
            "/sys/fs/cgroup/memory.peak",
        ])
        .output()
        .unwrap();
    report["postgres_peak_bytes"] = json!(
        String::from_utf8_lossy(&peak.stdout)
            .trim()
            .parse::<u64>()
            .ok()
    );
    let bytes: i64 = admin
        .query_one("SELECT pg_total_relation_size('gtd.changes')", &[])
        .unwrap()
        .get(0);
    report["audit_storage_bytes"] = json!(bytes);
    report["account_history_rows"] = json!(
        admin
            .query_one(
                "SELECT count(*) FROM gtd.changes WHERE account_id=$1",
                &[&account]
            )
            .unwrap()
            .get::<_, i64>(0)
    );
    println!("ACTIVITY_BENCH {}", report);
}
