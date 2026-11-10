use crate::{
    model::{EntityType, Status, Task},
    planning::{Importance, Moment, Recommendation},
    projection::PAGE_BYTES,
    recurrence_model::LEGACY_SERIES_TIMEZONE,
    store::{StoreError, dependencies::Graph},
};
use chrono::{DateTime, Duration, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(crate) const SUMMARY: &str = "priority_grid";
pub(crate) const CELL: &str = "priority_cell";
// The same frozen records can land in different cells under new timing rules.
pub(crate) const SUMMARY_CURSOR: &str = "priority_grid_v3";
pub(crate) const CELL_CURSOR: &str = "priority_cell_v3";
pub(crate) const PAGE_SIZE: usize = 20;
const PREVIEW_BYTES: usize = 64 * 1024;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Urgency {
    Undated,
    Later,
    Weeks,
    #[serde(rename = "within_7_days")]
    Within7Days,
    #[serde(rename = "within_48_hours")]
    Within48Hours,
    Immediate,
    Overdue,
}
impl Urgency {
    fn upcoming(at: DateTime<Utc>, now: DateTime<Utc>) -> Self {
        let remaining = at - now;
        if remaining <= Duration::hours(48) {
            Self::Within48Hours
        } else if remaining <= Duration::days(7) {
            Self::Within7Days
        } else if remaining <= Duration::days(28) {
            Self::Weeks
        } else {
            Self::Later
        }
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Scope {
    #[default]
    Next,
    Blocked,
    Waiting,
    Someday,
    Inbox,
    Committed,
    All,
}
impl Scope {
    fn includes(self, status: Status) -> bool {
        match self {
            Self::Next => status == Status::Next,
            Self::Blocked => status == Status::Blocked,
            Self::Waiting => status == Status::Waiting,
            Self::Someday => status == Status::Someday,
            Self::Inbox => status == Status::Inbox,
            Self::Committed => matches!(status, Status::Next | Status::Blocked | Status::Waiting),
            Self::All => matches!(
                status,
                Status::Next | Status::Blocked | Status::Waiting | Status::Someday | Status::Inbox
            ),
        }
    }
}

#[derive(Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct Cell {
    importance: Importance,
    urgency: Urgency,
    #[serde(default)]
    scope: Scope,
}

#[derive(Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct Query {
    pub project: Option<String>,
    pub cell: Option<Cell>,
    pub snapshot: Option<String>,
    pub cursor: Option<String>,
    pub offset: Option<u32>,
    pub limit: Option<u32>,
}
impl Query {
    pub fn validate(&self) -> Result<(), StoreError> {
        if self
            .project
            .as_deref()
            .is_some_and(|id| id != "all" && uuid::Uuid::parse_str(id).is_err())
        {
            return Err(StoreError::Invalid(
                "Choose all projects or a valid project ID.".into(),
            ));
        }
        if self.cell.is_some() != self.snapshot.is_some()
            || (self.cell.is_none()
                && (self.cursor.is_some() || self.limit.is_some() || self.offset.is_some()))
        {
            return Err(StoreError::Invalid(
                "A priority cell requires its grid snapshot. Pagination applies only to a cell."
                    .into(),
            ));
        }
        if self
            .offset
            .is_some_and(|offset| offset as usize > PAGE_SIZE || self.cursor.is_some())
        {
            return Err(StoreError::Invalid(
                "Use a cursor or an offset through the preloaded first page.".into(),
            ));
        }
        if self.limit.is_some_and(|limit| !(1..=100).contains(&limit)) {
            return Err(StoreError::Invalid(
                "Priority cell limits must be between 1 and 100.".into(),
            ));
        }
        Ok(())
    }
}

struct Timing {
    urgency: Urgency,
    work_block: Option<Moment>,
    scheduled: Option<Moment>,
    next: Option<DateTime<Utc>>,
}
impl Timing {
    fn boundary(&mut self, at: DateTime<Utc>, now: DateTime<Utc>) {
        if at > now && self.next.is_none_or(|next| at < next) {
            self.next = Some(at);
        }
    }
    fn approaching(&mut self, at: DateTime<Utc>, now: DateTime<Utc>, days_28: bool) {
        if days_28 {
            self.boundary(at - Duration::days(28), now);
        }
        self.boundary(at - Duration::days(7), now);
        self.boundary(at - Duration::hours(48), now);
    }
}

fn timing_at(task: &Task, now: DateTime<Utc>, series_timezone: Option<&str>) -> Timing {
    let mut result = Timing {
        urgency: Urgency::Undated,
        work_block: None,
        scheduled: None,
        next: None,
    };
    for (_, constraint) in task.timing_constraints() {
        let Some(moment) = constraint else { continue };
        let Ok(end) = moment.bound(true) else {
            continue;
        };
        let immediate_at = if moment.time.is_some() {
            end - Duration::hours(2)
        } else {
            moment.bound(false).unwrap_or(end)
        };
        let urgency = if now >= end {
            Urgency::Overdue
        } else if now >= immediate_at {
            Urgency::Immediate
        } else {
            Urgency::upcoming(end, now)
        };
        result.urgency = result.urgency.max(urgency);
        result.approaching(end, now, true);
        result.boundary(immediate_at, now);
        result.boundary(end, now);
    }
    if result.urgency != Urgency::Undated {
        if result.urgency < Urgency::Immediate
            && let Ok(Some((target, _))) = task.planning.buffer_target(task.due_date.as_deref())
            && let Ok(at) = target.bound(true)
        {
            let urgency = Urgency::upcoming(at, now);
            if urgency >= Urgency::Within7Days {
                result.urgency = result.urgency.max(urgency);
            }
            result.approaching(at, now, false);
        }
        return result;
    }

    // Prefer a current block, then the next planned block, then the block
    // that ended most recently. Earlier sessions may be part of a larger plan.
    let block = task
        .planning
        .blocks()
        .into_iter()
        .filter_map(|block| {
            let (start, end) = block.bounds().ok()?;
            Some((block, start, end))
        })
        .min_by_key(|(_, start, end)| {
            if *end <= now {
                (2, now - *end)
            } else if *start <= now {
                (0, *end - now)
            } else {
                (1, *start - now)
            }
        });
    if let Some((block, start, end)) = block {
        let immediate_at = if block.start.time.is_some() {
            start - Duration::hours(2)
        } else {
            start
        };
        result.urgency = if now >= end {
            Urgency::Overdue
        } else if now >= immediate_at {
            Urgency::Immediate
        } else {
            Urgency::upcoming(start, now)
        };
        result.work_block = Some(block.start);
        result.approaching(start, now, true);
        result.boundary(immediate_at, now);
        result.boundary(start, now);
        result.boundary(end, now);
        return result;
    }
    if let Some(occurrence) = &task.occurrence {
        let scheduled = Moment {
            date: occurrence.scheduled_date.clone(),
            time: None,
            timezone: series_timezone.unwrap_or(LEGACY_SERIES_TIMEZONE).into(),
            utc_offset_minutes: None,
        };
        if let (Ok(start), Ok(end)) = (scheduled.bound(false), scheduled.bound(true)) {
            result.urgency = if now >= end {
                Urgency::Overdue
            } else if now >= start {
                Urgency::Immediate
            } else {
                Urgency::upcoming(start, now)
            };
            result.scheduled = Some(scheduled);
            result.approaching(start, now, true);
            result.boundary(start, now);
            result.boundary(end, now);
        }
    }
    result
}

#[derive(Default, Clone, Copy, Serialize, JsonSchema)]
struct Counts {
    next: usize,
    blocked: usize,
    waiting: usize,
    someday: usize,
    inbox: usize,
}
impl Counts {
    fn add(&mut self, status: Status) {
        match status {
            Status::Next => self.next += 1,
            Status::Blocked => self.blocked += 1,
            Status::Waiting => self.waiting += 1,
            Status::Someday => self.someday += 1,
            Status::Inbox => self.inbox += 1,
            _ => unreachable!("only open tasks are counted"),
        }
    }
}

#[derive(Clone, Copy)]
struct Placement<'a> {
    importance: Importance,
    urgency: Urgency,
    importance_from: Option<&'a str>,
    urgency_from: Option<&'a str>,
    next: Option<DateTime<Utc>>,
}

