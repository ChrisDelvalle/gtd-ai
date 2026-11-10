use crate::model::{Status, TaskLink, TaskStatus};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepeatRule {
    pub start_date: String,
    pub frequency: Frequency,
    #[serde(default = "one")]
    pub interval: u16,
    /// Weekly days: MO,TU,WE,TH,FR,SA,SU. Monthly supports one day with ordinal.
    #[serde(default)]
    pub weekdays: Vec<String>,
    /// Monthly day 1..31; omitted uses the start date's day. Invalid dates are omitted.
    pub month_day: Option<u8>,
    /// Monthly weekday ordinal: 1..4 or -1 (last); requires one weekday.
    pub ordinal: Option<i8>,
    pub until: Option<String>,
    pub count: Option<u32>,
}
fn one() -> u16 {
    1
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Template {
    #[serde(default, flatten)]
    pub planning: crate::planning::RepeatPlanning,
    pub title: String,
    /// Human-readable description; supports lightweight Markdown. Up to 10000 characters.
    #[serde(default)]
    pub notes: String,
    /// Agent working notes. Omit/null preserves on template updates; empty clears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_notes: Option<String>,
    /// Short human brief. Omit/null preserves each existing default independently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(default)]
    pub links: Vec<TaskLink>,
    pub location: Option<String>,
    pub project_id: Option<String>,
    /// Deadline/review offset from scheduled date. Omit when no actual deadline/review is intended.
    pub due_offset_days: Option<i32>,
    pub review_offset_days: Option<i32>,
    #[serde(default = "next")]
    #[schemars(with = "TaskStatus")]
    pub status: Status,
}
fn next() -> Status {
    Status::Next
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Segment {
    /// Stable internal segment lineage for authoring comparisons; never accepted in inputs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_key: Option<String>,
    pub from: String,
    pub rule: RepeatRule,
    pub template: Template,
    #[serde(default)]
    pub replacements: std::collections::BTreeMap<String, String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Pause {
    pub from: String,
    pub through: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Series {
    /// Calendar zone pinned when the series is created. Historical series remain
    /// in New York even if the account default later changes.
    #[serde(
        default = "legacy_series_timezone",
        skip_serializing_if = "is_legacy_series_timezone"
    )]
    pub timezone: String,
    pub segments: Vec<Segment>,
    pub pauses: Vec<Pause>,
    pub ended_on: Option<String>,
}
pub(crate) const LEGACY_SERIES_TIMEZONE: &str = "America/New_York";
fn legacy_series_timezone() -> String {
    LEGACY_SERIES_TIMEZONE.into()
}
fn is_legacy_series_timezone(value: &str) -> bool {
    value == LEGACY_SERIES_TIMEZONE
}
impl Series {
    pub fn date_at(&self, at: chrono::DateTime<chrono::Utc>) -> Result<String, String> {
        let zone: chrono_tz::Tz = self
            .timezone
            .parse()
            .map_err(|_| "Invalid recurring calendar timezone")?;
        Ok(at.with_timezone(&zone).date_naive().to_string())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Occurrence {
    pub series_id: String,
    pub original_date: String,
    pub scheduled_date: String,
    #[serde(default)]
    pub skipped: bool,
    #[serde(default)]
    pub overrides: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateRecurrence {
    pub request_id: String,
    /// Adopt this existing unfinished task as the first occurrence, retaining its ID/history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_task_version: Option<i64>,
    #[schemars(with = "NewTemplate")]
    pub template: Template,
    pub rule: RepeatRule,
    pub reason: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    This,
    Following,
    All,
    Segment,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepeatAction {
    Edit,
    Skip,
    Unskip,
    Pause,
    Resume,
    End,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateRecurrence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_from: Option<String>,
    pub request_id: String,
    pub series_id: String,
    pub expected_version: i64,
    /// Edits: this/following/all. Skip/unskip: this. Pause/resume/end: all.
    pub scope: Scope,
    pub action: RepeatAction,
    /// Required for this/following scope; immutable original date identifies the occurrence after rescheduling. Omit for all.
    pub original_date: Option<String>,
    pub expected_occurrence_version: Option<i64>,
    /// Replacement rule, not a partial patch; read the current series first.
    pub rule: Option<RepeatRule>,
    /// Replacement defaults, not a partial patch; read current defaults first. Omitted agent_notes and new planning fields preserve; clear_planning clears planning explicitly.
    pub template: Option<Template>,
    /// This-occurrence rescheduling only. Does not shift the repeat schedule.
    pub scheduled_date: Option<String>,
    /// Update working notes only within the selected scope, without replacing task defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_notes: Option<String>,
    /// Short human brief. Omit/null preserves each existing default independently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ListOccurrences {
    #[serde(skip_deserializing, default, skip_serializing_if = "is_false")]
    #[schemars(skip)]
    pub agent_context: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub segments_only: bool,
    /// Optional defaults with rule to preview resolved timing and DST adjustments before saving.
    #[serde(default, deserialize_with = "preview_template")]
    #[schemars(with = "Option<PreviewTemplate>")]
    pub template: Option<Template>,
    /// Read one series; omit both series_id and rule to list series summaries.
    pub series_id: Option<String>,
    /// Supply rule for a read-only preview before creating a series.
    pub rule: Option<RepeatRule>,
    /// Inclusive scheduled-date lower bound, default today in America/New_York. Use an earlier date for missed/past occurrences; requires series_id or rule.
    pub from: Option<String>,
    /// Inclusive scheduled-date upper bound; requires series_id or rule.
    pub through: Option<String>,
    /// Pass returned next_cursor here with unchanged selectors/filters. Omit on refresh.
    pub cursor: Option<String>,
    /// Page size: default 20, maximum 100.
    pub limit: Option<u32>,
    /// Include agent notes in the full first-page series; summary rows remain compact.
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_agent_notes: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Schema for creating defaults; the shared Template also represents update
/// patches and historical snapshots, where importance may be absent.
pub struct NewTemplate;
impl JsonSchema for NewTemplate {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "NewTemplate".into()
    }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let mut schema = Template::json_schema(generator);
        crate::planning::require_importance(&mut schema);
        schema
    }
}

/// Timing previews carry no authoring claims and are never persisted.
fn preview_template<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Template>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    v.map(|mut v| {
        if let Some(o) = v.as_object_mut() {
            o.entry("title").or_insert(serde_json::json!(""));
        }
        serde_json::from_value(v).map_err(serde::de::Error::custom)
    })
    .transpose()
}
pub struct PreviewTemplate;
impl JsonSchema for PreviewTemplate {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "PreviewTemplate".into()
    }
    fn json_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let mut s = Template::json_schema(g);
        s.as_object_mut().unwrap().remove("required");
        s
    }
}
