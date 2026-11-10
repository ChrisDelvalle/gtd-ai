//! Preserve pre-planning contracts except explicitly additive planning and read-filter fields; exercise guidance recipes.
mod support;
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{application::Application, diagnostics::Diagnostics, server, store::Store};
#[test]
fn content_contract_preserves_canonical_tools_and_separates_human_entry() {
    let tools = server::tools();
    let canonical: Vec<_> = tools
        .iter()
        .filter(|t| !t.name.starts_with("gtd_ui_"))
        .collect();
    assert_eq!(canonical.len(), 16);
    for t in canonical {
        assert_eq!(
            serde_json::to_value(&t.meta).unwrap()["ui"]["visibility"],
            json!(["model"])
        );
        assert!(t.output_schema.is_some());
    }
    for name in ["gtd_ui_read", "gtd_ui_write"] {
        let t = tools.iter().find(|t| t.name == name).unwrap();
        assert_eq!(
            serde_json::to_value(&t.meta).unwrap()["ui"]["visibility"],
            json!(["app"])
        );
    }
    let capture = tools.iter().find(|t| t.name == "capture_item").unwrap();
    assert!(
        capture.input_schema["required"]
            .as_array()
            .unwrap()
            .contains(&json!("agent_notes"))
    );
    let list = tools.iter().find(|t| t.name == "list_items").unwrap();
    assert!(
        list.input_schema["properties"]
            .get("include_agent_notes")
            .is_none()
    );
    assert!(list.input_schema["properties"].get("detail").is_none());
    let legacy: todo_mcp::model::ListItems =
        serde_json::from_value(json!({"detail":"summary","include_agent_notes":false})).unwrap();
    assert_eq!(legacy.detail, Some(todo_mcp::model::Detail::Summary));
}

fn description_fields(value: &Value, descriptions: &mut Vec<String>) {
    if let Some(notes) = value
        .get("properties")
        .and_then(|fields| fields.get("notes"))
    {
        descriptions.push(notes["description"].as_str().unwrap_or("").to_owned());
    }
    match value {
        Value::Object(object) => object
            .values()
            .for_each(|value| description_fields(value, descriptions)),
        Value::Array(array) => array
            .iter()
            .for_each(|value| description_fields(value, descriptions)),
        _ => {}
    }
}

#[test]
fn markdown_guidance_reaches_nested_batch_project_and_recurrence_fields() {
    let tools = server::tools();
    for name in [
        "capture_item",
        "update_item",
        "apply_changes",
        "create_project",
        "update_project",
        "create_recurrence",
        "update_recurrence",
    ] {
        let tool = tools.iter().find(|tool| tool.name == name).unwrap();
        let mut descriptions = vec![];
        description_fields(
            &serde_json::to_value(&tool.input_schema).unwrap(),
            &mut descriptions,
        );
        assert!(!descriptions.is_empty(), "Missing notes fields: {name}");
        assert!(
            descriptions.iter().all(|text| text.contains("Markdown")),
            "Missing Markdown guidance: {name}"
        );
    }
}

fn fixture() -> (TempDir, Application) {
    let dir = TempDir::new().unwrap();
    let app = Application::new(
        Store::open(dir.path().join("tasks.sqlite3")).unwrap(),
        Diagnostics::open(&dir.path().join("events.sqlite3"), "test").unwrap(),
    );
    (dir, app)
}

async fn call(app: &Application, name: &str, args: Value) -> Value {
    app.execute(name, support::operation(name, args))
        .await
        .unwrap_or_else(|error| panic!("{name}: {error}"))
}

