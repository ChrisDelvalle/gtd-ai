//! Account-scoped history, derived chart reads, and committed-request selection.
use super::{
    reads::{Cursor, limit},
    *,
};
use crate::{
    activity::{self, ChartQuery, Event, Metric, Range, ResultsQuery, Window},
    model::*,
    projection,
    store::{StoreError, reads::query_key},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn invalid(message: impl Into<String>) -> Error {
    StoreError::Invalid(message.into()).into()
}

/// Shared with the offline migration. Call only inside an account-bound transaction.
pub(super) fn insert_event(
    tx: &mut ::postgres::Transaction<'_>,
    account: Uuid,
    change: &Change,
) -> Result<()> {
    let mut event = Event::from_change(change);
    if let Some(target) = event.undoes {
        event.automatic |= tx
            .query_opt(
                "SELECT automatic FROM gtd.activity_events WHERE account_id=$1 AND change_id=$2",
                &[&account, &target],
            )?
            .is_some_and(|r| r.get(0));
    }
    let kind = serde_json::to_value(event.entity_type)?
        .as_str()
        .unwrap()
        .to_owned();
    let category = serde_json::to_value(event.category)?
        .as_str()
        .unwrap()
        .to_owned();
    tx.execute("INSERT INTO gtd.activity_events(account_id,change_id,occurred_at,entity_id,entity_type,category,automatic,completion,undoes,document) VALUES($1,$2,$3::text::timestamptz,$4,$5,$6,$7,$8,$9,$10)",
        &[&account,&event.id,&event.at,&event.entity_id,&kind,&category,&event.automatic,&event.completion,&event.undoes,&serde_json::to_string(&event)?])?;
    Ok(())
}

impl Store {
    pub fn activity_summary(&self, p: &Principal, q: ChartQuery) -> Result<Value> {
        self.read(p, |tx| tx.chart(q, false))
    }
    pub fn activity_day(&self, p: &Principal, q: ChartQuery) -> Result<Value> {
        self.read(p, |tx| tx.chart(q, true))
    }
    pub fn request_results(&self, p: &Principal, q: ResultsQuery) -> Result<Value> {
        self.read(p, |tx| tx.results(q))
    }
}

impl AccountTransaction<'_> {
    pub(super) fn rebuild_activity(&mut self) -> Result<()> {
        let mut after = 0_i64;
        loop {
            let rows=self.tx.query("SELECT document,id FROM gtd.changes WHERE account_id=$1 AND id>$2 ORDER BY id LIMIT 200",&[&self.account.id,&after])?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                let c: Change = serde_json::from_str(&row.get::<_, String>(0))?;
                insert_event(&mut self.tx, self.account.id, &c)?;
                after = row.get(1);
            }
        }
        Ok(())
    }
    fn request_records(&mut self, ids: &[String]) -> Result<Vec<String>> {
        activity::validate_requests(ids).map_err(invalid)?;
        let rows = self.tx.query(
            "SELECT response FROM gtd.requests WHERE account_id=$1 AND id=ANY($2)",
            &[&self.account.id, &ids],
        )?;
        if rows.len() != ids.len() {
            return Err(
                StoreError::NotFound("Committed request reference unavailable".into()).into(),
            );
        }
        let mut found = BTreeSet::new();
        for row in rows {
            found.extend(
                activity::receipt_ids(&serde_json::from_str::<Value>(&row.get::<_, String>(0))?)
                    .map_err(invalid)?,
            );
        }
        Ok(found.into_iter().collect())
    }
    fn undo_events(&mut self, high: i64) -> Result<Vec<Event>> {
        self.tx.query("SELECT document FROM gtd.activity_events WHERE account_id=$1 AND change_id<=$2 AND undoes IS NOT NULL ORDER BY change_id DESC",&[&self.account.id,&high])?.into_iter()
            .map(|r|Ok(serde_json::from_str(&r.get::<_,String>(0))?)).collect()
    }
    pub(super) fn range_events(&mut self, high: i64, w: &Window) -> Result<Vec<Event>> {
        self.tx.query("SELECT document FROM gtd.activity_events WHERE account_id=$1 AND change_id<=$2 AND ($3::text IS NULL OR occurred_at >= $3::text::timestamptz) AND occurred_at <= $5::text::timestamptz AND (occurred_at < $4::text::timestamptz OR $4::text::timestamptz=$5::text::timestamptz) ORDER BY change_id",&[&self.account.id,&high,&w.start,&w.end,&w.evaluated_at])?.into_iter()
            .map(|r|Ok(serde_json::from_str(&r.get::<_,String>(0))?)).collect()
    }
    fn chart_changes(&mut self, high: i64, query: &ChartQuery, window: &Window) -> Result<Value> {
        let mut days = BTreeMap::new();
        let mut automatic = 0;
        let rows = self.tx.query_typed(
            "SELECT ((occurred_at AT TIME ZONE $5)::date)::text, category, automatic, count(*)
             FROM gtd.activity_events WHERE account_id=$1 AND change_id<=$2
             AND occurred_at >= $3::text::timestamptz AND occurred_at <= $4::text::timestamptz
             AND (occurred_at < $6::text::timestamptz OR $6::text::timestamptz=$4::text::timestamptz)
             GROUP BY 1,2,3",
            &[(&self.account.id, Type::UUID), (&high, Type::INT8), (&window.start, Type::TEXT),
              (&window.evaluated_at, Type::TEXT), (&window.timezone, Type::TEXT), (&window.end, Type::TEXT)],
        )?;
        for row in rows {
            let n = row.get::<_, i64>(3) as usize;
            if row.get::<_, bool>(2) {
                automatic += n;
            } else {
                let category = serde_json::from_value(Value::String(row.get(1)))?;
                let day: &mut (BTreeMap<_, _>, usize) =
                    days.entry(row.get::<_, String>(0)).or_default();
                day.0.insert(category, n);
            }
        }
        activity::daily_counts(days, automatic, query, window).map_err(invalid)
    }
    pub(super) fn activity_changes(&mut self, input: ListChanges) -> Result<ChangesResult> {
        activity::history_selector(&input).map_err(invalid)?;
        let max = limit(input.limit, 20)?;
        if let Some(ids) = &input.from_request_ids {
            self.request_records(ids)?;
        }
        let mut cursor = self.list_cursor(
            input.cursor.as_deref(),
            "history",
            query_key(&input)?,
            input.agent_context,
            0,
        )?;
        let window = input
            .range
            .resolve(
                cursor.timezone.parse().map_err(|_| Error::ResetRequired)?,
                &cursor.evaluated_at,
            )
            .map_err(invalid)?;
        let snapshot = Cursor {
            position: 0,
            ..cursor.clone()
        }
        .encode()?;
        let before = if cursor.position > 0 {
            Some(cursor.position as i64)
        } else {
            input.before_id
        };
        let kind = input
            .entity_type
            .or(if input.project_id.is_some() {
                Some(EntityType::Project)
            } else if input.task_id.is_some() {
                Some(EntityType::Task)
            } else {
                None
            })
            .map(|k| {
                serde_json::to_value(k)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            });
        let id = input.task_id.or(input.project_id);
        let rows=self.tx.query("SELECT c.document,e.document FROM gtd.activity_events e JOIN gtd.changes c ON c.account_id=e.account_id AND c.id=e.change_id
            WHERE e.account_id=$1 AND e.change_id<=$2 AND ($3::text IS NULL OR e.entity_id=$3) AND ($4::bigint IS NULL OR e.change_id<$4)
            AND ($5::bigint IS NULL OR e.change_id=$5) AND ($6::text IS NULL OR e.entity_type=$6)
            AND ($7::text IS NULL OR e.occurred_at >= $7::text::timestamptz)
            AND e.occurred_at <= $9::text::timestamptz AND (e.occurred_at < $8::text::timestamptz OR $8::text::timestamptz=$9::text::timestamptz)
            AND ($10::text[] IS NULL OR c.batch_id=ANY($10)) ORDER BY e.change_id DESC LIMIT $11",
            &[&self.account.id,&cursor.high,&id,&before,&input.change_id,&kind,&window.start,&window.end,&window.evaluated_at,&input.from_request_ids,&((max+1)as i64)])?;
        let cancelled = activity::reversals(&self.undo_events(cursor.high)?);
        let mut changes = Vec::new();
        let mut annotations = BTreeMap::new();
        let mut bytes = 1024 + snapshot.len() * 2;
        let mut more = false;
        let detail = if input.change_id.is_some() {
            input.detail.unwrap_or(Detail::Summary)
        } else {
            Detail::Summary
        };
        for row in rows {
            let c: Change = serde_json::from_str(&row.get::<_, String>(0))?;
            let event: Event = serde_json::from_str(&row.get::<_, String>(1))?;
            let a = activity::annotation(&c, &event, &cancelled);
            let size = serde_json::to_vec(&projection::change(&c, detail))?.len()
                + serde_json::to_vec(&a)?.len();
            if changes.len() == max || !changes.is_empty() && bytes + size > projection::PAGE_BYTES
            {
                more = true;
                break;
            }
            bytes += size;
            annotations.insert(c.id, a);
            changes.push(c);
        }
        let next_before_id = more.then(|| changes.last().unwrap().id);
        let next_cursor = if let Some(id) = next_before_id {
            cursor.position = id as u64;
            Some(cursor.encode()?)
        } else {
            None
        };
        Ok(ChangesResult {
            changes,
            next_before_id,
            next_cursor,
            snapshot,
            window,
            activity: annotations,
        })
    }
    pub(super) fn chart(&mut self, q: ChartQuery, day: bool) -> Result<Value> {
        let from = activity::date(&q.from).map_err(invalid)?;
        let through = activity::date(&q.through).map_err(invalid)?;
        if through < from || (through - from).num_days() > 370 {
            return Err(invalid("Chart ranges must contain 1–371 calendar days"));
        }
        let base = self.list_cursor(
            q.snapshot.as_deref(),
            "activity_chart",
            json!({"from":q.from,"through":q.through,"metric":q.metric}),
            false,
            0,
        )?;
        let snapshot = base.encode()?;
        let zone = base.timezone.parse().map_err(|_| Error::ResetRequired)?;
        let range = Range {
            from: Some(q.from.clone()),
            through: Some(q.through.clone()),
            days: None,
        };
        let window = range.resolve(zone, &base.evaluated_at).map_err(invalid)?;
        if !day {
            if q.day.is_some() || q.category.is_some() || q.automatic || q.cursor.is_some() {
                return Err(invalid("Day selectors require activity_day"));
            }
            let mut value = if q.metric == Metric::Changes {
                self.chart_changes(base.high, &q, &window)?
            } else {
                let cancelled = activity::reversals(&self.undo_events(base.high)?);
                let events = self.range_events(base.high, &window)?;
                activity::counts(&events, &cancelled, &q, &window).map_err(invalid)?
            };
            value["snapshot"] = snapshot.into();
            value["has_history"] = json!(base.high > 0);
            return Ok(value);
        }
        if q.snapshot.is_none() {
            return Err(invalid("activity_day requires the chart snapshot"));
        }
        let cancelled = activity::reversals(&self.undo_events(base.high)?);
        let selected = activity::date(q.day.as_deref().ok_or_else(|| invalid("Choose a day"))?)
            .map_err(invalid)?;
        if selected < from
            || selected > through
            || q.category.is_some() && q.metric != Metric::Changes
        {
            return Err(invalid(
                "Day selection is outside the chart or incompatible with its metric",
            ));
        }
        let day_window = Range {
            from: q.day.clone(),
            through: q.day.clone(),
            days: None,
        }
        .resolve(zone, &base.evaluated_at)
        .map_err(invalid)?;
        let mut events = self.range_events(base.high, &day_window)?;
        let mut seen = BTreeSet::new();
        events.retain(|e| {
            e.automatic == q.automatic
                && q.category.is_none_or(|kind| e.category == kind)
                && (q.automatic
                    || q.metric == Metric::Changes
                    || e.completion
                        && !cancelled.contains_key(&e.id)
                        && seen.insert(e.entity_id.clone()))
        });
        events.sort_by_key(|e| std::cmp::Reverse(e.id));
        let total = events.len();
        let key = query_key(&q)?;
        let mut cursor = if let Some(c) = &q.cursor {
            self.list_cursor(Some(c), "activity_day", key, false, 0)?
        } else {
            Cursor {
                phase: "activity_day".into(),
                query: key,
                position: 0,
                ..base.clone()
            }
        };
        if cursor.high != base.high || cursor.evaluated_at != base.evaluated_at {
            return Err(Error::ResetRequired);
        }
        let max = limit(q.limit, 20)?;
        let mut changes = Vec::new();
        let mut annotations = BTreeMap::new();
        let mut bytes = 1024 + snapshot.len() + cursor.encode()?.len();
        let mut more = false;
        let selected = events
            .iter()
            .filter(|e| cursor.position == 0 || e.id < cursor.position as i64)
            .take(max + 1)
            .collect::<Vec<_>>();
        let ids = selected.iter().map(|event| event.id).collect::<Vec<_>>();
        let documents: BTreeMap<i64, String> = self
            .tx
            .query_typed(
                "SELECT id, document FROM gtd.changes WHERE account_id=$1 AND id=ANY($2)",
                &[(&self.account.id, Type::UUID), (&ids, Type::INT8_ARRAY)],
            )?
            .into_iter()
            .map(|row| (row.get(0), row.get(1)))
            .collect();
        for event in selected {
            let document = documents.get(&event.id).ok_or(Error::Reconciliation)?;
            let c: Change = serde_json::from_str(document)?;
            let a = activity::annotation(&c, event, &cancelled);
            let size = serde_json::to_vec(&projection::change(&c, Detail::Summary))?.len()
                + serde_json::to_vec(&a)?.len();
            if changes.len() == max || !changes.is_empty() && bytes + size > projection::PAGE_BYTES
            {
                more = true;
                break;
            }
            bytes += size;
            annotations.insert(c.id, a);
            changes.push(c);
        }
        let next_before_id = more.then(|| changes.last().unwrap().id);
        let next_cursor = if let Some(id) = next_before_id {
            cursor.position = id as u64;
            Some(cursor.encode()?)
        } else {
            None
        };
        let mut value = projection::changes(
            &ChangesResult {
                changes,
                next_before_id,
                next_cursor,
                snapshot,
                window: day_window,
                activity: annotations,
            },
            Detail::Summary,
        );
        value["total"] = json!(total);
        Ok(value)
    }
    pub(super) fn results(&mut self, q: ResultsQuery) -> Result<Value> {
        let ids = self.request_records(&q.from_request_ids)?;
        let mut cursor = self.list_cursor(
            q.cursor.as_deref(),
            "request_results",
            query_key(&q)?,
            q.agent_context,
            0,
        )?;
        let snapshot = Cursor {
            position: 0,
            ..cursor.clone()
        }
        .encode()?;
        let max = limit(q.limit, 5)?;
        let rows=self.tx.query("SELECT document FROM (SELECT DISTINCT ON(entity_id) entity_id,seq,document FROM gtd.revisions WHERE account_id=$1 AND seq<=$2 AND entity_id=ANY($3) ORDER BY entity_id,seq DESC) r ORDER BY seq DESC,entity_id LIMIT $4 OFFSET $5",&[&self.account.id,&cursor.high,&ids,&((max+1)as i64),&(cursor.position as i64)])?;
        let mut records = Vec::new();
        let mut bytes = 1024 + snapshot.len() * 2;
        let mut more = false;
        for row in rows {
            let task: Task = serde_json::from_str(&row.get::<_, String>(0))?;
            let record = projection::page_record_with_agent_notes(
                &task,
                Detail::Full,
                true,
                q.agent_context,
            );
            let size = serde_json::to_vec(&record)?.len();
            if records.len() == max || !records.is_empty() && bytes + size > projection::PAGE_BYTES
            {
                more = true;
                break;
            }
            bytes += size;
            records.push(record);
        }
        cursor.position += records.len() as u64;
        Ok(
            json!({"app":"gtd","view":"results","records":records,"from_request_ids":q.from_request_ids,
            "next_cursor":if more{Some(cursor.encode()?)}else{None},"snapshot":snapshot,"evaluated_at":cursor.evaluated_at,"response_version":2}),
        )
    }
}