struct Entry<'a> {
    placement: Placement<'a>,
    timing: Timing,
    visible: bool,
}

pub(crate) struct Grid<'a> {
    tasks: HashMap<&'a str, Entry<'a>>,
    next_change_at: Option<String>,
}
impl<'a> Grid<'a> {
    pub fn new(
        graph: &'a Graph,
        rankings: &HashMap<String, Recommendation>,
        availability: Option<&str>,
        evaluated_at: &str,
        project: Option<&str>,
        series_timezone: impl Fn(&str) -> Option<&'a str>,
    ) -> Result<Self, StoreError> {
        let now = DateTime::parse_from_rfc3339(evaluated_at)
            .map_err(|_| StoreError::ResetRequired)?
            .with_timezone(&Utc);
        let mut tasks: HashMap<_, _> = graph
            .tasks
            .values()
            .filter(|task| {
                task.entity_type == EntityType::Task
                    && !task.archived
                    && Scope::All.includes(task.status)
                    && !task.occurrence.as_ref().is_some_and(|o| o.skipped)
            })
            .map(|task| {
                let timezone = task
                    .occurrence
                    .as_ref()
                    .and_then(|o| series_timezone(&o.series_id));
                let timing = timing_at(task, now, timezone);
                let visible = project.is_none_or(|filter| {
                    task.project_id.as_deref().is_some_and(|id| {
                        (filter == "all" || id == filter)
                            && graph.tasks.get(id).is_some_and(|p| {
                                p.entity_type == EntityType::Project && !p.archived
                            })
                    })
                });
                (
                    task.id.as_str(),
                    Entry {
                        placement: Placement {
                            importance: task.planning.importance.unwrap_or(Importance::Normal),
                            urgency: timing.urgency,
                            importance_from: None,
                            urgency_from: None,
                            next: timing.next,
                        },
                        timing,
                        visible,
                    },
                )
            })
            .collect();
        // Each open dependent already has the priority of everything it blocks
        // by the time it is visited. Project and status filters affect display.
        for task in graph.dependents_first() {
            let Some(source) = tasks.get(task.id.as_str()).map(|entry| entry.placement) else {
                continue;
            };
            for id in &task.blocked_by {
                let Some(entry) = tasks.get_mut(id.as_str()) else {
                    continue;
                };
                let target = &mut entry.placement;
                if source.importance.rank() > target.importance.rank() {
                    target.importance = source.importance;
                    target.importance_from = source.importance_from.or(Some(&task.id));
                }
                if source.urgency > target.urgency {
                    target.urgency = source.urgency;
                    target.urgency_from = source.urgency_from.or(Some(&task.id));
                }
                target.next = target.next.into_iter().chain(source.next).min();
            }
        }
        // Availability is committed by the normal worker. If the first read
        // lands between the boundary and that commit, check again while visible.
        let waiting_for_commit = tasks
            .iter()
            .filter(|(_, entry)| entry.visible)
            .any(|(id, _)| {
                let task = &graph.tasks[*id];
                task.status == Status::Blocked
                    && !task.manual_block
                    && task.planning.not_before.is_some()
                    && !task.planning.unavailable_at(now)
                    && graph.unresolved(task).is_empty()
            });
        let next_change_at = tasks
            .iter()
            .filter(|(_, entry)| entry.visible)
            .flat_map(|(id, entry)| {
                [
                    entry
                        .placement
                        .next
                        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                    rankings.get(*id).and_then(|r| r.next_change_at.clone()),
                ]
            })
            .flatten()
            .chain(availability.map(str::to_owned))
            .chain(waiting_for_commit.then(|| {
                (now + Duration::seconds(5)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            }))
            .min();
        Ok(Self {
            tasks,
            next_change_at,
        })
    }
    pub fn summary(&self, graph: &Graph, snapshot: String, evaluated_at: &str) -> Value {
        let mut counts = [[Counts::default(); 7]; 7];
        for (id, entry) in self.tasks.iter().filter(|(_, entry)| entry.visible) {
            let Placement {
                importance,
                urgency,
                ..
            } = entry.placement;
            counts[importance.rank() as usize][urgency as usize].add(graph.tasks[*id].status);
        }
        json!({"kind":SUMMARY,"counts":counts,"snapshot":snapshot,
               "evaluated_at":evaluated_at,"next_change_at":self.next_change_at})
    }
    pub fn includes(&self, task: &Task, cell: Cell) -> bool {
        self.placement(&task.id).is_some_and(|placement| {
            placement.importance == cell.importance
                && placement.urgency == cell.urgency
                && cell.scope.includes(task.status)
        })
    }
    fn placement(&self, id: &str) -> Option<Placement<'a>> {
        self.tasks
            .get(id)
            .filter(|entry| entry.visible)
            .map(|entry| entry.placement)
    }
    pub fn previews<'b>(
        &self,
        ordered: impl Iterator<Item = &'b Task>,
        graph: &Graph,
        rankings: &HashMap<String, Recommendation>,
    ) -> Result<Value, StoreError> {
        // Retain a prefix for every status in every square. Reading each
        // prefix in rounds gives sparse squares room beside crowded ones.
        let mut buckets = vec![Vec::new(); 49 * 5];
        for (position, task) in ordered.enumerate() {
            let Some(Placement {
                importance,
                urgency,
                ..
            }) = self.placement(&task.id)
            else {
                continue;
            };
            let square = importance.rank() as usize * 7 + urgency as usize;
            let status = match task.status {
                Status::Next => 0,
                Status::Inbox => 1,
                Status::Waiting => 2,
                Status::Blocked => 3,
                Status::Someday => 4,
                _ => unreachable!("only open tasks are counted"),
            };
            let bucket = &mut buckets[square * 5 + status];
            if bucket.len() < PAGE_SIZE {
                bucket.push((position, task));
            }
        }
        let mut squares = vec![Vec::new(); 49];
        let mut bytes = 256;
        'pages: for rank in 0..PAGE_SIZE {
            for (bucket, tasks) in buckets.iter().enumerate() {
                let Some((position, task)) = tasks.get(rank) else {
                    continue;
                };
                let row = self.row(task, graph, rankings);
                bytes += serde_json::to_vec(&row)?.len() + 1;
                if bytes > PREVIEW_BYTES {
                    break 'pages;
                }
                squares[bucket / 5].push((*position, row));
            }
        }
        // Preserve the ordinary Recommended order for combined filters.
        Ok(json!(
            squares
                .into_iter()
                .map(|mut square| {
                    square.sort_by_key(|(position, _)| *position);
                    square.into_iter().map(|(_, row)| row).collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
        ))
    }
    pub fn row(
        &self,
        task: &Task,
        graph: &Graph,
        rankings: &HashMap<String, Recommendation>,
    ) -> Value {
        let placement = self.tasks[task.id.as_str()].placement;
        let source = |id: &str| {
            let task = &graph.tasks[id];
            json!({"id":task.id,"title":task.title})
        };
        let priority_from = placement
            .importance_from
            .or(placement.urgency_from)
            .or_else(|| {
                rankings
                    .get(&task.id)
                    .and_then(|r| r.source_task_id.as_deref())
            });
        let timing = &self.tasks[placement.urgency_from.unwrap_or(&task.id)].timing;
        let mut row = json!({"id":task.id,"title":task.title,"status":task.status,
                             "work_block":timing.work_block,
                             "priority_from":priority_from.map(source)});
        if let Some(id) = placement
            .urgency_from
            .filter(|id| Some(*id) != priority_from)
        {
            row["urgency_from"] = source(id);
        }
        if let Some(scheduled) = &timing.scheduled {
            row["scheduled"] = json!(scheduled);
        }
        row
    }
}

