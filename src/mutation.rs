//! Semantic storage boundary for shared task, project, recurrence and undo rules.
//! SQL adapters supply account-scoped records; business rules never select an account.
use super::*;
use std::{cell::RefCell, collections::BTreeMap};

pub(crate) trait RecordRead {
    fn calendar_timezone(&self) -> chrono_tz::Tz {
        chrono_tz::America::New_York
    }
    fn load_record(&self, id: &str) -> Result<Task>;
    fn occurrences(&self, series: &str) -> Result<Vec<Task>>;
    fn archive_status(&self, task: &Task) -> Result<Option<Status>>;
}

pub(crate) trait Mutation: RecordRead {
    fn policy(&self) -> content::Policy;
    fn journal(&self) -> &Journal;
    fn write_current(&self, task: &Task) -> Result<()>;
    fn all_records(&self) -> Result<Vec<Task>>;
    fn undo_group(&self, id: i64) -> Result<(bool, Vec<Change>)>;
    fn high(&self) -> i64 {
        self.journal().high()
    }
    fn changes(&self) -> Vec<Change> {
        self.journal().changes()
    }
    fn stage(&self, change: Change, batch: &str) -> Result<MutationResult> {
        let result = self.journal().stage(change, batch)?;
        self.write_current(&result.task)?;
        Ok(result)
    }
    fn group(&self, ids: &[i64]) {
        self.journal().group(ids);
    }
    fn group_since(&self, since: i64) {
        self.journal().group_since(since);
    }
    fn resolve_status(&self, before: Task, mut after: Task, causes: &[i64]) -> Result<()>
    where
        Self: Sized,
    {
        let id = if let Some(id) = self.journal().replace(&after) {
            self.write_current(&after)?;
            id
        } else {
            after.version += 1;
            after.updated_at = now();
            let (origin, batch) = self.journal().cause(causes);
            let timed = causes.is_empty() && before.planning.not_before.is_some();
            record_change(
                self,
                if timed {
                    "availability_status"
                } else {
                    "dependency_status"
                },
                if timed {
                    "Recalculate readiness at the availability boundary"
                } else {
                    "Recalculate readiness after prerequisite changes"
                },
                Some(before),
                after,
                None,
                &origin,
                &batch,
            )?
            .change
            .id
        };
        let mut group = causes.to_vec();
        group.push(id);
        self.group(&group);
        Ok(())
    }
}

pub(crate) struct Journal {
    base: i64,
    journal: RefCell<Vec<(Change, String)>>,
    groups: RefCell<BTreeMap<i64, String>>,
}
impl Journal {
    pub fn new(base: i64) -> Self {
        Self {
            base,
            journal: RefCell::new(vec![]),
            groups: RefCell::new(BTreeMap::new()),
        }
    }
    pub fn high(&self) -> i64 {
        self.base + self.journal.borrow().len() as i64
    }
    pub fn changes(&self) -> Vec<Change> {
        self.journal
            .borrow()
            .iter()
            .map(|(c, _)| c.clone())
            .collect()
    }
    pub fn stage(&self, mut change: Change, batch: &str) -> Result<MutationResult> {
        if self
            .journal
            .borrow()
            .iter()
            .any(|(c, _)| c.task_id == change.task_id)
        {
            return Err(StoreError::Invalid("each record may be changed only once per batch, including scoped secondary changes".into()));
        }
        change.id = self.high() + 1;
        change.after.last_change_id = change.id;
        self.journal
            .borrow_mut()
            .push((change.clone(), batch.into()));
        Ok(MutationResult {
            task: change.after.clone(),
            change,
            replayed: false,
        })
    }
    pub fn group(&self, ids: &[i64]) {
        if ids.len() < 2 {
            return;
        }
        let mut groups = self.groups.borrow_mut();
        let old: HashSet<String> = ids
            .iter()
            .filter_map(|id| groups.get(id).cloned())
            .collect();
        let group = Uuid::new_v4().to_string();
        for value in groups.values_mut() {
            if old.contains(value) {
                *value = group.clone();
            }
        }
        for id in ids {
            groups.insert(*id, group.clone());
        }
    }
    pub fn group_since(&self, since: i64) {
        self.group(&(since + 1..=self.high()).collect::<Vec<_>>());
    }

