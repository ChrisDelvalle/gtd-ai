use super::{
    read_snapshot::Snapshot,
    reads::{Cursor, limit},
    *,
};
use crate::{
    model::{EntityType, ListItems, TaskSort, TaskView},
    priority_grid::{self, Grid, PAGE_SIZE, Query},
};
use serde_json::{Value, json};

impl Store {
    pub(super) fn priority_grid(&self, principal: &Principal, q: Query) -> Result<Value> {
        q.validate()?;
        self.read(principal, |tx| {
            let base = tx.list_cursor(
                q.snapshot.as_deref(),
                priority_grid::SUMMARY_CURSOR,
                json!({"project":q.project}),
                false,
                0,
            )?;
            if base.position != 0 || base.timezone != tx.account.timezone.name() {
                return Err(Error::ResetRequired);
            }
            let cell_page = if let Some(cell) = q.cell {
                let key = json!({"project":q.project,"cell":cell,"sort":q.sort});
                let cursor = if let Some(cursor) = &q.cursor {
                    tx.list_cursor(Some(cursor), priority_grid::CELL_CURSOR, key, false, 0)?
                } else {
                    Cursor {
                        phase: priority_grid::CELL_CURSOR.into(),
                        query: key,
                        position: q.offset.unwrap_or_default().into(),
                        ..base.clone()
                    }
                };
                if cursor.high != base.high
                    || cursor.evaluated_at != base.evaluated_at
                    || cursor.timezone != base.timezone
                {
                    return Err(Error::ResetRequired);
                }
                Some((cell, cursor, limit(q.limit, PAGE_SIZE as u32)?))
            } else {
                None
            };
            let snapshot = Snapshot::load(tx, base.high, base.evaluated_at.clone())?;
            let grid = Grid::new(
                &snapshot.graph,
                &snapshot.rankings,
                snapshot.availability.as_deref(),
                &base.evaluated_at,
                q.project.as_deref(),
                |id| snapshot.series_timezones.get(id).map(String::as_str),
            )?;
            let Some((cell, mut cursor, max)) = cell_page else {
                return snapshot.priority_summary(&base, &grid);
            };
            let rows = snapshot
                .priority_order_with(q.sort.unwrap_or(TaskSort::Action))
                .filter(|task| grid.includes(task, cell))
                .skip(cursor.position as usize)
                .map(|task| grid.row(task, &snapshot.graph, &snapshot.rankings));
            let (items, more) = priority_grid::page(rows, max)?;
            cursor.position += items.len() as u64;
            Ok(json!({"kind":priority_grid::CELL,"items":items,
                "next_cursor":more.then(|| cursor.encode()).transpose()?}))
        })
    }
}

impl Snapshot {
    fn priority_order(&self) -> impl Iterator<Item = &crate::model::Task> {
        self.priority_order_with(TaskSort::Action)
    }
    fn priority_order_with(&self, sort: TaskSort) -> impl Iterator<Item = &crate::model::Task> {
        let input = ListItems {
            view: Some(TaskView::All),
            archived: Some(false),
            sort: Some(sort),
            ..Default::default()
        };
        self.select(&input, EntityType::Task)
            .into_iter()
            .map(|(node, _)| &node.task)
    }

    fn priority_summary(&self, base: &Cursor, grid: &Grid<'_>) -> Result<Value> {
        let mut summary = grid.summary(&self.graph, base.encode()?, &base.evaluated_at);
        summary["previews"] = grid.previews(self.priority_order(), &self.graph, &self.rankings)?;
        Ok(summary)
    }

