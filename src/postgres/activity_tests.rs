use super::{
    tests::{fixture, principal},
    write_tests::{capture, input, patch, run},
    *,
};
use crate::{
    activity::{ChartQuery, ResultsQuery},
    model::ListChanges,
};
use serde_json::{Value, json};
fn query(metric: &str) -> ChartQuery {
    let d = chrono::Utc::now()
        .with_timezone(&chrono_tz::America::New_York)
        .date_naive()
        .to_string();
    input(json!({"from":d,"through":d,"metric":metric}))
}
#[test]
#[ignore = "Disposable PostgreSQL activity, RLS and migration acceptance; no model calls"]
fn activity_projection_isolation_snapshots_and_derived_rollback() {
    let (_container, mut admin, runtime, a, b) = fixture();
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let store = Store::connect(runtime.clone(), Environment::Staging, 2).unwrap();
    let first = run(&store, "a", "capture", capture("same-request"));
    let other = run(&store, "b", "capture", capture("same-request"));
    let completed = run(
        &store,
        "a",
        "update",
        patch(&first.task, "done", json!({"status":"done"})),
    );
    let before = store
        .activity_summary(&principal("a"), query("completed"))
        .unwrap();
    assert_eq!(before["total"], 1);
    let undo = run(
        &store,
        "a",
        "undo",
        json!({"request_id":"undo","change_id":completed.change.id,"expected_version":completed.task.version,"reason":"Fixture"}),
    );
    assert_eq!(
        store
            .activity_summary(&principal("a"), query("completed"))
            .unwrap()["total"],
        0
    );
    let mut day = query("completed");
    day.day = Some(day.from.clone());
    day.snapshot = Some(before["snapshot"].as_str().unwrap().into());
    assert_eq!(
        store.activity_day(&principal("a"), day.clone()).unwrap()["total"],
        1
    );
    assert!(store.activity_day(&principal("b"), day).is_err());
    run(
        &store,
        "a",
        "undo",
        json!({"request_id":"redo","change_id":undo.change.id,"expected_version":undo.task.version,"reason":"Fixture"}),
    );
    assert_eq!(
        store
            .activity_summary(&principal("a"), query("completed"))
            .unwrap()["total"],
        1
    );
    let result = |s: &Store, who: &str| {
        s.request_results(
            &principal(who),
            ResultsQuery {
                from_request_ids: vec!["same-request".into()],
                agent_context: true,
                ..Default::default()
            },
        )
        .unwrap()
    };
    assert_eq!(result(&store, "a")["records"][0]["id"], first.task.id);
    assert_eq!(result(&store, "b")["records"][0]["id"], other.task.id);
    assert!(
        store
            .request_results(
                &principal("b"),
                ResultsQuery {
                    from_request_ids: vec!["done".into()],
                    ..Default::default()
                }
            )
            .is_err()
    );
    let page = store
        .changes(&principal("a"), input(json!({"limit":1})))
        .unwrap();
    run(&store, "a", "capture", capture("after-snapshot"));
    let rest = store
        .changes(
            &principal("a"),
            input(json!({"limit":100,"cursor":page.next_cursor})),
        )
        .unwrap();
    assert_eq!(rest.changes.len(), 3);
    let cross: ListChanges = input(json!({"cursor":page.next_cursor}));
    assert!(store.changes(&principal("b"), cross).is_err());
    let counts = store
        .read(&principal("a"), |tx| {
            Ok(tx
                .tx
                .query_one("SELECT count(*) FROM gtd.activity_events", &[])?
                .get::<_, i64>(0))
        })
        .unwrap();
    assert_eq!(counts, 5);
    // Account timezone is frozen with the snapshot, not reinterpreted mid-report.
    admin
        .execute(
            "UPDATE gtd.accounts SET timezone='Asia/Tokyo' WHERE id=$1",
            &[&a],
        )
        .unwrap();
    let old = store
        .changes(&principal("a"), input(json!({"cursor":page.next_cursor})))
        .unwrap();
    assert_eq!(old.window.timezone, "America/New_York");
    assert_eq!(
        store
            .changes(&principal("a"), ListChanges::default())
            .unwrap()
            .window
            .timezone,
        "Asia/Tokyo"
    );
    let identity = store.identity;
    drop(store);
    let original: Value = admin
        .query_one(
            "SELECT jsonb_object_agg(account_id::text||id,response)::text FROM gtd.requests",
            &[],
        )
        .unwrap()
        .get::<_, String>(0)
        .parse()
        .unwrap();
    let downgrade =
        super::activity_operator::migrate(&mut admin, identity, "staging", "rollback").unwrap();
    assert_eq!(downgrade["authoritative_unchanged"], true);
    assert!(Store::connect(runtime.clone(), Environment::Staging, 1).is_err());
    // Rebuilding after rollback keeps receipts, revisions, and disabled-account history.
    admin
        .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&b])
        .unwrap();
    let upgrade =
        super::activity_operator::migrate(&mut admin, identity, "staging", "upgrade").unwrap();
    assert_eq!(upgrade["activity_rows"], 6);
    super::activity_operator::migrate(&mut admin, identity, "staging", "verify").unwrap();
    let final_receipts: Value = admin
        .query_one(
            "SELECT jsonb_object_agg(account_id::text||id,response)::text FROM gtd.requests",
            &[],
        )
        .unwrap()
        .get::<_, String>(0)
        .parse()
        .unwrap();
    assert_eq!(original, final_receipts);
    let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
    assert!(
        store
            .activity_summary(&principal("b"), query("changes"))
            .is_err()
    );
    let mut all = query("changes");
    all.from = chrono::Utc::now()
        .with_timezone(&chrono_tz::Asia::Tokyo)
        .date_naive()
        .pred_opt()
        .unwrap()
        .to_string();
    all.through = chrono::Utc::now()
        .with_timezone(&chrono_tz::Asia::Tokyo)
        .date_naive()
        .to_string();
    assert_eq!(
        store.activity_summary(&principal("a"), all).unwrap()["total"],
        5
    );
    admin
        .execute(
            "UPDATE gtd.accounts SET timezone='America/New_York' WHERE id=$1",
            &[&a],
        )
        .unwrap();
    // New York's repeated 01:30 instants are on the same day. The next
    // midnight is 25 hours after the start and belongs to a different bucket.
    admin
        .execute(
            "WITH dates AS (
            SELECT change_id, row_number() OVER (ORDER BY change_id) AS n
            FROM gtd.activity_events WHERE account_id=$1
         )
         UPDATE gtd.activity_events e SET
            occurred_at=($2::text[])[dates.n]::timestamptz,
            document=jsonb_set(e.document::jsonb, '{at}', to_jsonb(($2::text[])[dates.n]))::text
         FROM dates WHERE e.account_id=$1 AND e.change_id=dates.change_id",
            &[
                &a,
                &vec![
                    "2024-11-03T03:59:59Z",
                    "2024-11-03T05:30:00Z",
                    "2024-11-03T06:30:00Z",
                    "2024-11-04T04:59:59Z",
                    "2024-11-04T05:00:00Z",
                ],
            ],
        )
        .unwrap();
    let mut fall: ChartQuery = input(json!({
        "from":"2024-11-03","through":"2024-11-03","metric":"changes",
    }));
    let summary = store
        .activity_summary(&principal("a"), fall.clone())
        .unwrap();
    assert_eq!(summary["total"], 3);
    fall.day = Some(fall.from.clone());
    fall.snapshot = Some(summary["snapshot"].as_str().unwrap().into());
    assert_eq!(
        store.activity_day(&principal("a"), fall).unwrap()["total"],
        3
    );
    admin
        .batch_execute("ALTER TABLE gtd.activity_events NO FORCE ROW LEVEL SECURITY")
        .unwrap();
    assert!(matches!(
        store.activity_summary(&principal("a"), query("changes")),
        Err(Error::UnsafeRole)
    ));
}
