use std::{collections::HashSet, path::Path, time::Duration};

use chrono::{NaiveDate, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::model::*;
#[path = "reads.rs"]
pub(crate) mod reads;
#[path = "records.rs"]
mod records;
#[path = "recurrence.rs"]
pub(crate) mod recurrence;
#[path = "search.rs"]
mod search;
use reads::*;
use records::*;
#[path = "write_transaction.rs"]
mod write_transaction;
use write_transaction::WriteTransaction;
#[path = "mutation.rs"]
pub(crate) mod mutation;
use mutation::{Mutation, RecordRead};
#[path = "activity_reads.rs"]
mod activity_reads;
#[path = "content.rs"]
pub mod content;
#[path = "dependencies.rs"]
pub(crate) mod dependencies;
#[path = "planning_migration.rs"]
mod planning_migration;
#[path = "view_reads.rs"]
mod view_reads;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("Checkpoint is invalid or belongs to a different history; start a fresh snapshot")]
    ResetRequired,
    #[error("Search is unavailable or still indexing; retry shortly")]
    SearchUnavailable,
    #[error("{0}")]
    Conflict(String),
    #[error("request_id has already been used with different arguments or a different tool")]
    RetryKeyConflict,
    #[error("Bulk change {index} failed: {source}. Nothing in this batch was saved.")]
    Batch {
        index: usize,
        source: Box<StoreError>,
    },
    #[error("database operation failed")]
    BackendStorage,
    #[error("database operation failed")]
    Database(#[from] rusqlite::Error),
    #[error("stored data could not be decoded")]
    Json(#[from] serde_json::Error),
    #[error("filesystem operation failed")]
    Io(#[from] std::io::Error),
}

impl StoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Batch { source, .. } => source.code(),
            Self::Invalid(_) => "invalid_input",
            Self::ResetRequired => "reset_required",
            Self::SearchUnavailable => "search_unavailable",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::RetryKeyConflict => "request_id_conflict",
            Self::BackendStorage | Self::Database(_) | Self::Json(_) | Self::Io(_) => {
                "storage_error"
            }
        }
    }
}

type Result<T> = std::result::Result<T, StoreError>;

pub struct Store {
    connection: Connection,
    origin: &'static str,
    content_policy: content::Policy,
}

