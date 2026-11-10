//! Transport projections never alter the authoritative record or stored receipt.
use crate::model::*;
use serde_json::{Value, json};
pub const PAGE_BYTES: usize = 32 * 1024;
pub fn record(task: &Task, detail: Detail) -> Value {
    record_with_agent_notes(task, detail, false)
}

/// Apply at every nested task/defaults object; recurrence segments can hold working notes too.
fn agent_notes_projection(value: &mut Value, include: bool) {
    match value {
        Value::Object(object) => {
            object.remove("legacy_work_block_id");
            object.remove("content_key");
            for child in object.values_mut() {
                agent_notes_projection(child, include);
            }
            if object.contains_key("title") && object.contains_key("notes") {
                let notes = object
                    .get("agent_notes")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                object.insert("has_agent_notes".into(), json!(!notes.is_empty()));
                if include {
                    object.insert("agent_notes".into(), json!(notes));
                } else {
                    object.remove("agent_notes");
                    object
                        .entry("omitted_fields")
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .unwrap()
                        .push(json!("agent_notes"));
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                agent_notes_projection(item, include);
            }
        }
        _ => {}
    }
}

pub fn record_with_agent_notes(task: &Task, detail: Detail, include: bool) -> Value {
    let mut value = serde_json::to_value(task).expect("record serialization");
    agent_notes_projection(&mut value, include && detail == Detail::Full);
    value["brief"] = json!(task.brief);
    if task.entity_type == EntityType::Task {
        for key in [
            "importance",
            "estimated_minutes",
            "effort",
            "not_before",
            "safety_buffer",
            "deadline_time",
            "start_by",
            "planned_start",
            "planned_finish",
            "started_at",
        ] {
            value
                .as_object_mut()
                .unwrap()
                .entry(key)
                .or_insert(Value::Null);
        }
        value["started"] = json!(task.planning.started);
        value["work_blocks"] = json!(task.planning.blocks());
        let target = task
            .planning
            .buffer_target(task.due_date.as_deref())
            .ok()
            .flatten();
        value["buffer_target"] = json!(target.as_ref().map(|(m, _)| m));
        value["buffer_adjustment"] = json!(target.and_then(|(_, note)| note));
        let at = task
            .recommendation
            .as_ref()
            .and_then(|r| chrono::DateTime::parse_from_rfc3339(&r.evaluated_at).ok())
            .map(|v| v.with_timezone(&chrono::Utc))
            .unwrap_or_else(chrono::Utc::now);
        let mut reasons = Vec::new();
        if task.manual_block {
            reasons.push(json!({"kind":"manual"}));
        }
        if !task.unresolved_blocker_ids.is_empty() {
            reasons.push(json!({"kind":"prerequisites","task_ids":task.unresolved_blocker_ids}));
        }
        if task.planning.unavailable_at(at) {
            reasons.push(json!({"kind":"availability","available_at":task.planning.not_before}));
        }
        value["blocking_reasons"] = json!(reasons);
        value
            .as_object_mut()
            .unwrap()
            .remove("legacy_work_block_id");
        // Current transport records must explicitly clear these values when merged
        // into a previously loaded task. Historical documents keep their encoding.
        value["blocked_by"] = json!(task.blocked_by);
        value["manual_block"] = json!(task.manual_block);
    }
    if detail == Detail::Summary {
        value["work_block_count"] = json!(task.planning.blocks().len());
        value.as_object_mut().unwrap().remove("work_blocks");
        if let Some(series) = &task.recurrence {
            value.as_object_mut().unwrap().remove("recurrence");
            value["recurrence_summary"] = json!({"segment_count":series.segments.len(),"paused":series.pauses.iter().any(|p|p.through.is_none()),"ended_on":series.ended_on,"current_rule":series.segments.last().map(|s|&s.rule)});
        }
        value["has_notes"] = json!(!task.notes.is_empty());
        value["link_count"] = json!(task.links.len());
        value["has_location"] = json!(task.location.is_some());
        value["work_session_count"] = json!(task.work_sessions.len());
        value["has_completion_result"] = json!(task.completion_result.is_some());
        value["omitted_fields"] = json!([
            "work_blocks",
            "agent_notes",
            "notes",
            "links",
            "location",
            "work_sessions",
            "completion_result",
            "created_at",
            "updated_at"
        ]);
        if task.recurrence.is_some() {
            value["omitted_fields"]
                .as_array_mut()
                .unwrap()
                .push(json!("recurrence"));
        }
        for key in [
            "notes",
            "links",
            "location",
            "work_sessions",
            "completion_result",
            "created_at",
            "updated_at",
        ] {
            value.as_object_mut().unwrap().remove(key);
        }
    }
    value["detail"] = json!(detail);
    value
}
pub fn page_record(task: &Task, detail: Detail, explicit: bool) -> Value {
    page_record_with_agent_notes(task, detail, explicit, false)
}
pub fn page_record_with_agent_notes(
    task: &Task,
    detail: Detail,
    explicit: bool,
    include: bool,
) -> Value {
    let value = record_with_agent_notes(task, detail, include);
    if !explicit && !include && serde_json::to_vec(&value).unwrap().len() > 12 * 1024 {
        let mut summary = record(task, Detail::Summary);
        summary["detail_required"] = json!(true);
        summary
    } else {
        value
    }
}
// Historical records predating this field have the same empty value as newly cleared notes.
fn audit_agent_notes(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for child in object.values_mut() {
                audit_agent_notes(child);
            }
            if object.contains_key("title") && object.contains_key("notes") {
                object.entry("agent_notes").or_insert_with(|| json!(""));
            }
        }
        Value::Array(items) => {
            for item in items {
                audit_agent_notes(item);
            }
        }
        _ => {}
    }
}
pub fn change(change: &Change, detail: Detail) -> Value {
    let mut value = serde_json::to_value(change).expect("change serialization");
    value["entity_id"] = json!(change.task_id);
    if change.entity_type == EntityType::Project {
        value.as_object_mut().unwrap().remove("task_id");
        value["project_id"] = json!(change.task_id);
    }
    let after = serde_json::to_value(&change.after).unwrap();
    let before = serde_json::to_value(&change.before).unwrap();
    let keys = after
        .as_object()
        .unwrap()
        .keys()
        .chain(
            before
                .as_object()
                .into_iter()
                .flat_map(|object| object.keys()),
        )
        .collect::<std::collections::BTreeSet<_>>();
    value["changed_fields"] = json!(
        keys.into_iter()
            .filter(|key| {
                ![
                    "id",
                    "version",
                    "last_change_id",
                    "created_at",
                    "updated_at",
                    "entity_type",
                    "legacy_work_block_id",
                ]
                .contains(&key.as_str())
                    && before.get(key.as_str()) != after.get(key.as_str())
            })
            .collect::<Vec<_>>()
    );
    value["detail"] = json!(detail);
    if detail == Detail::Summary {
        value.as_object_mut().unwrap().remove("before");
        value["after"] = record(&change.after, Detail::Summary);
    } else {
        audit_agent_notes(&mut value["before"]);
        audit_agent_notes(&mut value["after"]);
    }
    value
}
pub fn mutation(result: &MutationResult) -> Value {
    let mut audit = change(&result.change, Detail::Summary);
    for key in ["before", "after", "reason"] {
        audit.as_object_mut().unwrap().remove(key);
    }
    let mut value = json!({"change":audit,"replayed":result.replayed,"response_version":2});
    value[if result.task.entity_type == EntityType::Project {
        "project"
    } else if result.task.entity_type == EntityType::Recurrence {
        "series"
    } else {
        "task"
    }] = record(&result.task, Detail::Summary);
    value
}

