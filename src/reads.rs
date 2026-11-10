use super::*;
use crate::projection::{self, PAGE_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Cursor {
    pub(super) v: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) evaluated_at: Option<String>,
    pub(super) store: String,
    pub(super) phase: String,
    pub(super) high: i64,
    pub(super) anchor: String,
    pub(super) position: u64,
    pub(super) query: Value,
}
fn identity(c: &Connection) -> Result<String> {
    Ok(c.query_row(
        "SELECT value FROM store_meta WHERE key='identity'",
        [],
        |r| r.get(0),
    )?)
}
pub(super) fn high(c: &Connection) -> Result<i64> {
    Ok(c.query_row("SELECT COALESCE(MAX(id),0) FROM changes", [], |r| r.get(0))?)
}
fn anchor(c: &Connection, n: i64) -> Result<String> {
    if n == 0 {
        return identity(c);
    }
    c.query_row("SELECT token FROM changes WHERE id=?1", [n], |r| r.get(0))
        .optional()?
        .ok_or(StoreError::ResetRequired)
}
pub(super) fn encode(c: &Cursor) -> String {
    serde_json::to_vec(c)
        .unwrap()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(super) fn decode(c: &Connection, value: &str) -> Result<Cursor> {
    if value.len() > 20000
        || !value.len().is_multiple_of(2)
        || !value.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(StoreError::ResetRequired);
    }
    let bytes = (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| StoreError::ResetRequired))
        .collect::<Result<Vec<_>>>()?;
    let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| StoreError::ResetRequired)?;
    if cursor.v != 2
        || cursor.position > i64::MAX as u64
        || cursor.high < 0
        || cursor.store != identity(c)?
        || cursor.anchor != anchor(c, cursor.high)?
    {
        return Err(StoreError::ResetRequired);
    }
    Ok(cursor)
}
pub(super) fn make(
    c: &Connection,
    phase: &str,
    high: i64,
    position: u64,
    query: Value,
) -> Result<Cursor> {
    Ok(Cursor {
        v: 2,
        evaluated_at: Some(crate::clock::timestamp()),
        store: identity(c)?,
        phase: phase.into(),
        high,
        anchor: anchor(c, high)?,
        position,
        query,
    })
}
pub(crate) fn query_key<T: Serialize>(input: &T) -> Result<Value> {
    let mut value = serde_json::to_value(input)?;
    for key in ["cursor", "offset", "limit"] {
        value.as_object_mut().unwrap().remove(key);
    }
    Ok(json!(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value)?)
    )))
}
pub(super) fn pagination(
    c: &Connection,
    cursor: Option<&str>,
    phase: &str,
    query: &Value,
    offset: u32,
) -> Result<(i64, u64)> {
    if let Some(cursor) = cursor {
        let cursor = decode(c, cursor)?;
        if cursor.phase != phase || cursor.query != *query || offset != 0 {
            return Err(StoreError::Invalid(
                "cursor requires unchanged filters and offset=0".into(),
            ));
        }
        Ok((cursor.high, cursor.position))
    } else {
        Ok((high(c)?, offset as u64))
    }
}
pub(super) const SOURCE: &str = "WITH latest AS (SELECT entity_id,MAX(seq) seq FROM revisions WHERE seq<=?1 GROUP BY entity_id), records AS (SELECT r.*, (SELECT MIN(seq) FROM revisions WHERE entity_id=r.entity_id) created_seq FROM revisions r JOIN latest l ON r.seq=l.seq) ";

const CURRENT_SOURCE: &str = "WITH records AS (SELECT id entity_id,json_extract(document,'$.entity_type') entity_type,json_extract(document,'$.last_change_id') seq,document,(SELECT MIN(seq) FROM revisions WHERE entity_id=tasks.id) created_seq FROM tasks WHERE ?1>=0) ";
fn snapshot_source(c: &Connection, h: i64) -> Result<&'static str> {
    Ok(if h == high(c)? {
        CURRENT_SOURCE
    } else {
        SOURCE
    })
}

