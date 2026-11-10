use super::*;

pub(super) fn entity_name(kind: EntityType) -> &'static str {
    match kind {
        EntityType::Task => "task",
        EntityType::Project => "project",
        EntityType::Recurrence => "recurrence",
    }
}
pub(super) fn require_kind(tx: &impl RecordRead, id: &str, kind: EntityType) -> Result<()> {
    if load_task(tx, id)?.entity_type != kind {
        return Err(StoreError::Invalid(
            "record type does not match this tool".into(),
        ));
    }
    Ok(())
}
pub(super) fn validate_extras(
    project: Option<&str>,
    review: Option<&str>,
    sessions: &[TaskLink],
    result: Option<&str>,
) -> Result<()> {
    if project.is_some_and(|id| Uuid::parse_str(id).is_err()) {
        return Err(StoreError::Invalid("project_id must be a UUID".into()));
    }
    validate_date(review)?;
    validate_context(sessions, None)?;
    if result.is_some_and(|s| s.chars().count() > 2000) {
        return Err(StoreError::Invalid(
            "completion_result exceeds 2000 characters".into(),
        ));
    }
    Ok(())
}

impl Store {
    pub fn create_project(&mut self, input: CreateProject) -> Result<MutationResult> {
        Ok(serde_json::from_value(self.execute_operation(
            mutation::Operation::CreateProject(input),
        )?)?)
    }
    pub fn update_project(&mut self, input: UpdateProject) -> Result<MutationResult> {
        Ok(serde_json::from_value(self.execute_operation(
            mutation::Operation::UpdateProject(input),
        )?)?)
    }
}
pub(super) fn create_project_in(
    tx: &impl Mutation,
    input: CreateProject,
    origin: &str,
) -> Result<MutationResult> {
    let f = input.fields;
    let status: Status = f.status.into();
    let mut capture: CaptureItem = serde_json::from_value(
        serde_json::json!({"request_id": input.request_id, "title": f.title, "notes": f.notes, "brief": f.brief, "agent_notes": f.agent_notes, "links": f.links, "archived": f.archived, "due_date": f.due_date, "review_date": f.review_date, "completion_result": f.completion_result, "status": if status == Status::Active { Status::Inbox } else { status }, "reason": input.reason}),
    )?;
    validate_capture(&capture)?;
    capture.status = status;
    capture_record(tx, capture, origin, EntityType::Project)
}
pub(super) fn update_project_in(
    tx: &impl Mutation,
    input: UpdateProject,
    origin: &str,
) -> Result<MutationResult> {
    require_kind(tx, &input.project_id, EntityType::Project)?;
    let mut value = serde_json::to_value(input.fields)?;
    value["request_id"] = input.request_id.into();
    value["task_id"] = input.project_id.into();
    value["expected_version"] = input.expected_version.into();
    value["reason"] = input.reason.into();
    let patch = serde_json::from_value(value)?;
    validate_update(&patch)?;
    update_in(tx, patch, origin)
}

// Validate the final transaction, not intermediate batch order. This also makes
// project completion safe against concurrent attachment and restoration by undo.
pub(super) fn validate_relationships(
    tx: &impl RecordRead,
    records: &std::collections::BTreeMap<String, Task>,
) -> Result<()> {
    let by_id = records;
    let mut invalid = 0;
    for task in records.values().filter(|t| !t.deleted) {
        if let Some(occurrence) = &task.occurrence
            && by_id
                .get(occurrence.series_id.as_str())
                .is_none_or(|s| s.deleted || s.entity_type != EntityType::Recurrence)
        {
            return Err(StoreError::Conflict(
                "Series still has retained occurrences; undo their changes first".into(),
            ));
        }
        if let Some(id) = &task.project_id
            && by_id.get(id.as_str()).is_none_or(|p| {
                p.entity_type != EntityType::Project
                    || p.deleted
                    || task.entity_type == EntityType::Project
                    || (task.entity_type != EntityType::Recurrence
                        && !task.archived
                        && (p.archived
                            || (p.status == Status::Done && task.status != Status::Done)
                            || (p.status == Status::Someday
                                && !matches!(task.status, Status::Someday | Status::Done))))
            })
        {
            invalid += 1;
        }
    }
    if invalid > 0 {
        return Err(StoreError::Conflict(format!(
            "Project transition or membership leaves {invalid} incompatible task(s). Resolve, archive, or move them explicitly; related changes can be applied atomically."
        )));
    }
    recurrence::validate_future_memberships(tx, records)
}

pub(super) fn migrate_records(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("ALTER TABLE changes ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'task'; ALTER TABLE changes ADD COLUMN batch_id TEXT; ALTER TABLE changes ADD COLUMN token TEXT; CREATE TABLE store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE revisions(seq INTEGER PRIMARY KEY REFERENCES changes(id), entity_id TEXT NOT NULL, entity_type TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document))); CREATE INDEX revisions_entity ON revisions(entity_id,seq); CREATE INDEX records_project ON tasks(json_extract(document,'$.project_id')); DROP TRIGGER changes_no_update;")?;
    tx.execute(
        "INSERT INTO store_meta VALUES('identity',?1)",
        [Uuid::new_v4().to_string()],
    )?;
    let mut statement = tx.prepare("SELECT id, document FROM changes ORDER BY id")?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, doc) in rows {
        let mut change: Change = serde_json::from_str(&doc)?;
        normalize_legacy_archive(tx, &mut change.after)?;
        tx.execute(
            "INSERT INTO revisions VALUES(?1,?2,'task',?3)",
            params![id, change.task_id, serde_json::to_string(&change.after)?],
        )?;
        tx.execute(
            "UPDATE changes SET token=?2,batch_id=?3 WHERE id=?1",
            params![id, Uuid::new_v4().to_string(), format!("legacy-{id}")],
        )?;
    }
    // Recover old atomic request boundaries without changing immutable documents.
    tx.execute("UPDATE changes SET batch_id=(SELECT 'legacy-batch-' || requests.id FROM requests, json_each(requests.response,'$.results') r WHERE json_extract(r.value,'$.change.id')=changes.id LIMIT 1) WHERE EXISTS (SELECT 1 FROM requests,json_each(requests.response,'$.results') r WHERE json_extract(r.value,'$.change.id')=changes.id)", [])?;
    tx.execute_batch("CREATE TRIGGER changes_no_update BEFORE UPDATE ON changes BEGIN SELECT RAISE(ABORT,'audit history is append-only'); END; CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'revisions are append-only'); END; CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'revisions are append-only'); END; PRAGMA user_version=3;")?;
    Ok(())
}
