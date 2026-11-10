//! Typed transport contracts. Compact receipts and historical records are distinct
//! from complete current agent records; additional fields allow compatible growth.
use serde_json::{Value, json};
fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required})
}
fn array(items: Value) -> Value {
    json!({"type":"array","items":items})
}
fn reference(name: &str) -> Value {
    json!({"$ref":format!("#/$defs/{name}")})
}
fn nullable(value: Value) -> Value {
    json!({"anyOf":[value,{"type":"null"}]})
}
pub fn schema(name: &str) -> Value {
    let mut record = serde_json::to_value(schemars::schema_for!(crate::model::Task)).unwrap();
    let mut defs = record
        .as_object_mut()
        .unwrap()
        .remove("$defs")
        .unwrap_or(json!({}));
    record.as_object_mut().unwrap().remove("$schema");
    // Summaries and historical receipts predate optional content fields. Their
    // fields retain types without pretending every receipt is a full Task.
    record["required"] = json!(["id", "title", "version"]);
    let p = record["properties"].as_object_mut().unwrap();
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
        if let Some(v) = p.get_mut(key) {
            *v = nullable(v.clone());
        }
    }
    p.insert("detail".into(), json!({"enum":["full","summary"]}));
    p.insert(
        "blocking_count".into(),
        json!({"type":"integer","minimum":0}),
    );
    p.insert(
        "task_counts".into(),
        json!({"type":"object","additionalProperties":{"type":"integer"}}),
    );
    // Historical defaults have optional content. Projection metadata belongs to
    // the transport and is intentionally not written back to stored snapshots.
    defs["Record"] = record;
    defs["CompleteRecord"] =
        json!({"allOf":[reference("Record"),{"required":["brief","notes","agent_notes"]}]});
    let string = json!({"type":"string"});
    let number = json!({"type":"integer"});
    let boolean = json!({"type":"boolean"});
    defs["Audit"] = object(
        json!({"id":number,"entity_id":string,"task_id":string,"project_id":string,"entity_type":reference("EntityType"),"operation":string,"reason":string,"created_at":string,"origin":string,"before":nullable(reference("Record")),"after":reference("Record"),"changed_fields":array(string.clone()),"undoes_change_id":nullable(number.clone()),"transaction_id":string,"transaction_end":boolean}),
        &["id", "operation"],
    );
    defs["Receipt"] = object(
        json!({"task":reference("Record"),"project":reference("Record"),"series":reference("Record"),"change":reference("Audit"),"replayed":boolean,"response_version":number,"request_id":string}),
        &["change", "replayed"],
    );
    defs["Receipt"]["anyOf"] =
        json!([{"required":["task"]},{"required":["project"]},{"required":["series"]}]);
    defs["Receipt"]["description"] = json!(
        "Confirmation of a committed mutation: record identifiers, versions, change identifiers, and replay state. This is not a current full record. A replay returns the original result; read current state before making a new decision."
    );
    defs["BatchReceipt"] = object(
        json!({"results":array(object(json!({"entity_id":string,"entity_type":reference("EntityType"),"version":number,"change_id":number,"operation":string,"replayed":boolean}),&["entity_id","version","change_id","replayed"])),"replayed":boolean,"response_version":number,"request_id":string}),
        &["results", "replayed"],
    );
    defs["Error"] = object(
        json!({"code":string,"message":string,"retryable":boolean,"environment":nullable(string.clone())}),
        &["code", "message"],
    );
    let complete = if name.starts_with("gtd_ui_") {
        reference("Record")
    } else {
        reference("CompleteRecord")
    };
    let tasks = object(
        json!({"items":array(complete.clone()),"next_cursor":nullable(string.clone()),"complete":boolean,"evaluated_at":string,"next_change_at":nullable(string.clone()),"history":array(reference("Audit")),"next_offset":nullable(number.clone()),"next_history_after":nullable(number.clone()),"scope":string,"sort":string,"detail":string,"group_recurrences":boolean}),
        &["items", "next_cursor", "complete"],
    );
    let projects = object(
        json!({"projects":array(complete.clone()),"next_cursor":nullable(string.clone()),"complete":boolean,"detail":string}),
        &["projects", "next_cursor", "complete"],
    );
    let changes = object(
        json!({"changes":array(reference("Audit")),"next_before_id":nullable(number.clone()),"next_cursor":nullable(string.clone()),"snapshot":string,"timezone":string,"from":nullable(string.clone()),"through":nullable(string.clone()),"evaluated_at":string}),
        &["changes", "next_before_id"],
    );
    defs["ActivityAnnotation"] = object(
        json!({"category":{"enum":["undo","completed","added","started","status","scheduling","edited"]},"automatic":boolean,"completion_eligible":boolean,"completion_recorded_at":nullable(string.clone()),"undone_by_change_id":nullable(number.clone()),"transitions":{"type":"object"}}),
        &[
            "category",
            "automatic",
            "completion_eligible",
            "transitions",
        ],
    );
    defs["Audit"]["properties"]["activity"] = reference("ActivityAnnotation");
    let results = object(
        json!({"app":{"const":"gtd"},"view":{"const":"results"},"records":array(complete.clone()),"from_request_ids":array(string.clone()),"next_cursor":nullable(string.clone()),"snapshot":string,"evaluated_at":string}),
        &[
            "app",
            "view",
            "records",
            "from_request_ids",
            "next_cursor",
            "snapshot",
        ],
    );
    let chart = object(
        json!({"days":array(object(json!({"date":string,"count":nullable(number.clone()),"categories":{"type":"object"},"partial":boolean,"future":boolean}), &["date","count","categories","partial","future"])),"snapshot":string,"total":number,"categories":{"type":"object"},"automatic_count":number,"has_history":boolean,"metric":{"enum":["completed","changes"]},"window":{"type":"object","properties":{"timezone":string,"from":string,"through":string,"evaluated_at":string}}}),
        &[
            "days",
            "total",
            "snapshot",
            "has_history",
            "metric",
            "window",
        ],
    );
    let launch = object(
        json!({"app":{"const":"gtd"},"view":string,"series_id":nullable(string.clone())}),
        &["app", "view"],
    );
    let sync = object(
        json!({"phase":{"enum":["snapshot","changes"]},"records":array(complete.clone()),"changes":array(reference("Audit")),"next_cursor":nullable(string.clone()),"checkpoint":nullable(string.clone()),"complete":boolean}),
        &[
            "phase",
            "records",
            "changes",
            "complete",
            "next_cursor",
            "checkpoint",
        ],
    );
    let series = object(
        json!({"series_list":array(complete.clone()),"next_cursor":nullable(string.clone()),"complete":boolean,"timezone":string}),
        &["series_list", "next_cursor", "complete"],
    );
    let occurrences = object(
        json!({"series":nullable(complete.clone()),"occurrences":array(object(json!({"original_date":string,"scheduled_date":string,"preview":boolean,"task":complete,"due_date":nullable(string.clone()),"timing_adjustments":array(string.clone()),"planning":reference("PlanningPreview")}),&["original_date","scheduled_date","preview"])),"next_cursor":nullable(string.clone()),"complete":boolean,"timezone":string,"from":string,"through":string}),
        &["occurrences", "next_cursor", "complete"],
    );
    // Planning is flattened into Record; reuse its field types for previews.
    defs["PlanningPreview"] = object(defs["Record"]["properties"].clone(), &[]);
    let segments = object(
        json!({"series_id":string,"version":number,"segments":array(object(json!({"from":string,"rule":reference("RepeatRule"),"template":reference("Template")}),&["from","rule","template"])),"next_cursor":nullable(string.clone()),"complete":boolean}),
        &[
            "series_id",
            "version",
            "segments",
            "next_cursor",
            "complete",
        ],
    );
    let home = object(
        json!({
            "next":tasks, "waiting":tasks, "someday":tasks,
            "reviewTasks":tasks, "reviewProjects":projects,
            "remaining":nullable(string.clone()),
        }),
        &[
            "next",
            "waiting",
            "someday",
            "reviewTasks",
            "reviewProjects",
            "remaining",
        ],
    );
    let full_view = object(
        json!({
            "kind":{"const":"full"},
            "home_notes_reusable":{"type":"boolean"},
            "reused_home_notes":{"type":"array","items":{"type":"string"},"maxItems":3},
            "chart_today":{"type":"string"},
            "token":nullable(string.clone()),
            "data":{"anyOf":[home,tasks,chart]},
        }),
        &["kind", "token", "data"],
    );
    let unchanged_view = object(
        json!({"kind":{"const":"unchanged"},"token":string}),
        &["kind", "token"],
    );
    let mut variants = match name {
        "capture_item" | "update_item" | "undo_change" | "create_project" | "update_project"
        | "create_recurrence" | "update_recurrence" => vec![reference("Receipt")],
        "apply_changes" => vec![reference("BatchReceipt")],
        "show_gtd" => vec![launch, results],
        "list_items" | "show_tasks" => vec![tasks],
        "list_projects" | "show_projects" => vec![projects],
        "list_changes" => vec![changes],
        "sync_state" => vec![sync],
        "list_occurrences" => vec![series, occurrences, segments],
        "gtd_ui_read" => vec![
            unchanged_view,
            full_view,
            chart,
            results,
            launch,
            tasks,
            projects,
            changes,
            sync,
            series,
            occurrences,
            segments,
        ],
        "gtd_ui_write" => vec![reference("Receipt"), reference("BatchReceipt")],
        _ => unreachable!(),
    };
    if name == "gtd_ui_read" {
        variants.extend(crate::priority_grid::outputs());
    }
    variants.push(reference("Error"));
    let mut result = json!({"type":"object","anyOf":variants,"properties":{"environment":{"type":["string","null"]},"response_version":{"type":"integer"}},"$defs":defs});
    fn clean(v: &mut Value) {
        match v {
            Value::Object(o) => {
                o.remove("description");
                o.remove("additionalProperties");
                for v in o.values_mut() {
                    clean(v);
                }
            }
            Value::Array(a) => {
                for v in a {
                    clean(v)
                }
            }
            _ => {}
        }
    }
    clean(&mut result);
    // Include only definitions reachable from this tool's result variants.
    fn refs(v: &Value, out: &mut std::collections::BTreeSet<String>) {
        match v {
            Value::Object(o) => {
                if let Some(r) = o
                    .get("$ref")
                    .and_then(Value::as_str)
                    .and_then(|s| s.strip_prefix("#/$defs/"))
                {
                    out.insert(r.into());
                }
                for (k, v) in o {
                    if k != "$defs" {
                        refs(v, out);
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    refs(v, out)
                }
            }
            _ => {}
        }
    }
    let mut needed = std::collections::BTreeSet::new();
    refs(&result, &mut needed);
    loop {
        let before = needed.len();
        for key in needed.clone() {
            refs(&result["$defs"][&key], &mut needed);
        }
        if needed.len() == before {
            break;
        }
    }
    result["$defs"]
        .as_object_mut()
        .unwrap()
        .retain(|k, _| needed.contains(k));
    if result["$defs"].get("Receipt").is_some() {
        result["$defs"]["Receipt"]["description"] =
            crate::mcp_contract::fields()["receipt"].clone();
    }
    for (field, key) in [
        ("brief", "brief_read"),
        ("agent_notes", "agent_read"),
        ("completed_at", "completed_at"),
        ("version", "version"),
    ] {
        if result
            .pointer(&format!("/$defs/Record/properties/{field}"))
            .is_some()
            && crate::mcp_contract::fields()[key].is_string()
        {
            result["$defs"]["Record"]["properties"][field]["description"] =
                crate::mcp_contract::fields()[key].clone();
        }
    }
    result
}