pub(crate) fn page(
    rows: impl Iterator<Item = Value>,
    max: usize,
) -> Result<(Vec<Value>, bool), StoreError> {
    let mut items = Vec::new();
    let mut bytes = 2048;
    for row in rows {
        let size = serde_json::to_vec(&row)?.len() + 1;
        if items.len() == max || !items.is_empty() && bytes + size > PAGE_BYTES {
            return Ok((items, true));
        }
        bytes += size;
        items.push(row);
    }
    Ok((items, false))
}

pub(crate) fn outputs() -> [Value; 2] {
    let mut counts = serde_json::to_value(schemars::schema_for!(Counts)).expect("counts schema");
    counts.as_object_mut().unwrap().remove("$schema");
    let source = json!({"type":"object","required":["id","title"],"properties":{"id":{"type":"string"},"title":{"type":"string"}}});
    let row = json!({"type":"object","required":["id","title","status","work_block","priority_from"],"properties":{
        "id":{"type":"string"},"title":{"type":"string"},"status":{"enum":["next","blocked","waiting","someday","inbox"]},
        "work_block":{"anyOf":[{"$ref":"#/$defs/Moment"},{"type":"null"}]},
        "scheduled":{"$ref":"#/$defs/Moment"},
        "priority_from":{"anyOf":[source,{"type":"null"}]},
        "urgency_from":source
    }});
    [
        json!({"type":"object","required":["kind","counts","snapshot","evaluated_at","next_change_at"],"properties":{
            "kind":{"const":SUMMARY},"counts":{"type":"array","minItems":7,"maxItems":7,"items":{"type":"array","minItems":7,"maxItems":7,"items":counts}},
            "snapshot":{"type":"string"},"evaluated_at":{"type":"string"},"next_change_at":{"type":["string","null"]},
            "previews":{"type":"array","minItems":49,"maxItems":49,"items":{"type":"array","items":row}}
        }}),
        json!({"type":"object","required":["kind","items","next_cursor"],"properties":{
            "kind":{"const":CELL},"items":{"type":"array","items":row},"next_cursor":{"type":["string","null"]}
        }}),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> Task {
        serde_json::from_value(json!({
            "id":"fixture","title":"Fixture","notes":"","status":"next","version":1,
            "created_at":"","updated_at":"","last_change_id":1,"deleted":false
        }))
        .unwrap()
    }

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn timing(task: &Task, now: DateTime<Utc>) -> Timing {
        timing_at(task, now, None)
    }

    fn moment(date: &str, time: Option<&str>) -> Moment {
        Moment {
            date: date.into(),
            time: time.map(str::to_owned),
            timezone: "America/New_York".into(),
            utc_offset_minutes: None,
        }
    }

    #[test]
    fn priority_grid_distinguishes_a_real_constraint_from_scheduled_work() {
        let mut task = task();
        task.planning.not_before = Some(moment("2026-12-01", None));
        task.review_date = Some("2026-11-06".into());
        let start = at("2026-11-06T15:00:00Z");
        let now = start - Duration::hours(2);
        assert_eq!(timing(&task, now).urgency, Urgency::Undated);
        task.planning.planned_start = Some(moment("2026-11-06", Some("10:00")));
        task.planning.planned_finish = Some(moment("2026-11-06", Some("12:00")));
        assert_eq!(
            timing(&task, now - Duration::seconds(1)).urgency,
            Urgency::Within48Hours
        );
        assert_eq!(timing(&task, now).urgency, Urgency::Immediate);
        assert_eq!(
            timing(&task, start + Duration::hours(1)).urgency,
            Urgency::Immediate
        );
        assert_eq!(
            timing(&task, start + Duration::hours(2)).urgency,
            Urgency::Overdue
        );
        assert_eq!(timing(&task, start).next, Some(start + Duration::hours(2)));

        task.planning.start_by = Some(moment("2026-11-05", Some("12:00")));
        assert_eq!(timing(&task, now).urgency, Urgency::Overdue);
        task.planning.started = true;
        task.planning.started_at = Some(moment("2026-11-05", Some("12:00")));
        assert_eq!(timing(&task, now).urgency, Urgency::Immediate);
        task.due_date = Some("2026-12-31".into());
        assert_eq!(timing(&task, now).urgency, Urgency::Later);
        assert_eq!(
            timing(&task, start + Duration::hours(2)).urgency,
            Urgency::Later
        );
        task.planning.safety_buffer = Some(crate::task_planning::SafetyBuffer {
            value: 60,
            unit: crate::task_planning::BufferUnit::Days,
        });
        assert_eq!(timing(&task, now).urgency, Urgency::Within48Hours);
    }

    #[test]
    fn priority_grid_uses_exact_horizons_and_local_day_across_dst() {
        let mut task = task();
        task.due_date = Some("2026-03-08".into()); // New York's 23-hour day.
        let midnight = at("2026-03-08T05:00:00Z");
        let end = at("2026-03-09T04:00:00Z");
        assert_eq!(
            timing(&task, midnight - Duration::seconds(1)).next,
            Some(midnight)
        );
        assert_eq!(timing(&task, midnight).urgency, Urgency::Immediate);
        assert_eq!(
            timing(&task, end - Duration::seconds(1)).urgency,
            Urgency::Immediate
        );
        assert_eq!(timing(&task, end).urgency, Urgency::Overdue);
        assert_eq!(
            timing(&task, end - Duration::days(28) - Duration::seconds(1)).urgency,
            Urgency::Later
        );
        assert_eq!(
            timing(&task, end - Duration::days(28)).urgency,
            Urgency::Weeks
        );
        assert_eq!(
            timing(&task, end - Duration::days(7)).urgency,
            Urgency::Within7Days
        );
        assert_eq!(
            timing(&task, end - Duration::hours(48)).urgency,
            Urgency::Within48Hours
        );
    }

    #[test]
    fn priority_grid_uses_current_then_next_then_latest_ended_work_block() {
        use crate::task_planning::WorkBlock;
        let mut task = task();
        task.planning.work_blocks = Some(vec![
            WorkBlock {
                id: "upcoming".into(),
                start: moment("2026-11-13", None),
                finish: None,
                calendar_event: None,
            },
            WorkBlock {
                id: "long".into(),
                start: moment("2026-11-05", None),
                finish: Some(moment("2026-11-06", None)),
                calendar_event: None,
            },
            WorkBlock {
                id: "short".into(),
                start: moment("2026-11-05", Some("10:00")),
                finish: Some(moment("2026-11-05", Some("12:00"))),
                calendar_event: None,
            },
        ]);
        let current = at("2026-11-05T16:00:00Z");
        assert_eq!(
            timing(&task, current).work_block.unwrap().time.as_deref(),
            Some("10:00")
        );
        assert_eq!(
            timing(&task, current + Duration::hours(1))
                .work_block
                .unwrap()
                .date,
            "2026-11-05"
        );
        let upcoming = at("2026-11-07T05:00:00Z");
        assert_eq!(timing(&task, upcoming).urgency, Urgency::Within7Days);
        assert_eq!(
            timing(&task, upcoming).work_block.unwrap().date,
            "2026-11-13"
        );
        let overdue = timing(&task, at("2026-11-14T05:00:00Z"));
        assert_eq!(overdue.urgency, Urgency::Overdue);
        assert_eq!(overdue.work_block.unwrap().date, "2026-11-13");
    }

    #[test]
    fn priority_grid_uses_the_rescheduled_date_in_the_series_timezone() {
        let mut task = task();
        task.occurrence = Some(crate::recurrence_model::Occurrence {
            series_id: "series".into(),
            original_date: "2026-03-01".into(),
            scheduled_date: "2026-03-08".into(),
            skipped: false,
            overrides: vec![],
        });
        let start = at("2026-03-08T08:00:00Z");
        let end = at("2026-03-09T07:00:00Z");
        let timing = |now| timing_at(&task, now, Some("America/Los_Angeles"));
        let upcoming = timing(start - Duration::seconds(1));
        assert_eq!(upcoming.urgency, Urgency::Within48Hours);
        assert_eq!(upcoming.next, Some(start));
        assert_eq!(timing(start).urgency, Urgency::Immediate);
        let last_second = timing(end - Duration::seconds(1));
        assert_eq!(last_second.urgency, Urgency::Immediate);
        assert_eq!(last_second.next, Some(end));
        let overdue = timing(end);
        assert_eq!(overdue.urgency, Urgency::Overdue);
        assert_eq!(overdue.scheduled.unwrap().date, "2026-03-08");
    }

    #[test]
    fn priority_grid_counts_occurrences_and_moves_their_prerequisites() {
        let mut first = task();
        first.id = uuid::Uuid::new_v4().to_string();
        first.planning.importance = Some(Importance::Low);
        let mut source = task();
        source.id = uuid::Uuid::new_v4().to_string();
        source.title = "Commitment".into();
        source.blocked_by.push(first.id.clone());
        source.status = Status::Blocked;
        source.planning.importance = Some(Importance::Critical);
        source.due_date = Some("2026-11-05".into());
        source.occurrence = Some(crate::recurrence_model::Occurrence {
            series_id: "series".into(),
            original_date: "2026-11-05".into(),
            scheduled_date: "2026-11-05".into(),
            skipped: false,
            overrides: vec![],
        });
        let mut skipped = source.clone();
        skipped.id = uuid::Uuid::new_v4().to_string();
        skipped.occurrence.as_mut().unwrap().skipped = true;
        let graph = Graph::new(vec![first.clone(), source.clone(), skipped]).unwrap();
        let instant = "2026-11-07T12:00:00Z";
        let ranks = graph.rankings(at(instant));
        let grid = Grid::new(&graph, &ranks, None, instant, None, |_| None).unwrap();
        let summary = grid.summary(&graph, "snapshot".into(), instant);
        assert_eq!(summary["counts"][2][0]["next"], 0);
        assert_eq!(summary["counts"][6][6]["next"], 1);
        assert_eq!(summary["counts"][6][6]["blocked"], 1);
        assert_eq!(
            grid.row(&first, &graph, &ranks)["priority_from"]["id"],
            source.id
        );
    }

    #[test]
    fn priority_grid_inherits_each_axis_through_the_open_chain_across_projects() {
        let make_task = |title: &str, importance| {
            let mut entry = task();
            entry.id = uuid::Uuid::new_v4().to_string();
            entry.title = title.into();
            entry.planning.importance = Some(importance);
            entry
        };
        let mut project = make_task("Project", Importance::Normal);
        project.entity_type = EntityType::Project;
        let mut root = make_task("Prerequisite", Importance::Unimportant);
        root.project_id = Some(project.id.clone());
        root.due_date = Some("2026-12-30".into());
        let mut middle = make_task("Intermediate", Importance::Low);
        middle.status = Status::Blocked;
        middle.blocked_by.push(root.id.clone());
        let mut critical = make_task("Critical outcome", Importance::Critical);
        critical.status = Status::Waiting;
        critical.blocked_by.push(middle.id.clone());
        let mut due = make_task("Earlier deadline", Importance::Normal);
        due.status = Status::Blocked;
        due.blocked_by.push(middle.id.clone());
        due.due_date = Some("2026-11-05".into());
        let mut completed = due.clone();
        completed.status = Status::Done;
        let mut archived = critical.clone();
        archived.archived = true;
        let instant = "2026-11-06T12:00:00Z";
        let check = |critical, due, importance, urgency, primary: &str, secondary: Option<&str>| {
            let graph = Graph::new(vec![
                root.clone(),
                middle.clone(),
                critical,
                due,
                project.clone(),
            ])
            .unwrap();
            let ranks = graph.rankings(at(instant));
            let grid =
                Grid::new(&graph, &ranks, None, instant, Some(&project.id), |_| None).unwrap();
            let cell = Cell {
                importance,
                urgency,
                scope: Scope::Next,
            };
            assert!(grid.includes(&root, cell));
            let summary = grid.summary(&graph, "snapshot".into(), instant);
            assert_eq!(
                summary["counts"][importance.rank() as usize][urgency as usize]["next"],
                1
            );
            let row = grid.row(&root, &graph, &ranks);
            assert_eq!(row["priority_from"]["id"], primary);
            assert_eq!(row["urgency_from"]["id"].as_str(), secondary);
        };
        check(
            critical.clone(),
            due.clone(),
            Importance::Critical,
            Urgency::Overdue,
            &critical.id,
            Some(&due.id),
        );
        check(
            critical.clone(),
            completed,
            Importance::Critical,
            Urgency::Later,
            &critical.id,
            None,
        );
        check(
            archived,
            due.clone(),
            Importance::Normal,
            Urgency::Overdue,
            &due.id,
            None,
        );
    }
}