pub(crate) fn validate_query(input: &ListItems) -> Result<()> {
    if let Some(id) = &input.blocked_by_id {
        dependencies::validate_ids(std::slice::from_ref(id))?;
    }
    if let Some(statuses) = &input.exclude_statuses
        && (statuses.len() > 6
            || statuses
                .iter()
                .any(|s| matches!(s, Status::Active | Status::Archived))
            || statuses
                .iter()
                .enumerate()
                .any(|(i, s)| statuses[..i].contains(s)))
    {
        return Err(StoreError::Invalid(
            "exclude_statuses accepts up to six distinct task statuses; use archived for archive membership".into(),
        ));
    }
    if input.view.is_some() && input.status.is_some() {
        return Err(StoreError::Invalid(
            "Choose view OR status, not both".into(),
        ));
    }
    if input.task_id.is_some() && input.task_ids.is_some() {
        return Err(StoreError::Invalid("Choose task_id OR task_ids".into()));
    }
    if let Some(ids) = &input.task_ids
        && (ids.is_empty()
            || ids.len() > 50
            || ids.iter().any(|id| Uuid::parse_str(id).is_err())
            || ids.iter().collect::<HashSet<_>>().len() != ids.len())
    {
        return Err(StoreError::Invalid(
            "task_ids requires 1–50 distinct UUIDs".into(),
        ));
    }
    for date in [
        &input.planned_from,
        &input.planned_through,
        &input.due_from,
        &input.due_through,
        &input.review_from,
        &input.review_through,
        &input.review_on,
    ] {
        validate_date(date.as_deref())?;
    }
    if input.undated && (input.due_from.is_some() || input.due_through.is_some()) {
        return Err(StoreError::Invalid(
            "undated cannot be combined with date bounds".into(),
        ));
    }
    for (from, to) in [
        (&input.planned_from, &input.planned_through),
        (&input.due_from, &input.due_through),
        (&input.review_from, &input.review_through),
    ] {
        if let (Some(a), Some(b)) = (from, to)
            && a > b
        {
            return Err(StoreError::Invalid(
                "from date must not follow through date".into(),
            ));
        }
    }
    if input
        .query
        .as_ref()
        .is_some_and(|s| s.chars().count() > 500)
    {
        return Err(StoreError::Invalid("query exceeds 500 characters".into()));
    }
    if input.history_after < 0 {
        return Err(StoreError::Invalid(
            "history_after must be nonnegative".into(),
        ));
    }
    if input.status == Some(Status::Archived) && input.archived == Some(false) {
        return Err(StoreError::Invalid(
            "status=archived conflicts with archived=false".into(),
        ));
    }
    Ok(())
}
pub(super) struct TaskSnapshot {
    graph: dependencies::Graph,
    series_timezones: std::collections::HashMap<String, String>,
    blocking_counts: std::collections::HashMap<String, usize>,
    rankings: std::sync::Arc<std::collections::HashMap<String, crate::planning::Recommendation>>,
    availability: Option<String>,
}

impl Store {
    pub(crate) fn priority_grid(&mut self, q: crate::priority_grid::Query) -> Result<Value> {
        use crate::priority_grid::{self, Grid};
        q.validate()?;
        let tx = self.connection.transaction()?;
        let query = json!({"project":q.project});
        let base = if let Some(value) = q.snapshot.as_deref() {
            let base = decode(&tx, value)?;
            if base.phase != priority_grid::SUMMARY_CURSOR
                || base.position != 0
                || base.query != query
            {
                return Err(StoreError::ResetRequired);
            }
            base
        } else {
            make(&tx, priority_grid::SUMMARY_CURSOR, high(&tx)?, 0, query)?
        };
        let at = base
            .evaluated_at
            .as_deref()
            .ok_or(StoreError::ResetRequired)?;
        let snapshot = TaskSnapshot::new(&tx, base.high, at)?;
        let grid = Grid::new(
            &snapshot.graph,
            &snapshot.rankings,
            snapshot.availability.as_deref(),
            at,
            q.project.as_deref(),
            |id| snapshot.series_timezones.get(id).map(String::as_str),
        )?;
        let result = if let Some(cell) = q.cell {
            let key = json!({"project":q.project,"cell":cell,"sort":q.sort});
            let mut cursor = if let Some(value) = q.cursor.as_deref() {
                let cursor = decode(&tx, value)?;
                if cursor.phase != priority_grid::CELL_CURSOR
                    || cursor.query != key
                    || cursor.high != base.high
                    || cursor.evaluated_at != base.evaluated_at
                {
                    return Err(StoreError::ResetRequired);
                }
                cursor
            } else {
                Cursor {
                    phase: priority_grid::CELL_CURSOR.into(),
                    query: key,
                    position: q.offset.unwrap_or_default().into(),
                    ..base.clone()
                }
            };
            let max = page_size(Some(q.limit.unwrap_or(priority_grid::PAGE_SIZE as u32)))?;
            let ids = snapshot
                .graph
                .tasks
                .values()
                .filter(|t| grid.includes(t, cell))
                .map(|t| t.id.clone())
                .collect();
            let input = ListItems {
                task_ids: Some(ids),
                sort: Some(q.sort.unwrap_or(TaskSort::Action)),
                ..Default::default()
            };
            let tasks = select(
                &tx,
                &input,
                EntityType::Task,
                base.high,
                cursor.position,
                max + 1,
                at,
                Some(&snapshot),
            )?;
            let (items, more) = priority_grid::page(
                tasks
                    .iter()
                    .map(|task| grid.row(task, &snapshot.graph, &snapshot.rankings)),
                max as usize,
            )?;
            cursor.position += items.len() as u64;
            json!({"kind":priority_grid::CELL,"items":items,"next_cursor":more.then(|| encode(&cursor))})
        } else {
            grid.summary(&snapshot.graph, encode(&base), at)
        };
        tx.commit()?;
        Ok(result)
    }
}

