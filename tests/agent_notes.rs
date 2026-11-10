//! Separate human descriptions and agent working context without changing old receipts.
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{application::Application, diagnostics::Diagnostics, store::Store};

const WORKING: &str = "Agent-only working context: previous decision, evidence, and uncertainty.";

fn setup() -> (TempDir, Application) {
    let dir = TempDir::new().unwrap();
    let app = Application::new(
        Store::open(dir.path().join("tasks.db")).unwrap(),
        Diagnostics::open(&dir.path().join("logs.db"), "test").unwrap(),
    );
    (dir, app)
}

async fn call(app: &Application, operation: &str, args: Value) -> Value {
    app.execute_ui(operation, args)
        .await
        .unwrap_or_else(|e| panic!("{operation}: {e}"))
}

fn no_agent_body(value: &Value) {
    match value {
        Value::Object(fields) => {
            assert!(
                !fields.contains_key("agent_notes"),
                "Unexpected agent note body"
            );
            for value in fields.values() {
                no_agent_body(value);
            }
        }
        Value::Array(values) => values.iter().for_each(no_agent_body),
        _ => {}
    }
}

fn omitted_agent_notes(value: &Value, has_notes: bool) {
    assert_eq!(value["has_agent_notes"], has_notes);
    assert!(
        value["omitted_fields"]
            .as_array()
            .unwrap()
            .contains(&json!("agent_notes")),
        "A missing working document must be explicitly marked omitted"
    );
    no_agent_body(value);
}

async fn create(app: &Application, project: bool, key: &str, fields: Value) -> Value {
    let mut args = json!({"request_id":key,"title":"Review the plan","brief":"Review the proposal and choose a next step.","notes":"Review the proposal and identify the next step.","reason":"Synthetic agent notes fixture"});
    args.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    if !project {
        args["importance"] = json!("normal");
        args["estimated_minutes"] = json!(30);
        args["effort"] = json!("medium");
    }
    call(
        app,
        if project {
            "create_project"
        } else {
            "capture_item"
        },
        args,
    )
    .await
}

async fn read(app: &Application, project: bool, id: &Value, include: bool) -> Value {
    let (operation, id_key, items) = if project {
        ("list_projects", "project_id", "projects")
    } else {
        ("list_items", "task_id", "items")
    };
    let mut args = json!({"detail":"full","include_agent_notes":include});
    args[id_key] = id.clone();
    call(app, operation, args).await[items][0].clone()
}

async fn edit(app: &Application, project: bool, record: &Value, key: &str, fields: Value) -> Value {
    let mut args = json!({"request_id":key,"expected_version":record["version"],"reason":"Synthetic agent notes edit"});
    args[if project { "project_id" } else { "task_id" }] = record["id"].clone();
    args.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    call(
        app,
        if project {
            "update_project"
        } else {
            "update_item"
        },
        args,
    )
    .await
}

#[tokio::test]
async fn task_and_project_working_documents_are_independent_optional_and_reversible() {
    let (_dir, app) = setup();
    for project in [false, true] {
        let kind = if project { "project" } else { "task" };
        let created = create(
            &app,
            project,
            &format!("create-{kind}"),
            json!({"agent_notes":WORKING}),
        )
        .await;
        omitted_agent_notes(&created[kind], true);
        let original = read(&app, project, &created[kind]["id"], true).await;
        assert_eq!(original["agent_notes"], WORKING);
        let described = edit(
            &app,
            project,
            &original,
            &format!("description-{kind}"),
            json!({"notes":"Read the proposal and choose a next step."}),
        )
        .await;
        let current = read(&app, project, &original["id"], true).await;
        assert_eq!(current["agent_notes"], WORKING);
        assert_eq!(
            current["notes"],
            "Read the proposal and choose a next step."
        );
        let null = edit(
            &app,
            project,
            &current,
            &format!("null-{kind}"),
            json!({"title":"Choose a next step","agent_notes":null}),
        )
        .await;
        let current = read(&app, project, &original["id"], true).await;
        assert_eq!(current["agent_notes"], WORKING);
        let cleared = edit(
            &app,
            project,
            &current,
            &format!("clear-{kind}"),
            json!({"agent_notes":""}),
        )
        .await;
        omitted_agent_notes(&cleared[kind], false);
        let empty = read(&app, project, &original["id"], true).await;
        assert_eq!(empty["agent_notes"], "");
        assert_eq!(empty["notes"], current["notes"]);
        let undone = call(&app, "undo_change", json!({"request_id":format!("undo-{kind}"),"change_id":cleared["change"]["id"],"expected_version":empty["version"],"reason":"Synthetic restoration"})).await;
        omitted_agent_notes(&undone[kind], true);
        assert_eq!(
            read(&app, project, &original["id"], true).await["agent_notes"],
            WORKING
        );
        let audit = call(
            &app,
            "list_changes",
            json!({"change_id":cleared["change"]["id"],"detail":"full"}),
        )
        .await;
        assert_eq!(audit["changes"][0]["before"]["agent_notes"], WORKING);
        assert_eq!(audit["changes"][0]["after"]["agent_notes"], "");
        assert!(
            audit["changes"][0]["changed_fields"]
                .as_array()
                .unwrap()
                .contains(&json!("agent_notes"))
        );
        assert!(
            described[kind]["version"].as_i64().unwrap() < null[kind]["version"].as_i64().unwrap()
        );
    }
}

