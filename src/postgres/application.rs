//! Transport-neutral account application. Identity is supplied by the trusted
//! entry point; authoring policy comes from operation routing, never arguments.
use super::*;
use crate::{
    model::*,
    projection,
    store::{StoreError, content::Policy},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub(super) fn parse<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| {
        StoreError::Invalid(
            "Arguments do not match this operation's schema; check fields and types".into(),
        )
        .into()
    })
}
impl Store {
    pub(crate) fn environment(&self) -> Environment {
        self.environment
    }
    pub fn execute_tool(
        &self,
        principal: &Principal,
        name: &str,
        arguments: Value,
    ) -> Result<Value> {
        if matches!(name, "gtd_ui_read" | "gtd_ui_write") {
            let operation = arguments
                .get("operation")
                .and_then(Value::as_str)
                .unwrap_or("");
            if name == "gtd_ui_read"
                && operation == "widget_pages"
                && arguments
                    .as_object()
                    .is_some_and(|o| o.keys().all(|k| k == "operation" || k == "arguments"))
            {
                let mut value =
                    self.widget_pages(principal, parse(arguments["arguments"].clone())?)?;
                value["response_version"] = json!(2);
                return Ok(value);
            }
            let allowed = if name == "gtd_ui_read" {
                crate::application::UI_READS
            } else {
                crate::application::UI_WRITES
            };
            if !allowed.contains(&operation)
                || arguments
                    .as_object()
                    .is_none_or(|o| o.keys().any(|k| k != "operation" && k != "arguments"))
            {
                return Err(StoreError::Invalid("Unsupported UI operation".into()).into());
            }
            return self.execute_app(
                principal,
                operation,
                arguments.get("arguments").cloned().unwrap_or(Value::Null),
            );
        }
        self.dispatch(principal, name, arguments, Policy::Agent, "mcp")
    }
    /// Only the app-only MCP facades select this entry. Website session routing
    /// will supply its own fixed origin when that separate integration is ready.
    fn execute_app(&self, principal: &Principal, name: &str, arguments: Value) -> Result<Value> {
        self.dispatch(principal, name, arguments, Policy::Human, "mcp")
    }
    pub(crate) fn execute_website(
        &self,
        principal: &Principal,
        name: &str,
        arguments: Value,
    ) -> Result<Value> {
        if !crate::application::UI_READS.contains(&name)
            && !crate::application::UI_WRITES.contains(&name)
        {
            return Err(StoreError::Invalid("Unsupported UI operation".into()).into());
        }
        self.dispatch(principal, name, arguments, Policy::Human, "website")
    }
    fn dispatch(
        &self,
        principal: &Principal,
        name: &str,
        arguments: Value,
        policy: Policy,
        origin: &str,
    ) -> Result<Value> {
        let agent = policy == Policy::Agent;
        let request_id = arguments
            .get("request_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if agent
            && matches!(
                name,
                "activity_summary"
                    | "activity_day"
                    | "request_results"
                    | "view_snapshot"
                    | "priority_grid"
            )
        {
            return Err(
                StoreError::Invalid("This operation is available only to the app".into()).into(),
            );
        }
        let mut value = match name {
            "get_profile" => {
                if arguments != json!({}) {
                    return Err(
                        StoreError::Invalid("get_profile accepts an empty object".into()).into(),
                    );
                }
                self.read(principal,|tx| {
                    let a=tx.account();
                    Ok(json!({"id":a.id().to_string(),"name":a.display_name().unwrap_or(a.username()),"nickname":a.username()}))
                })?
            }
            "show_gtd" => {
                let input = show_gtd_input(arguments)?;
                if input.view == GtdView::Results {
                    self.request_results(
                        principal,
                        crate::activity::ResultsQuery {
                            from_request_ids: input.from_request_ids.ok_or_else(|| {
                                StoreError::Invalid("Results requires from_request_ids".into())
                            })?,
                            agent_context: agent,
                            cursor: input.cursor,
                            limit: input.limit,
                            ..Default::default()
                        },
                    )?
                } else {
                    self.read(principal,|_|Ok(json!({"view":input.view,"series_id":input.series_id,"app":"gtd","response_version":2})))?
                }
            }
            "list_items" | "show_tasks" => {
                let input = task_input(name, arguments, agent)?;
                crate::view::task_list(&self.list(principal, input.clone())?, &input)
            }
            "list_projects" | "show_projects" => {
                let mut input: ListProjects = parse(arguments)?;
                input.agent_context = agent;
                if agent {
                    input.detail = Some(Detail::Full);
                    input.include_agent_notes = true;
                }
                self.projects(principal, input)?
            }
            "list_changes" => {
                let mut input: ListChanges = parse(arguments)?;
                input.agent_context = agent;
                let detail = if input.change_id.is_some() {
                    input.detail.unwrap_or(Detail::Summary)
                } else {
                    Detail::Summary
                };
                let result = self.changes(principal, input)?;
                projection::changes(&result, detail)
            }
            "view_snapshot" => self.view_snapshot(principal, parse(arguments)?)?,
            "activity_summary" => self.activity_summary(principal, parse(arguments)?)?,
            "activity_day" => self.activity_day(principal, parse(arguments)?)?,
            "priority_grid" => self.priority_grid(principal, parse(arguments)?)?,
            "request_results" => self.request_results(principal, parse(arguments)?)?,
            "sync_state" => {
                let mut input: SyncState = parse(arguments)?;
                input.agent_context = agent;
                self.sync_state(principal, &input)?
            }
            "list_occurrences" => {
                let mut input: crate::recurrence_model::ListOccurrences = parse(arguments)?;
                input.agent_context = agent;
                if agent {
                    input.include_agent_notes = true;
                }
                self.list_occurrences(principal, input)?
            }
            _ => {
                let operation = write_operation(name, arguments)?;
                let receipt = self.execute(principal, policy, origin, operation)?;
                if name == "apply_changes" {
                    let result: BatchResult = serde_json::from_value(receipt)?;
                    json!({"results":result.results.iter().map(|r|json!({"entity_id":r.task.id,"entity_type":r.task.entity_type,"version":r.task.version,"change_id":r.change.id,"operation":r.change.operation,"replayed":result.replayed})).collect::<Vec<_>>(),"replayed":result.replayed,"response_version":2})
                } else {
                    projection::mutation(&serde_json::from_value(receipt)?)
                }
            }
        };
        if crate::application::UI_WRITES.contains(&name) {
            value["request_id"] = json!(request_id);
        }
        if name != "get_profile" {
            value["environment"] = json!(self.environment.as_str());
        }
        Ok(value)
    }
}

pub(super) fn write_operation(name: &str, arguments: Value) -> Result<WriteOperation> {
    Ok(match name {
        "capture_item" => WriteOperation::Capture(parse(arguments)?),
        "update_item" => WriteOperation::Update(parse(arguments)?),
        "undo_change" => WriteOperation::Undo(parse(arguments)?),
        "apply_changes" => WriteOperation::Batch(parse(arguments)?),
        "create_project" => WriteOperation::CreateProject(parse(arguments)?),
        "update_project" => WriteOperation::UpdateProject(parse(arguments)?),
        "create_recurrence" => WriteOperation::CreateRecurrence(parse(arguments)?),
        "update_recurrence" => WriteOperation::UpdateRecurrence(parse(arguments)?),
        _ => return Err(StoreError::Invalid("Unknown operation".into()).into()),
    })
}

pub(super) fn show_gtd_input(arguments: Value) -> Result<ShowGtd> {
    let input: ShowGtd = parse(arguments)?;
    if let Some(id) = &input.series_id
        && (input.view != GtdView::Repeating || Uuid::parse_str(id).is_err())
    {
        return Err(StoreError::Invalid(
            "series_id requires view=repeating and a valid series ID".into(),
        )
        .into());
    }
    if input.view != GtdView::Results
        && (input.from_request_ids.is_some() || input.cursor.is_some() || input.limit.is_some())
    {
        return Err(StoreError::Invalid("from_request_ids requires view=results".into()).into());
    }
    Ok(input)
}

pub(super) fn task_input(name: &str, arguments: Value, agent: bool) -> Result<ListItems> {
    let mut input: ListItems = parse(arguments)?;
    input.agent_context = agent;
    if name == "show_tasks" {
        crate::activity::show_task_defaults(&mut input);
    }
    if agent {
        input.detail = Some(Detail::Full);
        input.include_agent_notes = true;
    }
    if name == "show_tasks"
        && input.sort != Some(TaskSort::Updated)
        && input.task_id.is_none()
        && input.task_ids.is_none()
    {
        input.group_recurrences = true;
    }
    if input.task_id.is_some() || input.task_ids.is_some() {
        input.group_recurrences = false;
    }
    Ok(input)
}