struct RankingFunctions<'a>(&'a Connection);
impl Drop for RankingFunctions<'_> {
    fn drop(&mut self) {
        // Do not retain a whole snapshot through closures on an idle pooled
        // connection. Statements using these functions have already been dropped.
        let _ = self.0.remove_function("gtd_dependency_key", 1);
        let _ = self.0.remove_function("gtd_dependency_next", 1);
        let _ = self.0.remove_function("gtd_effective_due", 1);
    }
}

impl TaskSnapshot {
    pub(super) fn new(c: &Connection, h: i64, evaluated_at: &str) -> Result<Self> {
        let timestamp = chrono::DateTime::parse_from_rfc3339(evaluated_at)
            .map_err(|_| StoreError::ResetRequired)?
            .with_timezone(&Utc);
        let source = snapshot_source(c, h)?;
        let mut series_timezones = std::collections::HashMap::new();
        let docs = c
            .prepare(&format!("{source} SELECT document FROM records"))?
            .query_map([h], |r| r.get::<_, String>(0))?
            .map(|r| {
                let mut task: Task = serde_json::from_str(&r?)?;
                // Read-only graph nodes never expose record bodies. Release large
                // payloads as each row is decoded, rather than retaining all prose
                // through sorting and parallel requests. Writes use complete nodes.
                task.notes = String::new();
                task.brief = String::new();
                task.agent_notes = String::new();
                task.links = Vec::new();
                task.work_sessions = Vec::new();
                if let Some(series) = task.recurrence.take() {
                    series_timezones.insert(task.id.clone(), series.timezone);
                }
                task.completion_result = None;
                task.location = None;
                task.timing_adjustments = Vec::new();
                Ok(task)
            })
            .collect::<Result<Vec<Task>>>()?;
        let graph = dependencies::Graph::new(docs)?;
        // The graph already contains the complete immutable read snapshot. Do
        // not rescan/decode revision history for every page or Home section.
        let availability = graph
            .tasks
            .values()
            .filter(|t| {
                t.entity_type == EntityType::Task && t.status == Status::Blocked && !t.archived
            })
            .filter_map(|t| t.planning.not_before.as_ref()?.bound(false).ok())
            .filter(|at| *at > timestamp)
            .min()
            .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let rankings =
            std::sync::Arc::new(graph.rankings_with_timezones(timestamp, &series_timezones));
        let blocking_counts = graph.blocking_counts();
        Ok(Self {
            graph,
            series_timezones,
            blocking_counts,
            rankings,
            availability,
        })
    }
}
// Keep the shared snapshot and explicit query context together at this boundary.
#[allow(clippy::too_many_arguments)]
fn select(
    c: &Connection,
    input: &ListItems,
    kind: EntityType,
    h: i64,
    offset: u64,
    limit: u32,
    evaluated_at: &str,
    snapshot: Option<&TaskSnapshot>,
) -> Result<Vec<Task>> {
    let active = kind == EntityType::Task
        && input.review_on.is_none()
        && (input.view == Some(TaskView::Active)
            || (input.view.is_none()
                && input.status.is_none()
                && input.archived != Some(true)
                && input.task_id.is_none()
                && input.task_ids.is_none()));
    let archive = if input.status == Some(Status::Archived) || input.review_on.is_some() {
        Some(input.review_on.is_none())
    } else {
        input.archived.or_else(|| {
            if input.view == Some(TaskView::All)
                || (input.view.is_none()
                    && input.status.is_none()
                    && (input.task_id.is_some() || input.task_ids.is_some()))
            {
                None
            } else {
                Some(false)
            }
        })
    };
    let status = input.status.filter(|s| *s != Status::Archived).map(|s| {
        serde_json::to_value(s.current())
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    });
    let ids = input
        .task_ids
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let ranked = input
        .query
        .as_deref()
        .filter(|q| !q.trim().is_empty())
        .map(|q| super::search::matches(c, q, h))
        .transpose()?;
    // Choose the same first result with or without grouping, including explicit
    // deadline/status exceptions. Reuse the order to keep representatives consistent.
    let order = "CASE WHEN ?17='relevance' THEN search_position END,
      CASE WHEN ?17='review' THEN json_extract(document,'$.review_date') END,
      CASE WHEN ?17='action' THEN COALESCE(json_extract(document,'$.archived'),0) END,
      CASE WHEN ?17='action' THEN CASE json_extract(document,'$.status') WHEN 'next' THEN 0 WHEN 'active' THEN 0 WHEN 'inbox' THEN 1 WHEN 'waiting' THEN 2 WHEN 'blocked' THEN 3 WHEN 'someday' THEN 4 WHEN 'done' THEN 5 ELSE 6 END END,
      CASE WHEN ?17='action' AND ?2='task' THEN dependency_key END,
      CASE WHEN ?17='importance' THEN gtd_importance(document) END DESC,
      CASE WHEN ?17='due' OR (?17='action' AND ?2!='task') THEN gtd_due(document) END,
      CASE WHEN ?17='effective_due' THEN gtd_effective_due(entity_id) END,
      CASE WHEN ?17='title' THEN gtd_title(document) END,
      CASE WHEN ?17='created_desc' THEN created_seq END DESC,
      CASE WHEN ?17='updated' THEN seq END DESC, created_seq, entity_id";
    let pending = "json_extract(document,'$.occurrence') IS NOT NULL AND json_extract(document,'$.status')!='done' AND COALESCE(json_extract(document,'$.archived'),0)=0 AND COALESCE(json_extract(document,'$.occurrence.skipped'),0)=0";
    let timestamp = chrono::DateTime::parse_from_rfc3339(evaluated_at)
        .map_err(|_| StoreError::ResetRequired)?
        .with_timezone(&Utc);
    // Project-only reads have no dependency ranking. Composed reads can reuse
    // one graph and evaluation for all sections of the same snapshot.
    let owned;
    let snapshot = if kind != EntityType::Task {
        None
    } else if snapshot.is_some() {
        snapshot
    } else {
        owned = TaskSnapshot::new(c, h, evaluated_at)?;
        Some(&owned)
    };
    let graph = snapshot.map(|s| &s.graph);
    let rankings = snapshot.map(|s| s.rankings.clone()).unwrap_or_default();
    // SQLite cannot index a JSON virtual-table join. A hash lookup avoids a
    // scan of every ranking for every candidate record (quadratic list reads).
    let keys = rankings.clone();
    let _functions = RankingFunctions(c);
    c.create_scalar_function(
        "gtd_dependency_key",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        move |ctx| {
            let id: String = ctx.get(0)?;
            Ok(keys.get(&id).map(|r| r.key.clone()))
        },
    )?;
    let effective = snapshot
        .map(|s| {
            s.graph
                .facts
                .iter()
                .map(|(id, f)| (id.clone(), f.due_key()))
                .collect::<std::collections::HashMap<_, _>>()
        })
        .unwrap_or_default();
    c.create_scalar_function(
        "gtd_effective_due",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        move |ctx| {
            let id: String = ctx.get(0)?;
            Ok(effective.get(&id).copied().unwrap_or(i64::MAX))
        },
    )?;
    let boundaries = rankings.clone();
    c.create_scalar_function(
        "gtd_dependency_next",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        move |ctx| {
            let id: String = ctx.get(0)?;
            Ok(boundaries.get(&id).and_then(|r| r.next_change_at.clone()))
        },
    )?;
    let grouped = input.group_recurrences && input.task_id.is_none() && input.task_ids.is_none();
    let grouping = if grouped {
        format!(
            "ranked AS (SELECT *, CASE WHEN {pending} THEN json_extract(document,'$.occurrence.series_id') ELSE entity_id END group_key, ({pending}) pending_group FROM matched), grouped AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY group_key ORDER BY {order}) group_row,COUNT(*) OVER(PARTITION BY group_key) group_count FROM ranked)"
        )
    } else {
        "grouped AS (SELECT *,0 pending_group,1 group_row,1 group_count FROM matched)".into()
    };
    let source = snapshot_source(c, h)?;
    let sql = format!("{source}, search_rank AS MATERIALIZED (SELECT value ranked_id,CAST(key AS INTEGER) search_position FROM json_each(?9)), matched AS MATERIALIZED (SELECT records.*,search_rank.search_position,gtd_dependency_key(entity_id) dependency_key,gtd_dependency_next(entity_id) dependency_next FROM records LEFT JOIN search_rank ON search_rank.ranked_id=records.entity_id WHERE entity_type=?2
      AND (?3 IS NULL OR entity_id=?3) AND (?4 IS NULL OR entity_id IN (SELECT value FROM json_each(?4)))
      AND (?5 IS NULL OR json_extract(document,'$.status')=?5)
      AND (?6 IS NULL OR COALESCE(json_extract(document,'$.archived'),0)=?6)
      AND (NOT ?7 OR (json_extract(document,'$.status') IN ('next','inbox','waiting','blocked') AND COALESCE(json_extract(document,'$.occurrence.skipped'),0)=0))
      AND (?8 OR json_extract(document,'$.deleted')=0)
      AND (?21 OR COALESCE(json_extract(document,'$.occurrence.skipped'),0)=0)
      AND (?9 IS NULL OR search_rank.ranked_id IS NOT NULL)
      AND (?10 IS NULL OR json_extract(document,'$.due_date')>=?10) AND (?11 IS NULL OR json_extract(document,'$.due_date')<=?11)
      AND (NOT ?12 OR json_extract(document,'$.due_date') IS NULL)
      AND (?13 IS NULL OR json_extract(document,'$.project_id')=?13)
      AND (?14 IS NULL OR json_extract(document,'$.review_date')>=?14) AND (?15 IS NULL OR json_extract(document,'$.review_date')<=?15)
      AND (?16 IS NULL OR (json_extract(document,'$.review_date')<=?16 AND json_extract(document,'$.status')!='done'))
      AND ((?23 IS NULL AND ?24 IS NULL) OR gtd_planned_match(document,?23,?24))
      AND (?28 IS NULL OR json_extract(document,'$.estimated_minutes')<=?28)
      AND (?29 IS NULL OR gtd_effort(document)<=?29)
      AND (?25 IS NULL OR json_extract(document,'$.status') NOT IN (SELECT value FROM json_each(?25)))
      AND (?27 IS NULL OR ?27 IN (SELECT value FROM json_each(json_extract(document,'$.blocked_by'))))
      ), {grouping}
      SELECT document,CASE WHEN pending_group THEN group_count END,(SELECT MIN(dependency_next) FROM matched) FROM grouped WHERE NOT ?20 OR group_row=1
      ORDER BY {order} LIMIT ?18 OFFSET ?19");
    let mut stmt = c.prepare(&sql)?;
    stmt.query_map(
        params![
            h,
            entity_name(kind),
            input.task_id,
            ids,
            status,
            archive,
            active,
            input.include_deleted,
            ranked,
            input.due_from,
            input.due_through,
            input.undated,
            input.project_id,
            input.review_from,
            input.review_through,
            input.review_on,
            input.effective_sort(),
            limit,
            offset as i64,
            input.group_recurrences && input.task_id.is_none() && input.task_ids.is_none(),
            input.view == Some(TaskView::All)
                || input.task_id.is_some()
                || input.task_ids.is_some()
                || archive == Some(true),
            evaluated_at,
            input.planned_from,
            input.planned_through,
            input
                .exclude_statuses
                .as_ref()
                .map(|items| serde_json::to_string(
                    &items.iter().map(|s| s.current()).collect::<Vec<_>>()
                ))
                .transpose()?,
            Option::<String>::None, // slot retained for the stable numbered SQL parameters
            input.blocked_by_id,
            input.max_estimated_minutes,
            input.max_effort.map(|v| v.rank())
        ],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<u32>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    )?
    .map(|r| {
        let (doc, count, next_change) = r?;
        let mut task: Task = serde_json::from_str(&doc)?;
        task.pending_occurrence_count =
            if input.group_recurrences && input.task_id.is_none() && input.task_ids.is_none() {
                count
            } else {
                None
            };
        if kind == EntityType::Task {
            task.unresolved_blocker_ids = graph.as_ref().expect("task graph").unresolved(&task);
            task.recommendation = Some(
                rankings
                    .get(&task.id)
                    .cloned()
                    .unwrap_or_else(|| crate::planning::evaluate(&task, timestamp)),
            );
        }
        if let Some(r) = task.recommendation.as_mut() {
            r.revision = Some(h);
            r.next_change_at = next_change;
        }
        Ok(task)
    })
    .collect()
}
fn trim_records(
    items: &mut Vec<Task>,
    limit: u32,
    detail: Detail,
    explicit: bool,
    include_agent_notes: bool,
    budget: usize,
) -> bool {
    let mut bytes = 2048;
    let mut count = 0;
    for item in items.iter().take(limit as usize) {
        let size = serde_json::to_vec(&projection::page_record_with_agent_notes(
            item,
            detail,
            explicit,
            include_agent_notes,
        ))
        .unwrap()
        .len()
            + 1;
        if count > 0 && bytes + size > budget {
            break;
        }
        bytes += size;
        count += 1;
    }
    let more = count < items.len();
    items.truncate(count);
    more
}
pub(super) fn read_tasks(
    c: &mut Connection,
    input: ListItems,
    search_high: Option<i64>,
) -> Result<ListResult> {
    let tx = c.transaction()?;
    let result = read_tasks_in(&tx, input, search_high, None)?;
    tx.commit()?;
    Ok(result)
}

