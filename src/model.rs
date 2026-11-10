use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    Inbox,
    Next,
    Waiting,
    Blocked,
    /// Legacy input and historical value; current records normalize to Blocked.
    Planned,
    /// Project lifecycle only; tasks use next/blocked/inbox/waiting.
    Active,
    Someday,
    Done,
    /// Legacy input alias for archived=true. Returned task status preserves workflow state.
    Archived,
}

impl Status {
    pub fn current(self) -> Self {
        if self == Self::Planned {
            Self::Blocked
        } else {
            self
        }
    }
}

/// GTD workflow: inbox is unclarified; next is ready; blocked is committed but not
/// ready; waiting has an external blocker; someday is uncommitted; done is complete.
/// Projects have their own lifecycle. archived is a legacy archive-membership alias.
#[derive(JsonSchema)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum TaskStatus {
    Inbox,
    Next,
    Waiting,
    Blocked,
    Someday,
    Done,
    Archived,
}

/// Workflow states for task filtering. Archive membership is filtered separately.
#[derive(JsonSchema)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum TaskFilterStatus {
    Inbox,
    Next,
    Waiting,
    Blocked,
    Someday,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskLink {
    /// Absolute HTTP/HTTPS URL, up to 2048 characters. No embedded credentials.
    pub url: String,
    /// Optional concise display label, up to 120 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EntityType {
    #[default]
    Task,
    Project,
    Recurrence,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Task {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_by: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub manual_block: bool,
    #[serde(default, skip_deserializing, skip_serializing_if = "Vec::is_empty")]
    pub unresolved_blocker_ids: Vec<String>,
    #[serde(default, flatten)]
    pub planning: crate::planning::Planning,
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub recommendation: Option<crate::planning::Recommendation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub timing_adjustments: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_occurrence_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<crate::recurrence_model::Series>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence: Option<crate::recurrence_model::Occurrence>,
    #[serde(default)]
    pub entity_type: EntityType,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub review_date: Option<String>,
    #[serde(default)]
    pub work_sessions: Vec<TaskLink>,
    #[serde(default)]
    pub completion_result: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    pub id: String,
    pub title: String,
    pub notes: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub brief: String,
    /// Agent working context, separate from the human description.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent_notes: String,
    #[serde(default)]
    pub links: Vec<TaskLink>,
    #[serde(default)]
    pub location: Option<String>,
    pub status: Status,
    /// Archive membership is independent of completion/workflow status.
    #[serde(default)]
    pub archived: bool,
    pub due_date: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Undoing capture hides a task but preserves its data and audit trail.
    pub deleted: bool,
    pub last_change_id: i64,
}

// Recommendation metadata is evaluated at read time, not a record revision.
impl PartialEq for Task {
    fn eq(&self, other: &Self) -> bool {
        self.blocked_by == other.blocked_by
            && self.manual_block == other.manual_block
            && self.planning == other.planning
            && self.timing_adjustments == other.timing_adjustments
            && self.pending_occurrence_count == other.pending_occurrence_count
            && self.recurrence == other.recurrence
            && self.occurrence == other.occurrence
            && self.entity_type == other.entity_type
            && self.project_id == other.project_id
            && self.review_date == other.review_date
            && self.work_sessions == other.work_sessions
            && self.completion_result == other.completion_result
            && self.completed_at == other.completed_at
            && self.id == other.id
            && self.title == other.title
            && self.notes == other.notes
            && self.brief == other.brief
            && self.agent_notes == other.agent_notes
            && self.links == other.links
            && self.location == other.location
            && self.status == other.status
            && self.archived == other.archived
            && self.due_date == other.due_date
            && self.version == other.version
            && self.created_at == other.created_at
            && self.updated_at == other.updated_at
            && self.deleted == other.deleted
            && self.last_change_id == other.last_change_id
    }
}
impl Eq for Task {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = crate::planning::require_importance)]
pub struct CaptureItem {
    /// Up to 50 distinct prerequisite task IDs. Omit/null preserves; [] clears. All must be completed for readiness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<Vec<String>>,
    #[serde(default, flatten)]
    pub planning: crate::planning::PlanningPatch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_date: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub work_sessions: Vec<TaskLink>,
    /// Optional resolution; valid only when done, at most 2000 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_result: Option<String>,

