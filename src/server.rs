use crate::{
    application::{Application, known_operation},
    model::*,
};
use rmcp::{ErrorData, RoleServer, ServerHandler, model::*, service::RequestContext};
use schemars::JsonSchema;
use serde_json::{Value, json};

pub const WIDGET_URI: &str = "ui://private-gtd/tasks-v2.html";
pub const PROBE_URI: &str = "ui://private-gtd/connection-probe-v1.html";
pub const CHATGPT_WIDGET_URI: &str = "ui://private-gtd/tasks-chatgpt-v1.html";
pub const WIDGET_MIME: &str = "text/html;profile=mcp-app";
pub const CHATGPT_WIDGET_MIME: &str = "text/html+skybridge";

fn widget_enabled() -> bool {
    std::env::var("TODO_WIDGET_ENABLED").as_deref() == Ok("1")
}

fn advertised_widget_uri() -> &'static str {
    if std::env::var("TODO_WIDGET_COMPAT").as_deref() == Ok("1") {
        CHATGPT_WIDGET_URI
    } else if std::env::var("TODO_WIDGET_PROBE").as_deref() == Ok("1") {
        PROBE_URI
    } else {
        WIDGET_URI
    }
}

#[derive(Clone)]
pub struct TodoServer {
    pub app: Application,
}

fn tool<T: JsonSchema>(name: &'static str, description: &'static str, read_only: bool) -> Tool {
    let schema = crate::mcp_contract::field_schema(
        name,
        serde_json::to_value(schemars::schema_for!(T)).expect("static tool schema"),
        false,
    );
    let mut descriptor = Tool::new(name, description, schema.as_object().unwrap().clone())
        .with_annotations(
            ToolAnnotations::new()
                .read_only(read_only)
                .destructive(false)
                .idempotent(true)
                .open_world(false),
        );
    if widget_enabled() {
        descriptor.meta = Some(
            json!({"ui":{"visibility":["model","app"]},"openai/widgetAccessible":true})
                .as_object()
                .unwrap()
                .clone()
                .into(),
        );
    }
    descriptor
}