    pub(super) fn widget_priorities(&self, base: &Cursor) -> Result<Value> {
        let cursor = Cursor {
            phase: priority_grid::SUMMARY_CURSOR.into(),
            query: json!({"project":null}),
            position: 0,
            ..base.clone()
        };
        let grid = Grid::new(
            &self.graph,
            &self.rankings,
            self.availability.as_deref(),
            &base.evaluated_at,
            None,
            |id| self.series_timezones.get(id).map(String::as_str),
        )?;
        self.priority_summary(&cursor, &grid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postgres::{
        tests::{fixture, principal},
        write_tests::{capture, high, input, patch, run},
    };

    #[test]
    #[ignore = "Disposable PostgreSQL priority chart and account isolation"]
    fn priority_grid_freezes_membership_and_filters_projects_in_account() {
        let (_container, mut admin, runtime, _, _) = fixture();
        admin
            .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
            .unwrap();
        let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
        let a = principal("a");
        let b = principal("b");
        let project = run(&store, "a", "project", json!({"request_id":"project","title":"Fixture project","brief":"Disposable project.","agent_notes":"Test fixture.","reason":"Deterministic fixture"})).task;
        let mut fields = capture("first");
        fields["project_id"] = json!(project.id);
        let first = run(&store, "a", "capture", fields).task;
        let second = run(&store, "a", "capture", capture("second")).task;
        run(
            &store,
            "a",
            "update",
            patch(&second, "archive", json!({"archived":true})),
        );
        let third = run(&store, "a", "capture", capture("third")).task;
        run(&store, "b", "capture", capture("other-account"));

        let revision = high(&store, "a");
        let snapshot = store.priority_grid(&a, Query::default()).unwrap();
        assert_eq!(snapshot["counts"][3][0]["next"], 2);
        assert_eq!(snapshot["previews"][21][0]["id"], first.id);
        assert_eq!(snapshot["previews"][21][1]["id"], third.id);
        assert_eq!(high(&store, "a"), revision);
        let project_snapshot = store
            .priority_grid(&a, input(json!({"project":project.id})))
            .unwrap();
        assert_eq!(project_snapshot["counts"][3][0]["next"], 1);
        assert_eq!(
            store
                .priority_grid(&b, input(json!({"project":project.id})))
                .unwrap()["counts"][3][0]["next"],
            0
        );
        let mut page_args = json!({"snapshot":snapshot["snapshot"],"cell":{"importance":"normal","urgency":"undated","scope":"next"},"limit":1});
        let page = store.priority_grid(&a, input(page_args.clone())).unwrap();
        assert_eq!(page["items"][0]["id"], first.id);
        let mut continuation = page_args.clone();
        continuation["offset"] = json!(1);
        assert_eq!(
            store.priority_grid(&a, input(continuation)).unwrap()["items"][0]["id"],
            third.id
        );
        assert!(store.priority_grid(&b, input(page_args.clone())).is_err());
        let mut urgent = capture("urgent-dependent");
        urgent["importance"] = json!("critical");
        urgent["due_date"] = json!("2020-01-01");
        urgent["blocked_by"] = json!([first.id]);
        let urgent = run(&store, "a", "capture", urgent).task;
        let raised = store
            .priority_grid(&a, input(json!({"project":project.id})))
            .unwrap();
        assert_eq!(raised["counts"][6][6]["next"], 1);
        assert_eq!(raised["counts"][6][6]["blocked"], 0);
        assert_eq!(raised["counts"][3][0]["next"], 0);
        let raised_page = store
            .priority_grid(
                &a,
                input(json!({
                    "project":project.id, "snapshot":raised["snapshot"],
                    "cell":{"importance":"critical","urgency":"overdue"}
                })),
            )
            .unwrap();
        assert_eq!(raised_page["items"][0], raised["previews"][48][0]);
        assert_eq!(raised_page["items"][0]["id"], first.id);
        assert_eq!(raised_page["items"][0]["priority_from"]["id"], urgent.id);
        let unchanged = store.priority_grid(&a, input(page_args.clone())).unwrap();
        assert_eq!(unchanged["items"], page["items"]);
        assert_eq!(
            crate::postgres::write_tests::task(&store, "a", &first.id),
            first
        );
        run(
            &store,
            "a",
            "update",
            patch(&third, "complete", json!({"status":"done"})),
        );
        page_args["cursor"] = page["next_cursor"].clone();
        let rest = store.priority_grid(&a, input(page_args.clone())).unwrap();
        assert_eq!(rest["items"][0]["id"], third.id);
        assert!(rest["next_cursor"].is_null());
        page_args["cell"]["scope"] = json!("all");
        assert!(store.priority_grid(&a, input(page_args.clone())).is_err());
        page_args["project"] = json!(project.id);
        assert!(store.priority_grid(&a, input(page_args)).is_err());
    }

    #[test]
    #[ignore = "Disposable PostgreSQL recurrence calendar and chart snapshot"]
    fn priority_grid_launch_and_drilldown_use_the_pinned_series_timezone() {
        let (_container, mut admin, runtime, _, _) = fixture();
        admin
            .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
            .unwrap();
        let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
        let account = principal("a");
        store
            .set_account_timezone(&account, "America/New_York", "America/Los_Angeles")
            .unwrap();
        run(
            &store,
            "a",
            "recurrence",
            json!({
                "request_id":"scheduled","rule":{"start_date":"2020-03-08","frequency":"daily","count":1},
                "template":{"title":"Scheduled fixture","brief":"Complete the fixture.","agent_notes":"Disposable fixture.",
                    "importance":"normal","status":"next","estimated_minutes":5,"effort":"low"},"reason":"Fixture"
            }),
        );
        store
            .set_account_timezone(&account, "America/Los_Angeles", "America/New_York")
            .unwrap();
        for (at, urgency, column) in [
            ("2020-03-09T06:59:59Z", "immediate", 5),
            ("2020-03-09T07:00:00Z", "overdue", 6),
        ] {
            let grid = store
                .read(&account, |tx| {
                    let mut cursor = tx.list_cursor(None, "widget", json!(null), false, 0)?;
                    cursor.evaluated_at = at.into();
                    let snapshot = Snapshot::load(tx, cursor.high, at.into())?;
                    snapshot.widget_priorities(&cursor)
                })
                .unwrap();
            assert_eq!(grid["counts"][3][column]["next"], 1);
            let row = &grid["previews"][3 * 7 + column][0];
            assert_eq!(row["scheduled"]["timezone"], "America/Los_Angeles");
            let page = store.priority_grid(&account, input(json!({
                "snapshot":grid["snapshot"], "cell":{"importance":"normal","urgency":urgency}
            }))).unwrap();
            assert_eq!(page["items"][0], *row);
        }
    }
    #[test]
    #[ignore = "Disposable PostgreSQL project fallback, exact closure and frozen filtering"]
    fn project_deadline_resolves_before_dependency_inheritance_and_survives_sorting() {
        let (_container, mut admin, runtime, _, _) = fixture();
        admin
            .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
            .unwrap();
        let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
        let account = principal("a");
        let project = run(&store, "a", "project", json!({"request_id":"project","title":"Launch","brief":"Deliver the fictional launch.","agent_notes":"Disposable project deadline inheritance fixture.","due_date":"2000-01-01","reason":"Disposable policy fixture"})).task;
        let root = run(&store, "a", "capture", capture("root")).task;
        let mut child = capture("child");
        child["project_id"] = json!(project.id);
        child["blocked_by"] = json!([root.id]);
        child["importance"] = json!("critical");
        let child = run(&store, "a", "capture", child).task;
        let before = high(&store, "a");
        let full = store
            .list(&account, input(json!({"task_id":root.id})))
            .unwrap();
        let r = full.items[0].recommendation.as_ref().unwrap();
        assert_eq!(r.source_task_id.as_deref(), Some(child.id.as_str()));
        assert_eq!(r.reason, "Project deadline overdue");
        assert!(r.effective_deadline.is_none()); // Own field sorting never borrows a dependency's date.
        let child_read = store
            .list(&account, input(json!({"task_id":child.id})))
            .unwrap();
        assert_eq!(
            child_read.items[0]
                .recommendation
                .as_ref()
                .unwrap()
                .deadline_project
                .as_ref()
                .unwrap()
                .id,
            project.id
        );
        assert_eq!(high(&store, "a"), before);
        let grid = store.priority_grid(&account, Query::default()).unwrap();
        assert_eq!(grid["counts"][6][6]["next"], 1);
        assert_eq!(grid["timing_counts"][6][6][1]["next"], 1);
        let args = json!({"snapshot":grid["snapshot"],"cell":{"importance":"critical","urgency":"overdue","timing":"deadlines"},"sort":"created_desc"});
        let page = store.priority_grid(&account, input(args.clone())).unwrap();
        assert_eq!(page["items"][0]["id"], root.id);
        assert_eq!(page["items"][0]["importance_from"]["id"], child.id);
        assert_eq!(page["items"][0]["urgency_from"]["id"], child.id);
        assert_eq!(page["items"][0]["deadline_project"]["id"], project.id);
        assert!(
            store
                .priority_grid(&principal("b"), input(args.clone()))
                .is_err()
        );
        run(
            &store,
            "a",
            "update_project",
            json!({"request_id":"later-project","project_id":project.id,"expected_version":project.version,"due_date":"2099-01-01","reason":"Snapshot isolation"}),
        );
        assert_eq!(
            store.priority_grid(&account, input(args)).unwrap()["items"],
            page["items"]
        );
        let fresh = store.priority_grid(&account, Query::default()).unwrap();
        assert_eq!(fresh["counts"][6][1]["next"], 1);
    }
}
