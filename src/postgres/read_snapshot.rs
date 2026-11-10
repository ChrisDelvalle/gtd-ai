//! One account/revision graph per composed read, with full bodies fetched only
//! for the selected page. Filtering and ordering never see another account.
use super::*;
use crate::{model::*, planning, store::dependencies::Graph};
use ::postgres::types::ToSql;
use chrono::{DateTime, Utc};
use std::{
    cell::RefCell,
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

const RANK_DOCUMENT: &str = "((document::jsonb - ARRAY['notes','brief','agent_notes','links','work_sessions','recurrence','completion_result','location','timing_adjustments']) || '{\"notes\":\"\"}'::jsonb)::text";
const EXACT_GRAPH_LIMIT: usize = 128;

pub(super) struct Node {
    pub task: Task,
    created: i64,
}
pub(super) struct Snapshot {
    pub high: i64,
    pub evaluated_at: String,
    pub nodes: Vec<Node>,
    pub graph: Graph,
    pub series_timezones: HashMap<String, String>,
    pub rankings: HashMap<String, planning::Recommendation>,
    pub blocking_counts: HashMap<String, usize>,
    pub availability: Option<String>,
    bodies: RefCell<HashMap<String, Task>>,
}

// Both sources expose the same account-bound historical record shape. The
// current path avoids walking history on ordinary screen loads.
pub(super) fn source(current: bool) -> &'static str {
    if current {
        "WITH records AS (SELECT t.id entity_id,t.entity_type,t.document,
         (SELECT min(r.seq) FROM gtd.revisions r WHERE r.account_id=$1 AND r.entity_id=t.id) created_seq
         FROM gtd.tasks t WHERE t.account_id=$1 AND $2::bigint>=0)"
    } else {
        "WITH latest AS (SELECT DISTINCT ON (entity_id) entity_id,entity_type,document
         FROM gtd.revisions WHERE account_id=$1 AND seq<=$2 ORDER BY entity_id,seq DESC),
         records AS (SELECT l.*,(SELECT min(r.seq) FROM gtd.revisions r WHERE r.account_id=$1 AND r.entity_id=l.entity_id) created_seq FROM latest l)"
    }
}
impl Snapshot {
    pub fn load(tx: &mut AccountTransaction<'_>, high: i64, evaluated_at: String) -> Result<Self> {
        Self::load_for(tx, high, evaluated_at, None)
    }