    /// Unique retry key for this intent. Reuse the exact key AND arguments on retry.
    pub request_id: String,
    /// Concise action title, 1–500 characters.
    pub title: String,
    /// Human-readable description; supports lightweight Markdown. Up to 10000 characters.
    #[serde(default)]
    pub notes: String,
    /// Agent working notes, up to 10000 characters. Omit/null preserves on update; empty clears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_notes: Option<String>,
    /// Short human brief, at most 600 Unicode characters. Omit/null preserves on updates; required outside Inbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,

    /// Actionable resources in display order; up to 20 links.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<TaskLink>,
    /// Optional place/address, up to 1000 characters; opens a Maps search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default)]
    #[schemars(with = "TaskStatus")]
    pub status: Status,
    /// Store in the archive without changing workflow status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    /// Optional calendar date YYYY-MM-DD; no time-of-day or timezone conversion.
    pub due_date: Option<String>,
    /// Why this change is being made; distinguish agent inference from user instruction.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateItem {
    /// Up to 50 distinct prerequisite task IDs. Omit/null preserves; [] clears. All must be completed for readiness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<Vec<String>>,
    #[serde(default, flatten)]
    pub planning: crate::planning::PlanningPatch,
    /// Omit/null preserves; clear_project removes membership.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub clear_project: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_date: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub clear_review_date: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_sessions: Option<Vec<TaskLink>>,
    /// Omit preserves; empty string clears. Read full details before replacement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_result: Option<String>,

    pub request_id: String,
    pub task_id: String,
    /// Version from the latest list result. A stale version fails without writing.
    pub expected_version: i64,
    pub title: Option<String>,
    /// Human-readable description; supports lightweight Markdown. Omit/null preserves; empty clears.
    pub notes: Option<String>,
    /// Agent working notes, up to 10000 characters. Omit/null preserves on update; empty clears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_notes: Option<String>,
    /// Short human brief, at most 600 Unicode characters. Omit/null preserves on updates; required outside Inbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,

