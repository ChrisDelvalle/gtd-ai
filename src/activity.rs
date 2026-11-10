//! Read-only interpretations of immutable history, shared by recaps and charts.
use crate::model::{Change, EntityType, Status};
use chrono::{DateTime, Days, LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Undo,
    Completed,
    Added,
    Started,
    Status,
    Scheduling,
    Edited,
}
pub const CATEGORIES: [Category; 7] = [
    Category::Undo,
    Category::Completed,
    Category::Added,
    Category::Started,
    Category::Status,
    Category::Scheduling,
    Category::Edited,
];

/// Small derived row. Never stores titles, briefs, notes, or credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: i64,
    pub entity_id: String,
    pub entity_type: EntityType,
    pub at: String,
    pub category: Category,
    pub automatic: bool,
    pub undoes: Option<i64>,
    pub completion: bool,
}
const TIMING: &[&str] = &[
    "due_date",
    "deadline_time",
    "start_by",
    "not_before",
    "planned_start",
    "planned_finish",
    "work_blocks",
    "safety_buffer",
    "review_date",
];

fn skipped(c: &crate::model::Task) -> bool {
    c.occurrence.as_ref().is_some_and(|o| o.skipped)
}
fn schedule(v: &Value) -> Value {
    let segments = v["segments"].as_array().map(|segments| {
        segments
            .iter()
            .map(|s| {
                let timing = TIMING
                    .iter()
                    .chain([&"due_offset_days", &"review_offset_days"])
                    .map(|key| ((*key).to_owned(), s["template"][*key].clone()))
                    .collect::<serde_json::Map<_, _>>();
                json!({"from":s["from"],"rule":s["rule"],"timing":timing})
            })
            .collect::<Vec<_>>()
    });
    json!({"segments":segments,"pauses":v["pauses"],"ended_on":v["ended_on"]})
}

impl Event {
    pub fn from_change(c: &Change) -> Self {
        let before = c.before.as_ref();
        let completion = c.undoes_change_id.is_none()
            && c.entity_type == EntityType::Task
            && c.after.status == Status::Done
            && !c.after.deleted
            && !skipped(&c.after)
            && before.is_none_or(|t| t.status != Status::Done);
        let a = serde_json::to_value(&c.after).expect("record");
        let b = serde_json::to_value(before).expect("record");
        let category = if c.undoes_change_id.is_some() {
            Category::Undo
        } else if completion {
            Category::Completed
        } else if before.is_none() {
            Category::Added
        } else if c.after.planning.started && before.is_some_and(|t| !t.planning.started) {
            Category::Started
        } else if before.is_some_and(|t| {
            t.status != c.after.status
                || t.archived != c.after.archived
                || t.deleted != c.after.deleted
                || skipped(t) != skipped(&c.after)
        }) {
            Category::Status
        } else if TIMING.iter().any(|k| a[*k] != b[*k])
            || a["occurrence"]["scheduled_date"] != b["occurrence"]["scheduled_date"]
            || schedule(&a["recurrence"]) != schedule(&b["recurrence"])
        {
            Category::Scheduling
        } else {
            Category::Edited
        };
        Self {
            id: c.id,
            entity_id: c.task_id.clone(),
            entity_type: c.entity_type,
            at: c.created_at.clone(),
            category,
            completion,
            undoes: c.undoes_change_id,
            automatic: matches!(
                c.operation.as_str(),
                "occurrence"
                    | "dependency_status"
                    | "availability_status"
                    | "require_importance"
                    | "rename_planned"
                    | "planning_defaults"
            ),
        }
    }
}

/// Resolve explicit undo/redo links at the caller's frozen revision. Ordinary
/// reopening has no undo link and deliberately does not cancel an accomplishment.
pub fn reversals(events: &[Event]) -> BTreeMap<i64, i64> {
    let mut ordered = events.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|e| std::cmp::Reverse(e.id));
    let mut cancelled = BTreeMap::new();
    for event in ordered {
        if !cancelled.contains_key(&event.id)
            && let Some(target) = event.undoes
        {
            cancelled.insert(target, event.id);
        }
    }
    cancelled
}

