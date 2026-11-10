use super::*;

pub(super) fn normalize(task: &mut Task) {
    if task.deleted || task.entity_type == EntityType::Project {
        return;
    }
    if matches!(
        task.status,
        Status::Next | Status::Blocked | Status::Waiting | Status::Planned
    ) {
        task.planning.estimated_minutes.get_or_insert(30);
        task.planning
            .effort
            .get_or_insert(crate::task_planning::Effort::Medium);
    }
    task.planning.normalize_blocks();
    if let Some(series) = &mut task.recurrence {
        for segment in &mut series.segments {
            let t = &mut segment.template;
            if matches!(
                t.status,
                Status::Next | Status::Blocked | Status::Waiting | Status::Planned
            ) {
                t.planning.estimated_minutes.get_or_insert(30);
                t.planning
                    .effort
                    .get_or_insert(crate::task_planning::Effort::Medium);
            }
            // Only stored legacy pairs need conversion; never reinterpret historical rows.
            if t.planning.work_blocks.is_none() && t.planning.planned_start.is_some() {
                t.planning.work_blocks = Some(vec![crate::task_planning::RelativeWorkBlock {
                    id: "legacy".into(),
                    start: t.planning.planned_start.clone().unwrap(),
                    finish: t.planning.planned_finish.clone(),
                }]);
                t.planning.legacy_work_block_id = Some("legacy".into());
            }
        }
    }
}
pub(super) fn migrate(tx: &Transaction<'_>) -> Result<()> {
    let docs = tx
        .prepare("SELECT document FROM tasks ORDER BY id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let batch = format!("migration-task-planning-{}", Uuid::new_v4());
    for doc in docs {
        let before: Task = serde_json::from_str(&doc)?;
        let mut after = before.clone();
        normalize(&mut after);
        if before != after {
            after.version += 1;
            after.updated_at = now();
            persist_change(
                tx,
                "planning_defaults",
                "Migrate committed work to 30 minutes / Medium where absent; preserve existing planned work as an identified block",
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
