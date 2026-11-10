//! Shared content invariants and authoring policy.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Policy {
    #[default]
    Human,
    Agent,
}
impl Policy {
    pub(super) fn notes(self, value: Option<&str>, creating: bool) -> Result<()> {
        if self == Self::Agent
            && ((creating && value.is_none()) || value.is_some_and(|s| s.trim().is_empty()))
        {
            return Err(StoreError::Invalid(
                "agent_notes must contain a task-specific handoff for agent-authored records"
                    .into(),
            ));
        }
        Ok(())
    }
}
pub(super) fn segment_key(s: &crate::recurrence_model::Segment) -> String {
    s.content_key
        .clone()
        .unwrap_or_else(|| format!("legacy:{}", s.from))
}
fn validate_brief(brief: &str, required: bool) -> Result<()> {
    if brief.chars().count() > 600 {
        return Err(StoreError::Invalid(
            "brief exceeds 600 Unicode characters".into(),
        ));
    }
    if required && brief.trim().is_empty() {
        return Err(StoreError::Invalid("brief is required outside Inbox and for projects. Supply a short human brief; historical undo cannot restore a missing required brief.".into()));
    }
    Ok(())
}
pub(super) fn validate_change(policy: Policy, change: &Change) -> Result<()> {
    let task = &change.after;
    if task.deleted {
        return Ok(());
    }
    let before = change.before.as_ref();
    let undo = change.undoes_change_id.is_some();
    if let Some(series) = &task.recurrence {
        for s in &series.segments {
            let key = segment_key(s);
            let old = before
                .and_then(|t| t.recurrence.as_ref())
                .and_then(|r| r.segments.iter().find(|old| segment_key(old) == key));
            let clarifying = old.is_some_and(|old| old.template.status == Status::Inbox)
                && s.template.status != Status::Inbox;
            validate_brief(
                s.template.brief.as_deref().unwrap_or(""),
                s.template.status != Status::Inbox,
            )?;
            if policy == Policy::Agent
                && !undo
                && (before.is_none() || clarifying)
                && s.template
                    .agent_notes
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
            {
                return Err(StoreError::Invalid(
                    "agent_notes is required when creating or clarifying recurring defaults".into(),
                ));
            }
        }
    } else {
        let clarifying =
            before.is_some_and(|t| t.status == Status::Inbox) && task.status != Status::Inbox;
        validate_brief(
            &task.brief,
            task.entity_type == EntityType::Project || task.status != Status::Inbox,
        )?;
        if policy == Policy::Agent
            && !undo
            && (clarifying || (before.is_none() && change.operation != "occurrence"))
            && task.agent_notes.trim().is_empty()
        {
            return Err(StoreError::Invalid(
                "agent_notes is required when creating or clarifying an agent-authored record"
                    .into(),
            ));
        }
    }
    Ok(())
}
/// Cleanup is an atomic gate, never a content backfill. Older databases with
/// incomplete content must use the 0.17 release to finish backfill first.
pub(super) fn migrate(tx: &Transaction<'_>) -> Result<()> {
    let mut stmt = tx.prepare("SELECT document FROM tasks")?;
    let docs = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for doc in docs {
        let task: Task = serde_json::from_str(&doc?)?;
        if task.deleted {
            continue;
        }
        if let Some(series) = &task.recurrence {
            for segment in &series.segments {
                validate_brief(segment.template.brief.as_deref().unwrap_or(""), segment.template.status != Status::Inbox)
                    .map_err(|e| StoreError::Invalid(format!("Brief cleanup refused for series {} segment {}: {e} Complete backfill with GTD 0.17 before upgrading.", task.id, segment.from)))?;
            }
        } else {
            validate_brief(&task.brief, task.entity_type == EntityType::Project || task.status != Status::Inbox)
                .map_err(|e| StoreError::Invalid(format!("Brief cleanup refused for {}: {e} Complete backfill with GTD 0.17 before upgrading.", task.id)))?;
        }
    }
    drop(stmt);
    tx.execute_batch("DROP TABLE IF EXISTS brief_exemptions;")?;
    tx.execute(
        "UPDATE store_meta SET value=?1 WHERE key='identity'",
        [Uuid::new_v4().to_string()],
    )?;
    tx.execute("DELETE FROM search_sessions", [])?;
    // Rebuild derived search, retaining recurrence worker checkpoints.
    tx.execute(
        "DELETE FROM search_state WHERE key NOT LIKE 'recurrence:%'",
        [],
    )?;
    Ok(())
}

pub(super) fn validate_replacement(value: Option<&str>, required: bool) -> Result<()> {
    if let Some(text) = value {
        if text.chars().count() > 600 {
            return Err(StoreError::Invalid(
                "brief exceeds 600 Unicode characters".into(),
            ));
        }
        if required && text.trim().is_empty() {
            return Err(StoreError::Invalid(
                "A supplied brief must be nonblank outside Inbox".into(),
            ));
        }
    }
    Ok(())
}