pub(super) fn read_tasks_in(
    tx: &Connection,
    input: ListItems,
    search_high: Option<i64>,
    snapshot: Option<&TaskSnapshot>,
) -> Result<ListResult> {
    validate_query(&input)?;
    let limit = page_size(Some(input.limit.unwrap_or(20)))?;
    let key = query_key(&input)?;
    let (h, offset) = pagination(tx, input.cursor.as_deref(), "tasks", &key, input.offset)?;
    let h = search_high.unwrap_or(h);
    let evaluated_at = if let Some(cursor) = &input.cursor {
        decode(tx, cursor)?
            .evaluated_at
            .ok_or(StoreError::ResetRequired)?
    } else {
        crate::clock::timestamp()
    };
    let owned;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned = TaskSnapshot::new(tx, h, &evaluated_at)?;
            &owned
        }
    };
    let mut items = select(
        tx,
        &input,
        EntityType::Task,
        h,
        offset,
        limit + 1,
        &evaluated_at,
        Some(snapshot),
    )?;
    let next_change_at = items
        .iter()
        .filter_map(|t| t.recommendation.as_ref()?.next_change_at.clone())
        .chain(snapshot.availability.clone())
        .min();
    let more = trim_records(
        &mut items,
        limit,
        input.effective_detail(),
        input.task_id.is_some(),
        input.include_agent_notes,
        if input.include_history {
            PAGE_BYTES / 2
        } else {
            PAGE_BYTES
        },
    );
    let position = offset + items.len() as u64;
    let next_cursor = more
        .then(|| {
            make(tx, "tasks", h, position, key).map(|mut c| {
                c.evaluated_at = Some(evaluated_at.clone());
                encode(&c)
            })
        })
        .transpose()?;
    let next_offset = if more {
        Some(u32::try_from(position).map_err(|_| StoreError::Invalid("offset overflow".into()))?)
    } else {
        None
    };
    let mut history = Vec::new();
    let mut next_history_after = None;
    if input.include_history && !items.is_empty() {
        let history_limit = page_size(input.history_limit)?;
        let ids = serde_json::to_string(&items.iter().map(|t| &t.id).collect::<Vec<_>>())?;
        let mut stmt=tx.prepare("SELECT document FROM changes WHERE id>?1 AND id<=?2 AND task_id IN (SELECT value FROM json_each(?3)) ORDER BY id LIMIT ?4")?;
        let all = stmt
            .query_map(
                params![input.history_after, h, ids, history_limit + 1],
                |r| r.get::<_, String>(0),
            )?
            .map(|r| Ok(serde_json::from_str::<Change>(&r?)?))
            .collect::<Result<Vec<_>>>()?;
        let mut bytes = 1024;
        for change in &all {
            let size = serde_json::to_vec(&projection::change(change, Detail::Summary))
                .unwrap()
                .len();
            if history.len() >= history_limit as usize
                || (!history.is_empty() && bytes + size > PAGE_BYTES / 2)
            {
                break;
            }
            bytes += size;
            history.push(change.clone());
        }
        if history.len() < all.len() {
            next_history_after = Some(history.last().map_or(input.history_after, |c| c.id));
        }
    }
    Ok(ListResult {
        effective_sort: input.effective_sort().into(),
        blocking_counts: if input.agent_context {
            Default::default()
        } else {
            items
                .iter()
                .map(|task| {
                    (
                        task.id.clone(),
                        snapshot.blocking_counts.get(&task.id).copied().unwrap_or(0),
                    )
                })
                .collect()
        },
        evaluated_at,
        next_change_at,
        items,
        next_cursor,
        next_offset,
        history,
        next_history_after,
    })
}
pub(super) fn read_changes(c: &Connection, input: ListChanges) -> Result<ChangesResult> {
    super::activity_reads::history(c, input)
}
impl Store {
    pub fn projects(&mut self, input: ListProjects) -> Result<Value> {
        if input.cursor.is_none() {
            self.settle_availability()?;
        }
        if input.view.is_some() && input.status.is_some() {
            return Err(StoreError::Invalid(
                "Choose view OR status, not both".into(),
            ));
        }
        let detail = input.detail.unwrap_or(if input.project_id.is_some() {
            Detail::Full
        } else {
            Detail::Summary
        });
        let exact = input.project_id.is_some();
        let key = query_key(&input)?;
        let filter = ListItems {
            sort: Some(input.sort.unwrap_or(if input.query.is_some() {
                TaskSort::Relevance
            } else if input.review_on.is_some() {
                TaskSort::Review
            } else {
                TaskSort::Due
            })),
            task_id: input.project_id,
            status: input.status.map(Into::into).or(
                if input.view == Some(TaskView::Active)
                    || (!exact
                        && input.view != Some(TaskView::All)
                        && input.archived != Some(true)
                        && input.review_on.is_none())
                {
                    Some(Status::Active)
                } else {
                    None
                },
            ),
            view: if input.view == Some(TaskView::All) {
                input.view
            } else {
                None
            },
            archived: input.archived,
            include_deleted: input.include_deleted,
            query: input.query,
            review_from: input.review_from,
            review_through: input.review_through,
            review_on: input.review_on,
            detail: Some(detail),
            ..Default::default()
        };
        validate_query(&filter)?;
        let limit = page_size(Some(input.limit.unwrap_or(20)))?;
        let search_high = if input.cursor.is_none() {
            filter
                .query
                .as_deref()
                .filter(|q| !q.trim().is_empty())
                .map(|q| self.prepare_search(q))
                .transpose()?
        } else {
            None
        };
        let tx = self.connection.transaction()?;
        let (h, offset) = pagination(&tx, input.cursor.as_deref(), "projects", &key, 0)?;
        let h = search_high.unwrap_or(h);
        let mut items = select(
            &tx,
            &filter,
            EntityType::Project,
            h,
            offset,
            limit + 1,
            &crate::clock::timestamp(),
            None,
        )?;
        let mut more = trim_records(
            &mut items,
            limit,
            detail,
            exact,
            input.include_agent_notes,
            PAGE_BYTES - 2048,
        );
        let mut projects = Vec::new();
        let mut bytes = 2048;
        let project_ids = serde_json::to_string(&items.iter().map(|t| &t.id).collect::<Vec<_>>())?;
        let source = snapshot_source(&tx, h)?;
        let count_sql = format!(
            "{source} SELECT json_extract(document,'$.project_id') project_id, CASE WHEN COALESCE(json_extract(document,'$.archived'),0)=1 THEN 'archived' ELSE json_extract(document,'$.status') END bucket,COUNT(*) FROM records WHERE entity_type='task' AND json_extract(document,'$.project_id') IN (SELECT value FROM json_each(?2)) AND json_extract(document,'$.deleted')=0 GROUP BY project_id,bucket"
        );
        let count_rows = tx
            .prepare(&count_sql)?
            .query_map(params![h, project_ids], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut counts_by_project =
            std::collections::BTreeMap::<String, std::collections::BTreeMap<String, i64>>::new();
        for (id, bucket, count) in count_rows {
            counts_by_project
                .entry(id)
                .or_default()
                .insert(bucket, count);
        }
        for task in items {
            let mut item = projection::page_record_with_agent_notes(
                &task,
                detail,
                exact,
                input.include_agent_notes,
            );
            let counts = counts_by_project.remove(&task.id).unwrap_or_default();
            item["needs_next_action"] = json!(
                task.status == Status::Active
                    && !task.archived
                    && counts.get("next").copied().unwrap_or(0) == 0
                    && counts.get("waiting").copied().unwrap_or(0) == 0
            );
            item["task_counts"] = json!(counts);
            let size = serde_json::to_vec(&item)?.len() + 1;
            if !projects.is_empty() && bytes + size > PAGE_BYTES {
                more = true;
                break;
            }
            bytes += size;
            projects.push(item);
        }
        let next = if more {
            Some(encode(&make(
                &tx,
                "projects",
                h,
                offset + projects.len() as u64,
                key,
            )?))
        } else {
            None
        };
        Ok(
            json!({"projects":projects,"next_cursor":next,"detail":detail,"complete":!more,"response_version":2}),
        )
    }
    pub fn sync_state(&mut self, input: SyncState) -> Result<Value> {
        if input.cursor.is_none() {
            self.settle_availability()?;
        }
        let limit = page_size(Some(input.limit.unwrap_or(20)))?;
        let tx = self.connection.transaction()?;
        let audience = json!({"agent_context":input.agent_context});
        let mut cursor = match input.cursor.as_deref() {
            Some(value) => decode(&tx, value)?,
            None => make(&tx, "snapshot", high(&tx)?, 0, audience.clone())?,
        };
        if cursor.query != audience {
            return Err(StoreError::ResetRequired);
        }
        if cursor.phase == "checkpoint" {
            if cursor.position != cursor.high as u64 {
                return Err(StoreError::ResetRequired);
            }
            cursor = make(
                &tx,
                "changes",
                high(&tx)?,
                cursor.position,
                audience.clone(),
            )?;
        }
        let mut records = Vec::new();
        let mut changes = Vec::new();
        let mut bytes = 2048;
        let mut more = false;
        match cursor.phase.as_str() {
            "snapshot" => {
                let sql = format!(
                    "{SOURCE} SELECT document FROM records WHERE json_extract(document,'$.deleted')=0 ORDER BY entity_type,entity_id LIMIT ?2 OFFSET ?3"
                );
                let mut stmt = tx.prepare(&sql)?;
                let rows = stmt
                    .query_map(
                        params![cursor.high, limit + 1, cursor.position as i64],
                        |r| r.get::<_, String>(0),
                    )?
                    .map(|r| Ok(serde_json::from_str::<Task>(&r?)?))
                    .collect::<Result<Vec<_>>>()?;
                for task in rows {
                    let value = if input.agent_context {
                        projection::agent_record_at(&task, cursor.evaluated_at.as_deref().unwrap())
                    } else {
                        projection::record(&task, Detail::Summary)
                    };
                    let size = serde_json::to_vec(&value)?.len();
                    if records.len() >= limit as usize
                        || (!records.is_empty() && bytes + size > PAGE_BYTES)
                    {
                        more = true;
                        break;
                    }
                    bytes += size;
                    records.push(value);
                    cursor.position += 1;
                }
            }
            "changes" => {
                if cursor.position > cursor.high as u64 {
                    return Err(StoreError::ResetRequired);
                }
                let mut stmt=tx.prepare("SELECT document,batch_id,NOT EXISTS(SELECT 1 FROM changes n WHERE n.id>c.id AND n.id<=?2 AND n.batch_id=c.batch_id) FROM changes c WHERE id>?1 AND id<=?2 ORDER BY id LIMIT ?3")?;
                let rows = stmt
                    .query_map(
                        params![cursor.position as i64, cursor.high, limit + 1],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, bool>(2)?,
                            ))
                        },
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                for (doc, batch, end) in rows {
                    let change: Change = serde_json::from_str(&doc)?;
                    let mut value = projection::change(&change, Detail::Summary);
                    if input.agent_context {
                        value["after"] = projection::agent_record_at(
                            &change.after,
                            cursor.evaluated_at.as_deref().unwrap(),
                        );
                    }
                    value["transaction_id"] = batch.into();
                    value["transaction_end"] = end.into();
                    let size = serde_json::to_vec(&value)?.len();
                    if changes.len() >= limit as usize
                        || (!changes.is_empty() && bytes + size > PAGE_BYTES)
                    {
                        more = true;
                        break;
                    }
                    bytes += size;
                    cursor.position = change.id as u64;
                    changes.push(value);
                }
            }
            _ => return Err(StoreError::Invalid("cursor is not a sync cursor".into())),
        }
        let next = more.then(|| encode(&cursor));
        let checkpoint = if more {
            None
        } else {
            Some(encode(&make(
                &tx,
                "checkpoint",
                cursor.high,
                cursor.high as u64,
                audience.clone(),
            )?))
        };
        Ok(
            json!({"phase":cursor.phase,"records":records,"changes":changes,"next_cursor":next,"checkpoint":checkpoint,"complete":!more,"response_version":2}),
        )
    }
}

