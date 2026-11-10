//! Read-only priority facts. Stored fields, graph propagation and display filters
//! remain separate; every key uses one caller-supplied evaluation time.
use crate::{
    model::{EntityType, Status, Task},
    planning::{Importance, Moment, Recommendation},
};
use chrono::{DateTime, Duration, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const POLICY: &str = "priority-v4";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Source {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectDeadline {
    pub deadline: Moment,
    pub source: Source,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Facts {
    pub deadline: Option<Moment>,
    pub project: Option<Source>,
    pub fallback: Option<ProjectDeadline>,
}

pub(crate) fn committed(t: &Task) -> bool {
    t.entity_type == EntityType::Task
        && !t.deleted
        && !t.archived
        && !t.occurrence.as_ref().is_some_and(|o| o.skipped)
        && matches!(t.status, Status::Next | Status::Blocked | Status::Waiting)
}

pub(crate) fn resolve(t: &Task, project: Option<&Task>) -> Facts {
    let own = t.planning.deadline(t.due_date.as_deref());
    let parent = project.filter(|p| {
        committed(t)
            && t.project_id.as_deref() == Some(&p.id)
            && p.entity_type == EntityType::Project
            && p.status == Status::Active
            && !p.deleted
            && !p.archived
    });
    let fallback = parent.and_then(|p| {
        p.planning
            .deadline(p.due_date.as_deref())
            .map(|deadline| ProjectDeadline {
                deadline,
                source: Source {
                    id: p.id.clone(),
                    title: p.title.clone(),
                },
            })
    });
    let inherited = t.due_date.is_none();
    let deadline = if inherited {
        fallback.as_ref().map(|f| f.deadline.clone())
    } else {
        own
    };
    let project = if inherited {
        fallback.as_ref().map(|f| f.source.clone())
    } else {
        None
    };
    Facts {
        deadline,
        project,
        fallback,
    }
}

impl Facts {
    pub fn constraints(&self, task: &Task) -> [(&'static str, Option<Moment>); 2] {
        [
            (
                if self.project.is_some() {
                    "Project deadline"
                } else {
                    "Deadline"
                },
                self.deadline.clone(),
            ),
            (
                "Start by",
                (!task.planning.started)
                    .then(|| task.planning.start_by.clone())
                    .flatten(),
            ),
        ]
    }
    pub fn due_key(&self) -> i64 {
        self.deadline
            .as_ref()
            .and_then(|m| m.bound(true).ok())
            .map_or(i64::MAX, |d| d.timestamp_millis())
    }
}

pub(crate) struct Plan {
    pub moment: Moment,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub current: bool,
    pub occurrence: bool,
}
impl Plan {
    fn tie(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        if self.occurrence || self.start > now {
            self.start
        } else {
            self.end
        }
    }
}

pub(crate) fn selected_plan(
    t: &Task,
    now: DateTime<Utc>,
    series_zone: Option<&str>,
) -> Option<Plan> {
    let block = t
        .planning
        .blocks()
        .into_iter()
        .filter_map(|b| {
            let (start, end) = b.bounds().ok()?;
            Some((b, start, end))
        })
        .min_by_key(|(b, start, end)| {
            if *end <= now {
                (2, (now - *end).num_milliseconds(), 0, b.id.clone())
            } else if *start <= now {
                (0, (*end - now).num_milliseconds(), 0, b.id.clone())
            } else {
                (
                    1,
                    (*start - now).num_milliseconds(),
                    end.timestamp_millis(),
                    b.id.clone(),
                )
            }
        });
    if let Some((b, start, end)) = block {
        return Some(Plan {
            moment: b.start,
            start,
            end,
            current: start <= now && now < end,
            occurrence: false,
        });
    }
    let o = t.occurrence.as_ref()?;
    let moment = Moment {
        date: o.scheduled_date.clone(),
        time: None,
        timezone: series_zone
            .unwrap_or(crate::recurrence_model::LEGACY_SERIES_TIMEZONE)
            .into(),
        utc_offset_minutes: None,
    };
    Some(Plan {
        start: moment.bound(false).ok()?,
        end: moment.bound(true).ok()?,
        moment,
        current: false,
        occurrence: true,
    })
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn time_key(at: Option<DateTime<Utc>>) -> String {
    at.map_or_else(
        || "1".to_owned() + &"0".repeat(20),
        |at| format!("0{:020}", (at.timestamp_millis() as u64) ^ (1 << 63)),
    )
}
fn approaching(at: DateTime<Utc>, now: DateTime<Utc>) -> i64 {
    if at <= now + Duration::hours(48) {
        2
    } else if at <= now + Duration::days(7) {
        1
    } else {
        0
    }
}

pub(crate) fn evaluate(
    t: &Task,
    facts: &Facts,
    now: DateTime<Utc>,
    series_zone: Option<&str>,
) -> Recommendation {
    let importance = t.planning.importance.unwrap_or(Importance::Normal);
    let mut boundaries = Vec::new();
    let mut constraints = Vec::new();
    for (label, moment) in facts.constraints(t) {
        let Some(m) = moment else { continue };
        let Ok(end) = m.bound(true) else { continue };
        let immediate = if m.time.is_some() {
            end - Duration::hours(2)
        } else {
            m.bound(false).unwrap_or(end)
        };
        let h = if now >= immediate {
            3
        } else {
            approaching(end, now)
        };
        constraints.push((h, end, label));
        boundaries.extend([
            end - Duration::days(7),
            end - Duration::hours(48),
            immediate,
            end,
        ]);
    }
    let h = constraints.iter().map(|(h, _, _)| *h).max().unwrap_or(0);
    let buffer = t
        .planning
        .buffer_target(t.due_date.as_deref())
        .ok()
        .flatten()
        .and_then(|(m, _)| m.bound(true).ok());
    if let Some(at) = buffer {
        boundaries.extend([at - Duration::days(7), at - Duration::hours(48), at]);
    }
    let b = buffer.map_or(0, |at| approaching(at, now));
    let promoted = if h.max(b) == 0 {
        None
    } else if h >= b {
        constraints
            .iter()
            .filter(|(v, _, _)| *v == h)
            .map(|(_, at, _)| *at)
            .min()
    } else {
        buffer
    };
    let mut extra: Vec<_> = constraints
        .iter()
        .filter(|(v, at, _)| *v > 0 && Some(*at) != promoted)
        .map(|(_, at, _)| *at)
        .collect();
    extra.sort();
    extra.dedup();
    let plan = selected_plan(t, now, series_zone);
    let current = plan.as_ref().is_some_and(|p| p.current);
    let mut remaining: Vec<_> = constraints
        .iter()
        .filter(|(v, _, _)| *v == 0)
        .map(|(_, at, _)| *at)
        .chain(plan.as_ref().map(|p| p.tie(now)))
        .filter(|at| Some(*at) != promoted && !extra.contains(at))
        .collect();
    remaining.sort();
    remaining.dedup();
    let mut key = format!(
        "{:02}:{}:{}:{}",
        9 - importance.rank() - h.max(b),
        3 - h,
        6 - importance.rank(),
        time_key(promoted)
    );
    for i in 0..2 {
        key.push_str(&format!(":{}", time_key(extra.get(i).copied())));
    }
    key.push_str(if current { ":0" } else { ":1" });
    for i in 0..3 {
        key.push_str(&format!(":{}", time_key(remaining.get(i).copied())));
    }
    // All candidate blocks matter: an overlapping block may take over before
    // the currently selected one ends. Not before remains readiness only.
    for block in t.planning.blocks() {
        if let Ok((a, end)) = block.bounds() {
            boundaries.extend([a, end]);
        }
    }
    if let Some(p) = &plan {
        boundaries.extend([p.start, p.end]);
    }
    if let Some(at) = t
        .planning
        .not_before
        .as_ref()
        .and_then(|m| m.bound(false).ok())
    {
        boundaries.push(at);
    }
    let reason = if h > 0 && h >= b {
        let (_, at, label) = constraints
            .iter()
            .filter(|(v, _, _)| *v == h)
            .min_by_key(|(_, at, _)| *at)
            .unwrap();
        if h == 3 {
            format!(
                "{label} {}",
                if *at <= now { "overdue" } else { "due soon" }
            )
        } else {
            format!(
                "{} importance · approaching {}",
                importance.label(),
                label.to_lowercase()
            )
        }
    } else if b > 0 {
        format!(
            "{} importance · approaching buffer target",
            importance.label()
        )
    } else if current {
        "Planned now".into()
    } else {
        format!("{} importance", importance.label())
    };
    Recommendation {
        source_task_id: None,
        reason,
        evaluated_at: stamp(now),
        next_change_at: boundaries
            .into_iter()
            .filter(|at| *at > now)
            .min()
            .map(stamp),
        effective_deadline: facts.deadline.clone(),
        deadline_project: facts.project.clone(),
        project_fallback: facts.fallback.clone(),
        revision: None,
        policy: POLICY.into(),
        key,
    }
}