    pub(super) fn load_for(
        tx: &mut AccountTransaction<'_>,
        high: i64,
        evaluated_at: String,
        exact: Option<&str>,
    ) -> Result<Self> {
        let at = DateTime::parse_from_rfc3339(&evaluated_at)
            .map_err(|_| Error::ResetRequired)?
            .with_timezone(&Utc);
        let exact = exact.filter(|_| high == tx.high());
        let focused = if let Some(id) = exact {
            // Dependents may supply inherited rank. Their prerequisites keep
            // graph validation and resolution identical to a complete load.
            // Creation order is immaterial for a single selected record.
            let sql = format!(
                "WITH RECURSIVE dependents(id) AS (
                    SELECT $2::text
                    UNION SELECT d.task_id FROM gtd.dependencies d
                    JOIN dependents q ON q.id=d.prerequisite_id WHERE d.account_id=$1
                 ), needed(id) AS (
                    SELECT id FROM dependents
                    UNION SELECT d.prerequisite_id FROM gtd.dependencies d
                    JOIN needed q ON q.id=d.task_id WHERE d.account_id=$1
                 ), bounded AS MATERIALIZED (SELECT id FROM needed LIMIT $3),
                 fits AS (SELECT count(*) < $3 AS small FROM bounded)
                 SELECT {RANK_DOCUMENT}, 0::bigint, NULL::text
                 FROM bounded JOIN gtd.tasks t USING (id)
                 WHERE t.account_id=$1 AND (SELECT small FROM fits)
                 UNION ALL SELECT NULL, 0::bigint, NULL::text WHERE NOT (SELECT small FROM fits)"
            );
            let rows = tx.tx.query_typed(
                &sql,
                &[
                    (&tx.account.id, Type::UUID),
                    (&id, Type::TEXT),
                    (&((EXACT_GRAPH_LIMIT + 1) as i64), Type::INT8),
                ],
            )?;
            // The sentinel avoids projecting any records before falling back.
            rows.first()
                .is_none_or(|row| row.get::<_, Option<&str>>(0).is_some())
                .then_some(rows)
        } else {
            None
        };
        let used_focus = focused.is_some();
        let rows = if let Some(rows) = focused {
            rows
        } else {
            let sql = format!(
                "{} SELECT {RANK_DOCUMENT},created_seq,
                 CASE WHEN entity_type='recurrence' THEN document::jsonb #>> '{{recurrence,timezone}}' END
                 FROM records",
                source(high == tx.high())
            );
            tx.tx
                .query_typed(&sql, &[(&tx.account.id, Type::UUID), (&high, Type::INT8)])?
        };
        let mut series_timezones = HashMap::new();
        let nodes = rows
            .into_iter()
            .map(|row| {
                let task: Task = serde_json::from_str(&row.get::<_, String>(0))?;
                if let Some(zone) = row.get::<_, Option<String>>(2) {
                    series_timezones.insert(task.id.clone(), zone);
                }
                Ok(Node {
                    task,
                    created: row.get(1),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let graph = Graph::new(nodes.iter().map(|n| n.task.clone()).collect())?;
        let blocking_counts = graph.blocking_counts();
        // Even exact responses carry the account-wide availability boundary.
        let mut other_holds = Vec::new();
        if used_focus {
            other_holds = tx
                .tx
                .query_typed(
                    "SELECT document::jsonb->>'not_before' FROM gtd.tasks
                 WHERE account_id=$1 AND entity_type='task'
                 AND document::jsonb->>'status'='blocked'
                 AND NOT COALESCE((document::jsonb->>'archived')::boolean,false)
                 AND NOT COALESCE((document::jsonb->>'deleted')::boolean,false)
                 AND document::jsonb->>'not_before' IS NOT NULL",
                    &[(&tx.account.id, Type::UUID)],
                )?
                .into_iter()
                .map(|row| {
                    serde_json::from_str::<crate::planning::Moment>(&row.get::<_, String>(0))
                })
                .collect::<std::result::Result<Vec<_>, _>>()?;
        }
        let availability = graph
            .tasks
            .values()
            .filter(|t| {
                t.entity_type == EntityType::Task && t.status == Status::Blocked && !t.archived
            })
            .filter_map(|t| t.planning.not_before.as_ref())
            .chain(other_holds.iter())
            .filter_map(|moment| moment.bound(false).ok())
            .filter(|at_bound| *at_bound > at)
            .min()
            .map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let rankings = graph.rankings(at);
        Ok(Self {
            high,
            evaluated_at,
            nodes,
            graph,
            series_timezones,
            rankings,
            blocking_counts,
            availability,
            bodies: RefCell::new(HashMap::new()),
        })
    }
    pub fn select<'a>(
        &'a self,
        input: &ListItems,
        kind: EntityType,
    ) -> Vec<(&'a Node, Option<u32>)> {
        self.select_search(input, kind, None)
    }
    pub fn select_search<'a>(
        &'a self,
        input: &ListItems,
        kind: EntityType,
        search: Option<&HashMap<String, usize>>,
    ) -> Vec<(&'a Node, Option<u32>)> {
        let mut matched: Vec<_> = self
            .nodes
            .iter()
            .filter(|n| {
                matches(&n.task, input, kind) && search.is_none_or(|s| s.contains_key(&n.task.id))
            })
            .collect();
        matched.sort_by(|a, b| {
            if input.effective_sort() == "relevance" {
                search
                    .map(|s| s.get(&a.task.id).cmp(&s.get(&b.task.id)))
                    .unwrap_or(Ordering::Equal)
            } else {
                Ordering::Equal
            }
            .then_with(|| self.compare(a, b, input, kind))
        });
        let grouped =
            input.group_recurrences && input.task_id.is_none() && input.task_ids.is_none();
        let group = |n: &Node| {
            n.task
                .occurrence
                .as_ref()
                .filter(|o| !o.skipped && n.task.status != Status::Done && !n.task.archived)
                .map(|o| o.series_id.clone())
        };
        let mut counts = HashMap::<String, u32>::new();
        if grouped {
            for n in &matched {
                if let Some(id) = group(n) {
                    *counts.entry(id).or_default() += 1;
                }
            }
        }
        let mut seen = HashSet::new();
        matched
            .into_iter()
            .filter_map(|n| {
                if grouped && let Some(id) = group(n) {
                    return seen.insert(id.clone()).then(|| (n, Some(counts[&id])));
                }
                Some((n, None))
            })
            .collect()
    }
    pub fn next_change(&self, input: &ListItems) -> Option<String> {
        self.nodes
            .iter()
            .filter(|n| matches(&n.task, input, EntityType::Task))
            .filter_map(|n| self.rankings.get(&n.task.id)?.next_change_at.clone())
            .chain(self.availability.clone())
            .min()
    }
    pub fn full(
        &self,
        tx: &mut AccountTransaction<'_>,
        ids: &[String],
    ) -> Result<HashMap<String, Task>> {
        let mut bodies = self.bodies.borrow_mut();
        let missing: Vec<_> = ids.iter().filter(|id| !bodies.contains_key(*id)).collect();
        if !missing.is_empty() {
            let current = self.high == tx.high();
            let sql = if current {
                "SELECT document FROM gtd.tasks WHERE account_id=$1 AND id=ANY($2)"
            } else {
                "SELECT DISTINCT ON(entity_id) document FROM gtd.revisions
                 WHERE account_id=$1 AND entity_id=ANY($2) AND seq<=$3 ORDER BY entity_id,seq DESC"
            };
            let mut args: Vec<(&(dyn ToSql + Sync), Type)> =
                vec![(&tx.account.id, Type::UUID), (&missing, Type::TEXT_ARRAY)];
            if !current {
                args.push((&self.high, Type::INT8));
            }
            for row in tx.tx.query_typed(sql, &args)? {
                let task: Task = serde_json::from_str(&row.get::<_, String>(0))?;
                bodies.insert(task.id.clone(), task);
            }
        }
        Ok(ids
            .iter()
            .filter_map(|id| bodies.get(id).map(|task| (id.clone(), task.clone())))
            .collect())
    }
    pub fn decorate(&self, task: &mut Task, count: Option<u32>, next: &Option<String>) {
        task.pending_occurrence_count = count;
        task.unresolved_blocker_ids = self.graph.unresolved(task);
        task.recommendation = self.rankings.get(&task.id).cloned().or_else(|| {
            // Deleted explicit records are excluded from the graph but remain inspectable.
            DateTime::parse_from_rfc3339(&self.evaluated_at)
                .ok()
                .map(|at| planning::evaluate(task, at.with_timezone(&Utc)))
        });
        if let Some(r) = task.recommendation.as_mut() {
            r.next_change_at = next.clone();
        }
    }
    fn compare(&self, a: &Node, b: &Node, input: &ListItems, kind: EntityType) -> Ordering {
        let (a_task, b_task) = (&a.task, &b.task);
        let review = if input.review_on.is_some() {
            a_task.review_date.cmp(&b_task.review_date)
        } else {
            Ordering::Equal
        };
        review
            .then_with(|| match input.effective_sort() {
                "action" => a_task
                    .archived
                    .cmp(&b_task.archived)
                    .then_with(|| status_order(a_task.status).cmp(&status_order(b_task.status)))
                    .then_with(|| {
                        if kind == EntityType::Task {
                            self.rankings
                                .get(&a_task.id)
                                .map(|r| &r.key)
                                .cmp(&self.rankings.get(&b_task.id).map(|r| &r.key))
                        } else {
                            planning::due_key(a_task).cmp(&planning::due_key(b_task))
                        }
                    }),
                "importance" => b_task
                    .planning
                    .importance
                    .map_or(3, planning::Importance::rank)
                    .cmp(
                        &a_task
                            .planning
                            .importance
                            .map_or(3, planning::Importance::rank),
                    ),
                "due" => planning::due_key(a_task).cmp(&planning::due_key(b_task)),
                "updated" => b_task.last_change_id.cmp(&a_task.last_change_id),
                _ => Ordering::Equal,
            })
            .then(a.created.cmp(&b.created))
            .then(a_task.id.cmp(&b_task.id))
    }
}
fn status_order(s: Status) -> u8 {
    match s {
        Status::Next | Status::Active => 0,
        Status::Inbox => 1,
        Status::Waiting => 2,
        Status::Blocked => 3,
        Status::Someday => 4,
        Status::Done => 5,
        _ => 6,
    }
}
fn date_range(value: Option<&str>, from: Option<&str>, through: Option<&str>) -> bool {
    from.is_none_or(|v| value.is_some_and(|d| d >= v))
        && through.is_none_or(|v| value.is_some_and(|d| d <= v))
}
fn matches(t: &Task, input: &ListItems, kind: EntityType) -> bool {
    let exact = input.task_id.is_some() || input.task_ids.is_some();
    let active = kind == EntityType::Task
        && input.review_on.is_none()
        && (input.view == Some(TaskView::Active)
            || (input.view.is_none()
                && input.status.is_none()
                && input.archived != Some(true)
                && !exact));
    let archive = if input.status == Some(Status::Archived) || input.review_on.is_some() {
        Some(input.review_on.is_none())
    } else {
        input.archived.or_else(|| {
            if input.view == Some(TaskView::All)
                || (input.view.is_none() && input.status.is_none() && exact)
            {
                None
            } else {
                Some(false)
            }
        })
    };
    t.entity_type == kind
        && input.task_id.as_ref().is_none_or(|id| id == &t.id)
        && input
            .task_ids
            .as_ref()
            .is_none_or(|ids| ids.contains(&t.id))
        && input
            .status
            .filter(|s| *s != Status::Archived)
            .is_none_or(|s| t.status == s.current())
        && archive.is_none_or(|v| t.archived == v)
        && (!active
            || (matches!(
                t.status,
                Status::Next | Status::Inbox | Status::Waiting | Status::Blocked
            ) && !t.occurrence.as_ref().is_some_and(|o| o.skipped)))
        && (input.include_deleted || !t.deleted)
        && (input.view == Some(TaskView::All)
            || exact
            || archive == Some(true)
            || !t.occurrence.as_ref().is_some_and(|o| o.skipped))
        && date_range(
            t.due_date.as_deref(),
            input.due_from.as_deref(),
            input.due_through.as_deref(),
        )
        && (!input.undated || t.due_date.is_none())
        && input
            .project_id
            .as_ref()
            .is_none_or(|id| t.project_id.as_ref() == Some(id))
        && date_range(
            t.review_date.as_deref(),
            input.review_from.as_deref(),
            input.review_through.as_deref(),
        )
        && input.review_on.as_ref().is_none_or(|on| {
            t.status != Status::Done && t.review_date.as_ref().is_some_and(|d| d <= on)
        })
        && ((input.planned_from.is_none() && input.planned_through.is_none())
            || t.planning.blocks().iter().any(|b| {
                input
                    .planned_from
                    .as_ref()
                    .is_none_or(|v| b.finish.as_ref().unwrap_or(&b.start).date >= *v)
                    && input
                        .planned_through
                        .as_ref()
                        .is_none_or(|v| b.start.date <= *v)
            }))
        && input
            .max_estimated_minutes
            .is_none_or(|m| t.planning.estimated_minutes.is_some_and(|v| v <= m))
        && input
            .max_effort
            .is_none_or(|m| t.planning.effort.is_some_and(|v| v.rank() <= m.rank()))
        && input
            .exclude_statuses
            .as_ref()
            .is_none_or(|statuses| !statuses.iter().any(|s| s.current() == t.status))
        && input
            .blocked_by_id
            .as_ref()
            .is_none_or(|id| t.blocked_by.contains(id))
}
