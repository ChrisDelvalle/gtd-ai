//! Account-scoped recurring defaults and previews, using the shared schedule
//! evaluator. A preview is never stored or accepted as a dependency target.
use super::{read_snapshot::source, reads::limit, *};
use crate::{
    model::{Detail, Task},
    projection,
    recurrence_model::*,
    store::{StoreError, reads::query_key, recurrence},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RangeCursor {
    cursor: String,
    from: String,
    through: String,
}
fn invalid(message: &str) -> Error {
    StoreError::Invalid(message.into()).into()
}
impl Store {
    pub fn list_occurrences(&self, principal: &Principal, input: ListOccurrences) -> Result<Value> {
        self.read(principal, |tx| tx.read_occurrences(input))
    }
}
impl AccountTransaction<'_> {
    fn series_at(&mut self, id: &str, high: i64) -> Result<Task> {
        let row=self.tx.query_opt("SELECT document FROM gtd.revisions WHERE account_id=$1 AND entity_id=$2 AND seq<=$3 ORDER BY seq DESC LIMIT 1",&[&self.account.id,&id,&high])?.ok_or_else(||invalid("Series not found"))?;
        let task: Task = serde_json::from_str(&row.get::<_, String>(0))?;
        if task.deleted
            || task.entity_type != crate::model::EntityType::Recurrence
            || task.recurrence.is_none()
        {
            return Err(invalid("Series not found"));
        }
        Ok(task)
    }
    pub fn read_occurrences(&mut self, input: ListOccurrences) -> Result<Value> {
        if input.segments_only {
            return self.read_segments(input);
        }
        if input.template.is_some() && input.rule.is_none() {
            return Err(invalid("Preview template requires rule"));
        }
        if let Some(template) = &input.template {
            let mut checked = template.clone();
            if checked.title.is_empty() {
                checked.title = "Timing preview".into()
            }
            recurrence::template(&checked)?;
        }
        if input.series_id.is_none() && input.rule.is_none() {
            return self.read_series(input);
        }
        if input.series_id.is_some() == input.rule.is_some() {
            return Err(invalid("Provide series_id or a rule preview"));
        }
        let max = limit(input.limit, 20)?;
        let range = input
            .cursor
            .as_ref()
            .map(|value| {
                if value.len() > 24000 {
                    return Err(Error::ResetRequired);
                }
                serde_json::from_str::<RangeCursor>(value).map_err(|_| Error::ResetRequired)
            })
            .transpose()?;
        let from = input
            .from
            .clone()
            .or_else(|| range.as_ref().map(|r| r.from.clone()))
            .unwrap_or_else(|| {
                crate::clock::now()
                    .with_timezone(&self.account.timezone)
                    .date_naive()
                    .to_string()
            });
        let through = input
            .through
            .clone()
            .or_else(|| range.as_ref().map(|r| r.through.clone()))
            .unwrap_or_else(|| "2199-12-31".into());
        if range
            .as_ref()
            .is_some_and(|r| r.from != from || r.through != through)
        {
            return Err(Error::ResetRequired);
        }
        recurrence::date(&from)?;
        recurrence::date(&through)?;
        if from > through {
            return Err(invalid("from follows through"));
        }
        let mut normalized = input.clone();
        normalized.from = Some(from.clone());
        normalized.through = Some(through.clone());
        let mut cursor = self.list_cursor(
            range.as_ref().map(|r| r.cursor.as_str()),
            "occurrences",
            query_key(&normalized)?,
            input.agent_context,
            0,
        )?;
        let series = input
            .series_id
            .as_ref()
            .map(|id| self.series_at(id, cursor.high))
            .transpose()?;
        let default = Template {
            planning: Default::default(),
            title: "Preview".into(),
            brief: None,
            notes: "".into(),
            agent_notes: None,
            links: vec![],
            location: None,
            project_id: None,
            due_offset_days: None,
            review_offset_days: None,
            status: crate::model::Status::Next,
        };
        let raw = if let Some(series) = &series {
            recurrence::schedule(series.recurrence.as_ref().unwrap(), &from, &through, 74000)?
        } else {
            recurrence::dates(
                input.rule.as_ref().unwrap(),
                &from,
                &through,
                (cursor.position as usize).saturating_add(max + 1),
            )?
            .into_iter()
            .map(|d| (d.clone(), d, input.template.as_ref().unwrap_or(&default)))
            .collect()
        };
        let mut templates = BTreeMap::new();
        let mut candidates = BTreeMap::new();
        for (original, date, template) in raw {
            templates.insert(original.clone(), template);
            candidates.insert(
                original.clone(),
                json!({"original_date":original,"scheduled_date":date,"preview":true}),
            );
        }
        if let Some(series) = &series {
            let sql = format!(
                "{} SELECT document FROM records WHERE document::jsonb #>> '{{occurrence,series_id}}'=$3",
                source(cursor.high == self.high)
            );
            for row in self
                .tx
                .query(&sql, &[&self.account.id, &cursor.high, &series.id])?
            {
                let task: Task = serde_json::from_str(&row.get::<_, String>(0))?;
                let occurrence = task.occurrence.as_ref().ok_or(Error::Reconciliation)?;
                candidates.remove(&occurrence.original_date);
                if !task.deleted
                    && occurrence.scheduled_date >= from
                    && occurrence.scheduled_date <= through
                {
                    candidates.insert(occurrence.original_date.clone(),json!({"original_date":occurrence.original_date,"scheduled_date":occurrence.scheduled_date,"preview":false,"task":if input.agent_context {projection::agent_record_at(&task,&cursor.evaluated_at)}else{projection::record(&task,Detail::Summary)}}));
                }
            }
        }
        let mut rows = candidates.into_values().collect::<Vec<_>>();
        rows.sort_by(|a, b| {
            a["scheduled_date"]
                .as_str()
                .cmp(&b["scheduled_date"].as_str())
                .then(
                    a["original_date"]
                        .as_str()
                        .cmp(&b["original_date"].as_str()),
                )
        });
        let mut rows = rows
            .into_iter()
            .skip(cursor.position as usize)
            .take(max + 1)
            .collect::<Vec<_>>();
        let mut more = rows.len() > max;
        rows.truncate(max);
        for row in &mut rows {
            if row["preview"] == true {
                let template = templates[row["original_date"].as_str().unwrap()];
                let date = row["scheduled_date"].as_str().unwrap();
                let due = recurrence::shifted(date, template.due_offset_days)?;
                let (planning, adjustments) = template
                    .planning
                    .materialize(date, due.as_deref())
                    .map_err(StoreError::Invalid)?;
                planning
                    .validate(due.as_deref())
                    .map_err(StoreError::Invalid)?;
                row["planning"] = json!(planning);
                row["due_date"] = json!(due);
                row["timing_adjustments"] = json!(adjustments);
            }
        }
        let mut series_value = series.as_ref().map(|task| {
            if input.agent_context {
                projection::agent_record_at(task, &cursor.evaluated_at)
            } else {
                projection::record_with_agent_notes(
                    task,
                    if cursor.position == 0 {
                        Detail::Full
                    } else {
                        Detail::Summary
                    },
                    input.include_agent_notes,
                )
            }
        });
        let omitted = !input.agent_context
            && !input.include_agent_notes
            && series_value
                .as_ref()
                .is_some_and(|v| serde_json::to_vec(v).unwrap().len() > projection::PAGE_BYTES / 2);
        if omitted {
            series_value = series
                .as_ref()
                .map(|t| projection::record(t, Detail::Summary));
        }
        let zone = series
            .as_ref()
            .map(|s| s.recurrence.as_ref().unwrap().timezone.clone())
            .unwrap_or_else(|| self.account.timezone.to_string());
        let offset = cursor.position;
        loop {
            cursor.position = offset + rows.len() as u64;
            let next = if more {
                Some(serde_json::to_string(&RangeCursor {
                    cursor: cursor.encode()?,
                    from: from.clone(),
                    through: through.clone(),
                })?)
            } else {
                None
            };
            let mut response = json!({"series":series_value,"occurrences":rows,"next_cursor":next,"complete":!more,"timezone":zone,"from":from,"through":through});
            if omitted {
                response["series_omitted"] = json!(true);
                response["series_detail"] = json!({"tool":"list_changes","change_id":series.as_ref().unwrap().last_change_id,"detail":"full"});
            }
            if rows.len() <= 1 || serde_json::to_vec(&response)?.len() <= projection::PAGE_BYTES {
                return Ok(response);
            }
            rows.pop();
            more = true;
        }
    }
    fn read_series(&mut self, input: ListOccurrences) -> Result<Value> {
        if input.from.is_some() || input.through.is_some() {
            return Err(invalid("Date bounds require series_id or a rule preview"));
        }
        let max = limit(input.limit, 20)?;
        let mut cursor = self.list_cursor(
            input.cursor.as_deref(),
            "recurrences",
            query_key(&input)?,
            input.agent_context,
            0,
        )?;
        let sql = format!(
            "{} SELECT document FROM records WHERE entity_type='recurrence' AND NOT (document::jsonb->>'deleted')::boolean ORDER BY created_seq,entity_id COLLATE \"C\" LIMIT $3 OFFSET $4",
            source(cursor.high == self.high)
        );
        let rows = self.tx.query(
            &sql,
            &[
                &self.account.id,
                &cursor.high,
                &((max + 1) as i64),
                &(cursor.position as i64),
            ],
        )?;
        let mut more = rows.len() > max;
        let mut values = rows
            .into_iter()
            .take(max)
            .map(|r| {
                let task: Task = serde_json::from_str(&r.get::<_, String>(0))?;
                Ok(if input.agent_context {
                    projection::agent_record_at(&task, &cursor.evaluated_at)
                } else {
                    projection::record(&task, Detail::Summary)
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let offset = cursor.position;
        loop {
            cursor.position = offset + values.len() as u64;
            let next = more.then(|| cursor.encode()).transpose()?;
            let value = json!({"series_list":values,"next_cursor":next,"complete":!more,"timezone":self.account.timezone.to_string()});
            if values.len() <= 1 || serde_json::to_vec(&value)?.len() <= projection::PAGE_BYTES {
                return Ok(value);
            }
            values.pop();
            more = true;
        }
    }
    fn read_segments(&mut self, input: ListOccurrences) -> Result<Value> {
        if input.series_id.is_none()
            || input.rule.is_some()
            || input.template.is_some()
            || input.from.is_some()
            || input.through.is_some()
        {
            return Err(invalid(
                "segments_only requires series_id and cannot use rule, template or date bounds",
            ));
        }
        let max = limit(input.limit, 50)?;
        let mut cursor = self.list_cursor(
            input.cursor.as_deref(),
            "segments",
            query_key(&input)?,
            input.agent_context,
            0,
        )?;
        let task = self.series_at(input.series_id.as_deref().unwrap(), cursor.high)?;
        let candidates: Vec<_> = task
            .recurrence
            .as_ref()
            .unwrap()
            .segments
            .iter()
            .skip(cursor.position as usize)
            .take(max + 1)
            .collect();
        let mut more = candidates.len() > max;
        let mut rows: Vec<_> = candidates
            .iter()
            .take(max)
            .map(|s| json!({"from":s.from,"rule":s.rule,"template":s.template}))
            .collect();
        for row in &mut rows {
            if row["template"]["brief"].is_null() {
                row["template"]["brief"] = json!("");
            }
            if row["template"]["agent_notes"].is_null() {
                row["template"]["agent_notes"] = json!("");
            }
        }
        let offset = cursor.position;
        loop {
            cursor.position = offset + rows.len() as u64;
            let next = more.then(|| cursor.encode()).transpose()?;
            let value = json!({"series_id":task.id,"version":task.version,"segments":rows,"next_cursor":next,"complete":!more});
            if rows.len() <= 1 || serde_json::to_vec(&value)?.len() <= projection::PAGE_BYTES {
                return Ok(value);
            }
            rows.pop();
            more = true;
        }
    }
}