pub fn changes(result: &ChangesResult, detail: Detail) -> Value {
    let items = result
        .changes
        .iter()
        .map(|c| {
            let mut value = change(c, detail);
            if let Some(activity) = result.activity.get(&c.id) {
                value["activity"] = activity.clone();
            }
            value
        })
        .collect::<Vec<_>>();
    json!({"changes":items,"next_before_id":result.next_before_id,"next_cursor":result.next_cursor,
        "snapshot":result.snapshot,"window":result.window,"evaluated_at":result.window.evaluated_at,
        "timezone":result.window.timezone,"from":result.window.from,"through":result.window.through,
        "detail":detail,"response_version":2})
}

/// Complete current agent context without repeating every historical default.
pub fn agent_record_at(task: &Task, evaluated_at: &str) -> Value {
    let mut value = record_with_agent_notes(task, Detail::Full, true);
    if let Some(series) = &task.recurrence {
        let today = chrono::DateTime::parse_from_rfc3339(evaluated_at)
            .expect("snapshot time")
            .with_timezone(&chrono_tz::America::New_York)
            .date_naive()
            .to_string();
        if let Some(segment) = series
            .segments
            .iter()
            .rev()
            .find(|s| s.from <= today)
            .or(series.segments.first())
        {
            let mut current = json!(segment);
            agent_notes_projection(&mut current, true);
            current["template"]["brief"] = json!(segment.template.brief.as_deref().unwrap_or(""));
            value["recurrence"]["segments"] = json!([current]);
            value["recurrence"]["segment_count"] = json!(series.segments.len());
            value["recurrence"]["segments_paginated"] = json!(true);
            value["brief"] = json!(segment.template.brief.as_deref().unwrap_or(""));
            value["notes"] = json!(segment.template.notes);
            value["agent_notes"] = json!(segment.template.agent_notes.as_deref().unwrap_or(""));
        }
    }
    value
}
