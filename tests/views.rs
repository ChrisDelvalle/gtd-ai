use serde_json::json;
use tempfile::TempDir;
use todo_mcp::{application::Application, diagnostics::Diagnostics, model::*, store::Store};
fn fixture() -> (TempDir, Store, Vec<Task>) {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("tasks.db")).unwrap();
    let mut tasks = vec![];
    for (i, (status, due)) in [
        (Status::Archived, Some("2026-10-01")),
        (Status::Done, Some("2026-10-03")),
        (Status::Someday, None),
        (Status::Waiting, Some("2026-10-03")),
        (Status::Inbox, Some("2026-10-04")),
        (Status::Next, None),
        (Status::Next, Some("2026-10-04")),
        (Status::Next, Some("2026-10-03")),
    ]
    .into_iter()
    .enumerate()
    {
        tasks.push(
            store
                .capture(CaptureItem {
                    brief: Some("Complete this disposable view fixture.".into()),
                    blocked_by: None,
                    planning: todo_mcp::planning::PlanningPatch {
                        importance: Some(todo_mcp::planning::Importance::Normal),
                        estimated_minutes: Some(30),
                        effort: Some(todo_mcp::task_planning::Effort::Medium),
                        ..Default::default()
                    },
                    project_id: None,
                    review_date: None,
                    work_sessions: vec![],
                    completion_result: None,
                    request_id: format!("seed-{i}"),
                    title: format!("Task {i}"),
                    notes: "Searchable weekend notes".repeat(200),
                    agent_notes: None,
                    links: vec![],
                    location: None,
                    status,
                    archived: None,
                    due_date: due.map(str::to_string),
                    reason: "Synthetic view test".into(),
                })
                .unwrap()
                .task,
        );
    }
    (dir, store, tasks)
}
#[test]
fn active_default_and_pagination_put_next_actions_before_old_archives() {
    let (_dir, mut store, tasks) = fixture();
    let first = store
        .list(ListItems {
            limit: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        first.items.iter().map(|t| &t.id).collect::<Vec<_>>(),
        vec![&tasks[7].id, &tasks[6].id]
    );
    assert_eq!(first.next_offset, Some(2));
    let rest = store
        .list(ListItems {
            offset: 2,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        rest.items.iter().map(|t| t.status).collect::<Vec<_>>(),
        vec![Status::Next, Status::Inbox, Status::Waiting]
    );
    assert!(rest.next_offset.is_none());
}

#[test]
fn status_exclusions_compose_with_archive_and_stable_pagination() {
    let (_dir, mut store, tasks) = fixture();
    let filter = ListItems {
        view: Some(TaskView::All),
        archived: Some(false),
        exclude_statuses: Some(vec![Status::Done, Status::Someday]),
        limit: Some(2),
        ..Default::default()
    };
    let first = store.list(filter.clone()).unwrap();
    let mut ids: Vec<_> = first.items.iter().map(|t| t.id.clone()).collect();
    let mut cursor = first.next_cursor;
    while let Some(next) = cursor {
        let page = store
            .list(ListItems {
                cursor: Some(next),
                ..filter.clone()
            })
            .unwrap();
        ids.extend(page.items.iter().map(|t| t.id.clone()));
        cursor = page.next_cursor;
    }
    assert_eq!(ids.len(), 5);
    assert!(!ids.contains(&tasks[0].id));
    let including_archive = store
        .list(ListItems {
            archived: None,
            limit: Some(100),
            ..filter.clone()
        })
        .unwrap();
    assert_eq!(including_archive.items.len(), 6);
    assert!(including_archive.items.iter().any(|t| t.archived));
    let none = store
        .list(ListItems {
            exclude_statuses: Some(vec![
                Status::Next,
                Status::Inbox,
                Status::Waiting,
                Status::Blocked,
                Status::Someday,
                Status::Done,
            ]),
            ..filter.clone()
        })
        .unwrap();
    assert!(none.items.is_empty());
    assert!(none.next_cursor.is_none());
    let first = store.list(filter.clone()).unwrap();
    assert!(
        store
            .list(ListItems {
                cursor: first.next_cursor,
                exclude_statuses: None,
                ..filter.clone()
            })
            .is_err()
    );
    for invalid in [
        vec![Status::Next, Status::Next],
        vec![Status::Archived],
        vec![Status::Active],
    ] {
        assert!(
            store
                .list(ListItems {
                    exclude_statuses: Some(invalid),
                    ..filter.clone()
                })
                .is_err()
        );
    }
}
#[test]
fn explicit_scopes_ids_and_date_ranges_are_predictable() {
    let (_dir, mut store, tasks) = fixture();
    for (status, count) in [
        (Status::Archived, 1),
        (Status::Done, 1),
        (Status::Someday, 1),
        (Status::Next, 3),
    ] {
        assert_eq!(
            store
                .list(ListItems {
                    status: Some(status),
                    ..Default::default()
                })
                .unwrap()
                .items
                .len(),
            count
        );
    }
    assert_eq!(
        store
            .list(ListItems {
                view: Some(TaskView::All),
                ..Default::default()
            })
            .unwrap()
            .items
            .len(),
        8
    );
    assert!(
        store
            .list(ListItems {
                task_id: Some(tasks[0].id.clone()),
                ..Default::default()
            })
            .unwrap()
            .items[0]
            .archived
    );
    assert!(
        store
            .list(ListItems {
                view: Some(TaskView::Active),
                task_id: Some(tasks[0].id.clone()),
                ..Default::default()
            })
            .unwrap()
            .items
            .is_empty()
    );
    let weekend = store
        .list(ListItems {
            due_from: Some("2026-10-03".into()),
            due_through: Some("2026-10-04".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(weekend.items.len(), 4);
    assert!(
        weekend
            .items
            .iter()
            .all(|t| !matches!(t.status, Status::Done | Status::Archived))
    );
    assert_eq!(
        store
            .list(ListItems {
                undated: true,
                ..Default::default()
            })
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(
        store
            .list(ListItems {
                view: Some(TaskView::All),
                status: Some(Status::Done),
                ..Default::default()
            })
            .is_err()
    );
    assert!(
        store
            .list(ListItems {
                undated: true,
                due_from: Some("2026-10-03".into()),
                ..Default::default()
            })
            .is_err()
    );
}
#[tokio::test]
async fn summaries_are_small_and_full_notes_remain_accessible() {
    let (dir, store, tasks) = fixture();
    let diagnostics = Diagnostics::open(&dir.path().join("events.db"), "web").unwrap();
    let app = Application::new(store, diagnostics);
    let summary = app.execute_ui("list_items", json!({})).await.unwrap();
    let full = app
        .execute_ui("list_items", json!({"detail":"full"}))
        .await
        .unwrap();
    assert_eq!(summary["scope"], "active");
    assert_eq!(summary["detail"], "summary");
    assert!(summary["items"][0].get("notes").is_none());
    assert_eq!(summary["items"][0]["has_notes"], true);
    assert!(summary.to_string().len() * 5 < full.to_string().len());
    let detail = app
        .execute_ui("list_items", json!({"task_id":tasks[0].id}))
        .await
        .unwrap();
    assert_eq!(detail["scope"], "selected");
    assert_eq!(detail["items"][0]["notes"], tasks[0].notes);
}