    /// Omit/null preserves links; an empty list removes all. Read full details before replacing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<TaskLink>>,
    /// Omit/null preserves location; an empty string removes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[schemars(with = "Option<TaskStatus>")]
    pub status: Option<Status>,
    /// Omit to preserve archive membership; false restores to ordinary lists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    /// Omit/null preserves the date. Use clear_due_date to remove it.
    pub due_date: Option<String>,
    #[serde(default)]
    pub clear_due_date: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UndoChange {
    pub request_id: String,
    /// Change to reverse; must still be this record's latest change.
    pub change_id: i64,
    pub expected_version: i64,
    pub reason: String,
}

/// One retry key for the batch; each record may change at most once, including scoped secondary changes.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplyChanges {
    /// Reuse this key and every operation unchanged after uncertain delivery.
    pub request_id: String,
    /// 1–50 task, project or recurrence operations. All succeed together or none is saved.
    pub operations: Vec<BatchOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum BatchOperation {
    #[schemars(transform = crate::planning::require_importance)]
    Capture {
        /// Prerequisite task IDs; omitted/null preserves and [] clears. At most 50 distinct IDs.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blocked_by: Option<Vec<String>>,
        #[serde(default, flatten)]
        planning: crate::planning::PlanningPatch,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        review_date: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        work_sessions: Vec<TaskLink>,
        /// Optional resolution; valid only when done, at most 2000 characters.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completion_result: Option<String>,
        title: String,
        /// Human-readable description; supports lightweight Markdown. Up to 10000 characters.
        #[serde(default)]
        notes: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_notes: Option<String>,
        /// Short human brief, at most 600 Unicode characters. Omit/null preserves on updates; required outside Inbox.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        brief: Option<String>,

        /// Actionable resources in display order; up to 20 links.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        links: Vec<TaskLink>,
        /// Optional place/address, up to 1000 characters; opens a Maps search.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        location: Option<String>,
        #[serde(default)]
        #[schemars(with = "TaskStatus")]
        status: Status,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        archived: Option<bool>,
        due_date: Option<String>,
        reason: String,
    },
    Update {
        /// Prerequisite task IDs; omitted/null preserves and [] clears. At most 50 distinct IDs.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blocked_by: Option<Vec<String>>,
        #[serde(default, flatten)]
        planning: crate::planning::PlanningPatch,
        /// Omit/null preserves; clear_project removes membership.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        clear_project: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        review_date: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        clear_review_date: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        work_sessions: Option<Vec<TaskLink>>,
        /// Omit preserves; empty string clears. Read full details before replacement.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completion_result: Option<String>,
        task_id: String,
        expected_version: i64,
        title: Option<String>,
        /// Human-readable description; supports lightweight Markdown. Omit/null preserves; empty clears.
        notes: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_notes: Option<String>,
        /// Short human brief, at most 600 Unicode characters. Omit/null preserves on updates; required outside Inbox.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        brief: Option<String>,

        /// Omit/null preserves links; an empty list removes all. Read full details before replacing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        links: Option<Vec<TaskLink>>,
        /// Omit/null preserves location; an empty string removes it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        location: Option<String>,
        #[schemars(with = "Option<TaskStatus>")]
        status: Option<Status>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        archived: Option<bool>,
        due_date: Option<String>,
        #[serde(default)]
        clear_due_date: bool,
        reason: String,
    },
    CreateRecurrence {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_task_version: Option<i64>,
        #[schemars(with = "crate::recurrence_model::NewTemplate")]
        template: crate::recurrence_model::Template,
        rule: crate::recurrence_model::RepeatRule,
        reason: String,
    },
    UpdateRecurrence {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segment_from: Option<String>,
        series_id: String,
        expected_version: i64,
        scope: crate::recurrence_model::Scope,
        action: crate::recurrence_model::RepeatAction,
        original_date: Option<String>,
        expected_occurrence_version: Option<i64>,
        rule: Option<crate::recurrence_model::RepeatRule>,
        /// Replacement defaults, not a partial patch; read current defaults first. Omitted agent_notes preserves.
        template: Option<crate::recurrence_model::Template>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_notes: Option<String>,
        /// Short human brief, at most 600 Unicode characters. Omit/null preserves on updates; required outside Inbox.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        brief: Option<String>,

        scheduled_date: Option<String>,
        reason: String,
    },
    CreateProject {
        #[serde(flatten)]
        fields: ProjectFields,
        reason: String,
    },
    UpdateProject {
        project_id: String,
        expected_version: i64,
        #[serde(flatten)]
        fields: ProjectPatch,
        reason: String,
    },
    Undo {
        change_id: i64,
        expected_version: i64,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchResult {
    /// Results in operation order, each with its own task, audit ID, and reason.
    pub results: Vec<MutationResult>,
    /// Original committed snapshots; re-read before making further decisions.
    pub replayed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskView {
    Active,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Detail {
    Summary,
    Full,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskSort {
    Importance,
    Action,
    Relevance,
    Due,
    EffectiveDue,
    Updated,
    Created,
    CreatedDesc,
    Title,
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ListItems {
    #[serde(skip_deserializing, default, skip_serializing_if = "is_false")]
    #[schemars(skip)]
    pub agent_context: bool,
    /// Maximum estimated remaining active minutes, inclusive. Missing estimates do not match.
    pub max_estimated_minutes: Option<u32>,
    /// Maximum demandingness, inclusive. Missing effort does not match; ordinary priority is unchanged.
    pub max_effort: Option<crate::task_planning::Effort>,
    /// List direct dependents whose blocked_by contains this task ID. Use view=all to include every workflow state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by_id: Option<String>,
    /// Inclusive local planned-date range; matches overlapping blocks, excludes unscheduled tasks.
    pub planned_from: Option<String>,
    pub planned_through: Option<String>,
    /// Collapse unfinished occurrences of each series to one row, with pending_occurrence_count.
    #[serde(default, skip_serializing_if = "is_false")]
    pub group_recurrences: bool,
    /// Pass returned next_cursor here with unchanged filters. Omit on refresh.
    pub cursor: Option<String>,
    /// Select project members; use view=all for every task state.
    pub project_id: Option<String>,
    /// Inclusive review-date lower bound.
    pub review_from: Option<String>,
    pub review_through: Option<String>,
    /// All unfinished, unarchived items with review_date on/before this date.
    pub review_on: Option<String>,
    /// Restrict to one task, including when inspecting its history.
    pub task_id: Option<String>,
    /// Select 1–50 distinct tasks for a combined card. Cannot be combined with task_id.
    pub task_ids: Option<Vec<String>>,
    /// Exact workflow status. Use the archived flag for archive membership. Cannot combine with view.
    #[schemars(with = "Option<TaskStatus>")]
    pub status: Option<Status>,
    /// Exclude task workflow statuses. Combines with view, status, and archive filters; omitted or empty excludes none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<Vec<TaskFilterStatus>>")]
    pub exclude_statuses: Option<Vec<Status>>,
    /// true selects archived tasks, false excludes them. Omit excludes archive except
    /// for view=all or explicit task IDs. Combine with status=done for completed archive items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    /// Omit for active (next, inbox, waiting, blocked). all includes every status, not deleted.
    /// Explicit task IDs bypass the implicit active filter; explicit filters still apply.
    pub view: Option<TaskView>,
    /// Summary by default; a single task_id defaults to full (includes notes, links, location, timestamps).
    pub detail: Option<Detail>,
    /// Default action: readiness/status first, then importance plus bounded constraint urgency and deterministic timing ties.
    /// status=done or archived=true defaults to updated; text queries default to relevance. Explicit sort wins.
    pub sort: Option<TaskSort>,
    /// Plain keywords: 1–10 words, at most 500 characters; no quoted phrases or exclusion operators. All terms match with typo/accent tolerance and prefixes; default relevance order.
    pub query: Option<String>,
    /// Inclusive calendar-date bounds; undated tasks are excluded when supplied.
    pub due_from: Option<String>,
    pub due_through: Option<String>,
    #[serde(default)]
    pub undated: bool,
    /// Include tombstones created by undoing capture.
    #[serde(default)]
    pub include_deleted: bool,
    /// Include a separate page of audit changes for the selected task IDs.
    #[serde(default)]
    pub include_history: bool,
    /// Task page size: default 20, maximum 100. Pass next_cursor as cursor with unchanged filters.
    pub limit: Option<u32>,
    /// Legacy pagination; prefer cursor for a stable snapshot.
    #[serde(default)]
    pub offset: u32,
    /// History cursor, exclusive. Pass returned next_history_after here.
    #[serde(default)]
    pub history_after: i64,
    /// Default 50, maximum 100 audit changes per response.
    pub history_limit: Option<u32>,
    /// Include agent working notes in full records only. Omitted by default.
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_agent_notes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Change {
    #[serde(default)]
    pub entity_type: EntityType,
    pub id: i64,
    pub task_id: String,
    pub operation: String,
    pub reason: String,
    pub before: Option<Task>,
    pub after: Task,
    pub undoes_change_id: Option<i64>,
    pub created_at: String,
    /// Assigned by the service, never accepted from tool arguments.
    #[serde(default = "unknown_origin")]
    pub origin: String,
}

fn unknown_origin() -> String {
    "unknown".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ListChanges {
    #[serde(skip_deserializing, default, skip_serializing_if = "is_false")]
    #[schemars(skip)]
    pub agent_context: bool,
    /// Inclusive local calendar dates, or the previous N complete calendar days.
    #[serde(flatten)]
    pub range: crate::activity::Range,
    /// Continue a frozen history snapshot with unchanged filters.
    pub cursor: Option<String>,
    /// Select history belonging to committed requests, including automatic effects.
    pub from_request_ids: Option<Vec<String>>,
    /// Select one project's own history, not its member tasks.
    pub project_id: Option<String>,
    /// Filter record kind; use recurrence with task_id to select one series.
    pub entity_type: Option<EntityType>,
    /// Exact audit event; full before/after data is available with detail=full.
    pub change_id: Option<i64>,
    pub detail: Option<Detail>,
    /// Select one task; pair with entity_type=recurrence for a series ID.
    pub task_id: Option<String>,
    /// Pass returned next_before_id here to read older changes.
    pub before_id: Option<i64>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct ChangesResult {
    pub changes: Vec<Change>,
    pub next_before_id: Option<i64>,
    pub next_cursor: Option<String>,
    pub snapshot: String,
    pub window: crate::activity::Window,
    pub activity: std::collections::BTreeMap<i64, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationResult {
    pub task: Task,
    pub change: Change,
    /// True means the original committed result is being returned; no new write occurred.
    pub replayed: bool,
}

#[derive(Debug, Serialize)]
pub struct ListResult {
    pub effective_sort: String,
    /// Computed from the same graph as this page. Never part of stored tasks.
    #[serde(skip)]
    pub blocking_counts: std::collections::BTreeMap<String, usize>,
    pub evaluated_at: String,
    pub next_change_at: Option<String>,
    pub next_cursor: Option<String>,
    pub items: Vec<Task>,
    pub next_offset: Option<u32>,
    pub history: Vec<Change>,
    pub next_history_after: Option<i64>,
}

impl ListItems {
    pub fn effective_sort(&self) -> &'static str {
        match self.sort.unwrap_or({
            if self.query.as_ref().is_some_and(|q| !q.trim().is_empty()) {
                TaskSort::Relevance
            } else if self.review_on.is_some() {
                TaskSort::Review
            } else if matches!(self.status, Some(Status::Done | Status::Archived))
                || self.archived == Some(true)
            {
                TaskSort::Updated
            } else {
                TaskSort::Action
            }
        }) {
            TaskSort::Action => "action",
            TaskSort::Importance => "importance",
            TaskSort::Relevance => "relevance",
            TaskSort::Due => "due",
            TaskSort::Updated => "updated",
            TaskSort::Created => "created",
            TaskSort::CreatedDesc => "created_desc",
            TaskSort::EffectiveDue => "effective_due",
            TaskSort::Title => "title",
            TaskSort::Review => "review",
        }
    }
    pub fn effective_detail(&self) -> Detail {
        self.detail.unwrap_or(if self.task_id.is_some() {
            Detail::Full
        } else {
            Detail::Summary
        })
    }
    pub fn effective_scope(&self) -> String {
        if self.review_on.is_some() {
            return "review".into();
        }
        if self.archived == Some(true) {
            return "archived".into();
        }
        if let Some(status) = self.status {
            return serde_json::to_value(status)
                .unwrap()
                .as_str()
                .unwrap()
                .into();
        }
        match self.view {
            Some(TaskView::All) => "all",
            Some(TaskView::Active) => "active",
            None if self.task_id.is_some() || self.task_ids.is_some() => "selected",
            None => "active",
        }
        .into()
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStatus {
    #[default]
    Active,
    Someday,
    Done,
}
impl From<ProjectStatus> for Status {
    fn from(value: ProjectStatus) -> Self {
        match value {
            ProjectStatus::Active => Self::Active,
            ProjectStatus::Someday => Self::Someday,
            ProjectStatus::Done => Self::Done,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ProjectFields {
    pub title: String,
    /// Human-readable description; supports lightweight Markdown. Up to 10000 characters.
    #[serde(default)]
    pub notes: String,
    /// Agent working notes, up to 10000 characters. Omit/null preserves on update; empty clears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_notes: Option<String>,
    /// Short human brief, at most 600 Unicode characters. Omit/null preserves on updates; required outside Inbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,

    #[serde(default)]
    pub links: Vec<TaskLink>,
    #[serde(default)]
    pub status: ProjectStatus,
    #[serde(default)]
    pub archived: bool,
    pub due_date: Option<String>,
    pub review_date: Option<String>,
    pub completion_result: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ProjectPatch {
    pub title: Option<String>,
    /// Human-readable description; supports lightweight Markdown. Omit/null preserves; empty clears.
    pub notes: Option<String>,
    /// Agent working notes, up to 10000 characters. Omit/null preserves on update; empty clears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_notes: Option<String>,
    /// Short human brief, at most 600 Unicode characters. Omit/null preserves on updates; required outside Inbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,

    pub links: Option<Vec<TaskLink>>,
    pub status: Option<ProjectStatus>,
    pub archived: Option<bool>,
    pub due_date: Option<String>,
    #[serde(default)]
    pub clear_due_date: bool,
    pub review_date: Option<String>,
    #[serde(default)]
    pub clear_review_date: bool,
    pub completion_result: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateProject {
    pub request_id: String,
    #[serde(flatten)]
    pub fields: ProjectFields,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateProject {
    pub request_id: String,
    pub project_id: String,
    pub expected_version: i64,
    #[serde(flatten)]
    pub fields: ProjectPatch,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ListProjects {
    /// Explicit global ordering; omission preserves the existing view default.
    pub sort: Option<TaskSort>,
    #[serde(skip_deserializing, default, skip_serializing_if = "is_false")]
    #[schemars(skip)]
    pub agent_context: bool,
    /// Omit for active projects; all includes every retained lifecycle and archive.
    pub view: Option<TaskView>,
    pub project_id: Option<String>,
    pub status: Option<ProjectStatus>,
    pub archived: Option<bool>,
    #[serde(default)]
    pub include_deleted: bool,
    /// Plain keywords: 1–10 words, at most 500 characters; no quoted phrases or exclusion operators. All terms match with typo/accent tolerance and prefixes.
    pub query: Option<String>,
    /// Inclusive review-date lower bound.
    pub review_from: Option<String>,
    pub review_through: Option<String>,
    pub review_on: Option<String>,
    pub detail: Option<Detail>,
    /// Page size: default 20, maximum 100.
    pub limit: Option<u32>,
    /// Pass returned next_cursor here with unchanged filters. Omit on refresh.
    pub cursor: Option<String>,
    /// Include agent working notes in full records only. Omitted by default.
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_agent_notes: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct SyncState {
    #[serde(skip_deserializing, default, skip_serializing_if = "is_false")]
    #[schemars(skip)]
    pub agent_context: bool,
    /// Omit for an initial snapshot. Pass next_cursor here to continue a page, or the completed checkpoint to read subsequent changes.
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

/// Everyday application destination. Task/project entry points retain their existing filters.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GtdView {
    #[default]
    Home,
    Repeating,
    Review,
    Activity,
    Charts,
    Help,
    Results,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShowGtd {
    /// Opens Home by default. Other views load their data on demand.
    #[serde(default)]
    pub view: GtdView,
    /// Optional series to open; only valid with view=repeating.
    pub series_id: Option<String>,
    /// Required only for view=results: 1–50 committed request IDs whose directly returned records should be displayed.
    pub from_request_ids: Option<Vec<String>>,
    /// Continue Results using next_cursor with unchanged request IDs.
    pub cursor: Option<String>,
    /// Results page size, 1–100 (default 5).
    pub limit: Option<u32>,
}

/// Local syntax validation only; never fetch a record URL.
pub fn valid_resource_url(value: &str) -> bool {
    value.chars().count() <= 2048
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
        && (value.starts_with("https://") || value.starts_with("http://"))
        && url::Url::parse(value).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
        })
}
