//! One description source and entry-point-specific schemas for Rust and the adapter.
use serde_json::{Value, json};
use std::sync::OnceLock;
pub fn guidance() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| {
        serde_json::from_str(include_str!("tool_guidance.json")).expect("reviewed guidance JSON")
    })
}
pub fn description(name: &str, ui: bool) -> String {
    let t = guidance()["tools"]
        .as_array()
        .unwrap()
        .iter()
        .chain(guidance()["app_only_facades"].as_array().unwrap())
        .find(|t| t["name"] == name)
        .expect("known tool");
    t["description"]
        .as_str()
        .or_else(|| {
            t["description_variants"][if ui { "ui_enabled" } else { "ui_disabled" }].as_str()
        })
        .expect("description")
        .to_owned()
}
pub fn annotations(name: &str) -> Value {
    guidance()["tools"]
        .as_array()
        .unwrap()
        .iter()
        .chain(guidance()["app_only_facades"].as_array().unwrap())
        .find(|t| t["name"] == name)
        .unwrap()["annotations"]
        .clone()
}
fn require(value: &mut Value, names: &[&str]) {
    let required = value
        .as_object_mut()
        .unwrap()
        .entry("required")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    for name in names {
        if !required.iter().any(|v| v == name) {
            required.push(json!(name));
        }
    }
}
fn content_create(schema: &mut Value, task: bool) {
    require(schema, &["agent_notes"]);
    schema["properties"]["agent_notes"]["type"] = json!("string");
    schema["properties"]["agent_notes"]["minLength"] = json!(1);
    if !task {
        require(schema, &["brief"]);
        schema["properties"]["brief"]["type"] = json!("string");
        schema["properties"]["brief"]["minLength"] = json!(1);
    } else {
        schema["allOf"] = json!([{ "if":{"required":["status"],"properties":{"status":{"not":{"enum":["inbox","archived"]}}}},"then":{"required":["brief"],"properties":{"brief":{"type":"string","minLength":1}}}}]);
    }
}
pub fn agent_schema(name: &str, mut schema: Value) -> Value {
    fn nested(node: &mut Value) {
        if let Some(op) = node
            .pointer("/properties/operation/const")
            .and_then(Value::as_str)
            .map(str::to_owned)
        {
            match op.as_str() {
                "capture" => content_create(node, true),
                "create_project" => content_create(node, false),
                "create_recurrence" => recurrence_create(node),
                _ => {}
            }
        }
        match node {
            Value::Object(o) => {
                for child in o.values_mut() {
                    nested(child)
                }
            }
            Value::Array(a) => {
                for child in a {
                    nested(child)
                }
            }
            _ => {}
        }
    }
    if name == "capture_item" {
        content_create(&mut schema, true);
    }
    if name == "create_project" {
        content_create(&mut schema, false);
    }
    if name == "create_recurrence" {
        recurrence_create(&mut schema);
    }
    nested(&mut schema);
    if let Some(def) = schema.pointer_mut("/$defs/NewTemplate") {
        require(def, &["agent_notes"]);
        def["properties"]["agent_notes"]["type"] = json!("string");
        def["properties"]["agent_notes"]["minLength"] = json!(1);
    }
    if matches!(
        name,
        "list_items" | "show_tasks" | "list_projects" | "show_projects" | "list_occurrences"
    ) && let Some(props) = schema.get_mut("properties").and_then(Value::as_object_mut)
    {
        props.remove("detail");
        props.remove("include_agent_notes");
    }
    schema
}
/// Nested tool schemas must rebase local refs when combined under one UI union.
pub fn ui_schema(operations: Vec<(String, Value)>) -> Value {
    fn rebase(v: &mut Value, prefix: &str) {
        match v {
            Value::Object(o) => {
                if let Some(r) = o.get_mut("$ref")
                    && let Some(s) = r.as_str().and_then(|r| r.strip_prefix("#/$defs/"))
                {
                    *r = json!(format!("#/$defs/{prefix}_{s}"));
                }
                for v in o.values_mut() {
                    rebase(v, prefix);
                }
            }
            Value::Array(a) => {
                for v in a {
                    rebase(v, prefix);
                }
            }
            _ => {}
        }
    }
    let mut defs = serde_json::Map::new();
    let mut variants = vec![];
    for (name, mut args) in operations {
        rebase(&mut args, &name);
        if let Some(Value::Object(children)) = args.as_object_mut().unwrap().remove("$defs") {
            for (k, v) in children {
                defs.insert(format!("{name}_{k}"), v);
            }
        }
        args.as_object_mut().unwrap().remove("$schema");
        variants.push(json!({"type":"object","properties":{"operation":{"const":name},"arguments":args},"required":["operation","arguments"],"additionalProperties":false}));
    }
    json!({"type":"object","oneOf":variants,"$defs":defs})
}