impl Store {
    pub(crate) fn read_source(&self) -> Option<(std::path::PathBuf, &'static str, String)> {
        let path = self.connection.path().filter(|p| !p.is_empty())?;
        let identity: String = self
            .connection
            .query_row(
                "SELECT value FROM store_meta WHERE key='identity'",
                [],
                |r| r.get(0),
            )
            .ok()?;
        Some((path.into(), self.origin, identity))
    }
    pub(crate) fn connect_read(path: &Path, origin: &'static str, identity: &str) -> Result<Self> {
        // Do not create, migrate or silently reopen an absent/replaced database.
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let schema: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if schema != 11 {
            return Err(StoreError::Invalid(format!(
                "unsupported database schema {schema}"
            )));
        }
        let actual: String = connection.query_row(
            "SELECT value FROM store_meta WHERE key='identity'",
            [],
            |r| r.get(0),
        )?;
        if actual != identity {
            return Err(StoreError::ResetRequired);
        }
        crate::planning::register(&connection)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        Ok(Self {
            connection,
            origin,
            content_policy: content::Policy::Human,
        })
    }
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let mut connection = Connection::open(path)?;
        crate::planning::register(&connection)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let schema: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match schema {
            0 => tx.execute_batch(include_str!("schema.sql"))?,
            1..=11 => {}
            _ => {
                return Err(StoreError::Invalid(format!(
                    "unsupported database schema {schema}"
                )));
            }
        }
        if schema < 2 {
            migrate_archive(&tx)?;
        }
        if schema < 3 {
            migrate_records(&tx)?;
        }
        if schema < 4 {
            tx.execute_batch("CREATE TABLE action_groups(change_id INTEGER PRIMARY KEY REFERENCES changes(id),group_id TEXT NOT NULL); CREATE INDEX action_groups_group ON action_groups(group_id); CREATE TABLE search_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE search_sessions(id TEXT PRIMARY KEY,store TEXT NOT NULL,query TEXT NOT NULL,high INTEGER NOT NULL,expires INTEGER NOT NULL,ids TEXT NOT NULL); CREATE UNIQUE INDEX occurrence_identity ON tasks(json_extract(document,'$.occurrence.series_id'),json_extract(document,'$.occurrence.original_date')) WHERE json_extract(document,'$.occurrence') IS NOT NULL; PRAGMA user_version=4;")?;
        }
        // Older binaries must not overwrite records containing fields they do not understand.
        if schema < 6 {
            tx.pragma_update(None, "user_version", 6)?;
        }
        let environment = std::env::var("TODO_ENVIRONMENT").unwrap_or_else(|_| "production".into());
        if !["production", "test", "demo"].contains(&environment.as_str()) {
            return Err(StoreError::Invalid("invalid environment".into()));
        }
        tx.execute(
            "INSERT OR IGNORE INTO store_meta VALUES('environment',?1)",
            [if schema == 0 {
                environment.as_str()
            } else {
                "production"
            }],
        )?;
        let recorded: String = tx.query_row(
            "SELECT value FROM store_meta WHERE key='environment'",
            [],
            |r| r.get(0),
        )?;
        if recorded != environment {
            return Err(StoreError::Invalid("database environment mismatch".into()));
        }
        if schema < 7 {
            migrate_importance(&tx)?;
            tx.pragma_update(None, "user_version", 7)?;
        }
        if schema < 8 {
            dependencies::migrate(&tx)?;
            tx.pragma_update(None, "user_version", 8)?;
        }
        if schema < 9 {
            planning_migration::migrate(&tx)?;
            tx.pragma_update(None, "user_version", 9)?;
        }
        if schema < 11 {
            content::migrate(&tx)?;
            tx.pragma_update(None, "user_version", 11)?;
        }
        tx.commit()?;
        Ok(Self {
            connection,
            origin: "unknown",
            content_policy: content::Policy::Human,
        })
    }

    pub fn set_content_policy(&mut self, policy: content::Policy) {
        self.content_policy = policy;
    }

    pub fn with_origin(mut self, origin: &'static str) -> Self {
        self.origin = origin;
        self
    }

    pub fn environment(&self) -> String {
        self.connection
            .query_row(
                "SELECT value FROM store_meta WHERE key='environment'",
                [],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "unknown".into())
    }

    pub fn health(&self) -> Result<()> {
        self.connection
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0))?;
        Ok(())
    }

    fn execute_operation(&mut self, operation: mutation::Operation) -> Result<serde_json::Value> {
        let request = operation.fingerprint()?;
        let key = operation.key().to_owned();
        let tx = WriteTransaction::with_policy(
            self.connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?,
            self.content_policy,
        )?;
        if let Some(result) = replay(&tx, &key, &request)? {
            return Ok(result);
        }
        let result = operation.apply(&tx, self.origin)?;
        save_request(tx, &key, &request, result)
    }
    pub fn capture(&mut self, input: CaptureItem) -> Result<MutationResult> {
        Ok(serde_json::from_value(
            self.execute_operation(mutation::Operation::Capture(input))?,
        )?)
    }
    pub fn update(&mut self, input: UpdateItem) -> Result<MutationResult> {
        Ok(serde_json::from_value(
            self.execute_operation(mutation::Operation::Update(input))?,
        )?)
    }
    pub fn undo(&mut self, input: UndoChange) -> Result<MutationResult> {
        Ok(serde_json::from_value(
            self.execute_operation(mutation::Operation::Undo(input))?,
        )?)
    }
    pub fn apply_changes(&mut self, input: ApplyChanges) -> Result<BatchResult> {
        Ok(serde_json::from_value(
            self.execute_operation(mutation::Operation::Batch(input))?,
        )?)
    }

    /// Catch up timed readiness before a fresh snapshot. The worker invokes the
    /// same resolver; the transaction makes retries and concurrent readers idempotent.
    pub fn settle_availability(&mut self) -> Result<()> {
        // Explicit writes already resolve dependency changes. A read only needs
        // the writer transaction when a timed hold might have elapsed. Avoid
        // taking SQLite's writer lock and rebuilding the graph on every read.
        let due: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE json_extract(document,'$.entity_type')='task'
              AND json_extract(document,'$.status')='blocked'
              AND COALESCE(json_extract(document,'$.manual_block'),0)=0
              AND COALESCE(json_extract(document,'$.archived'),0)=0
              AND COALESCE(json_extract(document,'$.deleted'),0)=0
              AND COALESCE(json_extract(document,'$.occurrence.skipped'),0)=0
              AND json_extract(document,'$.not_before') IS NOT NULL
              AND gtd_availability_next(document,?1) IS NULL)",
            [crate::clock::timestamp()],
            |row| row.get(0),
        )?;
        if !due {
            return Ok(());
        }
        let tx = WriteTransaction::with_policy(
            self.connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?,
            self.content_policy,
        )?;
        tx.finish()?;
        tx.commit()
    }
    pub fn list(&mut self, input: ListItems) -> Result<ListResult> {
        if input.cursor.is_none() {
            self.settle_availability()?;
        }
        validate_query(&input)?;
        page_size(input.limit)?;
        if input.include_history {
            page_size(input.history_limit)?;
        }
        let search_high = if input.cursor.is_none() {
            input
                .query
                .as_deref()
                .filter(|q| !q.trim().is_empty())
                .map(|q| self.prepare_search(q))
                .transpose()?
        } else {
            None
        };
        read_tasks(&mut self.connection, input, search_high)
    }
    pub fn changes(&self, input: ListChanges) -> Result<ChangesResult> {
        read_changes(&self.connection, input)
    }
    /// SQLite's online backup API creates a consistent snapshot, including WAL writes.
    pub fn backup(&self, destination: impl AsRef<Path>) -> Result<()> {
        let destination = destination.as_ref();
        // Never overwrite a backup (or accidentally overwrite the live database).
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        drop(file);
        let mut target = Connection::open(destination)?;
        // Pin one WAL read snapshot across incremental steps. Without this,
        // writes from the worker or another process restart the copy on every
        // step and can prevent it from ever completing. A WAL read transaction
        // permits those writers to continue; deployment bounds the job lifetime.
        let snapshot = self.connection.unchecked_transaction()?;
        snapshot.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })?;
        {
            let backup = rusqlite::backup::Backup::new(&snapshot, &mut target)?;
            backup.run_to_completion(32, Duration::from_millis(10), None)?;
        }
        snapshot.commit()?;
        Ok(())
    }
}