#[tokio::test]
async fn default_full_summary_show_and_sync_responses_do_not_dump_working_documents() {
    let (_dir, app) = setup();
    let checkpoint = call(&app, "sync_state", json!({})).await["checkpoint"].clone();
    let task = create(&app, false, "task", json!({"agent_notes":WORKING})).await;
    let project = create(&app, true, "project", json!({"agent_notes":WORKING})).await;
    for (tool, args, key) in [
        ("list_items", json!({}), "items"),
        ("show_tasks", json!({"detail":"full"}), "items"),
        ("list_items", json!({"task_id":task["task"]["id"]}), "items"),
        (
            "list_items",
            json!({"detail":"summary","include_agent_notes":true}),
            "items",
        ),
        ("list_projects", json!({}), "projects"),
        ("show_projects", json!({"detail":"full"}), "projects"),
        (
            "list_projects",
            json!({"project_id":project["project"]["id"]}),
            "projects",
        ),
        (
            "list_projects",
            json!({"detail":"summary","include_agent_notes":true}),
            "projects",
        ),
    ] {
        let page = call(&app, tool, args).await;
        no_agent_body(&page);
        omitted_agent_notes(&page[key][0], true);
    }
    for args in [json!({}), json!({"cursor":checkpoint})] {
        let sync = call(&app, "sync_state", args).await;
        no_agent_body(&sync);
        assert!(!sync.to_string().contains(WORKING));
    }
    let audit = call(&app, "list_changes", json!({})).await;
    no_agent_body(&audit);
    let included = read(&app, true, &project["project"]["id"], true).await;
    assert_eq!(included["agent_notes"], WORKING);
}

#[tokio::test]
async fn working_document_retries_conflicts_and_batch_atomicity_use_existing_guarantees() {
    let (_dir, app) = setup();
    let task = create(&app, false, "capture", json!({"agent_notes":WORKING})).await;
    let id = task["task"]["id"].clone();
    let args = json!({"request_id":"working-update","task_id":id,"expected_version":1,"agent_notes":"Revised evidence","reason":"Synthetic working update"});
    let updated = call(&app, "update_item", args.clone()).await;
    let replayed = call(&app, "update_item", args).await;
    assert_eq!(replayed["replayed"], true);
    assert_eq!(updated["task"], replayed["task"]);
    no_agent_body(&replayed);
    let stale = app.execute_ui("update_item", json!({"request_id":"stale","task_id":id,"expected_version":1,"agent_notes":"Stale evidence","reason":"Synthetic stale edit"})).await.unwrap_err();
    assert_eq!(stale["code"], "conflict");
    no_agent_body(&stale);
    let invalid = app.execute_ui("apply_changes", json!({"request_id":"invalid-batch","operations":[
        {"operation":"update","task_id":id,"expected_version":2,"agent_notes":"Must roll back","reason":"Synthetic rollback"},
        {"operation":"create_project","title":"Invalid","agent_notes":"x".repeat(10_001),"reason":"Synthetic invalid bound"}
    ]})).await.unwrap_err();
    assert_eq!(invalid["code"], "invalid_input");
    assert_eq!(
        read(&app, false, &id, true).await["agent_notes"],
        "Revised evidence"
    );
    let bulk_args = json!({"request_id":"bulk","operations":[
        {"operation":"update","task_id":id,"expected_version":2,"agent_notes":"Batch task context","reason":"Synthetic batch"},
        {"operation":"create_project","title":"Batch project","brief":"Review the batch project.","agent_notes":"Batch project context","reason":"Synthetic batch"}
    ]});
    let bulk = call(&app, "apply_changes", bulk_args.clone()).await;
    no_agent_body(&bulk);
    let repeated = call(&app, "apply_changes", bulk_args).await;
    assert_eq!(repeated["replayed"], true);
    assert_eq!(
        read(&app, false, &id, true).await["agent_notes"],
        "Batch task context"
    );
    let project_id = bulk["results"][1]["entity_id"].clone();
    assert_eq!(
        read(&app, true, &project_id, true).await["agent_notes"],
        "Batch project context"
    );
    let patched = call(&app, "apply_changes", json!({"request_id":"bulk-project-edit","operations":[
        {"operation":"update_project","project_id":project_id,"expected_version":1,"agent_notes":"New project context","reason":"Synthetic batch"},
        {"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Batch capture","agent_notes":"Captured context","reason":"Synthetic batch"}
    ]})).await;
    assert_eq!(
        read(&app, true, &project_id, true).await["agent_notes"],
        "New project context"
    );
    assert_eq!(
        read(&app, false, &patched["results"][1]["entity_id"], true).await["agent_notes"],
        "Captured context"
    );
}

