//! Calendar schedules are evaluated as dates. UTC noon is only an internal RRULE
//! representation, never a task time. Series use a pinned calendar zone; legacy
//! schedules retain New York independently of a later account-default change.
use super::*;
use crate::recurrence_model::*;
use chrono::{Datelike, Days};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OccurrenceCursor {
    cursor: String,
    from: String,
    through: String,
}

fn invalid(message: &str) -> StoreError {
    StoreError::Invalid(message.into())
}
pub(crate) fn date(value: &str) -> Result<NaiveDate> {
    validate_date(Some(value))?;
    let d = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| invalid("Invalid calendar date"))?;
    if !(2000..=2199).contains(&d.year()) {
        return Err(invalid("Repeat dates must be between 2000 and 2199"));
    }
    Ok(d)
}
pub(super) fn today() -> String {
    crate::clock::now()
        .with_timezone(&chrono_tz::America::New_York)
        .date_naive()
        .to_string()
}
fn rule_set(rule: &RepeatRule) -> Result<rrule::RRuleSet> {
    let start = date(&rule.start_date)?;
    if !(1..=365).contains(&rule.interval) {
        return Err(invalid("Repeat interval must be 1–365"));
    }
    if rule.until.is_some() && rule.count.is_some() {
        return Err(invalid("Choose an end date or count, not both"));
    }
    if rule.count.is_some_and(|n| n == 0 || n > 50000) {
        return Err(invalid("Repeat count must be 1–50000"));
    }
    if rule
        .weekdays
        .iter()
        .any(|s| !["MO", "TU", "WE", "TH", "FR", "SA", "SU"].contains(&s.as_str()))
        || rule.weekdays.iter().collect::<BTreeSet<_>>().len() != rule.weekdays.len()
    {
        return Err(invalid("Choose distinct weekdays MO through SU"));
    }
    if !rule.weekdays.is_empty()
        && !matches!(rule.frequency, Frequency::Weekly | Frequency::Monthly)
    {
        return Err(invalid(
            "Weekdays require a weekly rule, or monthly ordinal weekday",
        ));
    }
    if rule.month_day.is_some_and(|n| !(1..=31).contains(&n))
        || (rule.month_day.is_some() && rule.frequency != Frequency::Monthly)
    {
        return Err(invalid(
            "month_day requires a monthly rule and a day from 1 to 31",
        ));
    }
    if rule.ordinal.is_some_and(|n| ![-1, 1, 2, 3, 4].contains(&n))
        || (rule.ordinal.is_some()
            && (rule.frequency != Frequency::Monthly
                || rule.weekdays.len() != 1
                || rule.month_day.is_some()))
        || (rule.frequency == Frequency::Monthly
            && !rule.weekdays.is_empty()
            && rule.ordinal.is_none())
    {
        return Err(invalid(
            "Monthly ordinal requires one weekday and ordinal 1–4 or -1 (last)",
        ));
    }
    let freq = match rule.frequency {
        Frequency::Daily => "DAILY",
        Frequency::Weekly => "WEEKLY",
        Frequency::Monthly => "MONTHLY",
        Frequency::Yearly => "YEARLY",
    };
    let mut text = format!(
        "DTSTART:{}T120000Z\nRRULE:FREQ={freq};INTERVAL={};WKST=MO",
        start.format("%Y%m%d"),
        rule.interval
    );
    if let Some(until) = &rule.until {
        let end = date(until)?;
        if end < start {
            return Err(invalid("Repeat end precedes its start"));
        }
        text += &format!(";UNTIL={}T235959Z", end.format("%Y%m%d"));
    }
    if let Some(n) = rule.count {
        text += &format!(";COUNT={n}")
    }
    if let Some(n) = rule.month_day {
        text += &format!(";BYMONTHDAY={n}")
    }
    if !rule.weekdays.is_empty() {
        text += &format!(
            ";BYDAY={}{}",
            rule.ordinal.map(|n| n.to_string()).unwrap_or_default(),
            rule.weekdays.join(",")
        );
    }
    text.parse().map_err(|_| invalid("Unsupported repeat rule"))
}
pub(crate) fn dates(
    rule: &RepeatRule,
    from: &str,
    through: &str,
    limit: usize,
) -> Result<Vec<String>> {
    date(from)?;
    date(through)?;
    // Constrained daily-or-slower rules and a 200-year domain bound iteration even
    // when COUNT must be evaluated from DTSTART rather than from the page start.
    let set = rule_set(rule)?;
    let mut out = Vec::new();
    for dt in set.into_iter().take(74000) {
        let d = dt.date_naive().to_string();
        if d.as_str() > through {
            break;
        }
        if d.as_str() >= from {
            out.push(d);
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}
pub(crate) fn template(t: &Template) -> Result<()> {
    t.planning
        .merge(&Default::default())
        .map_err(StoreError::Invalid)?;
    validate_title(&t.title)?;
    validate_notes(&t.notes)?;
    validate_agent_notes(t.agent_notes.as_deref())?;
    validate_context(&t.links, t.location.as_deref())?;
    validate_extras(t.project_id.as_deref(), None, &[], None)?;
    if matches!(t.status, Status::Done | Status::Archived | Status::Active) {
        return Err(invalid("Repeat defaults require an unfinished task status"));
    }
    if [t.due_offset_days, t.review_offset_days]
        .iter()
        .flatten()
        .any(|n| n.unsigned_abs() > 3660)
    {
        return Err(invalid("Date offsets must be within 3660 days"));
    }
    Ok(())
}
pub(crate) fn shifted(d: &str, offset: Option<i32>) -> Result<Option<String>> {
    offset
        .map(|n| {
            date(d)?
                .checked_add_signed(chrono::Duration::days(n as i64))
                .map(|d| d.to_string())
                .ok_or_else(|| invalid("Date offset overflow"))
        })
        .transpose()
}
fn blank(t: &Template, d: &str, kind: EntityType) -> Result<Task> {
    let timestamp = now();
    let due = shifted(d, t.due_offset_days)?;
    let (planning, timing_adjustments) = t
        .planning
        .materialize(d, due.as_deref())
        .map_err(StoreError::Invalid)?;
    planning
        .validate(due.as_deref())
        .map_err(StoreError::Invalid)?;
    Ok(Task {
        blocked_by: vec![],
        manual_block: matches!(t.status, Status::Blocked | Status::Planned),
        unresolved_blocker_ids: vec![],
        planning,
        timing_adjustments,
        recommendation: None,
        entity_type: kind,
        id: Uuid::new_v4().to_string(),
        title: t.title.clone(),
        notes: t.notes.clone(),
        brief: t.brief.clone().unwrap_or_default(),
        agent_notes: t.agent_notes.clone().unwrap_or_default(),
        links: t.links.clone(),
        location: t.location.clone(),
        project_id: t.project_id.clone(),
        due_date: shifted(d, t.due_offset_days)?,
        review_date: shifted(d, t.review_offset_days)?,
        status: t.status,
        archived: false,
        work_sessions: vec![],
        completion_result: None,
        completed_at: None,
        version: 1,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        deleted: false,
        last_change_id: 0,
        recurrence: None,
        occurrence: None,
        pending_occurrence_count: None,
    })
}
fn series(tx: &impl RecordRead, id: &str) -> Result<Task> {
    require_kind(tx, id, EntityType::Recurrence)?;
    let t = load_task(tx, id)?;
    if t.deleted {
        return Err(StoreError::Conflict("Series was undone".into()));
    }
    Ok(t)
}
fn occurrences(tx: &impl RecordRead, id: &str) -> Result<Vec<Task>> {
    tx.occurrences(id)
}
fn mark_group(tx: &impl Mutation, since: i64) -> Result<()> {
    tx.group_since(since);
    Ok(())
}
fn high(tx: &impl Mutation) -> Result<i64> {
    Ok(tx.high())
}

pub(crate) fn schedule<'a>(
    s: &'a Series,
    from: &str,
    through: &str,
    limit: usize,
) -> Result<Vec<(String, String, &'a Template)>> {
    let mut result = BTreeMap::new();
    for (i, seg) in s.segments.iter().enumerate() {
        let begin = from.max(&seg.from);
        let end = through.min(
            s.segments
                .get(i + 1)
                .map(|x| x.from.as_str())
                .unwrap_or(through),
        );
        if begin > end {
            continue;
        }
        for d in dates(&seg.rule, begin, end, limit)? {
            if s.segments.get(i + 1).is_some_and(|x| d >= x.from)
                || s.ended_on.as_ref().is_some_and(|x| d >= *x)
                || s.pauses
                    .iter()
                    .any(|p| d >= p.from && p.through.as_ref().is_none_or(|end| d <= *end))
            {
                continue;
            }
            let original = seg.replacements.get(&d).unwrap_or(&d).clone();
            result.insert(d.clone(), (original, d, &seg.template));
        }
    }
    Ok(result.into_values().take(limit).collect())
}
// Reject a repeat before accepting it if a future clock change would make its
// block invalid. Otherwise a valid first occurrence could stall catch-up later.
fn validate_schedule_planning(data: &Series) -> Result<()> {
    if !data.segments.iter().any(|s| {
        let p = &s.template.planning;
        p.deadline_time.is_some()
            || p.start_by.is_some()
            || p.planned_start.is_some()
            || p.planned_finish.is_some()
            || p.not_before.is_some()
            || p.work_blocks.as_ref().is_some_and(|v| !v.is_empty())
            || p.safety_buffer.is_some()
    }) {
        return Ok(());
    }
    for (_, d, t) in schedule(data, "2000-01-01", "2199-12-31", 74000)? {
        let due = shifted(&d, t.due_offset_days)?;
        let checked = t
            .planning
            .materialize(&d, due.as_deref())
            .and_then(|(p, _)| p.validate(due.as_deref()));
        if let Err(message) = checked {
            return Err(invalid(&format!(
                "Repeat timing is invalid on {d}: {message}. Adjust the repeat times or end the schedule before this date."
            )));
        }
    }
    Ok(())
}
fn identity_date(data: &Series, original: &str) -> String {
    data.segments
        .iter()
        .enumerate()
        .find_map(|(index, segment)| {
            segment
                .replacements
                .iter()
                .find(|(scheduled, identity)| {
                    identity.as_str() == original
                        && *scheduled >= &segment.from
                        && data
                            .segments
                            .get(index + 1)
                            .is_none_or(|next| *scheduled < &next.from)
                })
                .map(|(scheduled, _)| scheduled.clone())
        })
        .unwrap_or_else(|| original.to_owned())
}
fn validate_identities(data: &Series) -> Result<()> {
    // Pausing must not hide a collision that would become visible on resume/undo.
    let mut unpaused = data.clone();
    unpaused.pauses.clear();
    unpaused.ended_on = None;
    let mut identities = BTreeSet::new();
    for (original, _, _) in schedule(&unpaused, "2000-01-01", "2199-12-31", 74000)? {
        if !identities.insert(original) {
            return Err(StoreError::Conflict(
                "This rule would reuse a stored occurrence identity; choose a later start or reschedule individual occurrences".into(),
            ));
        }
    }
    Ok(())
}
fn occurrence_task(s: &Task, original: &str, scheduled: &str, t: &Template) -> Result<Task> {
    let mut task = blank(t, scheduled, EntityType::Task)?;
    task.occurrence = Some(Occurrence {
        series_id: s.id.clone(),
        original_date: original.into(),
        scheduled_date: scheduled.into(),
        skipped: false,
        overrides: vec![],
    });
    Ok(task)
}
pub(super) fn materialize(
    tx: &impl Mutation,
    s: &Task,
    through: &str,
    origin: &str,
    batch: &str,
    limit: usize,
) -> Result<usize> {
    let data = s
        .recurrence
        .as_ref()
        .ok_or_else(|| invalid("Missing series data"))?;
    let mut existing = occurrences(tx, &s.id)?
        .into_iter()
        .map(|t| t.occurrence.unwrap().original_date)
        .collect::<BTreeSet<_>>();
    let mut n = 0;
    for (original, d, t) in schedule(data, "2000-01-01", through, 74000)? {
        if existing.contains(&original) {
            continue;
        }
        let task = occurrence_task(s, &original, &d, t)?;

        record_change(
            tx,
            "occurrence",
            "Materialized scheduled occurrence",
            None,
            task,
            None,
            origin,
            batch,
        )?;
        existing.insert(original);
        n += 1;
        if n >= limit {
            break;
        }
    }
    Ok(n)
}
fn require_caught_up(tx: &impl RecordRead, s: &Task) -> Result<()> {
    let existing = occurrences(tx, &s.id)?
        .into_iter()
        .map(|task| task.occurrence.unwrap().original_date)
        .collect::<BTreeSet<_>>();
    if schedule(
        s.recurrence.as_ref().unwrap(),
        "2000-01-01",
        &s.recurrence
            .as_ref()
            .unwrap()
            .date_at(crate::clock::now())
            .map_err(StoreError::Invalid)?,
        74000,
    )?
    .iter()
    .any(|(original, _, _)| !existing.contains(original))
    {
        return Err(StoreError::Conflict(
            "Series has missed occurrences awaiting catch-up; let the worker finish before changing its schedule, pausing, or ending it".into(),
        ));
    }
    Ok(())
}
pub(super) fn validate_future_memberships(
    tx: &impl RecordRead,
    records: &BTreeMap<String, Task>,
) -> Result<()> {
    for series in records
        .values()
        .filter(|t| t.entity_type == EntityType::Recurrence && !t.deleted)
    {
        let data = series.recurrence.as_ref().unwrap();
        let mut incompatible = Vec::new();
        for segment in &data.segments {
            if let Some(id) = &segment.template.project_id {
                let project = records.get(id);
                if project.is_none_or(|p| {
                    p.entity_type != EntityType::Project
                        || p.deleted
                        || p.archived
                        || p.status == Status::Done
                        || (p.status == Status::Someday
                            && segment.template.status != Status::Someday)
                }) {
                    incompatible.push((id.clone(), segment.template.status));
                }
            }
        }
        if incompatible.is_empty() {
            continue;
        }
        let existing = occurrences(tx, &series.id)?
            .into_iter()
            .map(|task| task.occurrence.unwrap().original_date)
            .collect::<BTreeSet<_>>();
        for (original, _, template) in schedule(data, "2000-01-01", "2199-12-31", 74000)? {
            if !existing.contains(&original)
                && template
                    .project_id
                    .as_ref()
                    .is_some_and(|id| incompatible.contains(&(id.clone(), template.status)))
            {
                return Err(StoreError::Conflict("Project transition leaves an upcoming or missed recurring occurrence incompatible; change or end the relevant series first".into()));
            }
        }
    }
    Ok(())
}
pub(super) fn create_in(
    tx: &impl Mutation,
    mut input: CreateRecurrence,
    origin: &str,
) -> Result<MutationResult> {
    validate_write(&input.request_id, &input.reason)?;
    tx.policy()
        .notes(input.template.agent_notes.as_deref(), true)?;
    template(&input.template)?;
    rule_set(&input.rule)?;
    let first_date = dates(&input.rule, &input.rule.start_date, "2199-12-31", 1)?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("Repeat rule has no occurrences"))?;
    if input.task_id.is_some() != input.expected_task_version.is_some() {
        return Err(invalid(
            "Adopting a task requires task_id and expected_task_version together",
        ));
    }
    let adopted = if let Some(id) = &input.task_id {
        require_kind(tx, id, EntityType::Task)?;
        let task = load_task(tx, id)?;
        check_version(&task, input.expected_task_version.unwrap())?;
        if task.deleted || task.status == Status::Done || task.occurrence.is_some() {
            return Err(StoreError::Conflict(
                "Adopt a live unfinished task that does not already repeat".into(),
            ));
        }
        Some(task)
    } else {
        None
    };
    if input.template.brief.is_none() {
        input.template.brief = adopted.as_ref().map(|t| t.brief.clone());
    }
    if input.template.agent_notes.is_none() {
        input.template.agent_notes = adopted
            .as_ref()
            .filter(|t| !t.agent_notes.is_empty())
            .map(|t| t.agent_notes.clone());
    }
    require_importance(input.template.planning.importance)?;
    let planning_clears = input.template.planning.clear_planning.clone();
    input.template.planning = input
        .template
        .planning
        .merge(&Default::default())
        .map_err(StoreError::Invalid)?;
    let first = high(tx)?;
    let mut task = blank(
        &input.template,
        &input.rule.start_date,
        EntityType::Recurrence,
    )?;
    task.recurrence = Some(Series {
        timezone: tx.calendar_timezone().name().into(),
        segments: vec![Segment {
            content_key: None,
            from: input.rule.start_date.clone(),
            rule: input.rule,
            template: input.template.clone(),
            replacements: BTreeMap::new(),
        }],
        pauses: vec![],
        ended_on: None,
    });
    validate_schedule_planning(task.recurrence.as_ref().unwrap())?;
    let result = record_change(
        tx,
        "create_recurrence",
        &input.reason,
        None,
        task,
        None,
        origin,
        &input.request_id,
    )?;
    if let Some(before) = adopted {
        let mut task = before.clone();
        // Adopting with an older client must not erase the task's assessed
        // importance or block. Keep unspecified values as this occurrence's
        // overrides, without inventing defaults for future occurrences.
        let mut preserved = vec![];
        macro_rules! preserve {
            ($field:ident, $name:ident) => {
                if before.planning.$field.is_some()
                    && input.template.planning.$field.is_none()
                    && !planning_clears.contains(&crate::planning::PlanningField::$name)
                {
                    preserved.push(stringify!($field).to_string());
                }
            };
        }
        preserve!(importance, Importance);
        preserve!(start_by, StartBy);
        preserve!(estimated_minutes, EstimatedMinutes);
        preserve!(effort, Effort);
        preserve!(not_before, NotBefore);
        preserve!(safety_buffer, SafetyBuffer);
        preserve!(work_blocks, WorkBlocks);
        preserve!(planned_start, PlannedStart);
        preserve!(planned_finish, PlannedFinish);
        if input.template.due_offset_days.is_some() {
            preserve!(deadline_time, DeadlineTime);
        }
        task.occurrence = Some(Occurrence {
            series_id: result.task.id.clone(),
            original_date: first_date.clone(),
            scheduled_date: first_date.clone(),
            skipped: false,
            overrides: preserved,
        });
        apply_defaults(&mut task, &input.template, &first_date)?;
        save(
            tx,
            before,
            task,
            "adopt_occurrence",
            &input.reason,
            origin,
            &input.request_id,
        )?;
    }
    let day = result
        .task
        .recurrence
        .as_ref()
        .unwrap()
        .date_at(crate::clock::now())
        .map_err(StoreError::Invalid)?;
    materialize(tx, &result.task, &day, origin, &input.request_id, 100)?;
    mark_group(tx, first)?;
    Ok(result)
}
fn save(
    tx: &impl Mutation,
    before: Task,
    mut after: Task,
    op: &str,
    reason: &str,
    origin: &str,
    batch: &str,
) -> Result<MutationResult> {
    after.version = before.version + 1;
    after.updated_at = now();
    record_change(tx, op, reason, Some(before), after, None, origin, batch)
}
fn apply_defaults(task: &mut Task, t: &Template, scheduled: &str) -> Result<()> {
    let overrides = &task.occurrence.as_ref().unwrap().overrides;
    if !overrides.iter().any(|x| x == "title") {
        task.title = t.title.clone()
    }
    if !overrides.iter().any(|x| x == "notes") {
        task.notes = t.notes.clone()
    }
    if !overrides.iter().any(|x| x == "brief")
        && let Some(brief) = &t.brief
    {
        task.brief = brief.clone();
    }
    if !overrides.iter().any(|x| x == "agent_notes")
        && let Some(notes) = &t.agent_notes
    {
        task.agent_notes = notes.clone();
    }
    if !overrides.iter().any(|x| x == "links") {
        task.links = t.links.clone()
    }
    if !overrides.iter().any(|x| x == "location") {
        task.location = t.location.clone()
    }
    if !overrides.iter().any(|x| x == "project_id") {
        task.project_id = t.project_id.clone()
    }
    if !overrides.iter().any(|x| x == "status") {
        task.status = t.status;
        task.manual_block = matches!(t.status, Status::Blocked | Status::Planned);
    }
    if !overrides.iter().any(|x| x == "due_date") {
        task.due_date = shifted(scheduled, t.due_offset_days)?
    }
    if !overrides.iter().any(|x| x == "review_date") {
        task.review_date = shifted(scheduled, t.review_offset_days)?
    }
    apply_planning(task, t, scheduled)
}
fn apply_planning(task: &mut Task, t: &Template, scheduled: &str) -> Result<()> {
    let mut defaults = t.planning.clone();
    if task.due_date.is_none() {
        defaults.deadline_time = None;
        defaults.safety_buffer = None;
    }
    let (p, notes) = defaults
        .materialize(scheduled, task.due_date.as_deref())
        .map_err(StoreError::Invalid)?;
    let overrides = &task.occurrence.as_ref().unwrap().overrides;
    macro_rules! field {
        ($f:ident) => {
            if !overrides.iter().any(|n| n == stringify!($f)) {
                task.planning.$f = p.$f;
            }
        };
    }
    field!(importance);
    field!(deadline_time);
    field!(start_by);
    field!(planned_start);
    field!(planned_finish);
    field!(estimated_minutes);
    field!(effort);
    field!(not_before);
    field!(safety_buffer);
    if !overrides
        .iter()
        .any(|n| n == "work_blocks" || n == "planned_start" || n == "planned_finish")
    {
        task.planning.work_blocks = p.work_blocks;
        task.planning.legacy_work_block_id = p.legacy_work_block_id;
    }
    task.planning.sync_legacy_block();
    task.planning
        .validate(task.due_date.as_deref())
        .map_err(StoreError::Invalid)?;
    task.timing_adjustments = notes;
    Ok(())
}
// Omitted working notes preserve each segment independently, including legacy templates.
fn merge_template(
    base: &Template,
    patch: Option<&Template>,
    agent_notes: Option<&String>,
    brief: Option<&String>,
    policy: content::Policy,
) -> Result<Template> {
    let mut result = patch.cloned().unwrap_or_else(|| base.clone());
    result.brief = brief
        .cloned()
        .or_else(|| patch.and_then(|p| p.brief.clone()))
        .or_else(|| base.brief.clone());
    content::validate_replacement(
        brief
            .or_else(|| patch.and_then(|p| p.brief.as_ref()))
            .map(String::as_str),
        result.status != Status::Inbox,
    )?;
    result.agent_notes = agent_notes
        .cloned()
        .or_else(|| patch.and_then(|p| p.agent_notes.clone()))
        .or_else(|| base.agent_notes.clone());
    if base.status == Status::Inbox && result.status != Status::Inbox {
        if result.brief.as_deref().unwrap_or("").trim().is_empty() {
            return Err(invalid("brief is required when clarifying Inbox defaults"));
        }
        policy.notes(result.agent_notes.as_deref(), true)?;
    }
    result.planning = patch
        .map(|p| p.planning.merge(&base.planning))
        .transpose()
        .map_err(StoreError::Invalid)?
        .unwrap_or_else(|| base.planning.clone());
    if result.due_offset_days.is_none() && patch.is_some_and(|p| p.planning.deadline_time.is_none())
    {
        result.planning.deadline_time = None;
        result.planning.safety_buffer = None;
    }
    // Validate the merged defaults, not an incomplete omission-preserving patch.
    let due = shifted("2026-01-15", result.due_offset_days)?;
    result
        .planning
        .materialize("2026-01-15", due.as_deref())
        .map_err(StoreError::Invalid)?
        .0
        .validate(due.as_deref())
        .map_err(StoreError::Invalid)?;
    Ok(result)
}
pub(super) fn update_in(
    tx: &impl Mutation,
    input: UpdateRecurrence,
    origin: &str,
) -> Result<MutationResult> {
    validate_write(&input.request_id, &input.reason)?;
    validate_agent_notes(input.agent_notes.as_deref())?;
    tx.policy().notes(input.agent_notes.as_deref(), false)?;
    if let Some(t) = &input.template {
        tx.policy().notes(t.agent_notes.as_deref(), false)?;
    }
    if input.brief.is_some()
        && (input.action != RepeatAction::Edit
            || input.template.as_ref().is_some_and(|t| t.brief.is_some()))
    {
        return Err(invalid("Use one brief replacement with action=edit"));
    }
    if input.agent_notes.is_some()
        && (input.action != RepeatAction::Edit || input.template.is_some() || input.rule.is_some())
    {
        return Err(invalid(
            "Use agent_notes alone with action=edit; omit rule and template",
        ));
    }
    let notes_supplied = input.agent_notes.is_some()
        || input
            .template
            .as_ref()
            .is_some_and(|t| t.agent_notes.is_some());
    let before = series(tx, &input.series_id)?;
    check_version(&before, input.expected_version)?;
    if input.scope == Scope::Segment {
        return repair_segment(tx, input, before, origin);
    }
    if input.segment_from.is_some() {
        return Err(invalid("segment_from requires scope=segment"));
    }
    let first = high(tx)?;
    let mut after = before.clone();
    if let Some(r) = &input.rule {
        rule_set(r)?;
    }
    if let Some(t) = &input.template {
        template(t)?;
    }
    if let Some(d) = &input.scheduled_date {
        date(d)?;
    }
    if let Some(d) = &input.original_date {
        date(d)?;
    }
    let data = after.recurrence.as_mut().unwrap();
    if input.scope == Scope::This {
        if !matches!(
            input.action,
            RepeatAction::Edit | RepeatAction::Skip | RepeatAction::Unskip
        ) || input.rule.is_some()
        {
            return Err(invalid(
                "This task supports edit, skip, or unskip; rule edits require a series scope",
            ));
        }
        let original = input
            .original_date
            .as_deref()
            .ok_or_else(|| invalid("This task requires original_date"))?;
        let existing = occurrences(tx, &before.id)?
            .into_iter()
            .find(|t| t.occurrence.as_ref().unwrap().original_date == original);
        let previous = existing.clone();
        let mut task = if let Some(t) = existing {
            check_version(
                &t,
                input.expected_occurrence_version.ok_or_else(|| {
                    invalid("Stored occurrences require expected_occurrence_version")
                })?,
            )?;
            if t.deleted {
                return Err(StoreError::Conflict(
                    "Occurrence was undone; restore through undo".into(),
                ));
            }
            t
        } else {
            if input.expected_occurrence_version.is_some() {
                return Err(StoreError::Conflict(
                    "Occurrence has not been materialized".into(),
                ));
            }
            if input.action == RepeatAction::Unskip {
                return Err(invalid("Occurrence has not been skipped"));
            }
            let row = schedule(data, "2000-01-01", "2199-12-31", 74000)?
                .into_iter()
                .find(|(o, _, _)| o == original)
                .ok_or_else(|| invalid("Date is not part of this series"))?;

            occurrence_task(&before, &row.0, &row.1, row.2)?
        };
        if task.status == Status::Done && input.action != RepeatAction::Edit {
            return Err(invalid("A completed occurrence cannot be skipped"));
        }
        match input.action {
            RepeatAction::Skip | RepeatAction::Unskip => {
                if input.template.is_some() || input.scheduled_date.is_some() {
                    return Err(invalid("Skip only changes skipped state"));
                }
                task.occurrence.as_mut().unwrap().skipped = input.action == RepeatAction::Skip;
            }
            RepeatAction::Edit => {
                if input.template.is_none()
                    && input.scheduled_date.is_none()
                    && input.agent_notes.is_none()
                    && input.brief.is_none()
                {
                    return Err(invalid("Supply task defaults or a scheduled date"));
                }
                if task.status == Status::Done
                    && (input.template.is_some()
                        || input.agent_notes.is_some()
                        || input.brief.is_some())
                {
                    return Err(invalid(
                        "Completed occurrence history is preserved; use update_item for an explicit task edit",
                    ));
                }
                let old_scheduled = task.occurrence.as_ref().unwrap().scheduled_date.clone();
                let scheduled = input.scheduled_date.as_deref().unwrap_or(&old_scheduled);
                // Resolve inherited offsets before changing the occurrence identity metadata.
                // A date-only exception moves inherited dates, but never an explicit date override.
                if input.scheduled_date.is_some() && input.template.is_none() {
                    let baseline_date = identity_date(data, original);
                    let source = data
                        .segments
                        .iter()
                        .rev()
                        .find(|s| s.from <= baseline_date)
                        .unwrap_or(&data.segments[0]);
                    let overrides = &task.occurrence.as_ref().unwrap().overrides;
                    if !overrides.iter().any(|name| name == "due_date") {
                        task.due_date = shifted(scheduled, source.template.due_offset_days)?;
                    }
                    if !overrides.iter().any(|name| name == "review_date") {
                        task.review_date = shifted(scheduled, source.template.review_offset_days)?;
                    }
                    apply_planning(&mut task, &source.template, scheduled)?;
                }
                content::validate_replacement(
                    input
                        .brief
                        .as_deref()
                        .or_else(|| input.template.as_ref().and_then(|t| t.brief.as_deref())),
                    input
                        .template
                        .as_ref()
                        .map(|t| t.status)
                        .unwrap_or(task.status)
                        != Status::Inbox,
                )?;
                if let Some(brief) = &input.brief {
                    task.brief = brief.clone();
                    if !task
                        .occurrence
                        .as_ref()
                        .unwrap()
                        .overrides
                        .iter()
                        .any(|n| n == "brief")
                    {
                        task.occurrence
                            .as_mut()
                            .unwrap()
                            .overrides
                            .push("brief".into());
                    }
                }
                if let Some(notes) = &input.agent_notes {
                    task.agent_notes = notes.clone();
                    let overrides = &mut task.occurrence.as_mut().unwrap().overrides;
                    if !overrides.iter().any(|n| n == "agent_notes") {
                        overrides.push("agent_notes".into());
                    }
                }
                if let Some(t) = input.template {
                    let preserve_agent_override = task
                        .occurrence
                        .as_ref()
                        .unwrap()
                        .overrides
                        .iter()
                        .any(|n| n == "agent_notes");
                    let scheduled_override = task
                        .occurrence
                        .as_ref()
                        .unwrap()
                        .overrides
                        .iter()
                        .any(|name| name == "scheduled_date");
                    let old_overrides = task.occurrence.as_ref().unwrap().overrides.clone();
                    task.occurrence.as_mut().unwrap().overrides.clear();
                    let fields = [
                        (
                            "estimated_minutes",
                            t.planning.estimated_minutes.is_some(),
                            crate::planning::PlanningField::EstimatedMinutes,
                        ),
                        (
                            "effort",
                            t.planning.effort.is_some(),
                            crate::planning::PlanningField::Effort,
                        ),
                        (
                            "not_before",
                            t.planning.not_before.is_some(),
                            crate::planning::PlanningField::NotBefore,
                        ),
                        (
                            "safety_buffer",
                            t.planning.safety_buffer.is_some(),
                            crate::planning::PlanningField::SafetyBuffer,
                        ),
                        (
                            "work_blocks",
                            t.planning.work_blocks.is_some(),
                            crate::planning::PlanningField::WorkBlocks,
                        ),
                        (
                            "importance",
                            t.planning.importance.is_some(),
                            crate::planning::PlanningField::Importance,
                        ),
                        (
                            "deadline_time",
                            t.planning.deadline_time.is_some(),
                            crate::planning::PlanningField::DeadlineTime,
                        ),
                        (
                            "start_by",
                            t.planning.start_by.is_some(),
                            crate::planning::PlanningField::StartBy,
                        ),
                        (
                            "planned_start",
                            t.planning.planned_start.is_some(),
                            crate::planning::PlanningField::PlannedStart,
                        ),
                        (
                            "planned_finish",
                            t.planning.planned_finish.is_some(),
                            crate::planning::PlanningField::PlannedFinish,
                        ),
                    ];
                    let supplied = fields
                        .iter()
                        .filter(|(_, set, key)| *set || t.planning.clear_planning.contains(key))
                        .map(|(name, _, _)| name.to_string())
                        .collect::<Vec<_>>();
                    for (name, _, _) in &fields {
                        if !supplied.iter().any(|n| n == name) {
                            task.occurrence
                                .as_mut()
                                .unwrap()
                                .overrides
                                .push(name.to_string());
                        }
                    }
                    apply_defaults(&mut task, &t, scheduled)?;
                    task.occurrence.as_mut().unwrap().overrides = vec![
                        "title",
                        "notes",
                        "links",
                        "location",
                        "project_id",
                        "status",
                        "due_date",
                        "review_date",
                    ]
                    .into_iter()
                    .map(String::from)
                    .collect();
                    for (name, _, _) in fields {
                        if supplied.iter().any(|n| n == name)
                            || old_overrides.iter().any(|n| n == name)
                        {
                            task.occurrence
                                .as_mut()
                                .unwrap()
                                .overrides
                                .push(name.into());
                        }
                    }
                    if t.brief.is_some() || old_overrides.iter().any(|n| n == "brief") {
                        task.occurrence
                            .as_mut()
                            .unwrap()
                            .overrides
                            .push("brief".into());
                    }
                    if t.agent_notes.is_some() || preserve_agent_override {
                        task.occurrence
                            .as_mut()
                            .unwrap()
                            .overrides
                            .push("agent_notes".into());
                    }
                    if scheduled_override {
                        task.occurrence
                            .as_mut()
                            .unwrap()
                            .overrides
                            .push("scheduled_date".into());
                    }
                }
                if let Some(d) = input.scheduled_date {
                    let o = task.occurrence.as_mut().unwrap();
                    o.scheduled_date = d;
                    if !o.overrides.iter().any(|name| name == "scheduled_date") {
                        o.overrides.push("scheduled_date".into());
                    }
                }
            }
            _ => unreachable!(),
        }
        if let Some(old) = &previous {
            if *old == task {
                return Err(invalid("No occurrence fields changed"));
            }
            task.version = old.version + 1;
        }
        task.updated_at = now();
        let result = record_change(
            tx,
            "update_occurrence",
            &input.reason,
            previous,
            task,
            None,
            origin,
            &input.request_id,
        )?;
        mark_group(tx, first)?;
        return Ok(result);
    }
    if input.expected_occurrence_version.is_some() || input.scheduled_date.is_some() {
        return Err(invalid(
            "Occurrence version and scheduled_date require scope=this",
        ));
    }
    if input.scope == Scope::All && input.original_date.is_some() {
        return Err(invalid("original_date requires scope=this or following"));
    }
    let anchor = if input.scope == Scope::Following {
        input
            .original_date
            .clone()
            .ok_or_else(|| invalid("Following scope requires original_date"))?
    } else {
        data.segments.first().unwrap().from.clone()
    };
    match input.action {
        RepeatAction::Edit => {
            if input.rule.is_none()
                && input.template.is_none()
                && input.agent_notes.is_none()
                && input.brief.is_none()
            {
                return Err(invalid("Supply a rule or defaults"));
            }
            let all = occurrences(tx, &before.id)?;
            if input.scope == Scope::Following
                && !all
                    .iter()
                    .any(|task| task.occurrence.as_ref().unwrap().original_date == anchor)
            {
                let mut underlying = data.clone();
                underlying.pauses.clear();
                underlying.ended_on = None;
                if !schedule(&underlying, "2000-01-01", "2199-12-31", 74000)?
                    .iter()
                    .any(|(original, _, _)| *original == anchor)
                {
                    return Err(invalid(
                        "Following original_date is not part of this series",
                    ));
                }
            }
            if input.rule.is_some() {
                require_caught_up(tx, &before)?;
            }
            // Series segments divide the schedule by its calendar dates; a following
            // edit selects by immutable identity even after a previous rule moved it.
            let schedule_anchor = identity_date(data, &anchor);
            let source = data
                .segments
                .iter()
                .rev()
                .find(|s| s.from <= schedule_anchor)
                .unwrap_or(&data.segments[0])
                .clone();
            let mut rule = input.rule.clone().unwrap_or_else(|| source.rule.clone());
            // A defaults-only following edit retains the original COUNT anchor.
            if input.rule.is_some()
                && input.scope == Scope::Following
                && rule.start_date < schedule_anchor
            {
                return Err(invalid(
                    "Following schedule must start on or after this occurrence's current schedule date",
                ));
            }
            if input.scope == Scope::All && input.rule.is_none() {
                rule = data.segments[0].rule.clone()
            }
            let t = merge_template(
                &source.template,
                input.template.as_ref(),
                input.agent_notes.as_ref(),
                input.brief.as_ref(),
                tx.policy(),
            )?;
            let boundary = if input.scope == Scope::All {
                rule.start_date.clone()
            } else {
                schedule_anchor.clone()
            };
            let source_key = content::segment_key(&source);
            let splitting = input.scope == Scope::Following
                && !data.segments.iter().any(|s| s.from == boundary);
            let content_key = if splitting {
                Uuid::new_v4().to_string()
            } else {
                source_key
            };
            let mut segment = Segment {
                content_key: Some(content_key),
                from: boundary.clone(),
                rule: rule.clone(),
                template: t.clone(),
                replacements: if input.rule.is_none() {
                    source.replacements
                } else {
                    BTreeMap::new()
                },
            };
            let eligible: Vec<_> = all
                .iter()
                .filter(|x| {
                    !x.deleted
                        && x.status != Status::Done
                        && (input.scope == Scope::All
                            || x.occurrence.as_ref().unwrap().original_date >= anchor)
                })
                .collect();
            let candidates = if input.rule.is_some() {
                dates(
                    &rule,
                    &boundary,
                    "2199-12-31",
                    eligible.len().saturating_add(all.len()).saturating_add(1),
                )?
            } else {
                vec![]
            };
            let protected: BTreeSet<_> = all
                .iter()
                .filter(|x| !eligible.iter().any(|a| a.id == x.id))
                .map(|x| x.occurrence.as_ref().unwrap().original_date.clone())
                .collect();
            let mut candidate = candidates.into_iter().filter(|d| !protected.contains(d));
            for old in eligible {
                let mut task = old.clone();
                let o = task.occurrence.as_mut().unwrap();
                if input.rule.is_some() {
                    let d=candidate.next().ok_or_else(||invalid("New rule has fewer remaining occurrences than stored unfinished tasks; resolve those tasks first"))?;
                    segment
                        .replacements
                        .insert(d.clone(), o.original_date.clone());
                    if !o.overrides.iter().any(|x| x == "scheduled_date") {
                        o.scheduled_date = d;
                    }
                }
                let scheduled = task.occurrence.as_ref().unwrap().scheduled_date.clone();
                let original = &task.occurrence.as_ref().unwrap().original_date;
                let identity = identity_date(data, original);
                let base = data
                    .segments
                    .iter()
                    .rev()
                    .find(|s| s.from <= identity)
                    .unwrap_or(&data.segments[0]);
                let mut defaults = if input.rule.is_none() {
                    merge_template(
                        &base.template,
                        input.template.as_ref(),
                        input.agent_notes.as_ref(),
                        input.brief.as_ref(),
                        tx.policy(),
                    )?
                } else {
                    t.clone()
                };
                // Unrequested working-note changes must not rewrite stored occurrences.
                if input.brief.is_none()
                    && input.template.as_ref().is_none_or(|t| t.brief.is_none())
                {
                    defaults.brief = None;
                }
                if !notes_supplied {
                    defaults.agent_notes = None;
                }
                apply_defaults(&mut task, &defaults, &scheduled)?;
                if task != *old {
                    save(
                        tx,
                        old.clone(),
                        task,
                        "update_occurrence",
                        &input.reason,
                        origin,
                        &input.request_id,
                    )?;
                }
            }
            if input.rule.is_none() {
                // Defaults edits do not replace previously chosen schedule segments
                // or restart their COUNT. Split only the segment containing the boundary.
                if input.scope == Scope::Following
                    && !data.segments.iter().any(|s| s.from == boundary)
                {
                    data.segments.push(segment);
                    data.segments.sort_by(|a, b| a.from.cmp(&b.from));
                }
                for segment in &mut data.segments {
                    if input.scope == Scope::All || segment.from >= boundary {
                        segment.template = merge_template(
                            &segment.template,
                            input.template.as_ref(),
                            input.agent_notes.as_ref(),
                            input.brief.as_ref(),
                            tx.policy(),
                        )?;
                    }
                }
            } else {
                // A rule replacement changes the schedule, not independent content
                // defaults. Retain later content boundaries and their exemption
                // lineage while using one COUNT-anchored replacement rule.
                let mut retained = Vec::new();
                if input.scope == Scope::All {
                    for (i, old) in data.segments.iter().enumerate() {
                        let mut next = old.clone();
                        if i == 0 {
                            next.from = next.from.min(boundary.clone());
                        }
                        next.rule = rule.clone();
                        next.replacements = segment.replacements.clone();
                        next.template = merge_template(
                            &old.template,
                            input.template.as_ref(),
                            input.agent_notes.as_ref(),
                            input.brief.as_ref(),
                            tx.policy(),
                        )?;
                        retained.push(next);
                    }
                } else {
                    retained.extend(data.segments.iter().filter(|s| s.from < boundary).cloned());
                    retained.push(segment.clone());
                    for old in data.segments.iter().filter(|s| s.from > boundary) {
                        let mut next = old.clone();
                        next.rule = rule.clone();
                        next.replacements = segment.replacements.clone();
                        next.template = merge_template(
                            &old.template,
                            input.template.as_ref(),
                            input.agent_notes.as_ref(),
                            input.brief.as_ref(),
                            tx.policy(),
                        )?;
                        retained.push(next);
                    }
                }
                data.segments = retained;
            }
            validate_identities(data)?;
            validate_schedule_planning(data)?;
            if input.template.is_some() || input.rule.is_some() {
                after.title = t.title.clone();
                after.notes = t.notes.clone();
                after.links = t.links.clone();
                after.location = t.location.clone();
                after.project_id = t.project_id.clone();
                after.status = t.status;
                after.manual_block = matches!(t.status, Status::Blocked | Status::Planned);
            }
            after.brief = data
                .segments
                .last()
                .and_then(|s| s.template.brief.clone())
                .unwrap_or_default();
            after.agent_notes = data
                .segments
                .last()
                .and_then(|s| s.template.agent_notes.clone())
                .unwrap_or_default();
        }
        RepeatAction::Pause | RepeatAction::Resume | RepeatAction::End => {
            if input.scope != Scope::All
                || input.rule.is_some()
                || input.template.is_some()
                || input.original_date.is_some()
            {
                return Err(invalid(
                    "Pause, resume, and end use scope=all without rule or occurrence fields",
                ));
            }
            let day = data
                .date_at(crate::clock::now())
                .map_err(StoreError::Invalid)?;
            match input.action {
                RepeatAction::Pause => {
                    if data.pauses.iter().any(|p| p.through.is_none()) || data.ended_on.is_some() {
                        return Err(invalid("Series is already paused or ended"));
                    }
                    require_caught_up(tx, &before)?;
                    data.pauses.push(Pause {
                        from: day,
                        through: None,
                    });
                }
                RepeatAction::Resume => {
                    if data.ended_on.is_some() {
                        return Err(invalid(
                            "An ended series cannot be resumed; undo its ending first",
                        ));
                    }
                    let p = data
                        .pauses
                        .iter_mut()
                        .find(|p| p.through.is_none())
                        .ok_or_else(|| invalid("Series is not paused"))?;
                    p.through = Some(
                        date(&day)?
                            .checked_sub_days(Days::new(1))
                            .unwrap()
                            .to_string(),
                    );
                }
                RepeatAction::End => {
                    if data.ended_on.is_some() {
                        return Err(invalid("Series is already ended"));
                    }
                    require_caught_up(tx, &before)?;
                    data.ended_on = Some(
                        date(&day)?
                            .checked_add_days(Days::new(1))
                            .unwrap()
                            .to_string(),
                    );
                }
                _ => unreachable!(),
            }
        }
        _ => return Err(invalid("Skip and unskip require scope=this")),
    }
    if after == before {
        return Err(invalid("No series fields changed"));
    }
    let result = save(
        tx,
        before,
        after,
        "update_recurrence",
        &input.reason,
        origin,
        &input.request_id,
    )?;
    mark_group(tx, first)?;
    Ok(result)
}
impl Store {
    fn list_recurrence_series(&mut self, input: ListOccurrences) -> Result<Value> {
        if input.from.is_some() || input.through.is_some() {
            return Err(invalid("Date bounds require series_id or a rule preview"));
        }
        let limit = page_size(Some(input.limit.unwrap_or(20)))? as usize;
        let tx = self.connection.transaction()?;
        let key = reads::query_key(&input)?;
        let (high, offset) =
            reads::pagination(&tx, input.cursor.as_deref(), "recurrences", &key, 0)?;
        let evaluated_at = input
            .cursor
            .as_deref()
            .map(|c| reads::decode(&tx, c))
            .transpose()?
            .and_then(|c| c.evaluated_at)
            .unwrap_or_else(crate::clock::timestamp);
        let sql = format!(
            "{} SELECT document FROM records WHERE entity_type='recurrence' AND json_extract(document,'$.deleted')=0 ORDER BY created_seq,entity_id LIMIT ?2 OFFSET ?3",
            reads::SOURCE
        );
        let rows = tx
            .prepare(&sql)?
            .query_map(params![high, (limit + 1) as i64, offset as i64], |row| {
                row.get::<_, String>(0)
            })?
            .map(|row| Ok(serde_json::from_str::<Task>(&row?)?))
            .collect::<Result<Vec<_>>>()?;
        let mut more = rows.len() > limit;
        let mut series = rows
            .iter()
            .take(limit)
            .map(|task| {
                if input.agent_context {
                    crate::projection::agent_record_at(task, &evaluated_at)
                } else {
                    crate::projection::record(task, Detail::Summary)
                }
            })
            .collect::<Vec<_>>();
        loop {
            let next = if more {
                Some(reads::encode(&{
                    let mut c = reads::make(
                        &tx,
                        "recurrences",
                        high,
                        offset + series.len() as u64,
                        key.clone(),
                    )?;
                    c.evaluated_at = Some(evaluated_at.clone());
                    c
                }))
            } else {
                None
            };
            let response = json!({"series_list":series,"next_cursor":next,"complete":!more,"timezone":"America/New_York"});
            if series.len() <= 1
                || serde_json::to_vec(&response)?.len() <= crate::projection::PAGE_BYTES
            {
                return Ok(response);
            }
            series.pop();
            more = true;
        }
    }
    pub fn create_recurrence(&mut self, input: CreateRecurrence) -> Result<MutationResult> {
        Ok(serde_json::from_value(self.execute_operation(
            mutation::Operation::CreateRecurrence(input),
        )?)?)
    }
    pub fn update_recurrence(&mut self, input: UpdateRecurrence) -> Result<MutationResult> {
        Ok(serde_json::from_value(self.execute_operation(
            mutation::Operation::UpdateRecurrence(input),
        )?)?)
    }
    pub fn materialize_recurrences(&mut self, through: &str) -> Result<usize> {
        date(through)?;
        let tx = WriteTransaction::with_policy(
            self.connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?,
            self.content_policy,
        )?;
        let docs=tx.prepare("SELECT document FROM tasks WHERE json_extract(document,'$.entity_type')='recurrence' AND json_extract(document,'$.deleted')=0")?.query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut total = 0;
        for doc in docs {
            let s: Task = serde_json::from_str(&doc)?;
            let key = format!("recurrence:{}", s.id);
            let checkpoint = format!("{}:{through}", s.version);
            if tx
                .query_row("SELECT value FROM search_state WHERE key=?1", [&key], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
                .as_deref()
                == Some(&checkpoint)
            {
                continue;
            }
            let first = high(&tx)?;
            let remaining = 100 - total;
            let count = materialize(
                &tx,
                &s,
                through,
                "worker",
                &Uuid::new_v4().to_string(),
                remaining,
            )?;
            mark_group(&tx, first)?;
            total += count;
            if count < remaining {
                tx.execute("INSERT INTO search_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,checkpoint])?;
            }
            if total >= 100 {
                break;
            }
        }
        tx.finish()?;
        tx.commit()?;
        Ok(total)
    }
    pub fn list_occurrences(&mut self, input: ListOccurrences) -> Result<Value> {
        if input.segments_only {
            return self.list_content_segments(input);
        }
        if input.template.is_some() && input.rule.is_none() {
            return Err(invalid("Preview template requires rule"));
        }
        if let Some(t) = &input.template {
            let mut checked = t.clone();
            if checked.title.is_empty() {
                checked.title = "Timing preview".into();
            }
            template(&checked)?;
        }
        if input.series_id.is_none() && input.rule.is_none() {
            return self.list_recurrence_series(input);
        }
        let limit = page_size(Some(input.limit.unwrap_or(20)))? as usize;
        let cursor = input
            .cursor
            .as_deref()
            .map(|value| {
                if value.len() > 24000 {
                    return Err(StoreError::ResetRequired);
                }
                serde_json::from_str::<OccurrenceCursor>(value)
                    .map_err(|_| StoreError::ResetRequired)
            })
            .transpose()?;
        let from = input
            .from
            .clone()
            .or_else(|| cursor.as_ref().map(|c| c.from.clone()))
            .unwrap_or_else(today);
        let through = input
            .through
            .clone()
            .or_else(|| cursor.as_ref().map(|c| c.through.clone()))
            .unwrap_or_else(|| "2199-12-31".into());
        if cursor
            .as_ref()
            .is_some_and(|c| c.from != from || c.through != through)
        {
            return Err(invalid("cursor requires unchanged date bounds"));
        }
        date(&from)?;
        date(&through)?;
        if from > through {
            return Err(invalid("from follows through"));
        }
        if input.series_id.is_some() == input.rule.is_some() {
            return Err(invalid("Provide series_id or a rule preview"));
        }
        let tx = self.connection.transaction()?;
        // Use the same authenticated store/history cursor envelope as ordinary reads.
        let mut normalized = input.clone();
        normalized.from = Some(from.clone());
        normalized.through = Some(through.clone());
        let key = reads::query_key(&normalized)?;
        let (h, offset) = reads::pagination(
            &tx,
            cursor.as_ref().map(|c| c.cursor.as_str()),
            "occurrences",
            &key,
            0,
        )?;
        let evaluated_at = cursor
            .as_ref()
            .map(|c| reads::decode(&tx, &c.cursor))
            .transpose()?
            .and_then(|c| c.evaluated_at)
            .unwrap_or_else(crate::clock::timestamp);
        let s = if let Some(id) = &input.series_id {
            let doc:String=tx.query_row("SELECT document FROM revisions WHERE entity_id=?1 AND seq<=?2 ORDER BY seq DESC LIMIT 1",params![id,h],|r|r.get(0)).optional()?.ok_or_else(||StoreError::NotFound("Series not found".into()))?;
            let task: Task = serde_json::from_str(&doc)?;
            if task.entity_type != EntityType::Recurrence || task.deleted {
                return Err(invalid("Invalid series"));
            }
            Some(task)
        } else {
            None
        };
        let default_template = Template {
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
            status: Status::Next,
        };
        let raw = if let Some(s) = &s {
            schedule(s.recurrence.as_ref().unwrap(), &from, &through, 74000)?
        } else {
            dates(
                input.rule.as_ref().unwrap(),
                &from,
                &through,
                (offset as usize).saturating_add(limit + 1),
            )?
            .into_iter()
            .map(|d| {
                (
                    d.clone(),
                    d,
                    input.template.as_ref().unwrap_or(&default_template),
                )
            })
            .collect()
        };
        // Resolve only the returned page. Never clone full descriptions into tens
        // of thousands of future previews when the caller asks for five dates.
        let mut templates = BTreeMap::new();
        let mut items = BTreeMap::<String, Value>::new();
        for (original, d, template) in raw {
            templates.insert(original.clone(), template);
            items.insert(
                original.clone(),
                json!({"original_date":original,"scheduled_date":d,"preview":true}),
            );
        }
        if let Some(s) = &s {
            let sql = format!(
                "{} SELECT document FROM records WHERE json_extract(document,'$.occurrence.series_id')=?2",
                reads::SOURCE
            );
            let docs = tx
                .prepare(&sql)?
                .query_map(params![h, s.id], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for doc in docs {
                let t: Task = serde_json::from_str(&doc)?;
                let o = t.occurrence.as_ref().unwrap();
                items.remove(&o.original_date);
                if !t.deleted && o.scheduled_date >= from && o.scheduled_date <= through {
                    items.insert(o.original_date.clone(),json!({"original_date":o.original_date,"scheduled_date":o.scheduled_date,"preview":false,"task":if input.agent_context {crate::projection::agent_record_at(&t,&evaluated_at)} else {crate::projection::record(&t,Detail::Summary)}}));
                }
            }
        }
        let mut rows = items.into_values().collect::<Vec<_>>();
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
            .skip(offset as usize)
            .take(limit + 1)
            .collect::<Vec<_>>();
        let mut more = rows.len() > limit;
        rows.truncate(limit);
        for row in &mut rows {
            if row["preview"] == true {
                let t = templates[row["original_date"].as_str().unwrap()];
                let d = row["scheduled_date"].as_str().unwrap();
                let due = shifted(d, t.due_offset_days)?;
                let (planning, adjustments) = t
                    .planning
                    .materialize(d, due.as_deref())
                    .map_err(StoreError::Invalid)?;
                planning
                    .validate(due.as_deref())
                    .map_err(StoreError::Invalid)?;
                row["planning"] = json!(planning);
                row["due_date"] = json!(due);
                row["timing_adjustments"] = json!(adjustments);
            }
        }
        let mut series = s.as_ref().map(|t| {
            if input.agent_context {
                return crate::projection::agent_record_at(t, &evaluated_at);
            }
            crate::projection::record_with_agent_notes(
                t,
                if offset == 0 {
                    Detail::Full
                } else {
                    Detail::Summary
                },
                input.include_agent_notes,
            )
        });
        let series_omitted = !input.agent_context
            && !input.include_agent_notes
            && series.as_ref().is_some_and(|value| {
                serde_json::to_vec(value).unwrap().len() > crate::projection::PAGE_BYTES / 2
            });
        if series_omitted {
            series = s
                .as_ref()
                .map(|t| crate::projection::record(t, Detail::Summary));
        }
        loop {
            let next = if more {
                Some(serde_json::to_string(&OccurrenceCursor {
                    cursor: reads::encode(&{
                        let mut c = reads::make(
                            &tx,
                            "occurrences",
                            h,
                            offset + rows.len() as u64,
                            key.clone(),
                        )?;
                        c.evaluated_at = Some(evaluated_at.clone());
                        c
                    }),
                    from: from.clone(),
                    through: through.clone(),
                })?)
            } else {
                None
            };
            let mut response = json!({"series":series,"occurrences":rows,"next_cursor":next,"complete":!more,"timezone":"America/New_York","from":from,"through":through});
            if series_omitted {
                response["series_omitted"] = json!(true);
                response["series_detail"] = json!({"tool":"list_changes","change_id":s.as_ref().unwrap().last_change_id,"detail":"full"});
            }
            if rows.len() <= 1
                || serde_json::to_vec(&response)?.len() <= crate::projection::PAGE_BYTES
            {
                return Ok(response);
            }
            rows.pop();
            more = true;
        }
    }
}

fn repair_segment(
    tx: &impl Mutation,
    input: UpdateRecurrence,
    before: Task,
    origin: &str,
) -> Result<MutationResult> {
    if input.action != RepeatAction::Edit
        || input.brief.is_none()
        || input.segment_from.is_none()
        || input.rule.is_some()
        || input.template.is_some()
        || input.agent_notes.is_some()
        || input.original_date.is_some()
        || input.expected_occurrence_version.is_some()
        || input.scheduled_date.is_some()
    {
        return Err(invalid(
            "Segment scope requires only brief and segment_from with action=edit",
        ));
    }
    let first = high(tx)?;
    let mut after = before.clone();
    let data = after.recurrence.as_mut().unwrap();
    let index = data
        .segments
        .iter()
        .position(|s| Some(&s.from) == input.segment_from.as_ref())
        .ok_or_else(|| invalid("Segment not found at this version; reread the series"))?;
    let old = &before.recurrence.as_ref().unwrap().segments[index];
    let end = data.segments.get(index + 1).map(|s| s.from.clone());
    content::validate_replacement(
        input.brief.as_deref(),
        data.segments[index].template.status != Status::Inbox,
    )?;
    data.segments[index].template.brief = input.brief.clone();
    for task in occurrences(tx, &before.id)? {
        if task.deleted
            || task.status == Status::Done
            || task
                .occurrence
                .as_ref()
                .unwrap()
                .overrides
                .iter()
                .any(|s| s == "brief")
        {
            continue;
        }
        let date = identity_date(
            before.recurrence.as_ref().unwrap(),
            &task.occurrence.as_ref().unwrap().original_date,
        );
        if date >= old.from && end.as_ref().is_none_or(|end| date < *end) {
            let mut updated = task.clone();
            updated.brief = input.brief.clone().unwrap();
            if updated != task {
                save(
                    tx,
                    task,
                    updated,
                    "update_occurrence",
                    &input.reason,
                    origin,
                    &input.request_id,
                )?;
            }
        }
    }
    after.brief = data
        .segments
        .last()
        .and_then(|s| s.template.brief.clone())
        .unwrap_or_default();
    if after == before {
        return Err(invalid("No series fields changed"));
    }
    let result = save(
        tx,
        before,
        after,
        "update_recurrence",
        &input.reason,
        origin,
        &input.request_id,
    )?;
    mark_group(tx, first)?;
    Ok(result)
}

impl Store {
    fn list_content_segments(&mut self, input: ListOccurrences) -> Result<Value> {
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
        let limit = page_size(input.limit)? as usize;
        let tx = self.connection.transaction()?;
        let key = reads::query_key(&input)?;
        let (h, offset) = reads::pagination(&tx, input.cursor.as_deref(), "segments", &key, 0)?;
        let doc:String=tx.query_row("SELECT document FROM revisions WHERE entity_id=?1 AND seq<=?2 ORDER BY seq DESC LIMIT 1",params![input.series_id,h],|r|r.get(0)).optional()?.ok_or_else(||invalid("Series not found"))?;
        let task: Task = serde_json::from_str(&doc)?;
        let data = task
            .recurrence
            .as_ref()
            .filter(|_| !task.deleted)
            .ok_or_else(|| invalid("Series not found"))?;
        let candidates = data
            .segments
            .iter()
            .skip(offset as usize)
            .take(limit + 1)
            .collect::<Vec<_>>();
        let mut more = candidates.len() > limit;
        let mut rows = candidates
            .iter()
            .take(limit)
            .map(|s| json!({"from":s.from,"rule":s.rule,"template":s.template}))
            .collect::<Vec<_>>();
        for row in &mut rows {
            if row["template"]["brief"].is_null() {
                row["template"]["brief"] = json!("");
            }
            if row["template"]["agent_notes"].is_null() {
                row["template"]["agent_notes"] = json!("");
            }
        }
        loop {
            let cursor = if more {
                Some(reads::encode(&reads::make(
                    &tx,
                    "segments",
                    h,
                    offset + rows.len() as u64,
                    key.clone(),
                )?))
            } else {
                None
            };
            let response = json!({"series_id":task.id,"version":task.version,"segments":rows,"next_cursor":cursor,"complete":!more});
            if rows.len() <= 1
                || serde_json::to_vec(&response)?.len() <= crate::projection::PAGE_BYTES
            {
                return Ok(response);
            }
            rows.pop();
            more = true;
        }
    }
}