pub fn inherit_automatic(events: &mut [Event]) {
    events.sort_by_key(|e| e.id);
    let mut known = BTreeMap::new();
    for event in events {
        if let Some(target) = event.undoes {
            event.automatic |= known.get(&target).copied().unwrap_or(false);
        }
        known.insert(event.id, event.automatic);
    }
}

pub fn annotation(c: &Change, event: &Event, cancelled: &BTreeMap<i64, i64>) -> Value {
    let a = serde_json::to_value(&c.after).expect("record");
    let b = serde_json::to_value(&c.before).expect("record");
    let mut transitions = serde_json::Map::new();
    for key in ["status", "started", "started_at", "archived", "deleted"]
        .iter()
        .chain(TIMING.iter())
    {
        if a[*key] != b[*key] {
            let compact = |v: &Value| {
                if *key == "work_blocks" {
                    json!(v.as_array().map(|blocks|blocks.iter().map(|block|json!({"id":block["id"],"start":block["start"],"finish":block["finish"]})).collect::<Vec<_>>()))
                } else {
                    v.clone()
                }
            };
            transitions.insert(
                (*key).into(),
                json!({"from":compact(&b[*key]),"to":compact(&a[*key])}),
            );
        }
    }
    for key in ["skipped", "scheduled_date"] {
        if a["occurrence"][key] != b["occurrence"][key] {
            transitions.insert(
                key.into(),
                json!({"from":b["occurrence"][key],"to":a["occurrence"][key]}),
            );
        }
    }
    json!({"category":event.category,"automatic":event.automatic,"transitions":transitions,
        "completion_eligible":event.completion && !event.automatic && !cancelled.contains_key(&event.id),
        "completion_recorded_at":event.completion.then_some(&event.at),
        "undone_by_change_id":cancelled.get(&event.id)})
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Range {
    /// Inclusive local calendar date. Cannot combine with days.
    pub from: Option<String>,
    /// Inclusive local calendar date. Cannot combine with days.
    pub through: Option<String>,
    /// Previous 1–366 complete calendar days in the account timezone, excluding today.
    pub days: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Window {
    pub timezone: String,
    pub from: Option<String>,
    pub through: Option<String>,
    pub start: Option<String>,
    pub end: String,
    pub evaluated_at: String,
}
pub fn date(s: &str) -> Result<NaiveDate, String> {
    let d = NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| "Use a calendar date in YYYY-MM-DD format".to_string())?;
    if d.format("%Y-%m-%d").to_string() != s {
        return Err("Use a calendar date in YYYY-MM-DD format".into());
    }
    Ok(d)
}
// Some IANA zones change at midnight or skip a calendar day. A date boundary
// means the first representable instant at or after that local midnight.
fn boundary(d: NaiveDate, zone: Tz) -> Result<DateTime<Utc>, String> {
    let midnight = d.and_hms_opt(0, 0, 0).ok_or("Invalid date boundary")?;
    for minute in 0..=2880 {
        let local = midnight
            .checked_add_signed(chrono::Duration::minutes(minute))
            .ok_or("Date outside supported range")?;
        match zone.from_local_datetime(&local) {
            LocalResult::Single(t) => return Ok(t.with_timezone(&Utc)),
            LocalResult::Ambiguous(a, b) => return Ok(a.min(b).with_timezone(&Utc)),
            LocalResult::None => {}
        }
    }
    Err("Could not resolve the local date boundary".into())
}
impl Range {
    pub fn resolve(&self, zone: Tz, evaluated_at: &str) -> Result<Window, String> {
        let now = DateTime::parse_from_rfc3339(evaluated_at)
            .map_err(|_| "Invalid evaluation time")?
            .with_timezone(&Utc);
        let today = now.with_timezone(&zone).date_naive();
        let (from, through) = if let Some(n) = self.days {
            if !(1..=366).contains(&n) || self.from.is_some() || self.through.is_some() {
                return Err(
                    "days must be 1–366 and cannot be combined with from or through".into(),
                );
            }
            (
                Some(
                    today
                        .checked_sub_days(Days::new(n as u64))
                        .ok_or("Date outside supported range")?,
                ),
                Some(today.pred_opt().ok_or("Date outside supported range")?),
            )
        } else {
            (
                self.from.as_deref().map(date).transpose()?,
                self.through.as_deref().map(date).transpose()?,
            )
        };
        if matches!((from,through),(Some(a),Some(b)) if a>b) {
            return Err("from must be on or before through".into());
        }
        let start = from.map(|d| boundary(d, zone)).transpose()?;
        let end = through
            .map(|d| boundary(d.succ_opt().ok_or("Date outside supported range")?, zone))
            .transpose()?
            .unwrap_or(now)
            .min(now);
        Ok(Window {
            timezone: zone.name().into(),
            from: from.map(|d| d.to_string()),
            through: through.map(|d| d.to_string()),
            start: start.map(|t| t.to_rfc3339()),
            end: end.to_rfc3339(),
            evaluated_at: evaluated_at.into(),
        })
    }
}
impl Window {
    pub fn contains(&self, at: &str) -> bool {
        let Ok(t) = DateTime::parse_from_rfc3339(at) else {
            return false;
        };
        let end = DateTime::parse_from_rfc3339(&self.end).expect("resolved end");
        let evaluated = DateTime::parse_from_rfc3339(&self.evaluated_at).expect("evaluation");
        self.start
            .as_ref()
            .is_none_or(|s| t >= DateTime::parse_from_rfc3339(s).expect("resolved start"))
            && t <= evaluated
            && (t < end || end == evaluated && t == end)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Metric {
    #[default]
    Completed,
    Changes,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChartQuery {
    pub from: String,
    pub through: String,
    #[serde(default)]
    pub metric: Metric,
    /// Snapshot returned by activity_summary. Required for day drilldowns.
    pub snapshot: Option<String>,
    /// Optional one-day selection, within the chart range.
    pub day: Option<String>,
    pub category: Option<Category>,
    #[serde(default)]
    pub automatic: bool,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}
pub fn counts(
    events: &[Event],
    cancellations: &BTreeMap<i64, i64>,
    query: &ChartQuery,
    window: &Window,
) -> Result<Value, String> {
    let zone: Tz = window.timezone.parse().map_err(|_| "Invalid timezone")?;
    let mut buckets = BTreeMap::<String, (BTreeMap<Category, usize>, BTreeSet<String>)>::new();
    let mut automatic = 0;
    for event in events.iter().filter(|e| window.contains(&e.at)) {
        if event.automatic {
            automatic += 1;
            continue;
        }
        let d = DateTime::parse_from_rfc3339(&event.at)
            .map_err(|_| "Invalid historical timestamp")?
            .with_timezone(&zone)
            .date_naive()
            .to_string();
        let b = buckets.entry(d).or_default();
        *b.0.entry(event.category).or_default() += 1;
        if query.metric == Metric::Completed
            && event.completion
            && !cancellations.contains_key(&event.id)
        {
            b.1.insert(event.entity_id.clone());
        }
    }
    let days = buckets
        .into_iter()
        .map(|(day, (categories, completed))| (day, (categories, completed.len())))
        .collect();
    daily_counts(days, automatic, query, window)
}

pub(crate) fn daily_counts(
    mut buckets: BTreeMap<String, (BTreeMap<Category, usize>, usize)>,
    automatic: usize,
    query: &ChartQuery,
    window: &Window,
) -> Result<Value, String> {
    let from = date(&query.from)?;
    let through = date(&query.through)?;
    if through < from || (through - from).num_days() > 370 {
        return Err("Chart ranges must contain 1–371 calendar days".into());
    }
    let zone: Tz = window.timezone.parse().map_err(|_| "Invalid timezone")?;
    let today = DateTime::parse_from_rfc3339(&window.evaluated_at)
        .map_err(|_| "Invalid evaluation time")?
        .with_timezone(&zone)
        .date_naive();
    let mut days = Vec::new();
    let mut totals = BTreeMap::<Category, usize>::new();
    let mut total = 0;
    for day in from
        .iter_days()
        .take(((through - from).num_days() + 1) as usize)
    {
        let (categories, completed) = buckets.remove(&day.to_string()).unwrap_or_default();
        let count = if query.metric == Metric::Completed {
            completed
        } else {
            categories.values().sum()
        };
        total += count;
        for (key, n) in &categories {
            *totals.entry(*key).or_default() += n;
        }
        days.push(json!({"date":day.to_string(),"count":if day>today {None}else{Some(count)},"categories":categories,"partial":day==today,"future":day>today}));
    }
    Ok(
        json!({"days":days,"total":total,"categories":totals,"automatic_count":automatic,"metric":query.metric,"window":window}),
    )
}

pub fn validate_requests(ids: &[String]) -> Result<(), String> {
    if ids.is_empty()
        || ids.len() > 50
        || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
        || ids.iter().any(|s| {
            s.is_empty()
                || s.len() > 128
                || !s
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_:.".contains(&c))
        })
    {
        return Err("from_request_ids requires 1–50 distinct valid request IDs".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResultsQuery {
    pub from_request_ids: Vec<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    #[serde(skip_deserializing, default)]
    #[schemars(skip)]
    pub agent_context: bool,
}

pub fn history_selector(input: &crate::model::ListChanges) -> Result<(), String> {
    if input.before_id.is_some_and(|id| id <= 0)
        || input.change_id.is_some_and(|id| id <= 0)
        || input.task_id.is_some() && input.project_id.is_some()
        || input.cursor.is_some() && input.before_id.is_some()
        || input.change_id.is_some()
            && (input.cursor.is_some()
                || input.range.from.is_some()
                || input.range.through.is_some()
                || input.range.days.is_some())
    {
        return Err("Invalid history selector; cursor cannot combine with before_id, and exact change lookup cannot combine with dates or cursor".into());
    }
    if let Some(ids) = &input.from_request_ids {
        validate_requests(ids)?;
    }
    Ok(())
}

pub fn receipt_ids(receipt: &Value) -> Result<BTreeSet<String>, String> {
    let mut ids = BTreeSet::new();
    let entries = receipt
        .get("results")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect::<Vec<_>>())
        .unwrap_or_else(|| vec![receipt]);
    for entry in entries {
        let record = ["task", "project", "series"]
            .iter()
            .find_map(|key| entry.get(*key));
        let id = record
            .and_then(|r| r["id"].as_str())
            .or_else(|| entry["entity_id"].as_str())
            .ok_or("Committed request receipt has no record reference")?;
        ids.insert(id.into());
    }
    Ok(ids)
}

pub fn show_task_defaults(input: &mut crate::model::ListItems) {
    let mut v = serde_json::to_value(&*input).expect("list args");
    for key in [
        "cursor",
        "limit",
        "detail",
        "agent_context",
        "include_agent_notes",
    ] {
        v.as_object_mut().unwrap().remove(key);
    }
    let selectors = v.as_object().unwrap().values().any(|v| match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_u64() != Some(0),
        Value::Array(a) => !a.is_empty(),
        _ => true,
    });
    if !selectors {
        input.view = Some(crate::model::TaskView::All);
        input.sort = Some(crate::model::TaskSort::Updated);
        if input.limit.is_none() {
            input.limit = Some(5);
        }
    }
}

#[cfg(test)]
mod tests;