#[tokio::test]
async fn documented_recurrence_discovery_history_and_replacement_recipe() {
    let (_dir, app) = fixture();
    let rule = json!({"start_date":"2090-01-01","frequency":"daily","count":2});
    let preview = call(&app, "list_occurrences", json!({"rule":rule})).await;
    assert_eq!(preview["occurrences"].as_array().unwrap().len(), 2);
    assert_eq!(
        call(&app, "list_occurrences", json!({})).await["series_list"],
        json!([])
    );
    let created = call(&app, "create_recurrence", json!({
        "request_id":"guide-create", "rule":rule,
        "template":{"estimated_minutes":30,"effort":"medium","importance":"normal","title":"Review the plan", "notes":"## Preparation\nRead the **brief**.", "agent_notes":"Retain the previous decision.", "location":"Main office"},
        "reason":"Isolated documentation recipe"
    })).await;
    let id = &created["series"]["id"];
    let listing = call(&app, "list_occurrences", json!({})).await;
    assert_eq!(listing["series_list"][0]["id"], *id);
    assert_eq!(
        listing["series_list"][0]["agent_notes"],
        "Retain the previous decision."
    );
    let ordinary = call(&app, "list_occurrences", json!({"series_id":id})).await;
    let defaults = &ordinary["series"]["recurrence"]["segments"][0]["template"];
    assert_eq!(defaults["agent_notes"], "Retain the previous decision.");

    // Preserve wanted ordinary defaults by reading and submitting them explicitly.
    // Output-only metadata is not valid input; select the actual template fields.
    let replacement = json!({"title":"Review the updated plan", "notes":defaults["notes"], "location":defaults["location"]});
    let edit = call(&app, "update_recurrence", json!({
        "request_id":"guide-edit", "series_id":id,"expected_version":1,
        "scope":"all","action":"edit","template":replacement,"reason":"Isolated documentation recipe"
    })).await;
    let full = call(
        &app,
        "list_occurrences",
        json!({"series_id":id,"include_agent_notes":true}),
    )
    .await;
    let defaults = &full["series"]["recurrence"]["segments"][0]["template"];
    assert_eq!(defaults["notes"], "## Preparation\nRead the **brief**.");
    assert_eq!(defaults["agent_notes"], "Retain the previous decision.");
    assert_eq!(defaults["location"], "Main office");

    // The documented exception is working notes, not every omitted template field.
    call(&app, "update_recurrence", json!({
        "request_id":"guide-replace", "series_id":id,"expected_version":edit["series"]["version"],
        "scope":"all","action":"edit","template":{"title":"A shorter review"},"reason":"Isolated replacement semantics"
    })).await;
    let full = call(
        &app,
        "list_occurrences",
        json!({"series_id":id,"include_agent_notes":true}),
    )
    .await;
    let defaults = &full["series"]["recurrence"]["segments"][0]["template"];
    assert_eq!(defaults["notes"], "");
    assert!(defaults["location"].is_null());
    assert_eq!(defaults["agent_notes"], "Retain the previous decision.");
    let history = call(
        &app,
        "list_changes",
        json!({"task_id":id,"entity_type":"recurrence","limit":1}),
    )
    .await;
    assert_eq!(history["changes"].as_array().unwrap().len(), 1);
    let older = call(
        &app,
        "list_changes",
        json!({"task_id":id,"entity_type":"recurrence","before_id":history["next_before_id"]}),
    )
    .await;
    assert_eq!(older["changes"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn earlier_from_includes_past_occurrences_and_next_cursor_is_an_input_cursor() {
    let (_dir, app) = fixture();
    let created = call(&app, "create_recurrence", json!({
        "request_id":"guide-past", "rule":{"start_date":"2020-01-01","frequency":"daily","count":3},
        "template":{"estimated_minutes":30,"effort":"medium","importance":"normal","title":"Review the old plan"},"reason":"Isolated date pagination recipe"
    })).await;
    let id = &created["series"]["id"];
    let current = call(&app, "list_occurrences", json!({"series_id":id})).await;
    assert_eq!(current["occurrences"], json!([]));
    let first = call(
        &app,
        "list_occurrences",
        json!({"series_id":id,"from":"2020-01-01","through":"2020-01-03","limit":1}),
    )
    .await;
    assert_eq!(first["occurrences"][0]["original_date"], "2020-01-01");
    let next = call(&app, "list_occurrences", json!({"series_id":id,"from":"2020-01-01","through":"2020-01-03","limit":1,"cursor":first["next_cursor"]})).await;
    assert_eq!(next["occurrences"][0]["original_date"], "2020-01-02");
}