pub fn tools() -> Vec<Tool> {
    let mut show = tool::<ListItems>(
        "show_tasks",
        if widget_enabled() {
            "Read authoritative tasks and request the experimental interactive cards. A successful tool result does not prove the host rendered the UI. Keep text results useful if rendering fails."
        } else {
            "Read authoritative tasks using the same filters as list_items. Interactive cards are currently disabled; summarize the returned records in text."
        },
        true,
    );
    if widget_enabled() {
        show.meta = Some(json!({"ui":{"resourceUri":advertised_widget_uri(),"visibility":["model","app"]}, "openai/outputTemplate":advertised_widget_uri(), "openai/widgetAccessible":true}).as_object().unwrap().clone().into());
    }
    let mut tools = vec![
        tool::<ShowGtd>(
            "show_gtd",
            "Open GTD at Home, Repeating, Review, Activity or Help; defaults to Home. Optional series_id opens one repeating task. Returns a launch receipt; the interface loads current data. Use show_tasks or show_projects for filtered or focused records.",
            true,
        ),
        tool::<crate::recurrence_model::CreateRecurrence>(
            "create_recurrence",
            "Create a calendar-date series with a rule and task template including required importance. Preview the rule with list_occurrences first. Missed occurrences stay unfinished; deadlines and review dates are independent offsets. Unique request_id and reason required.",
            false,
        ),
        tool::<crate::recurrence_model::UpdateRecurrence>(
            "update_recurrence",
            "Edit, skip/unskip an occurrence, edit this-and-following or all series defaults/rules, or pause/resume/end repetition. Specify scope, series expected_version and reason. Stored occurrence edits require expected_occurrence_version. Read current defaults before supplying a replacement template or rule. update_item edits only its identified occurrence. Completed history and individual overrides survive series changes. Scoped undo is atomic.",
            false,
        ),
        tool::<crate::recurrence_model::ListOccurrences>(
            "list_occurrences",
            "No series_id/rule lists series. Supply series_id to read a series and its occurrences, or rule to preview dates without writing. Occurrence dates default from today in America/New_York; use an earlier from for missed/past occurrences. Pass next_cursor as cursor with unchanged filters. Preview rows are not saved tasks.",
            true,
        ),
        tool::<CaptureItem>(
            "capture_item",
            "Capture a task or unprocessed thought. Supply importance, a unique request_id and a reason. Retry with identical arguments and the same request_id after uncertain delivery; an acknowledged capture returns the committed task and change ID.",
            false,
        ),
        tool::<ListItems>(
            "list_items",
            "Read tasks without opening a card. Defaults: 20 concise active tasks (next, inbox, waiting, blocked), next actions first, ranked by importance, timing and dependencies. Use status for an exact state, archived=true for the archive, view=all for all retained records, task_id for full details, or detail=full for descriptions, links and location in wider reads. Agent notes require include_agent_notes=true and full details. Text and due-date filters compose; pass next_cursor as cursor with unchanged filters for more.",
            true,
        ),
        tool::<UpdateItem>(
            "update_item",
            "Update a task using expected_version and a unique request_id. Omitted/null fields preserve values; clear_due_date removes a deadline. State the reason including any agent inference. Conflicts require a fresh read and decision, not blind retries.",
            false,
        ),
        tool::<UndoChange>(
            "undo_change",
            "Reverse the latest task, project or series change using change_id, that record's current expected_version, request_id and reason. Scoped recurrence changes reverse together or fail if any affected record has newer edits. Ordinary batches are not one undo group. Undoing creation makes a reversible tombstone; undoing an undo redoes it.",
            false,
        ),
        tool::<ApplyChanges>(
            "apply_changes",
            "Atomically apply 1–50 capture/update/undo, create_project/update_project or create_recurrence/update_recurrence operations. No record may change twice, including scoped secondary changes. Every operation needs a reason; edits/undos need current versions. All succeed or none is saved. Retry the entire batch unchanged with the same request_id after uncertain delivery. Returns compact receipts without a card; use show_tasks(task_ids=...) or show_projects(project_id=...) for a focused confirmation.",
            false,
        ),
        tool::<ListChanges>(
            "list_changes",
            "Read immutable task, project and series history, newest first. Pass next_before_id as before_id for older changes. Compact by default; change_id plus detail=full returns exact before/after, including agent notes. Includes reasons and service-assigned origin; MCP origin does not identify human versus agent.",
            true,
        ),
        tool::<CreateProject>(
            "create_project",
            "Create a lightweight GTD project: its title describes the desired outcome. Optional context and dates; no nested projects. Tasks attach separately using project_id. Supply request_id and reason.",
            false,
        ),
        tool::<UpdateProject>(
            "update_project",
            "Update project context or lifecycle with expected_version, request_id and reason. Completing requires unfinished tasks to be done, archived or moved. Shelving requires retained unarchived tasks to be someday/done; archiving requires tasks archived/moved. Resolve incompatible future/missed recurring commitments by changing or ending their series too. Related changes can use apply_changes.",
            false,
        ),
        tool::<ListProjects>(
            "list_projects",
            "Read projects without a card. Defaults to active unarchived summaries with task counts and needs_next_action. Read project_id for full description; add include_agent_notes=true for working notes; use status/archived/review filters or pass next_cursor as cursor. Read a project's tasks with list_items(project_id=...,view=all,archived=false).",
            true,
        ),
        tool::<ListProjects>(
            "show_projects",
            "Show compact project cards. Same filters as list_projects; use project_id to show an outcome and its actions.",
            true,
        ),
        tool::<SyncState>(
            "sync_state",
            "Read a consistent whole-store summary snapshot, then changes since a checkpoint. No cursor starts a snapshot including inactive records. Pass next_cursor as cursor until complete, then retain checkpoint with your state. Pass checkpoint as cursor to read subsequent task/project/series changes and tombstones. Buffer partial transactions until transaction_end. reset_required means discard cached state and start again. A checkpoint alone is not retained task knowledge.",
            true,
        ),
        show,
    ];
    let raw = tools.clone();
    for t in &mut tools {
        t.description = Some(crate::mcp_contract::description(&t.name, widget_enabled()).into());
        t.annotations = Some(
            serde_json::from_value(crate::mcp_contract::annotations(&t.name))
                .expect("tool annotations"),
        );
        t.input_schema = std::sync::Arc::new(
            crate::mcp_contract::agent_schema(
                &t.name,
                crate::mcp_contract::field_schema(
                    &t.name,
                    serde_json::to_value(&t.input_schema).unwrap(),
                    true,
                ),
            )
            .as_object()
            .unwrap()
            .clone(),
        );
        let mut meta = serde_json::to_value(&t.meta).unwrap_or(json!({}));
        if !meta.is_object() {
            meta = json!({});
        }
        if widget_enabled()
            && matches!(t.name.as_ref(), "show_tasks" | "show_projects" | "show_gtd")
        {
            meta["ui"]["resourceUri"] = json!(advertised_widget_uri());
            meta["openai/outputTemplate"] = json!(advertised_widget_uri());
        }
        meta["ui"]["visibility"] = json!(["model"]);
        meta["openai/widgetAccessible"] = json!(false);
        t.meta = Some(meta.as_object().unwrap().clone().into());
    }
    for (name, ops) in [
        ("gtd_ui_read", crate::application::UI_READS),
        ("gtd_ui_write", crate::application::UI_WRITES),
    ] {
        let mut operations = raw
            .iter()
            .filter(|t| ops.contains(&t.name.as_ref()))
            .map(|t| {
                (
                    t.name.to_string(),
                    serde_json::to_value(&t.input_schema).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        if name == "gtd_ui_read" {
            operations.push((
                "view_snapshot".into(),
                serde_json::to_value(schemars::schema_for!(crate::view::SnapshotRequest)).unwrap(),
            ));
            for operation in ["activity_summary", "activity_day"] {
                operations.push((
                    operation.into(),
                    serde_json::to_value(schemars::schema_for!(crate::activity::ChartQuery))
                        .unwrap(),
                ));
            }
            operations.push((
                "priority_grid".into(),
                serde_json::to_value(schemars::schema_for!(crate::priority_grid::Query)).unwrap(),
            ));
            operations.push((
                "request_results".into(),
                serde_json::to_value(schemars::schema_for!(crate::activity::ResultsQuery)).unwrap(),
            ));
        }
        let schema = crate::mcp_contract::ui_schema(operations);
        let mut t = Tool::new(
            name,
            crate::mcp_contract::description(name, widget_enabled()),
            schema.as_object().unwrap().clone(),
        );
        t.annotations = Some(
            serde_json::from_value(crate::mcp_contract::annotations(name)).expect("UI annotations"),
        );
        t.meta=Some(json!({"ui":{"visibility":["app"]},"openai/visibility":"private","openai/widgetAccessible":true}).as_object().unwrap().clone().into());
        tools.push(t);
    }
    for t in &mut tools {
        t.output_schema = Some(std::sync::Arc::new(
            crate::output_schema::schema(&t.name)
                .as_object()
                .unwrap()
                .clone(),
        ));
    }
    tools
}

/// UI requests pin the environment in transport metadata, not tool arguments.
/// A Store's environment cannot change during its lifetime, so checking this
/// opened Store also protects writes across watchdog-driven process replacement.
/// Missing metadata remains compatible with ordinary agents and older clients.
pub(crate) async fn guard_environment(
    app: &Application,
    operation: &str,
    expected: Option<&str>,
) -> Result<(), Value> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let expected = expected.to_owned();
    let app = app.clone();
    let operation = known_operation(operation);
    tokio::task::spawn_blocking(move || {
        let current = app
            .store
            .lock()
            .map(|store| store.environment())
            .unwrap_or_else(|_| "unknown".into());
        if expected == current && matches!(current.as_str(), "production" | "test" | "demo") {
            return Ok(());
        }
        let call = app.diagnostics.begin(operation);
        app.diagnostics
            .finish(&call, "error", Some("environment_changed"), None);
        Err(json!({
            "code":"environment_changed",
            "message":"The GTD environment changed. Reopen GTD before continuing.",
            "retryable":false,
            "environment":current
        }))
    })
    .await
    .unwrap_or_else(|_| {
        Err(json!({
            "code":"environment_changed",
            "message":"The GTD environment could not be confirmed. Reopen GTD before continuing.",
            "retryable":false,
            "environment":"unknown"
        }))
    })
}

impl ServerHandler for TodoServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(Implementation::new("todo-mcp", env!("CARGO_PKG_VERSION")))
        .with_instructions(format!("{}{}", match std::env::var("TODO_ENVIRONMENT").as_deref() { Ok("test") => "TEST MODE: disposable synthetic data. Do not treat these records as the user’s real commitments.\n", Ok("demo") => "DEMO MODE: fictional demonstration data. Do not treat these records as the user’s real commitments.\n", _ => "" },include_str!("instructions.txt")))
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        self.app
            .diagnostics
            .event("tools/list", "success", "Tool discovery");
        Ok(ListToolsResult {
            tools: tools(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        // rmcp moves wire params._meta into RequestContext before dispatch.
        let expected = context
            .meta
            .get("gtd/expectedEnvironment")
            .or_else(|| {
                request
                    .meta
                    .as_ref()
                    .and_then(|meta| meta.get("gtd/expectedEnvironment"))
            })
            .map(|value| value.as_str().unwrap_or(""));
        if let Err(error) = guard_environment(&self.app, &request.name, expected).await {
            return Ok(CallToolResult::structured_error(error).into());
        }
        // Validation happens inside execute, so rejected inputs are logged as well.
        let result = self
            .app
            .execute(
                &request.name,
                Value::Object(request.arguments.unwrap_or_default()),
            )
            .await;
        Ok(match result {
            Ok(value) => {
                let text = result_text(&request.name, &value);
                let mut response = CallToolResult::structured(value);
                response.content = vec![ContentBlock::text(text)];
                response
            }
            Err(value) => CallToolResult::structured_error(value),
        }
        .into())
    }

    async fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        self.app
            .diagnostics
            .event("resources/list", "success", "UI resource discovery");
        Ok(ListResourcesResult {
            resources: if widget_enabled() {
                vec![
                    Resource::new(advertised_widget_uri(), "private-gtd-tasks").with_mime_type(
                        if advertised_widget_uri() == CHATGPT_WIDGET_URI {
                            CHATGPT_WIDGET_MIME
                        } else {
                            WIDGET_MIME
                        },
                    ),
                ]
            } else {
                Vec::new()
            },
            ..Default::default()
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let call = self.app.diagnostics.begin("resources/read");
        if ![WIDGET_URI, PROBE_URI, CHATGPT_WIDGET_URI].contains(&request.uri.as_str()) {
            self.app
                .diagnostics
                .finish(&call, "error", Some("unknown_resource"), None);
            return Err(ErrorData::invalid_params("Unknown resource", None));
        }
        let (filename, mime) = match request.uri.as_str() {
            PROBE_URI => ("widget-probe.html", WIDGET_MIME),
            CHATGPT_WIDGET_URI => ("widget-chatgpt.html", CHATGPT_WIDGET_MIME),
            _ => ("widget.html", WIDGET_MIME),
        };
        // Only fixed, public resource identifiers are recorded, never arbitrary URIs.
        self.app.diagnostics.annotate(&call, filename);
        let path = crate::web::assets_dir().join(filename);
        let html = match tokio::fs::read_to_string(path).await {
            Ok(html) => html,
            Err(_) => {
                self.app
                    .diagnostics
                    .finish(&call, "error", Some("bundle_unavailable"), None);
                return Err(ErrorData::internal_error("UI bundle unavailable", None));
            }
        };
        self.app.diagnostics.finish(&call, "success", None, None);
        Ok(ReadResourceResult::new(vec![ResourceContents::text(html, request.uri).with_mime_type(mime).with_meta(
            json!({"ui":{"prefersBorder":true,"csp":{"connectDomains":[],"resourceDomains":[],"frameDomains":[]}},
                "openai/widgetPrefersBorder":true,
                "openai/widgetCSP":{"connect_domains":[],"resource_domains":[],"frame_domains":[]},
                "openai/ui":{"availableDisplayModes":["inline"],"preferredDisplayMode":"inline"},
                "openai/widgetDescription":"Private GTD task cards with current status, dates, and reversible quick actions."}).as_object().unwrap().clone().into()
        )]).into())
    }
}

/// Some hosts expose only text content to the model, even when their widget
/// consumes structuredContent. Keep the complete result available in both.
pub(crate) fn result_text(name: &str, value: &Value) -> String {
    if matches!(name, "gtd_ui_read" | "gtd_ui_write") {
        response_text(value)
    } else {
        value.to_string()
    }
}

fn response_text(value: &Value) -> String {
    if matches!(value["kind"].as_str(), Some("full" | "unchanged")) {
        return "GTD view checked.".into();
    }
    if value["app"] == "gtd" {
        return format!("GTD {} view.", value["view"].as_str().unwrap_or("home"));
    }
    if let Some(series) = value.get("series_list").and_then(Value::as_array) {
        return format!(
            "{} repeating series on this page{}.",
            series.len(),
            if value["next_cursor"].is_string() {
                "; continue with next_cursor"
            } else {
                ""
            }
        );
    }
    if let Some(occurrences) = value.get("occurrences").and_then(Value::as_array) {
        return format!(
            "{} occurrences on this page{}. Preview dates do not create tasks.",
            occurrences.len(),
            if value["next_cursor"].is_string() {
                "; continue with next_cursor"
            } else {
                ""
            }
        );
    }
    if value.get("series").is_some() {
        return format!(
            "Repeat settings saved: version {}, change #{}{}.",
            value["series"]["version"],
            value["change"]["id"],
            if value["replayed"] == true {
                " (replayed; read current state before another change)"
            } else {
                ""
            }
        );
    }
    if let Some(projects) = value.get("projects").and_then(Value::as_array) {
        return format!(
            "{} project(s) on this page{}. Full context is available by project_id.",
            projects.len(),
            if value["next_cursor"].is_string() {
                "; more available using next_cursor"
            } else {
                ""
            }
        );
    }
    if value.get("phase").is_some() {
        return format!(
            "{} page: {} record(s), {} change(s). {}",
            value["phase"].as_str().unwrap_or("sync"),
            value["records"].as_array().map_or(0, Vec::len),
            value["changes"].as_array().map_or(0, Vec::len),
            if value["complete"] == true {
                "Snapshot/traversal complete; checkpoint supplied."
            } else {
                "Continue with next_cursor; do not claim complete state yet."
            }
        );
    }
    if value.get("project").is_some() {
        return format!(
            "Project saved: version {}, change #{}.",
            value["project"]["version"], value["change"]["id"]
        );
    }
    if let Some(items) = value.get("items").and_then(Value::as_array) {
        let mut lines = vec![format!(
            "{} {} task(s) on this page{}.",
            items.len(),
            value["scope"].as_str().unwrap_or("selected"),
            if value["next_cursor"].is_string() {
                "; more available using next_cursor"
            } else {
                ""
            }
        )];
        for task in items {
            lines.push(format!(
                "- {} · {}{}",
                task["title"].as_str().unwrap_or(""),
                task["status"].as_str().unwrap_or(""),
                task["due_date"]
                    .as_str()
                    .map(|d| format!(" · due {d}"))
                    .unwrap_or_default()
            ));
        }
        lines.join("\n")
    } else if let Some(task) = value.get("task") {
        format!(
            "{}: {} · {} · version {} · change #{}{}.",
            value["change"]["operation"].as_str().unwrap_or("Saved"),
            task["title"].as_str().unwrap_or(""),
            task["status"].as_str().unwrap_or(""),
            task["version"],
            value["change"]["id"],
            if value["replayed"] == true {
                " (original receipt replayed; re-read current state)"
            } else {
                ""
            }
        )
    } else if let Some(results) = value.get("results").and_then(Value::as_array) {
        format!(
            "{} operation(s) committed atomically{}. Record receipts are in results.",
            results.len(),
            if value["replayed"] == true {
                " (original receipt replayed; re-read current state)"
            } else {
                ""
            }
        )
    } else {
        format!(
            "{} audit change(s). Compact changes are in changes; read change_id with detail=full for original values{}.",
            value["changes"].as_array().map_or(0, Vec::len),
            if value["next_before_id"].is_number() {
                "; more available using next_before_id"
            } else {
                ""
            }
        )
    }
}