#[tokio::test]
async fn description_and_working_document_limits_are_independent_and_unicode_safe() {
    let (_dir, app) = setup();
    for project in [false, true] {
        let kind = if project { "project" } else { "task" };
        let created = create(
            &app,
            project,
            kind,
            json!({"notes":"🧭".repeat(10_000),"agent_notes":"é".repeat(10_000)}),
        )
        .await;
        let full = read(&app, project, &created[kind]["id"], true).await;
        assert_eq!(full["notes"].as_str().unwrap().chars().count(), 10_000);
        assert_eq!(
            full["agent_notes"].as_str().unwrap().chars().count(),
            10_000
        );
        let mut args = json!({"request_id":format!("too-long-{kind}"),"expected_version":1,"agent_notes":"é".repeat(10_001),"reason":"Synthetic bound"});
        args[if project { "project_id" } else { "task_id" }] = full["id"].clone();
        let invalid = app
            .execute_ui(
                if project {
                    "update_project"
                } else {
                    "update_item"
                },
                args,
            )
            .await
            .unwrap_err();
        assert_eq!(invalid["code"], "invalid_input");
        assert_eq!(read(&app, project, &full["id"], true).await["version"], 1);
        let summary = read(&app, project, &full["id"], false).await;
        assert!(!summary.to_string().contains(&"é".repeat(100)));
    }
    for size in [10_000, 10_001] {
        let result = app.execute_ui("create_recurrence", json!({"request_id":format!("limit-series-{size}"),"template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Bounded repeat","notes":"x".repeat(10_000),"agent_notes":"y".repeat(size)},"rule":{"start_date":"2090-01-01","frequency":"daily","count":1},"reason":"Synthetic recurrence limit"})).await;
        if size == 10_000 {
            assert!(result.is_ok());
        } else {
            assert_eq!(result.unwrap_err()["code"], "invalid_input");
        }
    }
}

async fn repeat(app: &Application) -> Value {
    let created = call(app, "create_recurrence", json!({"request_id":"series","template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Review the plan","brief":"Review the proposal and choose a next step.","notes":"Choose a next action.","agent_notes":WORKING},"rule":{"start_date":"2090-01-01","frequency":"daily","count":4},"reason":"Synthetic recurrence notes"})).await;
    no_agent_body(&created);
    created["series"].clone()
}

async fn occurrences(app: &Application, id: &Value, include: bool) -> Value {
    call(app, "list_occurrences", json!({"series_id":id,"from":"2090-01-01","through":"2090-01-04","include_agent_notes":include})).await
}

async fn repeat_edit(app: &Application, series: &Value, key: &str, fields: Value) -> Value {
    let mut args = json!({"request_id":key,"series_id":series["id"],"expected_version":series["version"],"scope":"all","action":"edit","reason":"Synthetic recurrence working notes"});
    args.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    call(app, "update_recurrence", args).await
}

