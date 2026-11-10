//! Frozen pre-optimization selector, compiled only into deterministic tests.
//! Intentionally independent of the optimized SQL; remove after comparison acceptance.
use super::*;

pub(super) fn select_reference(
    c: &Connection,
    input: &ListItems,
    kind: EntityType,
    h: i64,
    offset: u64,
    limit: u32,
    evaluated_at: &str,
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
      CASE WHEN ?17='effective_due' THEN dependency_due END,
      CASE WHEN ?17='title' THEN gtd_title(document) END,
      CASE WHEN ?17='created_desc' THEN created_seq END DESC,
      CASE WHEN ?17='updated' THEN seq END DESC, created_seq, entity_id";
    let pending = "json_extract(document,'$.occurrence') IS NOT NULL AND json_extract(document,'$.status')!='done' AND COALESCE(json_extract(document,'$.archived'),0)=0 AND COALESCE(json_extract(document,'$.occurrence.skipped'),0)=0";
    let timestamp = chrono::DateTime::parse_from_rfc3339(evaluated_at)
        .map_err(|_| StoreError::ResetRequired)?
        .with_timezone(&Utc);
    let graph_docs = c
        .prepare(&format!("{SOURCE} SELECT document FROM records"))?
        .query_map([h], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str(&r?)?))
        .collect::<Result<Vec<Task>>>()?;
    let graph = dependencies::Graph::new(graph_docs)?;
    let rankings = graph.rankings(timestamp);
    let rank_json = serde_json::to_string(
        &rankings
            .iter()
            .map(|(id, r)| (id, json!({"key": r.key, "next": r.next_change_at, "due": graph.facts.get(id).map(|f| f.due_key())})))
            .collect::<std::collections::BTreeMap<_, _>>(),
    )?;
    let sql = format!("{SOURCE}, dependency_rank AS (SELECT key dependency_id,json_extract(value,'$.key') dependency_key,json_extract(value,'$.next') dependency_next,json_extract(value,'$.due') dependency_due FROM json_each(?26)), search_rank AS MATERIALIZED (SELECT value ranked_id,CAST(key AS INTEGER) search_position FROM json_each(?9)), matched AS (SELECT records.*,search_rank.search_position,dependency_key,dependency_next,dependency_due FROM records LEFT JOIN search_rank ON search_rank.ranked_id=records.entity_id LEFT JOIN dependency_rank ON dependency_id=records.entity_id WHERE entity_type=?2
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
      ), ranked AS (SELECT *, CASE WHEN {pending} THEN json_extract(document,'$.occurrence.series_id') ELSE entity_id END group_key, ({pending}) pending_group FROM matched), grouped AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY group_key ORDER BY {order}) group_row,COUNT(*) OVER(PARTITION BY group_key) group_count FROM ranked)
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
            rank_json,
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
            task.unresolved_blocker_ids = graph.unresolved(&task);
            task.recommendation = Some(
                rankings
                    .get(&task.id)
                    .cloned()
                    .unwrap_or_else(|| crate::planning::evaluate(&task, timestamp)),
            );
        }
        if let Some(r) = task.recommendation.as_mut() {
            r.next_change_at = next_change;
            r.revision = Some(h);
        }
        Ok(task)
    })
    .collect()
}
