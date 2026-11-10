//! Real PostgreSQL/RLS with a deterministic loopback search engine. The mock
//! checks server-generated ownership filters and can deliberately return bad hits.
use super::{
    tests::{fixture, principal},
    write_tests::{capture, input, patch, run},
    *,
};
use crate::model::*;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
#[path = "../../tests/support/search_mock.rs"]
mod mock;

fn ready(store: &Store, account: &str) {
    for _ in 0..30 {
        store.index_once(&principal(account)).unwrap();
        if store.search_health(&principal(account)).unwrap()["ready"] == true {
            return;
        }
    }
    panic!("Index did not become ready");
}
fn publication(store: &Store, account: &str) -> Value {
    store
        .read(&principal(account), |tx| {
            let value = super::search::get(tx, "active")?.unwrap();
            Ok(serde_json::from_str(&value)?)
        })
        .unwrap()
}
fn search(store: &Store, account: &str, args: Value) -> Result<ListResult> {
    store.list(&principal(account), input(args))
}
fn unavailable(result: Result<ListResult>) {
    assert!(matches!(
        result,
        Err(Error::Business(crate::store::StoreError::SearchUnavailable))
    ));
}

#[test]
#[ignore = "Manual deterministic PostgreSQL/search checks; disposable Docker and loopback mock only"]
fn search_isolation_frozen_results_validation_restart_and_fencing() {
    let (_container, mut admin, runtime, a, b) = fixture();
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let mock = mock::Mock::start();
    let config = SearchConfig::new(mock.url.clone(), "synthetic-test-key".into()).unwrap();
    let store = Store::connect(runtime.clone(), Environment::Staging, 4)
        .unwrap()
        .with_search(config.clone());
    let tasks: Vec<_> = (0..5)
        .map(|i| run(&store, "a", "capture", capture(&format!("quartz-{i}"))).task)
        .collect();
    let foreign = run(&store, "b", "capture", capture("quartz-private-b")).task;
    let project=run(&store,"a","project",json!({"request_id":"project","title":"Quartz project","brief":"Fixture outcome.","agent_notes":"Shared synthetic context.","reason":"Fixture"})).task;
    // Accepted async task IDs survive a process restart without resubmission.
    mock.state.lock().unwrap().hold = true;
    store.index_once(&principal("a")).unwrap();
    let count = mock.state.lock().unwrap().tasks.len();
    let restarted = Store::connect(runtime, Environment::Staging, 4)
        .unwrap()
        .with_search(config);
    restarted.index_once(&principal("a")).unwrap();
    assert_eq!(mock.state.lock().unwrap().tasks.len(), count);
    mock.state.lock().unwrap().hold = false;
    ready(&restarted, "a");
    ready(&store, "b");
    let initial = publication(&store, "a");
    let other = publication(&store, "b");
    assert_ne!(initial["index"], other["index"]);
    {
        let state = mock.state.lock().unwrap();
        let index = &state.indices[initial["index"].as_str().unwrap()];
        assert!(
            index
                .docs
                .values()
                .all(|d| d["account_id"] == a.to_string())
        );
        assert!(
            index.settings["filterableAttributes"]
                .as_array()
                .unwrap()
                .contains(&json!("account_id"))
        );
    }
    let first = search(&store, "a", json!({"query":"quartz","limit":2})).unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(first.items.iter().all(|t| t.id != foreign.id));
    let cursor = first.next_cursor.clone().unwrap();
    assert!(matches!(
        search(
            &store,
            "b",
            json!({"query":"quartz","limit":2,"cursor":cursor})
        ),
        Err(Error::ResetRequired)
    ));
    assert!(matches!(
        search(
            &store,
            "a",
            json!({"query":"other","limit":2,"cursor":cursor})
        ),
        Err(Error::ResetRequired)
    ));
    let projects = store
        .projects(&principal("a"), input(json!({"query":"quartz"})))
        .unwrap();
    assert_eq!(projects["projects"][0]["id"], project.id);
    let before = search(
        &store,
        "a",
        json!({"query":"quartz","sort":"created","limit":100}),
    )
    .unwrap();
    assert_eq!(
        before.items.iter().map(|t| &t.id).collect::<Vec<_>>(),
        tasks.iter().map(|t| &t.id).collect::<Vec<_>>()
    );
    let changed = run(
        &store,
        "a",
        "update",
        patch(
            &tasks[4],
            "rename",
            json!({"title":"Changed after snapshot"}),
        ),
    )
    .task;
    ready(&store, "a");
    let mut frozen = first.items;
    let mut next = Some(cursor);
    while let Some(cursor) = next {
        let page = search(
            &store,
            "a",
            json!({"query":"quartz","limit":2,"cursor":cursor}),
        )
        .unwrap();
        assert_eq!(page.evaluated_at, first.evaluated_at);
        frozen.extend(page.items);
        next = page.next_cursor;
    }
    assert_eq!(frozen.len(), 5);
    assert!(
        frozen
            .iter()
            .any(|t| t.id == changed.id && t.title == "quartz-4")
    );
    assert_eq!(
        search(&store, "a", json!({"query":"quartz"}))
            .unwrap()
            .items
            .len(),
        4
    );
    // Collection affects only this account's retired generation; cursor reads
    // use frozen authoritative IDs and do not need that remote index anymore.
    admin
        .execute(
            "UPDATE gtd.search_state SET value='0' WHERE account_id=$1 AND key=$2",
            &[
                &a,
                &format!("generation:{}", initial["index"].as_str().unwrap()),
            ],
        )
        .unwrap();
    store.index_once(&principal("a")).unwrap();
    store.index_once(&principal("a")).unwrap();
    {
        let state = mock.state.lock().unwrap();
        assert!(
            !state
                .indices
                .contains_key(initial["index"].as_str().unwrap())
        );
        assert!(state.indices.contains_key(other["index"].as_str().unwrap()));
    }
    // IDs are not sufficient: reject a foreign owner, absent ID and wrong revision.
    for hit in [
        json!({"id":foreign.id,"revision":foreign.last_change_id,"account_id":b.to_string()}),
        json!({"id":foreign.id,"revision":foreign.last_change_id,"account_id":a.to_string()}),
        json!({"id":tasks[0].id,"revision":tasks[0].last_change_id+100,"account_id":a.to_string()}),
        json!({"id":tasks[0].id,"account_id":a.to_string()}),
    ] {
        mock.state.lock().unwrap().override_hits = Some(vec![hit]);
        unavailable(search(&store, "a", json!({"query":"quartz"})));
        mock.state.lock().unwrap().override_hits = None;
        let old = publication(&store, "a");
        ready(&store, "a");
        assert_ne!(
            old["index"],
            publication(&store, "a")["index"],
            "repair must get a fresh generation"
        );
    }
    let mut agent_query: ListItems = input(json!({"query":"quartz"}));
    agent_query.agent_context = true;
    let matches = store.list(&principal("a"), agent_query).unwrap();
    assert!(
        matches
            .items
            .iter()
            .all(|t| t.agent_notes == "Synthetic context only.")
    );
    // Missing indexes rebuild at the same database revision, without task writes.
    let lost = publication(&store, "a");
    mock.state
        .lock()
        .unwrap()
        .indices
        .remove(lost["index"].as_str().unwrap());
    unavailable(search(&store, "a", json!({"query":"quartz"})));
    ready(&store, "a");
    assert_eq!(publication(&store, "a")["high"], lost["high"]);
    // Revoked lease prevents publication; network work holds no account lock.
    run(&store, "a", "capture", capture("quartz-new"));
    let principal_a = principal("a");
    let replacement = store.clone();
    mock.state.lock().unwrap().stats_callback = Some(Box::new(move || {
        replacement
            .write(&principal_a, |tx| {
                super::search::put(
                    tx,
                    "lease",
                    &format!("{}:replacement-owner", chrono::Utc::now().timestamp() + 30),
                )
            })
            .unwrap();
    }));
    let mut fenced = false;
    for _ in 0..12 {
        if store.index_once(&principal("a")).is_err() {
            fenced = true;
            break;
        }
    }
    assert!(fenced);
    assert_ne!(store.search_health(&principal("a")).unwrap()["ready"], true);
    admin
        .execute(
            "DELETE FROM gtd.search_state WHERE account_id=$1 AND key='lease'",
            &[&a],
        )
        .unwrap();
    ready(&store, "a");
    // Ordinary explicit sorts remain independent of engine relevance. Bad query
    // syntax never reaches the engine, and all waits share one bounded deadline.
    let calls = mock.state.lock().unwrap().searches.len();
    assert!(search(&store, "a", json!({"query":"-quartz"})).is_err());
    assert_eq!(mock.state.lock().unwrap().searches.len(), calls);
    mock.state.lock().unwrap().delay = Duration::from_secs(5);
    let started = Instant::now();
    unavailable(search(&store, "a", json!({"query":"quartz"})));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(
        store
            .read(&principal("a"), |tx| super::search::get(tx, "repair"))
            .unwrap()
            .is_none(),
        "a timeout must not trigger an unnecessary index rebuild"
    );
    admin
        .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&a])
        .unwrap();
    assert!(matches!(
        search(&store, "a", json!({"query":"quartz"})),
        Err(Error::AccountUnavailable)
    ));
    // Search bodies contain only server-owned filters, never caller expressions.
    assert!(
        mock.state
            .lock()
            .unwrap()
            .search_bodies
            .iter()
            .all(|body| body["filter"] == format!("account_id = \"{a}\"")
                || body["filter"] == format!("account_id = \"{b}\""))
    );
}