    pub fn receipt<T: Serialize + DeserializeOwned>(&self, result: T) -> Result<T> {
        fn refresh(value: &mut serde_json::Value, changes: &[Change]) -> Result<()> {
            if let Some(items) = value.get_mut("results").and_then(|v| v.as_array_mut()) {
                for item in items {
                    refresh(item, changes)?;
                }
            } else if let Some(id) = value
                .get("change")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_i64())
                && let Some(change) = changes.iter().find(|c| c.id == id)
            {
                value["task"] = serde_json::to_value(&change.after)?;
                value["change"] = serde_json::to_value(change)?;
            }
            Ok(())
        }
        let mut value = serde_json::to_value(result)?;
        refresh(&mut value, &self.changes())?;
        Ok(serde_json::from_value(value)?)
    }
    pub fn replace(&self, after: &Task) -> Option<i64> {
        let mut entries = self.journal.borrow_mut();
        let (change, _) = entries
            .iter_mut()
            .find(|(change, _)| change.task_id == after.id)?;
        change.after = after.clone();
        Some(change.id)
    }
    pub fn cause(&self, causes: &[i64]) -> (String, String) {
        self.journal
            .borrow()
            .iter()
            .find(|(c, _)| causes.contains(&c.id))
            .map(|(c, b)| (c.origin.clone(), b.clone()))
            .unwrap_or_else(|| ("unknown".into(), Uuid::new_v4().to_string()))
    }
    pub fn entries(&self) -> Vec<(Change, String)> {
        self.journal.borrow().clone()
    }
    pub fn groups(&self) -> BTreeMap<i64, String> {
        self.groups.borrow().clone()
    }
}

