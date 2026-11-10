//! Compare native PostgreSQL reads with the established SQLite contract on the
//! exact same retained records; then edit dependencies between cursor pages.
use super::{
    legacy::{Snapshot, Source},
    tests::{fixture, principal},
    write_tests::{capture, input, patch, run},
    *,
};
use crate::{model::*, projection};
use serde_json::{Value, json};

fn without_checkpoint_identity(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for key in ["evaluated_at", "environment"] {
                object.remove(key);
            }
            if let Some(cursor) = object.get_mut("next_cursor") {
                *cursor = json!(!cursor.is_null());
            }
            for child in object.values_mut() {
                without_checkpoint_identity(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                without_checkpoint_identity(item);
            }
        }
        _ => {}
    }
}

fn assert_tasks(a: ListResult, b: ListResult) {
    assert_eq!(a.items, b.items);
    for (a, b) in a.items.iter().zip(&b.items) {
        assert_eq!(a.unresolved_blocker_ids, b.unresolved_blocker_ids);
        assert_eq!(
            a.recommendation
                .as_ref()
                .map(|r| (&r.reason, &r.source_task_id)),
            b.recommendation
                .as_ref()
                .map(|r| (&r.reason, &r.source_task_id))
        );
    }
    assert_eq!(
        a.history.iter().map(|c| c.id).collect::<Vec<_>>(),
        b.history.iter().map(|c| c.id).collect::<Vec<_>>()
    );
    assert_eq!(a.next_offset, b.next_offset);
    assert_eq!(a.next_cursor.is_some(), b.next_cursor.is_some());
    assert_eq!(a.next_history_after, b.next_history_after);
}
#[test]
#[ignore = "Manual deterministic read parity checks; isolated Docker and synthetic SQLite only"]
fn lists_history_and_cursors_preserve_contract_and_account_isolation() {
    let (_container, mut admin, runtime, _, _) = fixture();
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("read-parity.sqlite3");
    let mut old = crate::store::Store::open(&path).unwrap();
    let project=old.create_project(input(json!({"title":"Fixture project","brief":"Synthetic project.","notes":"Human project context.","agent_notes":"Agent project context.","request_id":"project","reason":"Fixture","review_date":"2090-01-01"}))).unwrap();
    let mut tasks = Vec::new();
    for i in 0..42 {
        let status = ["next", "inbox", "waiting", "blocked", "someday", "done"][i % 6];
        let mut value = capture(&format!("task-{i}"));
        value["status"] = json!(status);
        value["importance"] = json!(
            [
                "unimportant",
                "very_low",
                "low",
                "normal",
                "high",
                "very_high",
                "critical"
            ][i % 7]
        );
        value["estimated_minutes"] = json!((i + 1) * 5);
        value["effort"] = json!(["trivial", "low", "medium", "high", "extreme"][i % 5]);
        value["notes"] = json!(format!("Human instructions for {i}."));
        if i % 3 == 0 {
            value["due_date"] = json!("2090-01-03");
        }
        if i % 5 == 0 {
            value["due_date"] = json!("2000-01-01");
        }
        if i % 2 == 0 {
            value["review_date"] = json!("2090-01-02");
            value["project_id"] = json!(project.task.id);
        }
        if i % 4 == 0 {
            value["planned_start"] =
                json!({"date":"2090-01-01","time":"23:00","timezone":"America/New_York"});
            value["planned_finish"] =
                json!({"date":"2090-01-02","time":"01:00","timezone":"America/New_York"});
        }
        tasks.push(old.capture(input(value)).unwrap().task);
    }
    tasks[0] = old
        .update(input(patch(
            &tasks[0],
            "dep",
            json!({"blocked_by":[tasks[1].id]}),
        )))
        .unwrap()
        .task;
    tasks[10] = old
        .update(input(patch(
            &tasks[10],
            "archive",
            json!({"archived":true}),
        )))
        .unwrap()
        .task;
    let deleted = old.capture(input(capture("tombstone"))).unwrap();
    old.undo(input(json!({"request_id":"undo","change_id":deleted.change.id,"expected_version":deleted.task.version,"reason":"Fixture"}))).unwrap();
    let series=old.create_recurrence(input(json!({"request_id":"repeat","reason":"Fixture","template":{"title":"Repeating fixture","brief":"Repeat fixture work.","agent_notes":"Shared fixture context.","importance":"normal","estimated_minutes":5,"effort":"low"},"rule":{"start_date":"2090-01-01","frequency":"daily","count":5}}))).unwrap();
    old.materialize_recurrences("2090-01-03").unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    let source = Source {
        identity: db
            .query_row(
                "SELECT value FROM store_meta WHERE key='identity'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
            .parse()
            .unwrap(),
        environment: old.environment(),
    };
    Snapshot::open(&path, &source)
        .unwrap()
        .import(&store, &principal("a"))
        .unwrap();
    let foreign = run(&store, "b", "capture", capture("private-b"));
    for agent_context in [false, true] {
        for args in [
            json!({}),
            json!({"series_id":series.task.id,"segments_only":true}),
            json!({"series_id":series.task.id,"from":"2090-01-01","through":"2090-01-05","limit":2}),
            json!({"rule":{"start_date":"2026-03-07","frequency":"daily","count":3},"template":{"planned_start":{"offset_days":0,"time":"02:30","timezone":"America/New_York"},"planned_finish":{"offset_days":0,"time":"04:30","timezone":"America/New_York"}},"from":"2026-03-07","through":"2026-03-09","limit":2}),
        ] {
            let mut old_query: crate::recurrence_model::ListOccurrences = input(args);
            old_query.agent_context = agent_context;
            let mut new_query = old_query.clone();
            loop {
                let mut previous = old.list_occurrences(old_query.clone()).unwrap();
                let mut current = store
                    .list_occurrences(&principal("a"), new_query.clone())
                    .unwrap();
                let old_next = previous["next_cursor"].as_str().map(str::to_owned);
                let new_next = current["next_cursor"].as_str().map(str::to_owned);
                if let Some(cursor) = &new_next {
                    assert!(matches!(
                        store.list_occurrences(
                            &principal("b"),
                            crate::recurrence_model::ListOccurrences {
                                cursor: Some(cursor.clone()),
                                ..new_query.clone()
                            }
                        ),
                        Err(Error::ResetRequired)
                    ));
                    assert!(
                        store
                            .list_occurrences(
                                &principal("a"),
                                crate::recurrence_model::ListOccurrences {
                                    agent_context: !agent_context,
                                    cursor: Some(cursor.clone()),
                                    ..new_query.clone()
                                }
                            )
                            .is_err()
                    );
                }
                without_checkpoint_identity(&mut previous);
                without_checkpoint_identity(&mut current);
                assert_eq!(previous, current);
                if new_next.is_none() {
                    break;
                }
                old_query.cursor = old_next;
                new_query.cursor = new_next;
            }
        }
    }
    assert!(
        store
            .list_occurrences(&principal("b"), input(json!({"series_id":series.task.id})))
            .is_err()
    );
    store
        .read(&principal("a"), |tx| {
            let snapshot =
                super::read_snapshot::Snapshot::load(tx, tx.high(), crate::clock::timestamp())?;
            assert!(snapshot.nodes.iter().all(|n| n.task.notes.is_empty()
                && n.task.agent_notes.is_empty()
                && n.task.brief.is_empty()));
            Ok(())
        })
        .unwrap();
    for loading in ["on-demand", "featured", "top-three"] {
        let request = json!({"review_on":"2090-01-02","loading":loading});
        let mut previous = old.home_view(input(request.clone())).unwrap();
        let mut current = store.home_view(&principal("a"), input(request)).unwrap();
        // Home's continuation can be consumed by the ordinary account-bound list.
        let cursor = current["data"]["waiting"]["next_cursor"].as_str().unwrap();
        let page = store
            .list(
                &principal("a"),
                input(
                    json!({"status":"waiting","group_recurrences":true,"limit":4,"cursor":cursor}),
                ),
            )
            .unwrap();
        assert!(!page.items.is_empty());
        without_checkpoint_identity(&mut previous);
        without_checkpoint_identity(&mut current);
        assert_eq!(previous, current);
    }
    let mut cases = vec![
        json!({}),
        json!({"view":"active"}),
        json!({"view":"all"}),
        json!({"archived":true}),
        json!({"status":"archived"}),
        json!({"view":"all","include_deleted":true}),
        json!({"view":"all","group_recurrences":true}),
        json!({"view":"all","project_id":project.task.id}),
        json!({"blocked_by_id":tasks[1].id,"view":"all"}),
        json!({"view":"all","review_on":"2090-01-02"}),
        json!({"review_from":"2090-01-02","review_through":"2090-01-03"}),
        json!({"view":"all","due_from":"2090-01-01","due_through":"2090-01-03"}),
        json!({"view":"all","undated":true}),
        json!({"view":"all","planned_from":"2090-01-02","planned_through":"2090-01-02"}),
        json!({"view":"all","max_estimated_minutes":30,"max_effort":"low"}),
        json!({"view":"all","exclude_statuses":["done","someday"]}),
        json!({"task_id":tasks[10].id}),
        json!({"task_ids":[tasks[0].id,tasks[1].id]}),
        json!({"task_id":deleted.task.id,"include_deleted":true,"include_history":true,"history_limit":1}),
    ];
    for status in [
        "inbox", "next", "waiting", "blocked", "planned", "someday", "done",
    ] {
        cases.push(json!({"status":status}));
    }
    for sort in [
        "action",
        "due",
        "importance",
        "created",
        "updated",
        "relevance",
    ] {
        cases.push(json!({"view":"all","sort":sort}));
    }
    for args in cases {
        let mut q: ListItems = input(args.clone());
        q.limit = Some(100);
        assert_tasks(
            old.list(q.clone()).unwrap(),
            store.list(&principal("a"), q).unwrap(),
        );
    }
    for args in [
        json!({}),
        json!({"view":"all"}),
        json!({"project_id":project.task.id}),
        json!({"review_on":"2090-01-02"}),
        json!({"status":"active"}),
    ] {
        let query: ListProjects = input(args);
        assert_eq!(
            old.projects(query.clone()).unwrap(),
            store.projects(&principal("a"), query).unwrap()
        );
    }
    for args in [
        json!({"limit":4}),
        json!({"task_id":tasks[0].id}),
        json!({"project_id":project.task.id}),
        json!({"entity_type":"recurrence","task_id":series.task.id}),
        json!({"change_id":1,"detail":"full"}),
    ] {
        let query: ListChanges = input(args);
        let mut sqlite = serde_json::to_value(old.changes(query.clone()).unwrap()).unwrap();
        let mut postgres =
            serde_json::to_value(store.changes(&principal("a"), query).unwrap()).unwrap();
        for page in [&mut sqlite, &mut postgres] {
            without_checkpoint_identity(page);
            // These open-ended queries resolve through each backend's own
            // evaluation instant and issue backend-specific snapshot tokens.
            page["window"].as_object_mut().unwrap().remove("end");
            assert!(
                page.as_object_mut()
                    .unwrap()
                    .remove("snapshot")
                    .unwrap()
                    .is_string()
            );
        }
        assert_eq!(sqlite, postgres);
    }
    for args in [
        json!({"task_id":foreign.task.id}),
        json!({"task_ids":[foreign.task.id]}),
        json!({"blocked_by_id":foreign.task.id}),
        json!({"project_id":foreign.task.id}),
    ] {
        assert!(
            store
                .list(&principal("a"), input(args))
                .unwrap()
                .items
                .is_empty()
        );
    }
    assert!(
        store
            .changes(&principal("a"), input(json!({"task_id":foreign.task.id})))
            .unwrap()
            .changes
            .is_empty()
    );
    assert!(
        store
            .projects(
                &principal("b"),
                input(json!({"project_id":project.task.id}))
            )
            .unwrap()["projects"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // A complete immutable read, including graph nodes outside the page, is
    // preserved after an intervening prerequisite edit and time change.
    let q: ListItems = input(json!({"view":"all","group_recurrences":true,"limit":3}));
    let mut expected = Vec::new();
    let mut before = ListItems {
        limit: Some(100),
        ..q.clone()
    };
    loop {
        let page = store.list(&principal("a"), before.clone()).unwrap();
        expected.extend(page.items);
        if let Some(cursor) = page.next_cursor {
            before.cursor = Some(cursor)
        } else {
            break;
        }
    }
    let first = store.list(&principal("a"), q.clone()).unwrap();
    let cursor = first.next_cursor.clone().unwrap();
    let mut continuation = ListItems {
        cursor: Some(cursor.clone()),
        ..q.clone()
    };
    assert!(matches!(
        store.list(&principal("b"), continuation.clone()),
        Err(Error::ResetRequired)
    ));
    continuation.archived = Some(false);
    assert!(matches!(
        store.list(&principal("a"), continuation),
        Err(Error::ResetRequired)
    ));
    run(
        &store,
        "a",
        "update",
        patch(&tasks[1], "after-page", json!({"status":"done"})),
    );
    let frozen_time = first.evaluated_at.clone();
    let mut seen = first.items;
    let mut next = Some(cursor);
    while let Some(cursor) = next {
        let page = store
            .list(
                &principal("a"),
                ListItems {
                    cursor: Some(cursor),
                    ..q.clone()
                },
            )
            .unwrap();
        assert_eq!(page.evaluated_at, frozen_time);
        seen.extend(page.items);
        next = page.next_cursor;
    }
    assert_eq!(seen.len(), expected.len());
    for (seen, expected) in seen.iter().zip(&expected) {
        assert_eq!(seen, expected);
    }
    let fresh = store
        .list(&principal("a"), input(json!({"task_id":tasks[0].id})))
        .unwrap();
    assert_eq!(fresh.items[0].status, Status::Next);

    // Complete context pagination shrinks long pages without summary substitution.
    for i in 0..3 {
        let mut v = capture(&format!("long-{i}"));
        v["notes"] = json!("🪴".repeat(9000));
        v["agent_notes"] = json!("Fresh agent handoff. ".repeat(100));
        run(&store, "b", "capture", v);
    }
    let mut q: ListItems = input(json!({"view":"all","limit":100}));
    q.agent_context = true;
    let mut total = 0;
    loop {
        let page = store.list(&principal("b"), q.clone()).unwrap();
        assert!(!page.items.is_empty());
        assert!(page.items.len() <= 2);
        for t in &page.items {
            assert!(!t.agent_notes.is_empty());
        }
        total += page.items.len();
        if let Some(cursor) = page.next_cursor {
            assert!(matches!(
                store.list(
                    &principal("b"),
                    ListItems {
                        agent_context: false,
                        detail: Some(Detail::Full),
                        include_agent_notes: true,
                        cursor: Some(cursor.clone()),
                        ..q.clone()
                    }
                ),
                Err(Error::ResetRequired)
            ));
            q.cursor = Some(cursor);
        } else {
            break;
        }
    }
    assert_eq!(total, 4);
    let ui = store
        .list(
            &principal("b"),
            ListItems {
                agent_context: false,
                cursor: None,
                ..q
            },
        )
        .unwrap();
    assert_eq!(ui.items.len(), 4);
    assert!(
        serde_json::to_vec(&crate::view::task_list(&ui, &ListItems::default()))
            .unwrap()
            .len()
            < projection::PAGE_BYTES
    );
    for args in [
        json!({"view":"all","status":"next"}),
        json!({"due_from":"2090-03-03","due_through":"2090-01-01"}),
        json!({"limit":101}),
    ] {
        assert!(store.list(&principal("a"), input(args)).is_err());
    }
    assert!(matches!(
        store.list(&principal("a"), input(json!({"query":"fixture"}))),
        Err(Error::Business(crate::store::StoreError::SearchUnavailable))
    ));
}
