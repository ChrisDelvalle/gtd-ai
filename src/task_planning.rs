//! Planning additions shared by validation, recurrence and recommendation reads.
use crate::{
    model::TaskLink,
    planning::{Moment, RelativeMoment},
};
use chrono::{Duration, Timelike};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    Trivial,
    Low,
    Medium,
    High,
    Extreme,
}
impl Effort {
    pub fn rank(self) -> u8 {
        self as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BufferUnit {
    Days,
    Hours,
    Minutes,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SafetyBuffer {
    /// Positive calendar days, or elapsed hours/minutes for a timed deadline.
    pub value: u32,
    pub unit: BufferUnit,
}
impl SafetyBuffer {
    pub fn target(&self, deadline: &Moment) -> Result<(Moment, Option<String>), String> {
        if self.value == 0 || self.value > 5256000 {
            return Err("Buffer must be positive and at most 5256000 units".into());
        }
        if self.unit == BufferUnit::Days {
            if self.value > 3660 {
                return Err("Calendar-day buffer must be at most 3660 days".into());
            }
            let date = crate::planning::date(&deadline.date)?
                .checked_sub_signed(Duration::days(self.value.into()))
                .ok_or("Buffer date overflow")?;
            return Moment {
                date: date.to_string(),
                utc_offset_minutes: None,
                ..deadline.clone()
            }
            .recurring();
        }
        if deadline.time.is_none() {
            return Err("Hour/minute buffers require a timed deadline; use calendar days for a date-only deadline".into());
        }
        let minutes = i64::from(self.value)
            * if self.unit == BufferUnit::Hours {
                60
            } else {
                1
            };
        if minutes > 5256000 {
            return Err("Buffer must be at most ten years".into());
        }
        let instant = deadline
            .bound(false)?
            .checked_sub_signed(Duration::minutes(minutes))
            .ok_or("Buffer time overflow")?;
        let tz: chrono_tz::Tz = deadline.timezone.parse().map_err(|_| "Invalid timezone")?;
        let local = instant.with_timezone(&tz);
        use chrono::Offset;
        Ok((
            Moment {
                date: local.date_naive().to_string(),
                time: Some(format!("{:02}:{:02}", local.hour(), local.minute())),
                timezone: deadline.timezone.clone(),
                utc_offset_minutes: Some(local.offset().fix().local_minus_utc() / 60),
            },
            None,
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkBlock {
    /// Stable identifier. Omit on creation; retain returned IDs when replacing the list.
    #[serde(default)]
    pub id: String,
    pub start: Moment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish: Option<Moment>,
    /// Reference only; this service does not synchronize the event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_event: Option<TaskLink>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RelativeWorkBlock {
    #[serde(default)]
    pub id: String,
    pub start: RelativeMoment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish: Option<RelativeMoment>,
    // Event references belong to specific occurrences, never every repeat.
}
pub fn validate_block(block: &WorkBlock) -> Result<(), String> {
    block.start.bound(false)?;
    if let Some(end) = &block.finish {
        if end.time.is_some() != block.start.time.is_some() {
            return Err(
                "Work block start and finish must have matching date/time precision".into(),
            );
        }
        if end.bound(true)? <= block.start.bound(false)? {
            return Err("Work block finish must follow its start".into());
        }
    }
    if block.id.is_empty() || block.id.len() > 80 {
        return Err("Work block ID must contain 1–80 characters".into());
    }
    if let Some(link) = &block.calendar_event
        && (!crate::model::valid_resource_url(&link.url)
            || link.label.as_ref().is_some_and(|v| v.chars().count() > 120))
    {
        return Err("Invalid calendar event reference".into());
    }
    Ok(())
}
pub fn validate_estimates(
    minutes: Option<u32>,
    effort: Option<Effort>,
    status: crate::model::Status,
    archived: bool,
) -> Result<(), String> {
    if minutes.is_some_and(|n| n > 5256000) {
        return Err("Estimated minutes must be between zero and 5256000".into());
    }
    if !archived
        && matches!(
            status,
            crate::model::Status::Next
                | crate::model::Status::Blocked
                | crate::model::Status::Planned
                | crate::model::Status::Waiting
        )
        && (minutes.is_none() || effort.is_none())
    {
        return Err("Committed tasks require estimated_minutes (remaining active work) and effort; capture an unclarified item in Inbox or supply both estimates".into());
    }
    Ok(())
}

use crate::planning::{Planning, PlanningField, PlanningPatch, RepeatPlanning};
impl Planning {
    pub fn blocks(&self) -> Vec<WorkBlock> {
        self.work_blocks.clone().unwrap_or_else(|| {
            self.planned_start
                .as_ref()
                .map(|start| {
                    vec![WorkBlock {
                        id: "legacy".into(),
                        start: start.clone(),
                        finish: self.planned_finish.clone(),
                        calendar_event: None,
                    }]
                })
                .unwrap_or_default()
        })
    }
    pub fn normalize_blocks(&mut self) {
        if self.work_blocks.is_none() && self.planned_start.is_some() {
            self.work_blocks = Some(self.blocks());
            self.legacy_work_block_id = Some("legacy".into());
        }
        if let Some(blocks) = &mut self.work_blocks {
            for b in blocks.iter_mut() {
                if b.id.is_empty() {
                    b.id = uuid::Uuid::new_v4().to_string();
                }
            }
        }
        self.sync_legacy_block();
    }
    pub fn sync_legacy_block(&mut self) {
        if let Some(blocks) = &self.work_blocks {
            if self.legacy_work_block_id.is_none() {
                self.legacy_work_block_id = blocks.first().map(|b| b.id.clone());
            }
            let block = blocks
                .iter()
                .find(|b| Some(&b.id) == self.legacy_work_block_id.as_ref());
            self.planned_start = block.map(|b| b.start.clone());
            self.planned_finish = block.and_then(|b| b.finish.clone());
        }
    }
    pub fn buffer_target(
        &self,
        due: Option<&str>,
    ) -> Result<Option<(Moment, Option<String>)>, String> {
        self.safety_buffer
            .as_ref()
            .map(|buffer| {
                buffer.target(
                    &self
                        .deadline(due)
                        .ok_or("Safety buffer requires a deadline")?,
                )
            })
            .transpose()
    }
    pub fn unavailable_at(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        self.not_before
            .as_ref()
            .is_some_and(|m| m.bound(false).is_ok_and(|v| v > now))
    }
    pub fn validate_extensions(&self, due: Option<&str>) -> Result<(), String> {
        if self.estimated_minutes.is_some_and(|n| n > 5256000) {
            return Err("Estimated minutes must be at most 5256000".into());
        }
        self.buffer_target(due)?;
        let blocks = self.blocks();
        if blocks.len() > 100 {
            return Err("A task supports at most 100 work blocks".into());
        }
        let mut ids = std::collections::HashSet::new();
        for b in &blocks {
            validate_block(b)?;
            if !ids.insert(&b.id) {
                return Err("Work block IDs must be distinct".into());
            }
        }
        Ok(())
    }
}
impl PlanningPatch {
    pub fn apply_blocks(&self, p: &mut Planning) -> Result<(), String> {
        let legacy = self.planned_start.is_some()
            || self.planned_finish.is_some()
            || self.clear_planning.iter().any(|f| {
                matches!(
                    f,
                    PlanningField::PlannedStart | PlanningField::PlannedFinish
                )
            });
        let clear = self.clear_planning.contains(&PlanningField::WorkBlocks);
        if (self.work_blocks.is_some() || clear) && legacy {
            return Err("Use work_blocks or legacy planned_start/planned_finish, not both".into());
        }
        if clear && self.work_blocks.is_some() {
            return Err("Cannot set and clear work_blocks".into());
        }
        p.normalize_blocks();
        if let Some(blocks) = &self.work_blocks {
            p.work_blocks = Some(blocks.clone());
        }
        if clear {
            p.work_blocks = Some(vec![]);
        }
        if legacy {
            let id = p
                .legacy_work_block_id
                .clone()
                .unwrap_or_else(|| "legacy".into());
            let mut blocks = p.blocks();
            let at = blocks.iter().position(|b| b.id == id);
            let mut start = at.map(|i| blocks[i].start.clone());
            let mut finish = at.and_then(|i| blocks[i].finish.clone());
            if self.clear_planning.contains(&PlanningField::PlannedStart) {
                if self.planned_start.is_some() {
                    return Err("Cannot set and clear planned_start".into());
                }
                start = None;
                finish = None;
            } else if let Some(v) = &self.planned_start {
                start = Some(v.clone());
            }
            if self.clear_planning.contains(&PlanningField::PlannedFinish) {
                if self.planned_finish.is_some() {
                    return Err("Cannot set and clear planned_finish".into());
                }
                finish = None;
            } else if let Some(v) = &self.planned_finish {
                finish = Some(v.clone());
            }
            if finish.is_some() && start.is_none() {
                return Err("Planned finish requires planned start".into());
            }
            let reference = at.and_then(|i| blocks[i].calendar_event.clone());
            if let Some(i) = at {
                blocks.remove(i);
            }
            if let Some(start) = start {
                blocks.insert(
                    at.unwrap_or(blocks.len()),
                    WorkBlock {
                        id: id.clone(),
                        start,
                        finish,
                        calendar_event: reference,
                    },
                );
            }
            p.legacy_work_block_id = Some(id);
            p.work_blocks = Some(blocks);
        }
        p.normalize_blocks();
        Ok(())
    }
}
impl RepeatPlanning {
    pub fn merge_blocks(&mut self, patch: &Self, base: &Self) -> Result<(), String> {
        let legacy = patch.planned_start.is_some()
            || patch.planned_finish.is_some()
            || patch.clear_planning.iter().any(|f| {
                matches!(
                    f,
                    PlanningField::PlannedStart | PlanningField::PlannedFinish
                )
            });
        let modern = patch.work_blocks.is_some()
            || patch.clear_planning.contains(&PlanningField::WorkBlocks);
        if legacy && modern {
            return Err("Use work_blocks or legacy planned fields, not both".into());
        }
        if patch.clear_planning.contains(&PlanningField::WorkBlocks) {
            self.work_blocks = Some(vec![]);
        }
        if self.work_blocks.is_none() && self.planned_start.is_some() {
            self.work_blocks = Some(vec![RelativeWorkBlock {
                id: "legacy".into(),
                start: self.planned_start.clone().unwrap(),
                finish: self.planned_finish.clone(),
            }]);
        }
        if legacy
            && ((patch.clear_planning.contains(&PlanningField::PlannedStart)
                && patch.planned_finish.is_some())
                || (!patch.clear_planning.contains(&PlanningField::PlannedStart)
                    && self.planned_finish.is_some()
                    && self.planned_start.is_none()))
        {
            return Err("Planned finish requires planned start".into());
        }
        if legacy && base.work_blocks.is_some() {
            let mut blocks = base.work_blocks.clone().unwrap();
            let id = base.legacy_work_block_id.as_deref().unwrap_or("legacy");
            let at = blocks.iter().position(|b| b.id == id);
            if let Some(i) = at {
                blocks.remove(i);
            }
            if patch.clear_planning.contains(&PlanningField::PlannedStart) {
                self.planned_start = None;
                self.planned_finish = None;
            }
            if let Some(start) = &self.planned_start {
                blocks.insert(
                    at.unwrap_or(blocks.len()),
                    RelativeWorkBlock {
                        id: id.into(),
                        start: start.clone(),
                        finish: self.planned_finish.clone(),
                    },
                );
            }
            self.work_blocks = Some(blocks);
        }
        self.legacy_work_block_id = base.legacy_work_block_id.clone();
        if let Some(blocks) = &mut self.work_blocks {
            if blocks.len() > 100 {
                return Err("At most 100 recurring work blocks are supported".into());
            }
            let mut ids = std::collections::HashSet::new();
            for b in blocks.iter_mut() {
                if b.id.is_empty() {
                    b.id = uuid::Uuid::new_v4().to_string();
                }
                if !ids.insert(&b.id) {
                    return Err("Work block IDs must be distinct".into());
                }
            }
            if self.legacy_work_block_id.is_none() {
                self.legacy_work_block_id = blocks.first().map(|b| b.id.clone());
            }
            let b = blocks
                .iter()
                .find(|b| Some(&b.id) == self.legacy_work_block_id.as_ref());
            self.planned_start = b.map(|b| b.start.clone());
            self.planned_finish = b.and_then(|b| b.finish.clone());
        }
        Ok(())
    }
}