impl RecordRead for Transaction<'_> {
    fn load_record(&self, id: &str) -> Result<Task> {
        let document: String = self
            .query_row("SELECT document FROM tasks WHERE id=?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| StoreError::NotFound("task not found".into()))?;
        Ok(serde_json::from_str(&document)?)
    }
    fn occurrences(&self, id: &str) -> Result<Vec<Task>> {
        self.prepare("SELECT document FROM tasks WHERE json_extract(document,'$.occurrence.series_id')=?1 ORDER BY json_extract(document,'$.occurrence.original_date')")?
            .query_map([id], |r| r.get::<_,String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    fn archive_status(&self, task: &Task) -> Result<Option<Status>> {
        let status: Option<String> = self.query_row(
            "SELECT json_extract(document,'$.before.status') FROM changes WHERE task_id=?1 AND id<=?2
             AND json_extract(document,'$.before.status') IN ('inbox','next','waiting','someday','done') ORDER BY id DESC LIMIT 1",
            params![task.id,task.last_change_id], |r| r.get(0)).optional()?;
        status
            .map(|s| Ok(serde_json::from_value(s.into())?))
            .transpose()
    }
}

/// Parsed operations shared by both transports. Identity and authoring policy are
/// supplied by trusted entry points, never deserialized from operation arguments.
pub enum Operation {
    Capture(CaptureItem),
    Update(UpdateItem),
    Undo(UndoChange),
    Batch(ApplyChanges),
    CreateProject(CreateProject),
    UpdateProject(UpdateProject),
    CreateRecurrence(crate::recurrence_model::CreateRecurrence),
    UpdateRecurrence(crate::recurrence_model::UpdateRecurrence),
}
impl Operation {
    pub(crate) fn key(&self) -> &str {
        match self {
            Self::Capture(i) => &i.request_id,
            Self::Update(i) => &i.request_id,
            Self::Undo(i) => &i.request_id,
            Self::Batch(i) => &i.request_id,
            Self::CreateProject(i) => &i.request_id,
            Self::UpdateProject(i) => &i.request_id,
            Self::CreateRecurrence(i) => &i.request_id,
            Self::UpdateRecurrence(i) => &i.request_id,
        }
    }
    pub(crate) fn fingerprint(&self) -> Result<String> {
        match self {
            Self::Capture(i) => request_json("capture_item", i),
            Self::Update(i) => request_json("update_item", i),
            Self::Undo(i) => request_json("undo_change", i),
            Self::Batch(i) => request_json("apply_changes", i),
            Self::CreateProject(i) => request_json("create_project", i),
            Self::UpdateProject(i) => request_json("update_project", i),
            Self::CreateRecurrence(i) => request_json("create_recurrence", i),
            Self::UpdateRecurrence(i) => request_json("update_recurrence", i),
        }
    }
    /// Receipt lookup must precede this: new authoring requirements cannot reject
    /// a committed historical request with the same fingerprint.
    pub(crate) fn apply(self, tx: &impl Mutation, origin: &str) -> Result<serde_json::Value> {
        let result = match self {
            Self::Capture(i) => {
                validate_capture(&i)?;
                require_importance(i.planning.importance)?;
                capture_in(tx, i, origin)?
            }
            Self::Update(i) => {
                validate_update(&i)?;
                require_kind(tx, &i.task_id, EntityType::Task)?;
                update_in(tx, i, origin)?
            }
            Self::Undo(i) => {
                validate_undo(&i)?;
                undo_in(tx, i, origin)?
            }
            Self::CreateProject(i) => {
                validate_write(&i.request_id, &i.reason)?;
                create_project_in(tx, i, origin)?
            }
            Self::UpdateProject(i) => {
                validate_write(&i.request_id, &i.reason)?;
                update_project_in(tx, i, origin)?
            }
            Self::CreateRecurrence(i) => recurrence::create_in(tx, i, origin)?,
            Self::UpdateRecurrence(i) => recurrence::update_in(tx, i, origin)?,
            Self::Batch(i) => {
                validate_write(&i.request_id, "Batch request")?;
                if i.operations.is_empty() || i.operations.len() > 50 {
                    return Err(StoreError::Invalid(
                        "a batch must contain 1–50 operations".into(),
                    ));
                }
                if request_json("apply_changes", &i)?.len() > 128 * 1024 {
                    return Err(StoreError::Invalid(
                        "batch arguments exceed 128 KiB; use smaller batches".into(),
                    ));
                }
                let mut results = Vec::with_capacity(i.operations.len());
                for (index, op) in i.operations.into_iter().enumerate() {
                    results.push(batch_operation(tx, &i.request_id, op, origin).map_err(
                        |source| StoreError::Batch {
                            index: index + 1,
                            source: Box::new(source),
                        },
                    )?);
                }
                return Ok(serde_json::to_value(BatchResult {
                    results,
                    replayed: false,
                })?);
            }
        };
        Ok(serde_json::to_value(result)?)
    }
}

pub(crate) fn finish_rules(tx: &impl Mutation) -> Result<()> {
    let mut graph = dependencies::Graph::new(tx.all_records()?)?;
    dependencies::resolve(tx, &graph)?;
    // Validate the final resolved records without loading/decoding the graph twice.
    for change in tx.changes() {
        if !change.after.deleted {
            graph.tasks.insert(change.task_id, change.after);
        }
    }
    validate_relationships(tx, &graph.tasks)?;
    for change in tx.changes() {
        validate_record_importance(&change.after)?;
        content::validate_change(tx.policy(), &change)?;
    }
    Ok(())
}

/// One bounded slice of a series catch-up. All generated records share an undo
/// group and the caller's account transaction, including readiness transitions.
#[cfg(feature = "postgres-storage")]
pub(crate) fn materialize_series(
    tx: &impl Mutation,
    series: &Task,
    through: &str,
    limit: usize,
) -> Result<usize> {
    let start = tx.high();
    let count = recurrence::materialize(
        tx,
        series,
        through,
        "worker",
        &Uuid::new_v4().to_string(),
        limit,
    )?;
    tx.group_since(start);
    Ok(count)
}
