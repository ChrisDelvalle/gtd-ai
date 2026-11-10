use super::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(super) fn validate_ids(ids: &[String]) -> Result<()> {
    if ids.len() > 50
        || ids.iter().any(|id| Uuid::parse_str(id).is_err())
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err(StoreError::Invalid(
            "blocked_by accepts at most 50 distinct task UUIDs".into(),
        ));
    }
    Ok(())
}
pub(super) fn normalize(task: &mut Task) {
    if task.deleted {
        return;
    }
    if task.status == Status::Planned {
        task.status = Status::Blocked;
        task.manual_block = true;
    }
    if let Some(series) = &mut task.recurrence {
        for segment in &mut series.segments {
            if segment.template.status == Status::Planned {
                segment.template.status = Status::Blocked;
            }
        }
    }
}
fn satisfied(task: &Task) -> bool {
    !task.deleted
        && task.status == Status::Done
        && !task.occurrence.as_ref().is_some_and(|o| o.skipped)
}
fn committed(task: &Task) -> bool {
    !task.deleted
        && !task.archived
        && task.entity_type == EntityType::Task
        && matches!(
            task.status,
            Status::Next | Status::Blocked | Status::Waiting
        )
        && !task.occurrence.as_ref().is_some_and(|o| o.skipped)
}
pub(crate) struct Graph {
    pub tasks: BTreeMap<String, Task>,
    // Dependents precede prerequisites, allowing a single pass for inherited rank.
    order: Vec<String>,
}
impl Graph {
    pub fn new(tasks: Vec<Task>) -> Result<Self> {
        let tasks: BTreeMap<_, _> = tasks
            .into_iter()
            .filter(|t| !t.deleted)
            .map(|t| (t.id.clone(), t))
            .collect();
        let mut incoming: BTreeMap<_, usize> = tasks.keys().map(|id| (id.clone(), 0)).collect();
        for task in tasks.values() {
            validate_ids(&task.blocked_by)?;
            if task.entity_type != EntityType::Task && !task.blocked_by.is_empty() {
                return Err(StoreError::Invalid(
                    "Only tasks can have prerequisites".into(),
                ));
            }
            for id in &task.blocked_by {
                if id == &task.id {
                    return Err(StoreError::Invalid("A task cannot block itself".into()));
                }
                if !tasks
                    .get(id)
                    .is_some_and(|t| t.entity_type == EntityType::Task)
                {
                    return Err(StoreError::Conflict(format!(
                        "Prerequisite {id} must be a retained task; remove references before undoing its creation"
                    )));
                }
                *incoming.get_mut(id).unwrap() += 1;
            }
        }
        let mut queue: BTreeSet<_> = incoming
            .iter()
            .filter(|(_, n)| **n == 0)
            .map(|(id, _)| id.clone())
            .collect();
        let mut order = Vec::with_capacity(tasks.len());
        while let Some(id) = queue.pop_first() {
            for prerequisite in &tasks[&id].blocked_by {
                let count = incoming.get_mut(prerequisite).unwrap();
                *count -= 1;
                if *count == 0 {
                    queue.insert(prerequisite.clone());
                }
            }
            order.push(id);
        }
        if order.len() != tasks.len() {
            return Err(StoreError::Invalid(
                "Dependencies form a cycle; remove a link before saving".into(),
            ));
        }
        Ok(Self { tasks, order })
    }
    pub fn unresolved(&self, task: &Task) -> Vec<String> {
        task.blocked_by
            .iter()
            .filter(|id| !self.tasks.get(*id).is_some_and(satisfied))
            .cloned()
            .collect()
    }
    pub(crate) fn dependents_first(&self) -> impl Iterator<Item = &Task> {
        self.order.iter().map(|id| &self.tasks[id])
    }
    pub fn blocking_counts(&self) -> HashMap<String, usize> {
        let mut counts = HashMap::new();
        for task in self.tasks.values() {
            for prerequisite in &task.blocked_by {
                *counts.entry(prerequisite.clone()).or_insert(0) += 1;
            }
        }
        counts
    }
    pub fn rankings(
        &self,
        now: chrono::DateTime<Utc>,
    ) -> HashMap<String, crate::planning::Recommendation> {
        let mut ranks: HashMap<_, _> = self
            .tasks
            .values()
            .map(|t| (t.id.clone(), crate::planning::evaluate(t, now)))
            .collect();
        for id in &self.order {
            let task = &self.tasks[id];
            if !committed(task) {
                continue;
            }
            let source = ranks[id].clone();
            for prerequisite in &task.blocked_by {
                if !committed(&self.tasks[prerequisite]) {
                    continue;
                }
                let target = ranks.get_mut(prerequisite).unwrap();
                let next = target
                    .next_change_at
                    .iter()
                    .chain(source.next_change_at.iter())
                    .min()
                    .cloned();
                if source.key < target.key {
                    *target = source.clone();
                    target.source_task_id =
                        Some(source.source_task_id.clone().unwrap_or_else(|| id.clone()));
                }
                target.next_change_at = next;
            }
        }
        ranks
    }
}
pub(super) fn resolve(tx: &impl Mutation, graph: &Graph) -> Result<()> {
    let changes = tx.changes();
    let evaluated_at = crate::clock::now();
    for task in graph.tasks.values() {
        if task.entity_type != EntityType::Task
            || task.archived
            || task.occurrence.as_ref().is_some_and(|o| o.skipped)
            || !matches!(task.status, Status::Next | Status::Blocked)
        {
            continue;
        }
        let status = if task.manual_block
            || !graph.unresolved(task).is_empty()
            || task.planning.unavailable_at(evaluated_at)
        {
            Status::Blocked
        } else {
            Status::Next
        };
        if status == task.status {
            continue;
        }
        let causes: Vec<_> = changes
            .iter()
            .filter(|c| {
                task.blocked_by.contains(&c.task_id)
                    && c.before.as_ref().is_some_and(satisfied) != satisfied(&c.after)
            })
            .map(|c| c.id)
            .collect();
        let mut after = task.clone();
        after.status = status;
        tx.resolve_status(task.clone(), after, &causes)?;
    }
    Ok(())
}
pub(super) fn migrate(tx: &Transaction<'_>) -> Result<()> {
    let docs = tx
        .prepare("SELECT document FROM tasks ORDER BY id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let batch = format!("migration-dependencies-{}", Uuid::new_v4());
    for doc in docs {
        let before: Task = serde_json::from_str(&doc)?;
        let mut after = before.clone();
        normalize(&mut after);
        if before != after {
            after.version += 1;
            after.updated_at = now();
            persist_change(
                tx,
                "rename_planned",
                "Rename Planned to manually Blocked, preserving readiness",
                Some(before),
                after,
                None,
                "migration",
                &batch,
            )?;
        }
    }
    tx.execute(
        "UPDATE store_meta SET value=?1 WHERE key='identity'",
        [Uuid::new_v4().to_string()],
    )?;
    tx.execute("DELETE FROM search_sessions", [])?;
    Ok(())
}
