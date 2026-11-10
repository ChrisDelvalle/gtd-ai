//! SQLite reference/recovery reads. Production uses the indexed PostgreSQL projection.
use super::*;
use crate::{
    activity::{self, ChartQuery, Event, Metric, Range, ResultsQuery},
    projection,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn snapshot(
    c: &Connection,
    encoded: Option<&str>,
    phase: &str,
    key: Value,
) -> Result<reads::Cursor> {
    if let Some(encoded) = encoded {
        let v = reads::decode(c, encoded)?;
        if v.phase != phase || v.query != key {
            return Err(StoreError::ResetRequired);
        }
        Ok(v)
    } else {
        reads::make(c, phase, reads::high(c)?, 0, key)
    }
}
fn rows(c: &Connection, high: i64) -> Result<(Vec<Change>, Vec<Event>)> {
    let mut statement = c.prepare("SELECT document FROM changes WHERE id<=?1 ORDER BY id")?;
    let changes = statement
        .query_map([high], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str::<Change>(&r?)?))
        .collect::<Result<Vec<_>>>()?;
    let mut events = changes.iter().map(Event::from_change).collect::<Vec<_>>();
    activity::inherit_automatic(&mut events);
    Ok((changes, events))
}
fn requests(c: &Connection, ids: &[String]) -> Result<Vec<String>> {
    activity::validate_requests(ids).map_err(StoreError::Invalid)?;
    let mut selected = BTreeSet::new();
    for id in ids {
        let raw = c
            .query_row("SELECT response FROM requests WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .ok_or_else(|| {
                StoreError::NotFound("Committed request reference unavailable".into())
            })?;
        selected.extend(
            activity::receipt_ids(&serde_json::from_str(&raw)?).map_err(StoreError::Invalid)?,
        );
    }
    Ok(selected.into_iter().collect())
}
pub(super) fn history(c: &Connection, input: ListChanges) -> Result<ChangesResult> {
    activity::history_selector(&input).map_err(StoreError::Invalid)?;
    let max = input.limit.unwrap_or(20) as usize;
    if !(1..=100).contains(&max) {
        return Err(StoreError::Invalid("limit must be 1–100".into()));
    }
    let mut cursor = snapshot(
        c,
        input.cursor.as_deref(),
        "history",
        reads::query_key(&input)?,
    )?;
    let window = input
        .range
        .resolve(
            chrono_tz::America::New_York,
            cursor
                .evaluated_at
                .as_deref()
                .ok_or(StoreError::ResetRequired)?,
        )
        .map_err(StoreError::Invalid)?;
    let original = reads::encode(&reads::Cursor {
        position: 0,
        ..cursor.clone()
    });
    let request_changes = if let Some(ids) = &input.from_request_ids {
        requests(c, ids)?;
        let mut stmt = c.prepare(
            "SELECT id FROM changes WHERE batch_id IN (SELECT value FROM json_each(?1))",
        )?;
        Some(
            stmt.query_map([serde_json::to_string(ids)?], |r| r.get::<_, i64>(0))?
                .collect::<std::result::Result<BTreeSet<_>, _>>()?,
        )
    } else {
        None
    };
    let (changes, events) = rows(c, cursor.high)?;
    let cancelled = activity::reversals(&events);
    let kind = input.entity_type.or(if input.project_id.is_some() {
        Some(EntityType::Project)
    } else if input.task_id.is_some() {
        Some(EntityType::Task)
    } else {
        None
    });
    let id = input.task_id.or(input.project_id);
    let before = if cursor.position > 0 {
        Some(cursor.position as i64)
    } else {
        input.before_id
    };
    let detail = if input.change_id.is_some() {
        input.detail.unwrap_or(Detail::Summary)
    } else {
        Detail::Summary
    };
    let mut selected = Vec::new();
    let mut annotations = BTreeMap::new();
    let mut bytes = 1024 + original.len() * 2;
    let mut more = false;
    for (change, event) in changes.iter().zip(&events).rev().filter(|(ch, _)| {
        id.as_ref().is_none_or(|id| id == &ch.task_id)
            && kind.is_none_or(|k| k == ch.entity_type)
            && before.is_none_or(|n| ch.id < n)
            && input.change_id.is_none_or(|n| ch.id == n)
            && request_changes
                .as_ref()
                .is_none_or(|ids| ids.contains(&ch.id))
            && window.contains(&ch.created_at)
    }) {
        let a = activity::annotation(change, event, &cancelled);
        let size = serde_json::to_vec(&projection::change(change, detail))?.len()
            + serde_json::to_vec(&a)?.len();
        if selected.len() == max || !selected.is_empty() && bytes + size > projection::PAGE_BYTES {
            more = true;
            break;
        }
        bytes += size;
        annotations.insert(change.id, a);
        selected.push(change.clone());
    }
    let next_before_id = more.then(|| selected.last().unwrap().id);
    let next_cursor = next_before_id.map(|id| {
        cursor.position = id as u64;
        reads::encode(&cursor)
    });
    Ok(ChangesResult {
        changes: selected,
        next_before_id,
        next_cursor,
        snapshot: original,
        window,
        activity: annotations,
    })
}
impl Store {
    pub fn activity_summary(&self, q: ChartQuery) -> Result<Value> {
        chart(&self.connection, q, false)
    }
    pub fn activity_day(&self, q: ChartQuery) -> Result<Value> {
        chart(&self.connection, q, true)
    }
    pub fn request_results(&self, q: ResultsQuery) -> Result<Value> {
        let ids = requests(&self.connection, &q.from_request_ids)?;
        let mut cursor = snapshot(
            &self.connection,
            q.cursor.as_deref(),
            "request_results",
            reads::query_key(&q)?,
        )?;
        let original = reads::encode(&reads::Cursor {
            position: 0,
            ..cursor.clone()
        });
        let max = q.limit.unwrap_or(5) as usize;
        if !(1..=100).contains(&max) {
            return Err(StoreError::Invalid("limit must be 1–100".into()));
        }
        let mut stmt=self.connection.prepare("SELECT document FROM revisions WHERE entity_id IN (SELECT value FROM json_each(?1)) AND seq IN (SELECT MAX(seq) FROM revisions WHERE seq<=?2 GROUP BY entity_id) ORDER BY seq DESC,entity_id LIMIT ?3 OFFSET ?4")?;
        let rows = stmt
            .query_map(
                params![
                    serde_json::to_string(&ids)?,
                    cursor.high,
                    (max + 1) as i64,
                    cursor.position as i64
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut records = Vec::new();
        let mut bytes = 1024 + original.len() * 2;
        let mut more = false;
        for raw in rows {
            let task: Task = serde_json::from_str(&raw)?;
            let r = projection::page_record_with_agent_notes(
                &task,
                Detail::Full,
                true,
                q.agent_context,
            );
            let size = serde_json::to_vec(&r)?.len();
            if records.len() == max || !records.is_empty() && bytes + size > projection::PAGE_BYTES
            {
                more = true;
                break;
            }
            bytes += size;
            records.push(r);
        }
        cursor.position += records.len() as u64;
        Ok(
            json!({"app":"gtd","view":"results","records":records,"from_request_ids":q.from_request_ids,"next_cursor":more.then(||reads::encode(&cursor)),"snapshot":original,"evaluated_at":cursor.evaluated_at,"response_version":2}),
        )
    }
}
fn chart(c: &Connection, q: ChartQuery, day: bool) -> Result<Value> {
    let from = activity::date(&q.from).map_err(StoreError::Invalid)?;
    let through = activity::date(&q.through).map_err(StoreError::Invalid)?;
    if through < from || (through - from).num_days() > 370 {
        return Err(StoreError::Invalid(
            "Chart ranges must contain 1–371 calendar days".into(),
        ));
    }
    let base = snapshot(
        c,
        q.snapshot.as_deref(),
        "activity_chart",
        json!({"from":q.from,"through":q.through,"metric":q.metric}),
    )?;
    let original = reads::encode(&base);
    let at = base
        .evaluated_at
        .as_deref()
        .ok_or(StoreError::ResetRequired)?;
    let window = Range {
        from: Some(q.from.clone()),
        through: Some(q.through.clone()),
        days: None,
    }
    .resolve(chrono_tz::America::New_York, at)
    .map_err(StoreError::Invalid)?;
    let (changes, events) = rows(c, base.high)?;
    let cancelled = activity::reversals(&events);
    if !day {
        if q.day.is_some() || q.category.is_some() || q.automatic || q.cursor.is_some() {
            return Err(StoreError::Invalid(
                "Day selectors require activity_day".into(),
            ));
        }
        let mut v =
            activity::counts(&events, &cancelled, &q, &window).map_err(StoreError::Invalid)?;
        v["snapshot"] = original.into();
        v["has_history"] = json!(base.high > 0);
        return Ok(v);
    }
    if q.snapshot.is_none() {
        return Err(StoreError::Invalid(
            "activity_day requires the chart snapshot".into(),
        ));
    }
    let selected = activity::date(
        q.day
            .as_deref()
            .ok_or_else(|| StoreError::Invalid("Choose a day".into()))?,
    )
    .map_err(StoreError::Invalid)?;
    if selected < from || selected > through || q.category.is_some() && q.metric != Metric::Changes
    {
        return Err(StoreError::Invalid(
            "Day selection is outside the chart or incompatible with its metric".into(),
        ));
    }
    let mut cursor = if q.cursor.is_some() {
        snapshot(
            c,
            q.cursor.as_deref(),
            "activity_day",
            reads::query_key(&q)?,
        )?
    } else {
        reads::Cursor {
            phase: "activity_day".into(),
            query: reads::query_key(&q)?,
            position: 0,
            ..base.clone()
        }
    };
    if cursor.high != base.high || cursor.evaluated_at != base.evaluated_at {
        return Err(StoreError::ResetRequired);
    }
    let day_window = Range {
        from: q.day.clone(),
        through: q.day.clone(),
        days: None,
    }
    .resolve(chrono_tz::America::New_York, at)
    .map_err(StoreError::Invalid)?;
    let mut seen = BTreeSet::new();
    let eligible = events
        .iter()
        .filter(|e| {
            day_window.contains(&e.at)
                && e.automatic == q.automatic
                && q.category.is_none_or(|k| k == e.category)
                && (q.automatic
                    || q.metric == Metric::Changes
                    || e.completion
                        && !cancelled.contains_key(&e.id)
                        && seen.insert(e.entity_id.clone()))
        })
        .map(|e| e.id)
        .collect::<BTreeSet<_>>();
    let max = q.limit.unwrap_or(20) as usize;
    if !(1..=100).contains(&max) {
        return Err(StoreError::Invalid("limit must be 1–100".into()));
    }
    let mut found = Vec::new();
    let mut annotations = BTreeMap::new();
    let mut bytes = 1024 + original.len() + reads::encode(&cursor).len();
    let mut more = false;
    for (ch, event) in changes
        .iter()
        .zip(&events)
        .rev()
        .filter(|(ch, _)| {
            eligible.contains(&ch.id) && (cursor.position == 0 || ch.id < cursor.position as i64)
        })
        .take(max + 1)
    {
        let a = activity::annotation(ch, event, &cancelled);
        let size = serde_json::to_vec(&projection::change(ch, Detail::Summary))?.len()
            + serde_json::to_vec(&a)?.len();
        if found.len() == max || !found.is_empty() && bytes + size > projection::PAGE_BYTES {
            more = true;
            break;
        }
        bytes += size;
        annotations.insert(ch.id, a);
        found.push(ch.clone());
    }
    let next_before_id = more.then(|| found.last().unwrap().id);
    let next_cursor = next_before_id.map(|id| {
        cursor.position = id as u64;
        reads::encode(&cursor)
    });
    let mut v = projection::changes(
        &ChangesResult {
            changes: found,
            next_before_id,
            next_cursor,
            snapshot: original,
            window: day_window,
            activity: annotations,
        },
        Detail::Summary,
    );
    v["total"] = json!(eligible.len());
    Ok(v)
}