#[tokio::test]
async fn recurrence_default_and_occurrence_reads_protect_nested_working_documents() {
    let (_dir, app) = setup();
    let series = repeat(&app).await;
    app.store
        .lock()
        .unwrap()
        .materialize_recurrences("2090-01-03")
        .unwrap();
    let listing = call(&app, "list_occurrences", json!({})).await;
    no_agent_body(&listing);
    let page = occurrences(&app, &series["id"], false).await;
    no_agent_body(&page);
    let template = &page["series"]["recurrence"]["segments"][0]["template"];
    omitted_agent_notes(template, true);
    let included = occurrences(&app, &series["id"], true).await;
    assert_eq!(
        included["series"]["recurrence"]["segments"][0]["template"]["agent_notes"],
        WORKING
    );
    for row in page["occurrences"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["preview"] == false)
    {
        omitted_agent_notes(&row["task"], true);
        assert_eq!(
            read(&app, false, &row["task"]["id"], true).await["agent_notes"],
            WORKING
        );
    }
    let audit = call(
        &app,
        "list_changes",
        json!({"change_id":series["last_change_id"],"detail":"full"}),
    )
    .await;
    assert_eq!(
        audit["changes"][0]["after"]["recurrence"]["segments"][0]["template"]["agent_notes"],
        WORKING
    );
}

#[tokio::test]
async fn scoped_template_edits_preserve_omitted_notes_per_segment_and_occurrence_overrides() {
    let (_dir, app) = setup();
    let mut series = repeat(&app).await;
    app.store
        .lock()
        .unwrap()
        .materialize_recurrences("2090-01-03")
        .unwrap();
    let rows = occurrences(&app, &series["id"], false).await["occurrences"].clone();
    let first = read(&app, false, &rows[0]["task"]["id"], true).await;
    edit(
        &app,
        false,
        &first,
        "override",
        json!({"agent_notes":"Occurrence-specific evidence"}),
    )
    .await;
    let following = repeat_edit(&app, &series, "following", json!({"scope":"following","original_date":"2090-01-02","template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Later review","notes":"Later human description","agent_notes":"Later default evidence"}})).await;
    series = following["series"].clone();
    let all = repeat_edit(
        &app,
        &series,
        "old-client-all",
        json!({"template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Clearer title","notes":"Clear human instructions"}}),
    )
    .await;
    series = all["series"].clone();
    let defaults = occurrences(&app, &series["id"], true).await;
    let segments = defaults["series"]["recurrence"]["segments"]
        .as_array()
        .unwrap();
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0]["template"]["agent_notes"], WORKING);
    assert_eq!(
        segments[1]["template"]["agent_notes"],
        "Later default evidence"
    );
    let current_first = read(&app, false, &first["id"], true).await;
    assert_eq!(current_first["agent_notes"], "Occurrence-specific evidence");
    let this = repeat_edit(&app, &series, "old-client-this", json!({"scope":"this","original_date":"2090-01-01","expected_occurrence_version":current_first["version"],"template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"One clearer review","notes":"One human description","agent_notes":null}})).await;
    let current_first = read(&app, false, &this["task"]["id"], true).await;
    assert_eq!(current_first["agent_notes"], "Occurrence-specific evidence");
    assert!(
        current_first["occurrence"]["overrides"]
            .as_array()
            .unwrap()
            .contains(&json!("agent_notes"))
    );
    let follow_null = repeat_edit(&app, &series, "null-following", json!({"scope":"following","original_date":"2090-01-03","template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Last review","agent_notes":null}})).await;
    series = follow_null["series"].clone();
    let page = occurrences(&app, &series["id"], true).await;
    assert_eq!(
        page["series"]["recurrence"]["segments"][2]["template"]["agent_notes"],
        "Later default evidence"
    );
    let changed = repeat_edit(
        &app,
        &series,
        "all-agent-edit",
        json!({"template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Unified review","agent_notes":"Unified default evidence"}}),
    )
    .await;
    series = changed["series"].clone();
    assert_eq!(
        read(&app, false, &first["id"], true).await["agent_notes"],
        "Occurrence-specific evidence"
    );
    for row in rows.as_array().unwrap().iter().skip(1).take(2) {
        assert_eq!(
            read(&app, false, &row["task"]["id"], true).await["agent_notes"],
            "Unified default evidence"
        );
    }
    let cleared = repeat_edit(
        &app,
        &series,
        "all-agent-clear",
        json!({"template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Unified review","agent_notes":""}}),
    )
    .await;
    let defaults = occurrences(&app, &series["id"], true).await;
    for segment in defaults["series"]["recurrence"]["segments"]
        .as_array()
        .unwrap()
    {
        assert_eq!(segment["template"]["agent_notes"], "");
    }
    let restored = call(&app, "undo_change", json!({"request_id":"undo-series-clear","change_id":cleared["change"]["id"],"expected_version":cleared["series"]["version"],"reason":"Synthetic scoped undo"})).await;
    no_agent_body(&restored);
    assert_eq!(
        read(&app, false, &rows[1]["task"]["id"], true).await["agent_notes"],
        "Unified default evidence"
    );
}

