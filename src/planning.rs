//! Task importance, optional planning data and the single recommendation policy used by every client.
use crate::model::Task;
use crate::task_planning::{Effort, RelativeWorkBlock, SafetyBuffer, WorkBlock};
use chrono::{
    DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeZone, Utc,
};
use chrono_tz::Tz;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn default_zone() -> String {
    "America/New_York".into()
}
fn no(v: &bool) -> bool {
    !v
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Importance {
    Unimportant,
    VeryLow,
    Low,
    Normal,
    High,
    VeryHigh,
    Critical,
}
impl Importance {
    pub fn rank(self) -> i64 {
        match self {
            Self::Unimportant => 0,
            Self::VeryLow => 1,
            Self::Low => 2,
            Self::Normal => 3,
            Self::High => 4,
            Self::VeryHigh => 5,
            Self::Critical => 6,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Unimportant => "Unimportant",
            Self::VeryLow => "Very low",
            Self::Low => "Low",
            Self::Normal => "Normal",
            Self::High => "High",
            Self::VeryHigh => "Very high",
            Self::Critical => "Critical",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Clock {
    /// Local HH:MM. An optional time on the existing due_date; not a separate deadline.
    pub time: String,
    /// IANA timezone; defaults to America/New_York, independent of device timezone.
    #[serde(default = "default_zone")]
    pub timezone: String,
    /// Explicit UTC offset in minutes, only needed to disambiguate a repeated local time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utc_offset_minutes: Option<i32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Moment {
    /// Local calendar date YYYY-MM-DD. Without time, precision remains a whole day.
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(default = "default_zone")]
    pub timezone: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utc_offset_minutes: Option<i32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RelativeMoment {
    /// Calendar-day offset from this occurrence's scheduled date; -3660..3660.
    pub offset_days: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(default = "default_zone")]
    pub timezone: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanningField {
    // Accepted only to return an actionable rejection to legacy clients.
    #[schemars(skip)]
    Importance,
    DeadlineTime,
    StartBy,
    PlannedStart,
    PlannedFinish,
    StartedAt,
    EstimatedMinutes,
    Effort,
    NotBefore,
    SafetyBuffer,
    WorkBlocks,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Planning {
    /// Remaining active work in whole minutes; required with effort for committed work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<u32>,
    /// Demandingness, independent of duration and importance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety_buffer: Option<SafetyBuffer>,
    /// Earliest availability. Does not replace Start by or a planned block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before: Option<Moment>,
    /// Replacement block list: read current blocks first, retain IDs; [] clears all blocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_blocks: Option<Vec<WorkBlock>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_work_block_id: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importance: Option<Importance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_time: Option<Clock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_by: Option<Moment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_start: Option<Moment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_finish: Option<Moment>,
    #[serde(default, skip_serializing_if = "no")]
    pub started: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Moment>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PlanningPatch {
    /// Remaining active work in whole minutes; required with effort for committed work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<u32>,
    /// Demandingness, independent of duration and importance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety_buffer: Option<SafetyBuffer>,
    /// Earliest availability. Does not replace Start by or a planned block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before: Option<Moment>,
    /// Replacement block list: read current blocks first, retain IDs; [] clears all blocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_blocks: Option<Vec<WorkBlock>>,

    /// Required when creating a task; omit/null preserves on updates. Value/consequences independent of urgency. Use normal when no other level is supported; cannot be cleared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importance: Option<Importance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_time: Option<Clock>,
    /// Latest intended start, not a not-before date. Stops creating urgency once started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_by: Option<Moment>,
    /// Legacy alias for the designated original block. Prefer work_blocks; never mix both forms in one patch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_start: Option<Moment>,
    /// Legacy finish for the designated original block; does not replace additional blocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_finish: Option<Moment>,
    /// Confirm work actually began. False resets the marker and actual start time; never inferred from the clock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<bool>,
    /// Known actual start, optionally date-only. Supplying it confirms started; unknown time stays unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Moment>,
    /// Explicitly clear optional planning fields. Omitted/null values otherwise preserve existing data.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clear_planning: Vec<PlanningField>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RepeatPlanning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(skip)]
    pub legacy_work_block_id: Option<String>,
    /// Remaining active work in whole minutes; required with effort for committed work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<u32>,
    /// Demandingness, independent of duration and importance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety_buffer: Option<SafetyBuffer>,
    /// Earliest availability. Does not replace Start by or a planned block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before: Option<RelativeMoment>,
    /// Replacement block list: read current blocks first, retain IDs; [] clears all blocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_blocks: Option<Vec<RelativeWorkBlock>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Required on series creation. Omit/null preserves each existing segment on updates; cannot be cleared.
    pub importance: Option<Importance>,
    /// Requires due_offset_days. Local repeat times retain their wall-clock meaning across DST.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_time: Option<Clock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_by: Option<RelativeMoment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_start: Option<RelativeMoment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_finish: Option<RelativeMoment>,
    /// New planning defaults survive omission during template replacement. Clear them explicitly here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clear_planning: Vec<PlanningField>,
}

pub fn date(value: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .filter(|v| value.len() == 10 && !value.starts_with('-') && v.to_string() == value)
        .ok_or_else(|| "Use a valid calendar date YYYY-MM-DD".into())
}
fn time(value: &str) -> Result<NaiveTime, String> {
    NaiveTime::parse_from_str(value, "%H:%M")
        .ok()
        .filter(|v| v.format("%H:%M").to_string() == value)
        .ok_or_else(|| "Use a local time HH:MM".into())
}
fn zone(value: &str) -> Result<Tz, String> {
    value
        .parse()
        .map_err(|_| "Use an IANA timezone such as America/New_York".into())
}
fn choose(
    local: NaiveDateTime,
    tz: Tz,
    offset: Option<i32>,
    repeat: bool,
) -> Result<DateTime<Tz>, String> {
    let selected = match tz.from_local_datetime(&local) {
        LocalResult::Single(v) => v,
        LocalResult::Ambiguous(a, b) => {
            if let Some(n) = offset {
                [a, b]
                    .into_iter()
                    .find(|v| v.offset().fix().local_minus_utc() / 60 == n)
                    .ok_or_else(|| {
                        "UTC offset does not match this local time and timezone".to_string()
                    })?
            } else if repeat {
                a.min(b)
            } else {
                return Err(format!(
                    "{local} occurs twice in {tz}; supply utc_offset_minutes={} or {}",
                    a.offset().fix().local_minus_utc() / 60,
                    b.offset().fix().local_minus_utc() / 60
                ));
            }
        }
        LocalResult::None if repeat => {
            // Find the offsets on either side, including historical whole-day changes.
            let mut before = None;
            let mut after = None;
            for minute in 1..=2880 {
                if before.is_none() {
                    before = tz
                        .from_local_datetime(&(local - Duration::minutes(minute)))
                        .earliest();
                }
                if after.is_none() {
                    after = tz
                        .from_local_datetime(&(local + Duration::minutes(minute)))
                        .earliest();
                }
                if before.is_some() && after.is_some() {
                    break;
                }
            }
            let (Some(a), Some(b)) = (before, after) else {
                return Err("Cannot resolve timezone transition".into());
            };
            let gap = b.offset().fix().local_minus_utc() - a.offset().fix().local_minus_utc();
            tz.from_local_datetime(&(local + Duration::seconds(gap as i64)))
                .earliest()
                .ok_or("Cannot resolve timezone transition")?
        }
        LocalResult::None => {
            return Err(format!(
                "{local} does not exist in {tz} because the clock changes; choose a valid time"
            ));
        }
    };
    if offset.is_some_and(|n| selected.offset().fix().local_minus_utc() / 60 != n) {
        return Err("UTC offset does not match this local time and timezone".into());
    }
    Ok(selected)
}
impl Moment {
    pub fn bound(&self, end: bool) -> Result<DateTime<Utc>, String> {
        let mut d = date(&self.date)?;
        let tz = zone(&self.timezone)?;
        if self.time.is_none() && self.utc_offset_minutes.is_some() {
            return Err("UTC offset requires a time".into());
        }
        if self.time.is_none() && end {
            d = d.succ_opt().ok_or("Date overflow")?;
        }
        let t = self
            .time
            .as_deref()
            .map(time)
            .transpose()?
            .unwrap_or(NaiveTime::MIN);
        choose(
            d.and_time(t),
            tz,
            self.utc_offset_minutes,
            self.time.is_none(),
        )
        .map(|x| x.with_timezone(&Utc))
    }
    pub fn recurring(mut self) -> Result<(Self, Option<String>), String> {
        let Some(ref clock) = self.time else {
            self.bound(false)?;
            return Ok((self, None));
        };
        let local = date(&self.date)?.and_time(time(clock)?);
        let tz = zone(&self.timezone)?;
        let actual = choose(local, tz, None, true)?;
        let adjustment = match tz.from_local_datetime(&local) {
            LocalResult::Single(_) => None,
            LocalResult::None => Some(format!(
                "{} {} {} shifts to {} for the clock change",
                self.date,
                clock,
                self.timezone,
                actual.format("%Y-%m-%d %H:%M")
            )),
            LocalResult::Ambiguous(..) => Some(format!(
                "{} {} {} uses the earlier occurrence of this repeated time",
                self.date, clock, self.timezone
            )),
        };
        self.date = actual.date_naive().to_string();
        self.time = Some(actual.format("%H:%M").to_string());
        self.utc_offset_minutes =
            if matches!(tz.from_local_datetime(&local), LocalResult::Ambiguous(..)) {
                Some(actual.offset().fix().local_minus_utc() / 60)
            } else {
                None
            };
        Ok((self, adjustment))
    }
}
impl Clock {
    pub fn on(&self, date: &str) -> Moment {
        Moment {
            date: date.into(),
            time: Some(self.time.clone()),
            timezone: self.timezone.clone(),
            utc_offset_minutes: self.utc_offset_minutes,
        }
    }
}
impl RelativeMoment {
    pub fn on(&self, d: &str) -> Result<Moment, String> {
        if self.offset_days.unsigned_abs() > 3660 {
            return Err("Planning offsets must be within 3660 days".into());
        }
        Ok(Moment {
            date: date(d)?
                .checked_add_signed(Duration::days(self.offset_days as i64))
                .ok_or("Date overflow")?
                .to_string(),
            time: self.time.clone(),
            timezone: self.timezone.clone(),
            utc_offset_minutes: None,
        })
    }
}
impl PlanningPatch {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
    pub fn apply(&self, p: &mut Planning) -> Result<(), String> {
        macro_rules! set {
            ($field:ident,$variant:ident) => {{
                let clear = self.clear_planning.contains(&PlanningField::$variant);
                if clear && self.$field.is_some() {
                    return Err(concat!("Cannot set and clear ", stringify!($field)).into());
                }
                if clear {
                    p.$field = None;
                } else if let Some(v) = &self.$field {
                    p.$field = Some(v.clone());
                }
            }};
        }
        reject_importance_clear(&self.clear_planning)?;
        if let Some(importance) = self.importance {
            p.importance = Some(importance);
        }
        set!(estimated_minutes, EstimatedMinutes);
        set!(effort, Effort);
        set!(not_before, NotBefore);
        set!(safety_buffer, SafetyBuffer);
        self.apply_blocks(p)?;
        set!(deadline_time, DeadlineTime);
        set!(start_by, StartBy);

        set!(started_at, StartedAt);
        if self.started == Some(false) && self.started_at.is_some() {
            return Err("Cannot reset started and supply an actual start together".into());
        }
        if let Some(v) = self.started {
            p.started = v;
            if !v {
                p.started_at = None;
            }
        }
        if self.started_at.is_some() {
            p.started = true;
        }
        Ok(())
    }
}
impl Planning {
    pub fn deadline(&self, d: Option<&str>) -> Option<Moment> {
        d.map(|d| {
            self.deadline_time
                .as_ref()
                .map(|c| c.on(d))
                .unwrap_or(Moment {
                    date: d.into(),
                    time: None,
                    timezone: default_zone(),
                    utc_offset_minutes: None,
                })
        })
    }
    pub fn validate(&self, due: Option<&str>) -> Result<(), String> {
        if self.deadline_time.is_some() && due.is_none() {
            return Err("deadline_time requires due_date".into());
        }
        self.validate_extensions(due)?;
        for m in [
            self.not_before.clone(),
            self.deadline(due),
            self.start_by.clone(),
            self.planned_start.clone(),
            self.planned_finish.clone(),
            self.started_at.clone(),
        ]
        .iter()
        .flatten()
        {
            m.bound(false)?;
            m.bound(true)?;
        }
        if let Some(end) = &self.planned_finish {
            let start = self
                .planned_start
                .as_ref()
                .ok_or("Planned finish requires planned start")?;
            if start.time.is_some() != end.time.is_some() {
                return Err(
                    "Planned start and finish must both be date-only or both include time".into(),
                );
            }
            if end.bound(true)? <= start.bound(false)? {
                return Err("Planned finish must follow planned start".into());
            }
        }
        if self.started_at.is_some() && !self.started {
            return Err("Actual start requires the started marker".into());
        }
        if self
            .started_at
            .as_ref()
            .is_some_and(|v| v.bound(false).is_ok_and(|d| d > crate::clock::now()))
        {
            return Err("Actual start cannot be in the future".into());
        }
        Ok(())
    }
}
impl RepeatPlanning {
    pub fn merge(&self, base: &Self) -> Result<Self, String> {
        reject_importance_clear(&self.clear_planning)?;
        let mut out = self.clone();
        macro_rules! field {
            ($field:ident,$variant:ident) => {
                if self.clear_planning.contains(&PlanningField::$variant) {
                    if self.$field.is_some() {
                        return Err(concat!("Cannot set and clear ", stringify!($field)).into());
                    }
                    out.$field = None;
                } else if out.$field.is_none() {
                    out.$field = base.$field.clone();
                }
            };
        }
        field!(importance, Importance);
        field!(deadline_time, DeadlineTime);
        field!(start_by, StartBy);
        field!(estimated_minutes, EstimatedMinutes);
        field!(effort, Effort);
        field!(not_before, NotBefore);
        field!(safety_buffer, SafetyBuffer);
        field!(work_blocks, WorkBlocks);
        field!(planned_start, PlannedStart);
        field!(planned_finish, PlannedFinish);
        out.merge_blocks(self, base)?;
        if self.clear_planning.contains(&PlanningField::StartedAt) {
            return Err("Started is per occurrence, not a recurring default".into());
        }
        out.clear_planning.clear();
        Ok(out)
    }
    pub fn materialize(
        &self,
        d: &str,
        due: Option<&str>,
    ) -> Result<(Planning, Vec<String>), String> {
        let mut p = Planning {
            importance: self.importance,
            estimated_minutes: self.estimated_minutes,
            effort: self.effort,
            safety_buffer: self.safety_buffer.clone(),
            legacy_work_block_id: self.legacy_work_block_id.clone(),
            ..Planning::default()
        };
        let mut adjustments = vec![];
        for (field, relative) in [
            ("start_by", &self.start_by),
            ("not_before", &self.not_before),
            ("planned_start", &self.planned_start),
            ("planned_finish", &self.planned_finish),
        ] {
            if let Some(v) = relative {
                let (v, note) = v.on(d)?.recurring()?;
                if let Some(note) = note {
                    adjustments.push(format!("{field}: {note}"));
                }
                match field {
                    "start_by" => p.start_by = Some(v),
                    "not_before" => p.not_before = Some(v),
                    "planned_start" => p.planned_start = Some(v),
                    _ => p.planned_finish = Some(v),
                }
            }
        }
        if let Some(clock) = &self.deadline_time {
            let due = due.ok_or("deadline_time requires due_offset_days")?;
            let (value, note) = clock.on(due).recurring()?;
            // Calendar repeats normally shift within their scheduled deadline day.
            if value.date != due {
                return Err("Timezone transition moves deadline to another date; use an occurrence exception".into());
            }
            if let Some(note) = note {
                adjustments.push(format!("deadline_time: {note}"));
            }
            p.deadline_time = Some(Clock {
                time: value.time.unwrap(),
                timezone: value.timezone,
                utc_offset_minutes: value.utc_offset_minutes,
            });
        }
        if let Some(blocks) = &self.work_blocks {
            let mut result = Vec::new();
            for b in blocks {
                let (start, note) = b.start.on(d)?.recurring()?;
                if let Some(note) = note {
                    adjustments.push(format!("block {}: {note}", b.id));
                }
                let finish = b
                    .finish
                    .as_ref()
                    .map(|v| v.on(d)?.recurring())
                    .transpose()?;
                if let Some((_, Some(note))) = &finish {
                    adjustments.push(format!("block {}: {note}", b.id));
                }
                result.push(WorkBlock {
                    id: b.id.clone(),
                    start,
                    finish: finish.map(|(v, _)| v),
                    calendar_event: None,
                });
            }
            p.work_blocks = Some(result);
        }
        p.normalize_blocks();
        if let Some((_, Some(note))) = p.buffer_target(due)? {
            adjustments.push(format!("buffer target: {note}"));
        }
        Ok((p, adjustments))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Recommendation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_task_id: Option<String>,
    pub reason: String,
    pub evaluated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_change_at: Option<String>,
    #[serde(skip)]
    pub key: String,
}
fn stamp(v: DateTime<Utc>) -> String {
    v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
impl Task {
    pub(crate) fn timing_constraints(&self) -> [(&'static str, Option<Moment>); 2] {
        [
            ("Deadline", self.planning.deadline(self.due_date.as_deref())),
            (
                "Start by",
                if self.planning.started {
                    None
                } else {
                    self.planning.start_by.clone()
                },
            ),
        ]
    }
}
impl WorkBlock {
    pub(crate) fn bounds(&self) -> Result<(DateTime<Utc>, DateTime<Utc>), String> {
        let start = self.start.bound(false)?;
        let end = match &self.finish {
            Some(finish) => finish.bound(true)?,
            None => Moment {
                time: None,
                utc_offset_minutes: None,
                ..self.start.clone()
            }
            .bound(true)?,
        };
        Ok((start, end))
    }
}

pub fn evaluate(t: &Task, now: DateTime<Utc>) -> Recommendation {
    let p = &t.planning;
    let importance = p.importance.map_or(3, Importance::rank);
    let mut boundaries = vec![];
    let constraints = t.timing_constraints();
    let mut earliest: Option<(DateTime<Utc>, &str)> = None;
    let mut immediate = false;
    for (label, m) in constraints
        .iter()
        .filter_map(|(l, m)| m.as_ref().map(|m| (*l, m)))
    {
        if let Ok(end) = m.bound(true) {
            if earliest.is_none_or(|(d, _)| end < d) {
                earliest = Some((end, label));
            }
            let today = date(&m.date).is_ok_and(|d| {
                zone(&m.timezone).is_ok_and(|tz| now.with_timezone(&tz).date_naive() >= d)
            });
            if end <= now
                || (m.time.is_some() && end <= now + Duration::hours(2))
                || (m.time.is_none() && today)
            {
                immediate = true;
            }
            boundaries.extend([
                end - Duration::days(7),
                end - Duration::hours(48),
                end - Duration::hours(2),
                end,
            ]);
            if m.time.is_none()
                && let Ok(begin) = m.bound(false)
            {
                boundaries.push(begin);
            }
        }
    }
    if let Some(available) = p.not_before.as_ref().and_then(|m| m.bound(false).ok()) {
        boundaries.push(available);
    }
    let current_blocks: Vec<_> = p
        .blocks()
        .iter()
        .filter_map(|b| {
            let (a, end) = b.bounds().ok()?;
            boundaries.extend([a, end]);
            (a <= now && now < end).then_some((a, end))
        })
        .collect();
    let block = current_blocks.into_iter().min_by_key(|(_, end)| *end);
    let in_block = block.is_some();
    // Targets boost remaining work, but never masquerade as immediate deadlines.
    let mut planning_constraint = earliest;
    if let Ok(Some((target, _))) = p.buffer_target(t.due_date.as_deref())
        && let Ok(end) = target.bound(true)
    {
        boundaries.extend([end - Duration::days(7), end - Duration::hours(48), end]);
        if planning_constraint.is_none_or(|(d, _)| end < d) {
            planning_constraint = Some((end, "Buffer target"));
        }
    }
    let boost = planning_constraint.map_or(0, |(d, _)| {
        if d <= now + Duration::hours(48) {
            2
        } else if d <= now + Duration::days(7) {
            1
        } else {
            0
        }
    });
    let group = if immediate {
        0
    } else if in_block {
        1
    } else {
        2
    };
    let value = if group < 2 {
        importance
    } else {
        importance + boost
    };
    let tie = if group == 1 {
        block.map(|(_, b)| b)
    } else if group == 2 {
        planning_constraint.map(|(d, _)| d)
    } else {
        earliest.map(|(d, _)| d)
    }
    .map_or(999_999_999_999_999, |d| {
        d.timestamp_millis() + 100_000_000_000_000
    });
    let reason = if immediate {
        format!(
            "{} {}",
            earliest.map_or("Timing", |(_, l)| l),
            if earliest.is_some_and(|(d, _)| d <= now) {
                "overdue"
            } else {
                "due soon"
            }
        )
    } else if in_block {
        "Planned now".into()
    } else if boost > 0 {
        format!(
            "{} importance · approaching {}",
            p.importance.unwrap_or(Importance::Normal).label(),
            planning_constraint.unwrap().1.to_lowercase()
        )
    } else {
        p.importance
            .map_or("Normal ranking · importance unset".into(), |i| {
                format!("{} importance", i.label())
            })
    };
    Recommendation {
        source_task_id: None,
        reason,
        evaluated_at: stamp(now),
        next_change_at: boundaries.into_iter().filter(|d| *d > now).min().map(stamp),
        key: format!("{group}:{:02}:{:02}:{tie:015}", 8 - value, 6 - importance),
    }
}
pub fn due_key(t: &Task) -> i64 {
    t.planning
        .deadline(t.due_date.as_deref())
        .and_then(|m| m.bound(true).ok())
        .map_or(i64::MAX, |d| d.timestamp_millis())
}
pub fn register(c: &rusqlite::Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    c.create_scalar_function("gtd_rank", 2, flags, |ctx| {
        let t: Task = serde_json::from_str(&ctx.get::<String>(0)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
        let now = DateTime::parse_from_rfc3339(&ctx.get::<String>(1)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?
            .with_timezone(&Utc);
        Ok(evaluate(&t, now).key)
    })?;
    c.create_scalar_function("gtd_next", 2, flags, |ctx| {
        let t: Task = serde_json::from_str(&ctx.get::<String>(0)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
        let now = DateTime::parse_from_rfc3339(&ctx.get::<String>(1)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?
            .with_timezone(&Utc);
        Ok(evaluate(&t, now).next_change_at)
    })?;
    c.create_scalar_function("gtd_due", 1, flags, |ctx| {
        let t: Task = serde_json::from_str(&ctx.get::<String>(0)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
        Ok(due_key(&t))
    })?;
    c.create_scalar_function("gtd_importance", 1, flags, |ctx| {
        let t: Task = serde_json::from_str(&ctx.get::<String>(0)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
        Ok(t.planning.importance.map_or(3, Importance::rank))
    })?;
    c.create_scalar_function("gtd_availability_next", 2, flags, |ctx| {
        let t: Task = serde_json::from_str(&ctx.get::<String>(0)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
        let now = DateTime::parse_from_rfc3339(&ctx.get::<String>(1)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?
            .with_timezone(&Utc);
        Ok(t.planning
            .not_before
            .as_ref()
            .and_then(|m| m.bound(false).ok())
            .filter(|at| *at > now)
            .map(stamp))
    })?;
    c.create_scalar_function("gtd_effort", 1, flags, |ctx| {
        let t: Task = serde_json::from_str(&ctx.get::<String>(0)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
        Ok(t.planning.effort.map(|v| v.rank()))
    })?;
    c.create_scalar_function("gtd_planned_match", 3, flags, |ctx| {
        let t: Task = serde_json::from_str(&ctx.get::<String>(0)?)
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
        let from: Option<String> = ctx.get(1)?;
        let through: Option<String> = ctx.get(2)?;
        Ok(t.planning.blocks().iter().any(|b| {
            from.as_ref()
                .is_none_or(|v| b.finish.as_ref().unwrap_or(&b.start).date >= *v)
                && through.as_ref().is_none_or(|v| b.start.date <= *v)
        }))
    })?;
    Ok(())
}

/// Capture inputs and new recurrence templates require importance; update patches
/// and immutable historical snapshots retain their omission semantics.
pub fn require_importance(schema: &mut schemars::Schema) {
    let object = schema.ensure_object();
    let required = object
        .entry("required")
        .or_insert_with(|| serde_json::json!([]));
    if let Some(required) = required.as_array_mut()
        && !required.contains(&serde_json::json!("importance"))
    {
        required.push(serde_json::json!("importance"));
    }
    let mut importance = schemars::schema_for!(Importance);
    importance.ensure_object().insert(
        "description".into(),
        serde_json::json!("Required task importance, independent of urgency. Use normal when context does not support another level; critical requires exceptional stakes."),
    );
    object
        .get_mut("properties")
        .and_then(|v| v.as_object_mut())
        .unwrap()
        .insert(
            "importance".into(),
            serde_json::to_value(importance).expect("importance schema"),
        );
}
fn reject_importance_clear(fields: &[PlanningField]) -> Result<(), String> {
    if fields.contains(&PlanningField::Importance) {
        return Err(
            "Importance is required and cannot be cleared; choose one of its seven levels".into(),
        );
    }
    Ok(())
}