fn now() -> String {
    crate::clock::audit_now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn page_size(value: Option<u32>) -> Result<u32> {
    match value.unwrap_or(50) {
        n @ 1..=110 => Ok(n),
        _ => Err(StoreError::Invalid(
            "page limits must be between 1 and 100".into(),
        )),
    }
}

fn validate_write(request_id: &str, reason: &str) -> Result<()> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_:.".contains(&c))
    {
        return Err(StoreError::Invalid(
            "request_id must be 1–128 ASCII letters, digits, or -_:.".into(),
        ));
    }
    if reason.trim().is_empty() || reason.chars().count() > 2000 {
        return Err(StoreError::Invalid(
            "reason must contain 1–2000 characters".into(),
        ));
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<()> {
    if title.trim().is_empty() || title.chars().count() > 500 {
        return Err(StoreError::Invalid(
            "title must contain 1–500 characters".into(),
        ));
    }
    Ok(())
}

fn validate_notes(notes: &str) -> Result<()> {
    if notes.chars().count() > 10_000 {
        return Err(StoreError::Invalid("notes exceed 10000 characters".into()));
    }
    Ok(())
}

fn validate_agent_notes(notes: Option<&str>) -> Result<()> {
    if notes.is_some_and(|s| s.chars().count() > 10_000) {
        return Err(StoreError::Invalid(
            "agent_notes exceed 10000 characters".into(),
        ));
    }
    Ok(())
}

fn validate_context(links: &[TaskLink], location: Option<&str>) -> Result<()> {
    if links.len() > 20 {
        return Err(StoreError::Invalid(
            "links must contain at most 20 entries".into(),
        ));
    }
    for link in links {
        if !crate::model::valid_resource_url(&link.url) {
            return Err(StoreError::Invalid(
                "links require absolute HTTP/HTTPS URLs without credentials, up to 2048 characters"
                    .into(),
            ));
        }
        if link.label.as_ref().is_some_and(|v| v.chars().count() > 120) {
            return Err(StoreError::Invalid(
                "link labels must not exceed 120 characters".into(),
            ));
        }
    }
    if location.is_some_and(|v| v.chars().count() > 1000) {
        return Err(StoreError::Invalid(
            "location must not exceed 1000 characters".into(),
        ));
    }
    Ok(())
}

fn validate_date(date: Option<&str>) -> Result<()> {
    if let Some(date) = date {
        let valid = date.len() == 10
            && NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .is_ok_and(|parsed| parsed.format("%Y-%m-%d").to_string() == date);
        if !valid {
            return Err(StoreError::Invalid(
                "due_date must be a valid YYYY-MM-DD date".into(),
            ));
        }
    }
    Ok(())
}

fn request_json(operation: &str, input: &impl Serialize) -> Result<String> {
    Ok(serde_json::to_string(&(operation, input))?)
}

fn replay<T: DeserializeOwned>(
    tx: &Transaction<'_>,
    key: &str,
    request: &str,
) -> Result<Option<T>> {
    let stored: Option<(String, String)> = tx
        .query_row(
            "SELECT request, response FROM requests WHERE id = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match stored {
        None => Ok(None),
        Some((original, response)) if original == request => {
            let mut result: serde_json::Value = serde_json::from_str(&response)?;
            result["replayed"] = true.into();
            if let Some(results) = result.get_mut("results").and_then(|v| v.as_array_mut()) {
                for item in results {
                    item["replayed"] = true.into();
                }
            }
            Ok(Some(serde_json::from_value(result)?))
        }
        Some(_) => Err(StoreError::RetryKeyConflict),
    }
}

fn load_task(tx: &impl RecordRead, id: &str) -> Result<Task> {
    tx.load_record(id)
}

fn check_version(task: &Task, expected: i64) -> Result<()> {
    if task.version != expected {
        return Err(StoreError::Conflict(format!(
            "expected version {expected}, current version {}; re-read before deciding whether to retry",
            task.version
        )));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn persist_change(
    tx: &Transaction<'_>,
    operation: &str,
    reason: &str,
    before: Option<Task>,
    mut after: Task,
    undoes_change_id: Option<i64>,
    origin: &str,
    batch_id: &str,
) -> Result<MutationResult> {
    validate_record_importance(&after)?;
    // BEGIN IMMEDIATE serializes writers across processes. Allocate the audit ID
    // before serializing so the task and immutable audit document agree.
    let change_id: i64 = tx.query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM changes", [], |r| {
        r.get(0)
    })?;
    after.last_change_id = change_id;
    let change = Change {
        entity_type: after.entity_type,
        id: change_id,
        task_id: after.id.clone(),
        operation: operation.into(),
        reason: reason.into(),
        before,
        after: after.clone(),
        undoes_change_id,
        created_at: after.updated_at.clone(),
        origin: origin.into(),
    };
    tx.execute("INSERT INTO tasks(id, document) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET document=excluded.document", params![after.id, serde_json::to_string(&after)?])?;
    tx.execute(
        "INSERT INTO changes(id, task_id, document, entity_type, batch_id, token) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![change_id, after.id, serde_json::to_string(&change)?, entity_name(after.entity_type), batch_id, Uuid::new_v4().to_string()],
    )?;
    tx.execute(
        "INSERT INTO revisions(seq, entity_id, entity_type, document) VALUES (?1, ?2, ?3, ?4)",
        params![
            change_id,
            after.id,
            entity_name(after.entity_type),
            serde_json::to_string(&after)?
        ],
    )?;
    let result = MutationResult {
        task: after,
        change,
        replayed: false,
    };
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn record_change(
    tx: &impl Mutation,
    operation: &str,
    reason: &str,
    before: Option<Task>,
    mut after: Task,
    undoes_change_id: Option<i64>,
    origin: &str,
    batch_id: &str,
) -> Result<MutationResult> {
    dependencies::normalize(&mut after);
    validate_record_importance(&after)?;
    tx.stage(
        Change {
            entity_type: after.entity_type,
            id: 0,
            task_id: after.id.clone(),
            operation: operation.into(),
            reason: reason.into(),
            before,
            created_at: after.updated_at.clone(),
            after,
            undoes_change_id,
            origin: origin.into(),
        },
        batch_id,
    )
}

fn save_request<T: Serialize + DeserializeOwned>(
    tx: WriteTransaction<'_>,
    key: &str,
    request: &str,
    result: T,
) -> Result<T> {
    tx.finish()?;
    let result = tx.receipt(result)?;
    tx.execute(
        "INSERT INTO requests(id,request,response) VALUES(?1,?2,?3)",
        params![key, request, serde_json::to_string(&result)?],
    )?;
    tx.commit()?;
    Ok(result)
}

fn validate_capture(input: &CaptureItem) -> Result<()> {
    dependencies::validate_ids(input.blocked_by.as_deref().unwrap_or(&[]))?;
    let mut planning = crate::planning::Planning::default();
    input
        .planning
        .apply(&mut planning)
        .map_err(StoreError::Invalid)?;
    planning
        .validate(input.due_date.as_deref())
        .map_err(StoreError::Invalid)?;
    validate_write(&input.request_id, &input.reason)?;
    if input.status == Status::Active {
        return Err(StoreError::Invalid(
            "active is a project state; use next or blocked for a task".into(),
        ));
    }
    validate_extras(
        input.project_id.as_deref(),
        input.review_date.as_deref(),
        &input.work_sessions,
        input.completion_result.as_deref(),
    )?;
    if input
        .completion_result
        .as_ref()
        .is_some_and(|v| !v.trim().is_empty())
        && input.status != Status::Done
    {
        return Err(StoreError::Invalid(
            "completion_result requires done status".into(),
        ));
    }
    validate_archive(input.status, input.archived)?;
    validate_title(&input.title)?;
    validate_notes(&input.notes)?;
    validate_agent_notes(input.agent_notes.as_deref())?;
    validate_context(&input.links, input.location.as_deref())?;
    validate_date(input.due_date.as_deref())?;
    Ok(())
}

fn capture_in(tx: &impl Mutation, input: CaptureItem, origin: &str) -> Result<MutationResult> {
    capture_record(tx, input, origin, EntityType::Task)
}
fn capture_record(
    tx: &impl Mutation,
    input: CaptureItem,
    origin: &str,
    kind: EntityType,
) -> Result<MutationResult> {
    tx.policy().notes(input.agent_notes.as_deref(), true)?;
    let timestamp = now();
    let mut planning = crate::planning::Planning::default();
    input
        .planning
        .apply(&mut planning)
        .map_err(StoreError::Invalid)?;
    let task = Task {
        blocked_by: input.blocked_by.unwrap_or_default(),
        manual_block: matches!(input.status, Status::Blocked | Status::Planned),
        unresolved_blocker_ids: vec![],
        planning,
        recommendation: None,
        timing_adjustments: vec![],
        pending_occurrence_count: None,
        entity_type: kind,
        recurrence: None,
        occurrence: None,
        project_id: input.project_id,
        review_date: input.review_date,
        work_sessions: input.work_sessions,
        completion_result: input.completion_result.filter(|v| !v.trim().is_empty()),
        completed_at: (input.status == Status::Done).then(|| timestamp.clone()),
        id: Uuid::new_v4().to_string(),
        title: input.title,
        notes: input.notes,
        brief: input.brief.unwrap_or_default(),
        agent_notes: input.agent_notes.unwrap_or_default(),
        links: input.links,
        location: input.location.filter(|v| !v.trim().is_empty()),
        status: if input.status == Status::Archived {
            Status::Inbox
        } else {
            input.status
        },
        archived: input.archived.unwrap_or(input.status == Status::Archived),
        due_date: input.due_date,
        version: 1,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        deleted: false,
        last_change_id: 0,
    };
    record_change(
        tx,
        "capture",
        &input.reason,
        None,
        task,
        None,
        origin,
        &input.request_id,
    )
}

fn validate_update(input: &UpdateItem) -> Result<()> {
    dependencies::validate_ids(input.blocked_by.as_deref().unwrap_or(&[]))?;
    validate_extras(
        input.project_id.as_deref(),
        input.review_date.as_deref(),
        input.work_sessions.as_deref().unwrap_or(&[]),
        input.completion_result.as_deref(),
    )?;
    if (input.clear_project && input.project_id.is_some())
        || (input.clear_review_date && input.review_date.is_some())
    {
        return Err(StoreError::Invalid(
            "cannot set and clear the same field".into(),
        ));
    }
    validate_archive(input.status.unwrap_or_default(), input.archived)?;
    validate_write(&input.request_id, &input.reason)?;
    if let Some(title) = &input.title {
        validate_title(title)?;
    }
    validate_agent_notes(input.agent_notes.as_deref())?;
    if let Some(notes) = &input.notes {
        validate_notes(notes)?;
    }
    validate_context(
        input.links.as_deref().unwrap_or(&[]),
        input.location.as_deref(),
    )?;
    validate_date(input.due_date.as_deref())?;
    if input.clear_due_date && input.due_date.is_some() {
        return Err(StoreError::Invalid(
            "cannot set and clear due_date together".into(),
        ));
    }
    if input.blocked_by.is_none()
        && input.title.is_none()
        && input.planning.is_empty()
        && input.notes.is_none()
        && input.agent_notes.is_none()
        && input.brief.is_none()
        && input.links.is_none()
        && input.location.is_none()
        && input.status.is_none()
        && input.archived.is_none()
        && input.due_date.is_none()
        && !input.clear_due_date
        && input.project_id.is_none()
        && !input.clear_project
        && input.review_date.is_none()
        && !input.clear_review_date
        && input.work_sessions.is_none()
        && input.completion_result.is_none()
    {
        return Err(StoreError::Invalid(
            "provide at least one field to update".into(),
        ));
    }
    Ok(())
}

fn update_in(tx: &impl Mutation, input: UpdateItem, origin: &str) -> Result<MutationResult> {
    tx.policy().notes(input.agent_notes.as_deref(), false)?;
    let before = load_task(tx, &input.task_id)?;
    check_version(&before, input.expected_version)?;
    if before.deleted {
        return Err(StoreError::Conflict(
            "task capture was undone; undo that change to restore it".into(),
        ));
    }
    let mut after = before.clone();
    if let Some(ids) = input.blocked_by {
        if before.entity_type != EntityType::Task {
            return Err(StoreError::Invalid(
                "Only tasks can have prerequisites".into(),
            ));
        }
        after.blocked_by = ids;
    }
    if input.status.is_some_and(|s| {
        if before.entity_type == EntityType::Project {
            !matches!(s, Status::Active | Status::Someday | Status::Done)
        } else {
            s == Status::Active
        }
    }) {
        return Err(StoreError::Invalid(
            "invalid workflow state for this record type".into(),
        ));
    }
    if input.clear_project {
        after.project_id = None;
    } else if let Some(id) = input.project_id {
        after.project_id = Some(id);
    }
    if input.clear_review_date {
        after.review_date = None;
    } else if let Some(date) = input.review_date {
        after.review_date = Some(date);
    }
    if let Some(sessions) = input.work_sessions {
        after.work_sessions = sessions;
    }
    if let Some(title) = input.title {
        after.title = title;
    }
    content::validate_replacement(
        input.brief.as_deref(),
        before.entity_type == EntityType::Project
            || input
                .status
                .filter(|s| *s != Status::Archived)
                .unwrap_or(before.status)
                != Status::Inbox,
    )?;
    if let Some(brief) = input.brief {
        after.brief = brief;
    }
    if let Some(notes) = input.notes {
        after.notes = notes;
    }
    if let Some(notes) = input.agent_notes {
        after.agent_notes = notes;
    }
    if let Some(links) = input.links {
        after.links = links;
    }
    if let Some(location) = input.location {
        after.location = (!location.trim().is_empty()).then_some(location);
    }
    if let Some(status) = input.status {
        if status == Status::Archived {
            after.archived = true;
        } else {
            after.status = status;
            after.manual_block = matches!(status, Status::Blocked | Status::Planned);
        }
    }
    if let Some(archived) = input.archived {
        after.archived = archived;
    }
    if input.clear_due_date {
        after.due_date = None;
    } else if let Some(date) = input.due_date {
        after.due_date = Some(date);
    }
    input
        .planning
        .apply(&mut after.planning)
        .map_err(StoreError::Invalid)?;
    if input.clear_due_date {
        after.planning.deadline_time = None;
        after.planning.safety_buffer = None;
    }
    after
        .planning
        .validate(after.due_date.as_deref())
        .map_err(StoreError::Invalid)?;
    if after.planning != before.planning || after.due_date != before.due_date {
        after.timing_adjustments.clear();
    }
    if after.status != before.status {
        if after.status == Status::Done {
            after.completed_at = Some(now());
        } else if before.status == Status::Done {
            after.completed_at = None;
            after.completion_result = None;
        }
    }
    if let Some(result) = input.completion_result {
        if after.status != Status::Done && !result.trim().is_empty() {
            return Err(StoreError::Invalid(
                "completion_result requires done status".into(),
            ));
        }
        after.completion_result = (!result.trim().is_empty()).then_some(result);
    }
    if let Some(occurrence) = after.occurrence.as_mut() {
        let old = serde_json::to_value(&before)?;
        // The comparison excludes completion timestamps; explicit field overrides
        // survive later changes to series defaults.
        let changed = [
            ("title", serde_json::to_value(&after.title)?),
            ("notes", serde_json::to_value(&after.notes)?),
            ("brief", serde_json::to_value(&after.brief)?),
            ("agent_notes", serde_json::to_value(&after.agent_notes)?),
            ("links", serde_json::to_value(&after.links)?),
            ("location", serde_json::to_value(&after.location)?),
            ("project_id", serde_json::to_value(&after.project_id)?),
            ("status", serde_json::to_value(after.status)?),
            ("manual_block", serde_json::to_value(after.manual_block)?),
            ("due_date", serde_json::to_value(&after.due_date)?),
            (
                "importance",
                serde_json::to_value(after.planning.importance)?,
            ),
            (
                "deadline_time",
                serde_json::to_value(&after.planning.deadline_time)?,
            ),
            ("start_by", serde_json::to_value(&after.planning.start_by)?),
            (
                "estimated_minutes",
                serde_json::to_value(after.planning.estimated_minutes)?,
            ),
            ("effort", serde_json::to_value(after.planning.effort)?),
            (
                "not_before",
                serde_json::to_value(&after.planning.not_before)?,
            ),
            (
                "safety_buffer",
                serde_json::to_value(&after.planning.safety_buffer)?,
            ),
            (
                "work_blocks",
                serde_json::to_value(&after.planning.work_blocks)?,
            ),
            (
                "planned_start",
                serde_json::to_value(&after.planning.planned_start)?,
            ),
            (
                "planned_finish",
                serde_json::to_value(&after.planning.planned_finish)?,
            ),
            ("review_date", serde_json::to_value(&after.review_date)?),
        ];
        for (key, value) in changed {
            let previous = if key == "agent_notes" {
                serde_json::json!(before.agent_notes)
            } else {
                old[key].clone()
            };
            if previous != value && !occurrence.overrides.iter().any(|x| x == key) {
                occurrence
                    .overrides
                    .push(if key == "manual_block" { "status" } else { key }.into());
            }
        }
    }
    if after == before {
        return Err(StoreError::Invalid(
            "update does not change any fields".into(),
        ));
    }
    after.version += 1;
    after.updated_at = now();
    record_change(
        tx,
        "update",
        &input.reason,
        Some(before),
        after,
        None,
        origin,
        &input.request_id,
    )
}

fn validate_undo(input: &UndoChange) -> Result<()> {
    validate_write(&input.request_id, &input.reason)?;
    Ok(())
}

fn undo_in(tx: &impl Mutation, input: UndoChange, origin: &str) -> Result<MutationResult> {
    let (group, docs) = tx.undo_group(input.change_id)?;
    if docs.is_empty() {
        return Err(StoreError::NotFound("change not found".into()));
    }
    let mut pairs = Vec::new();
    for change in docs {
        if ["require_importance", "rename_planned", "planning_defaults"]
            .contains(&change.operation.as_str())
        {
            return Err(StoreError::Conflict("Required-importance migration cannot be undone; choose a different importance with update_item or update_recurrence".into()));
        }
        let current = load_task(tx, &change.task_id)?;
        if change.id == input.change_id {
            check_version(&current, input.expected_version)?;
        }
        if current.last_change_id != change.id {
            return Err(StoreError::Conflict(
                "A record in this change has newer edits; the entire undo was refused".into(),
            ));
        }
        pairs.push((change, current));
    }
    let undo_start = tx.high();
    let mut primary = None;
    for (change, before) in pairs {
        let mut after = change.before.unwrap_or_else(|| Task {
            deleted: true,
            ..before.clone()
        });
        normalize_legacy_archive(tx, &mut after)?;
        normalize_importance(&mut after);
        dependencies::normalize(&mut after);
        planning_migration::normalize(&mut after);
        after.version = before.version + 1;
        after.updated_at = now();
        let result = record_change(
            tx,
            "undo",
            &input.reason,
            Some(before),
            after,
            Some(change.id),
            origin,
            &input.request_id,
        )?;
        if change.id == input.change_id {
            primary = Some(result)
        }
    }
    if group {
        tx.group_since(undo_start);
    }
    primary.ok_or_else(|| StoreError::NotFound("change not found".into()))
}

fn batch_operation(
    tx: &impl Mutation,
    key: &str,
    operation: BatchOperation,
    origin: &str,
) -> Result<MutationResult> {
    let mut value = serde_json::to_value(operation)?;
    let name = value["operation"].as_str().unwrap().to_owned();
    value.as_object_mut().unwrap().remove("operation");
    value["request_id"] = key.into();
    match name.as_str() {
        "capture" => {
            let input = serde_json::from_value(value)?;
            validate_capture(&input)?;
            require_importance(input.planning.importance)?;
            capture_in(tx, input, origin)
        }
        "update" => {
            let input: UpdateItem = serde_json::from_value(value)?;
            validate_update(&input)?;
            require_kind(tx, &input.task_id, EntityType::Task)?;
            update_in(tx, input, origin)
        }
        "undo" => {
            let input = serde_json::from_value(value)?;
            validate_undo(&input)?;
            undo_in(tx, input, origin)
        }
        "create_recurrence" => recurrence::create_in(tx, serde_json::from_value(value)?, origin),
        "update_recurrence" => recurrence::update_in(tx, serde_json::from_value(value)?, origin),
        "create_project" => create_project_in(tx, serde_json::from_value(value)?, origin),
        "update_project" => update_project_in(tx, serde_json::from_value(value)?, origin),
        _ => Err(StoreError::Invalid("unknown batch operation".into())),
    }
}

// v2 changes the current projection only. Audit snapshots and retry receipts are
// immutable. Recover the workflow state from evidence before the archive event;
// captures with no previous status are conservatively treated as inbox.
fn normalize_legacy_archive(tx: &impl RecordRead, task: &mut Task) -> Result<()> {
    if task.status == Status::Archived {
        task.status = tx.archive_status(task)?.unwrap_or_default();
        task.archived = true;
    }
    Ok(())
}

fn migrate_archive(tx: &Transaction<'_>) -> Result<()> {
    let mut statement = tx.prepare(
        "SELECT document FROM tasks WHERE json_extract(document, '$.status') = 'archived'",
    )?;
    let documents = statement
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    for document in documents {
        let mut task: Task = serde_json::from_str(&document)?;
        normalize_legacy_archive(tx, &mut task)?;
        tx.execute(
            "UPDATE tasks SET document = ?2 WHERE id = ?1",
            params![task.id, serde_json::to_string(&task)?],
        )?;
    }
    tx.pragma_update(None, "user_version", 2)?;
    Ok(())
}
fn validate_archive(status: Status, archived: Option<bool>) -> Result<()> {
    if status == Status::Archived && archived == Some(false) {
        return Err(StoreError::Invalid(
            "status=archived conflicts with archived=false".into(),
        ));
    }
    Ok(())
}

fn require_importance(value: Option<crate::planning::Importance>) -> Result<()> {
    value.ok_or_else(|| StoreError::Invalid("Importance is required; choose one of its seven levels (normal when no other level is supported)".into())).map(|_| ())
}

// One write boundary protects captures, updates, batches, recurrence generation
// and undo. Historical snapshots and tombstones remain faithful to their time.
fn validate_record_importance(task: &Task) -> Result<()> {
    if task.deleted || task.entity_type == EntityType::Project {
        return Ok(());
    }
    require_importance(task.planning.importance)?;
    if task.entity_type == EntityType::Task {
        crate::task_planning::validate_estimates(
            task.planning.estimated_minutes,
            task.planning.effort,
            task.status,
            task.archived,
        )
        .map_err(StoreError::Invalid)?;
    }
    if let Some(series) = &task.recurrence {
        for segment in &series.segments {
            require_importance(segment.template.planning.importance)?;
            let t = &segment.template;
            crate::task_planning::validate_estimates(
                t.planning.estimated_minutes,
                t.planning.effort,
                t.status,
                task.archived,
            )
            .map_err(StoreError::Invalid)?;
        }
    }
    Ok(())
}
fn normalize_importance(task: &mut Task) {
    if task.deleted || task.entity_type == EntityType::Project {
        return;
    }
    task.planning
        .importance
        .get_or_insert(crate::planning::Importance::Normal);
    if let Some(series) = &mut task.recurrence {
        for segment in &mut series.segments {
            segment
                .template
                .planning
                .importance
                .get_or_insert(crate::planning::Importance::Normal);
        }
    }
}
fn migrate_importance(tx: &Transaction<'_>) -> Result<()> {
    let documents = tx
        .prepare("SELECT document FROM tasks ORDER BY id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let batch = format!("migration-importance-{}", Uuid::new_v4());
    let timestamp = now();
    for document in documents {
        let before: Task = serde_json::from_str(&document)?;
        let mut after = before.clone();
        normalize_importance(&mut after);
        if after != before {
            after.version += 1;
            after.updated_at = timestamp.clone();
            persist_change(
                tx,
                "require_importance",
                "Importance is now required. Unset values become Normal, preserving their previous ranking.",
                Some(before),
                after,
                None,
                "migration",
                &batch,
            )?;
        }
    }
    // Existing snapshot cursors would otherwise expose pre-migration records.
    tx.execute(
        "UPDATE store_meta SET value=?1 WHERE key='identity'",
        [Uuid::new_v4().to_string()],
    )?;
    tx.execute("DELETE FROM search_sessions", [])?;
    Ok(())
}