#[tokio::test]
async fn legacy_documents_and_exact_pre_feature_retry_receipts_remain_unchanged() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../src/schema.sql")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let record = json!({"id":id,"title":"Legacy","notes":"Existing human description","status":"inbox","due_date":null,"version":1,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","deleted":false,"last_change_id":1});
    let change = json!({"id":1,"task_id":id,"operation":"capture","reason":"Legacy","before":null,"after":record,"undoes_change_id":null,"created_at":"2026-10-01T00:00:00Z"});
    let receipt = json!({"task":record,"change":change,"replayed":false});
    let request = r#"["capture_item",{"request_id":"legacy","title":"Legacy","notes":"Existing human description","status":"inbox","due_date":null,"reason":"Legacy"}]"#;
    db.execute(
        "INSERT INTO tasks(id,document) VALUES(?1,?2)",
        rusqlite::params![id, record.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO changes(id,task_id,document) VALUES(1,?1,?2)",
        rusqlite::params![id, change.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO requests(id,request,response) VALUES('legacy',?1,?2)",
        rusqlite::params![request, receipt.to_string()],
    )
    .unwrap();
    drop(db);
    let app = Application::new(
        Store::open(&path).unwrap(),
        Diagnostics::open(&dir.path().join("logs.db"), "test").unwrap(),
    );
    let replay = call(&app, "capture_item", json!({"request_id":"legacy","title":"Legacy","notes":"Existing human description","reason":"Legacy"})).await;
    assert_eq!(replay["replayed"], true);
    omitted_agent_notes(&replay["task"], false);
    let full = read(&app, false, &json!(id), true).await;
    assert_eq!(full["agent_notes"], "");
    assert_eq!(full["notes"], "Existing human description");
    let db = rusqlite::Connection::open(&path).unwrap();
    let current: Value = serde_json::from_str(
        &db.query_row("SELECT document FROM tasks WHERE id=?1", [&id], |row| {
            row.get::<_, String>(0)
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(current["importance"], "normal");
    assert_eq!(current["version"], 2);
    assert_eq!(
        db.query_row("SELECT document FROM changes WHERE id=1", [], |row| row
            .get::<_, String>(
            0
        ))
        .unwrap(),
        change.to_string()
    );
    assert_eq!(
        db.query_row(
            "SELECT response FROM requests WHERE id='legacy'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        receipt.to_string()
    );
}

#[tokio::test]
async fn notes_only_recurrence_edits_preserve_templates_rules_and_inherit_safely() {
    let (_dir, app) = setup();
    let series = repeat(&app).await;
    app.store
        .lock()
        .unwrap()
        .materialize_recurrences("2090-01-02")
        .unwrap();
    let initial = occurrences(&app, &series["id"], true).await;
    let original_template = initial["series"]["recurrence"]["segments"][0]["template"].clone();
    let original_rule = initial["series"]["recurrence"]["segments"][0]["rule"].clone();
    let updated = repeat_edit(
        &app,
        &series,
        "notes-only",
        json!({"agent_notes":"Updated working brief"}),
    )
    .await;
    let series = updated["series"].clone();
    let full = occurrences(&app, &series["id"], true).await;
    let mut expected_template = original_template.clone();
    expected_template["agent_notes"] = json!("Updated working brief");
    assert_eq!(
        full["series"]["recurrence"]["segments"][0]["template"],
        expected_template
    );
    assert_eq!(
        full["series"]["recurrence"]["segments"][0]["rule"],
        original_rule
    );
    let first_id = &full["occurrences"][0]["task"]["id"];
    let first = read(&app, false, first_id, true).await;
    let receipt = repeat_edit(&app, &series, "one-note", json!({"scope":"this","original_date":"2090-01-01","expected_occurrence_version":first["version"],"agent_notes":"This instance only"})).await;
    assert_eq!(
        read(&app, false, first_id, true).await["agent_notes"],
        "This instance only"
    );
    assert_eq!(
        read(&app, false, first_id, true).await["notes"],
        original_template["notes"]
    );
    assert_eq!(receipt["task"]["id"], *first_id);
    let batch_args = json!({"request_id":"notes-only-batch","operations":[{"operation":"update_recurrence","series_id":series["id"],"expected_version":series["version"],"scope":"following","original_date":"2090-01-02","action":"edit","agent_notes":"Later brief","reason":"Synthetic scoped notes batch"}]});
    let batch = call(&app, "apply_changes", batch_args.clone()).await;
    no_agent_body(&batch);
    assert_eq!(
        call(&app, "apply_changes", batch_args).await["replayed"],
        true
    );
    let full = occurrences(&app, &series["id"], true).await;
    assert_eq!(
        full["series"]["recurrence"]["segments"][1]["template"]["agent_notes"],
        "Later brief"
    );
    assert_eq!(
        full["series"]["recurrence"]["segments"][1]["template"]["notes"],
        original_template["notes"]
    );
    assert_eq!(
        read(&app, false, first_id, true).await["agent_notes"],
        "This instance only"
    );
    let current = &full["series"];
    let invalid = app.execute_ui("update_recurrence", json!({"request_id":"ambiguous-notes","series_id":series["id"],"expected_version":current["version"],"scope":"all","action":"edit","agent_notes":"Ambiguous","template":{"brief":"Perform the recurring fixture work.","title":"Overwrite"},"reason":"Synthetic invalid combination"})).await.unwrap_err();
    assert_eq!(invalid["code"], "invalid_input");
}

#[test]
fn absent_optional_mutation_fields_do_not_change_canonical_legacy_request_shapes() {
    use serde::Serialize;
    use serde::de::DeserializeOwned;
    fn canonical<T: DeserializeOwned + Serialize>(value: Value) {
        let parsed: T = serde_json::from_value(value.clone()).unwrap();
        let omitted = serde_json::to_value(parsed).unwrap();
        no_agent_body(&omitted);
        let mut explicit_null = value;
        explicit_null["agent_notes"] = Value::Null;
        let parsed: T = serde_json::from_value(explicit_null).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), omitted);
    }
    canonical::<todo_mcp::model::CaptureItem>(
        json!({"request_id":"old","title":"Old","reason":"Test"}),
    );
    canonical::<todo_mcp::model::UpdateItem>(
        json!({"request_id":"old","task_id":uuid::Uuid::new_v4().to_string(),"expected_version":1,"notes":"Edit","reason":"Test"}),
    );
    canonical::<todo_mcp::model::CreateProject>(
        json!({"request_id":"old","title":"Old","reason":"Test"}),
    );
    canonical::<todo_mcp::model::UpdateProject>(
        json!({"request_id":"old","project_id":uuid::Uuid::new_v4().to_string(),"expected_version":1,"notes":"Edit","reason":"Test"}),
    );
    canonical::<todo_mcp::recurrence_model::Template>(json!({"title":"Old","notes":"Description"}));
    canonical::<todo_mcp::recurrence_model::UpdateRecurrence>(
        json!({"request_id":"old","series_id":uuid::Uuid::new_v4().to_string(),"expected_version":1,"scope":"all","action":"edit","template":{"brief":"Perform the recurring fixture work.","title":"Old"},"reason":"Test"}),
    );
}

#[tokio::test]
async fn adopting_a_task_retains_working_context_when_older_templates_omit_it() {
    let (_dir, app) = setup();
    let created = create(
        &app,
        false,
        "adopted-task",
        json!({"status":"next","agent_notes":WORKING}),
    )
    .await;
    let task = &created["task"];
    let args = json!({"request_id":"adopt-series","task_id":task["id"],"expected_task_version":task["version"],"template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Repeat the review","notes":"Review the proposal each day."},"rule":{"start_date":"2090-01-01","frequency":"daily","count":2},"reason":"Synthetic old-client adoption"});
    let adopted = call(&app, "create_recurrence", args.clone()).await;
    assert_eq!(
        call(&app, "create_recurrence", args).await["replayed"],
        true
    );
    assert_eq!(
        read(&app, false, &task["id"], true).await["agent_notes"],
        WORKING
    );
    let defaults = occurrences(&app, &adopted["series"]["id"], true).await;
    assert_eq!(
        defaults["series"]["recurrence"]["segments"][0]["template"]["agent_notes"],
        WORKING
    );
    app.store
        .lock()
        .unwrap()
        .materialize_recurrences("2090-01-02")
        .unwrap();
    let rows = occurrences(&app, &adopted["series"]["id"], false).await;
    assert_eq!(rows["occurrences"].as_array().unwrap().len(), 2);
    for row in rows["occurrences"].as_array().unwrap() {
        assert_eq!(
            read(&app, false, &row["task"]["id"], true).await["agent_notes"],
            WORKING
        );
    }
}

#[tokio::test]
async fn notes_only_all_edit_retains_distinct_human_defaults_in_each_segment() {
    let (_dir, app) = setup();
    let series = repeat(&app).await;
    let following = repeat_edit(&app, &series, "distinct-following", json!({"scope":"following","original_date":"2090-01-03","template":{"brief":"Perform the recurring fixture work.","estimated_minutes":30,"effort":"medium","importance":"normal","title":"A different action","notes":"Different later instructions","status":"waiting","due_offset_days":2,"location":"Main office","links":[{"url":"https://example.test/guide","label":"Guide"}],"agent_notes":"Different later agent context"}})).await;
    let before = occurrences(&app, &series["id"], true).await;
    repeat_edit(
        &app,
        &following["series"],
        "notes-only-all",
        json!({"agent_notes":"Shared current brief"}),
    )
    .await;
    let after = occurrences(&app, &series["id"], true).await;
    let old_segments = before["series"]["recurrence"]["segments"]
        .as_array()
        .unwrap();
    let new_segments = after["series"]["recurrence"]["segments"]
        .as_array()
        .unwrap();
    assert_eq!(old_segments.len(), 2);
    assert_eq!(new_segments.len(), 2);
    for (old, new) in old_segments.iter().zip(new_segments) {
        let mut expected = old.clone();
        expected["template"]["agent_notes"] = json!("Shared current brief");
        assert_eq!(*new, expected);
    }
    assert_ne!(
        new_segments[0]["template"]["title"],
        new_segments[1]["template"]["title"]
    );
}

#[tokio::test]
async fn opted_in_working_documents_keep_snapshot_pagination_and_response_budgets() {
    let (_dir, app) = setup();
    let long = "a".repeat(9_000);
    let mut ids = Vec::new();
    for i in 0..5 {
        let item = create(
            &app,
            false,
            &format!("page-{i}"),
            json!({"notes":"h".repeat(500),"agent_notes":long}),
        )
        .await;
        ids.push(item["task"]["id"].clone());
    }
    let args = json!({"view":"all","sort":"created","detail":"full","include_agent_notes":true,"limit":100});
    let mut page = call(&app, "list_items", args.clone()).await;
    assert!(page["next_cursor"].is_string());
    let last = read(&app, false, ids.last().unwrap(), true).await;
    edit(
        &app,
        false,
        &last,
        "concurrent-note",
        json!({"agent_notes":"Newer agent evidence"}),
    )
    .await;
    let mut seen = std::collections::HashSet::new();
    loop {
        assert!(serde_json::to_vec(&page).unwrap().len() <= todo_mcp::projection::PAGE_BYTES);
        for item in page["items"].as_array().unwrap() {
            assert!(seen.insert(item["id"].as_str().unwrap().to_owned()));
            assert_eq!(item["agent_notes"], long);
            assert_eq!(item["version"], 1);
        }
        if page["next_cursor"].is_null() {
            break;
        }
        let mut next = args.clone();
        next["cursor"] = page["next_cursor"].clone();
        page = call(&app, "list_items", next).await;
    }
    assert_eq!(seen.len(), 5);
    assert_eq!(
        read(&app, false, &last["id"], true).await["agent_notes"],
        "Newer agent evidence"
    );
}