pub(crate) fn fields() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_str(include_str!("field_guidance.json")).unwrap())
}
fn describe(schema: &mut Value, field: &str, key: &str) {
    if let Some(prop) = schema.get_mut("properties").and_then(|v| v.get_mut(field)) {
        prop["description"] = fields()[key].clone();
    }
}
fn author_fields(schema: &mut Value, kind: &str, agent: bool) {
    let create = matches!(kind, "capture" | "create_project" | "repeat_create");
    let repeat = kind.starts_with("repeat_");
    let project = kind.contains("project");
    let scoped = kind == "update_recurrence";
    let suffix = if create { "create" } else { "patch" };
    let entity = if repeat {
        "repeat"
    } else if project {
        "project"
    } else {
        "task"
    };
    describe(
        schema,
        "brief",
        &if scoped {
            "brief_scoped".into()
        } else {
            format!("brief_{entity}_{suffix}")
        },
    );
    describe(
        schema,
        "agent_notes",
        &if !agent {
            "agent_human".into()
        } else if scoped {
            "agent_scoped".into()
        } else {
            format!("agent_{entity}_{suffix}")
        },
    );
    describe(
        schema,
        "notes",
        if repeat {
            "notes_repeat"
        } else if create {
            "notes_create"
        } else {
            "notes_patch"
        },
    );
    for (field, base) in [
        ("links", "links"),
        ("work_sessions", "sessions"),
        ("completion_result", "result"),
    ] {
        describe(schema, field, &format!("{base}_{suffix}"));
    }
    if !project {
        describe(schema, "due_date", &format!("due_{suffix}"));
    }
    if kind == "update" {
        describe(schema, "status", "status_patch");
    }
    for (field, max) in [("brief", 600), ("notes", 10000), ("agent_notes", 10000)] {
        if let Some(p) = schema.pointer_mut(&format!("/properties/{field}")) {
            p["maxLength"] = json!(max);
        }
    }
    if agent && create && !repeat {
        content_create(schema, !project);
    }
    if agent && kind == "repeat_create" {
        require(schema, &["agent_notes"]);
        schema["properties"]["agent_notes"]["type"] = json!("string");
        schema["properties"]["agent_notes"]["minLength"] = json!(1);
    }
}
/// Apply each definition at its actual schema surface, including batch members.
pub fn field_schema(name: &str, mut schema: Value, agent: bool) -> Value {
    let kind = match name {
        "capture_item" => "capture",
        "update_item" => "update",
        n => n,
    };
    if matches!(
        kind,
        "capture" | "update" | "create_project" | "update_project" | "update_recurrence"
    ) {
        author_fields(&mut schema, kind, agent);
    }
    fn walk(v: &mut Value, agent: bool) {
        if let Some(op) = v
            .pointer("/properties/operation/const")
            .and_then(Value::as_str)
            .map(str::to_owned)
        {
            author_fields(v, &op, agent);
        }
        for key in [
            "reason",
            "started",
            "started_at",
            "estimated_minutes",
            "effort",
            "segment_from",
            "segments_only",
        ] {
            describe(v, key, key);
        }
        if v.pointer("/properties/scope").is_some() && v.pointer("/properties/series_id").is_some()
        {
            describe(v, "scope", "scope");
            describe(v, "original_date", "original_date");
            describe(v, "rule", "replacement_rule");
            describe(v, "template", "replacement_template");
        }
        if v.pointer("/properties/calendar_event").is_some() {
            describe(v, "calendar_event", "calendar_event");
        }
        match v {
            Value::Object(o) => {
                for child in o.values_mut() {
                    walk(child, agent)
                }
            }
            Value::Array(a) => {
                for child in a {
                    walk(child, agent)
                }
            }
            _ => {}
        }
    }
    walk(&mut schema, agent);
    for (def, kind) in [
        ("NewTemplate", "repeat_create"),
        ("Template", "repeat_patch"),
    ] {
        if let Some(v) = schema.pointer_mut(&format!("/$defs/{def}")) {
            author_fields(v, kind, agent);
        }
    }
    if let Some(v) = schema.pointer_mut("/$defs/PreviewTemplate") {
        describe(v, "notes", "notes_repeat");
    }
    if let Some(v) = schema.pointer_mut("/$defs/TaskLink") {
        describe(v, "url", "url");
        describe(v, "label", "link_label");
    }
    match name {
        "list_items" | "show_tasks" | "list_projects" | "show_projects" => {
            describe(&mut schema, "task_ids", "task_ids");
            describe(&mut schema, "cursor", "record_cursor");
            if agent {
                describe(&mut schema, "limit", "record_limit");
            }
        }
        "list_occurrences" => {
            describe(&mut schema, "template", "preview_template");
            if agent {
                describe(&mut schema, "limit", "occurrence_limit");
            }
        }
        "sync_state" => {
            describe(&mut schema, "cursor", "sync_cursor");
            if agent {
                describe(&mut schema, "limit", "sync_limit");
            }
        }
        "list_changes" => {
            describe(&mut schema, "change_id", "change_id");
            describe(&mut schema, "detail", "audit_detail");
        }
        _ => {}
    }
    schema
}

fn recurrence_create(schema: &mut Value) {
    schema["allOf"] = json!([{"if":{"not":{"required":["task_id"],"properties":{"task_id":{"type":"string"}}}},"then":{"properties":{"template":{"if":{"not":{"required":["status"],"properties":{"status":{"const":"inbox"}}}},"then":{"required":["brief"],"properties":{"brief":{"type":"string","minLength":1}}}}}}}]);
}