#[cfg(test)]
#[path = "reads_reference.rs"]
mod reference;

#[cfg(test)]
mod read_equivalence {
    use super::*;
    use serde_json::json;
    #[test]
    fn optimized_selection_matches_frozen_reference_across_filters_and_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("db")).unwrap();
        let mut ids = vec![];
        let project=store.create_project(serde_json::from_value(json!({"request_id":"project","brief":"Perform the disposable selection fixture.","title":"Fixture project","reason":"Differential fixture"})).unwrap()).unwrap().task;
        for i in 0..24 {
            let mut args = json!({"request_id":format!("task-{i}"),"brief":"Perform the disposable selection fixture.","title":format!("Fixture {i}"),"importance":(["normal","high","critical"][i%3]),"estimated_minutes":30,"effort":"medium","status":(["next","waiting","blocked","someday","done","inbox"][i%6]),"reason":"Differential fixture"});
            if i % 3 == 0 {
                args["project_id"] = json!(project.id);
            }
            if i % 4 == 0 {
                args["due_date"] = json!("2026-10-10");
            }
            if i % 5 == 0 {
                args["review_date"] = json!("2026-10-08");
            }
            if i > 0 && i % 7 == 0 {
                args["blocked_by"] = json!([ids[0]]);
            }
            ids.push(
                store
                    .capture(serde_json::from_value(args).unwrap())
                    .unwrap()
                    .task
                    .id,
            );
        }
        store.update(serde_json::from_value(json!({"request_id":"edit","task_id":ids[0],"expected_version":1,"status":"done","reason":"Fixture edit"})).unwrap()).unwrap();
        let tx = store.connection.transaction().unwrap();
        let newest = high(&tx).unwrap();
        for revision in [newest, newest - 1, 12] {
            for value in [
                json!({}),
                json!({"view":"all"}),
                json!({"status":"next"}),
                json!({"task_id":ids[0]}),
                json!({"task_ids":[ids[0],ids[1]]}),
                json!({"project_id":project.id}),
                json!({"review_on":"2026-10-09"}),
                json!({"view":"all","sort":"importance"}),
                json!({"view":"all","sort":"created"}),
                json!({"view":"all","sort":"updated"}),
                json!({"view":"all","sort":"due"}),
                json!({"view":"all","sort":"effective_due"}),
                json!({"view":"all","sort":"created_desc"}),
                json!({"view":"all","sort":"title"}),
                json!({"review_on":"2026-10-09","sort":"created_desc"}),
                json!({"view":"all","exclude_statuses":["done","someday"]}),
            ] {
                let input: ListItems = serde_json::from_value(value.clone()).unwrap();
                for offset in [0, 3] {
                    let expected = reference::select_reference(
                        &tx,
                        &input,
                        EntityType::Task,
                        revision,
                        offset,
                        5,
                        "2026-10-09T12:00:00Z",
                    )
                    .unwrap();
                    let actual = select(
                        &tx,
                        &input,
                        EntityType::Task,
                        revision,
                        offset,
                        5,
                        "2026-10-09T12:00:00Z",
                        None,
                    )
                    .unwrap();
                    assert_eq!(
                        serde_json::to_value(actual).unwrap(),
                        serde_json::to_value(expected).unwrap(),
                        "{value} at {revision}, offset {offset}"
                    );
                }
            }
        }
    }
}
