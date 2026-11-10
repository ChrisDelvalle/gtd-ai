use crate::{
    diagnostics::Diagnostics,
    model::*,
    projection,
    store::{Store, StoreError},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Application {
    pub store: Arc<Mutex<Store>>,
    pub diagnostics: Diagnostics,
    reads: Option<Arc<crate::read_pool::ReadPool>>,
}

pub fn known_operation(name: &str) -> &'static str {
    match name {
        "capture_item" => "capture_item",
        "list_items" => "list_items",
        "update_item" => "update_item",
        "undo_change" => "undo_change",
        "apply_changes" => "apply_changes",
        "show_tasks" => "show_tasks",
        "show_gtd" => "show_gtd",
        "activity_summary" => "activity_summary",
        "view_snapshot" => "view_snapshot",
        "activity_day" => "activity_day",
        "priority_grid" => "priority_grid",
        "request_results" => "request_results",
        "list_changes" => "list_changes",
        "create_project" => "create_project",
        "update_project" => "update_project",
        "list_projects" => "list_projects",
        "show_projects" => "show_projects",
        "sync_state" => "sync_state",
        "create_recurrence" => "create_recurrence",
        "update_recurrence" => "update_recurrence",
        "list_occurrences" => "list_occurrences",
        _ => "unknown_tool",
    }
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, StoreError> {
    // serde errors may contain arbitrary user content. Return a fixed safe error.
    serde_json::from_value(value).map_err(|_| {
        StoreError::Invalid(
            "Arguments do not match this operation's schema; check fields and types".into(),
        )
    })
}

impl Application {
    pub async fn view(&self, request: crate::view::ViewRequest) -> Result<Value, Value> {
        let app = self.clone();
        tokio::task::spawn_blocking(move || {
            let call = app.diagnostics.begin("http.view");
            let result = (|| -> Result<Value, StoreError> {
                if let Some(reads) = &app.reads {
                    reads.acquire()?.home_view(request)
                } else {
                    app.store
                        .lock()
                        .map_err(|_| StoreError::Invalid("Task store unavailable".into()))?
                        .home_view(request)
                }
            })();
            match result {
                Ok(value) => {
                    app.diagnostics.finish(&call, "success", None, Some(&value));
                    Ok(value)
                }
                Err(error) => {
                    app.diagnostics
                        .finish(&call, "error", Some(error.code()), None);
                    Err(json!({"code":error.code(),"message":error.to_string()}))
                }
            }
        })
        .await
        .unwrap_or_else(|_| Err(json!({"code":"internal_error","message":"View read interrupted"})))
    }
    pub fn new(store: Store, diagnostics: Diagnostics) -> Self {
        let reads = crate::read_pool::ReadPool::new(&store).map(Arc::new);
        Self {
            store: Arc::new(Mutex::new(store)),
            diagnostics,
            reads,
        }
    }

    pub async fn execute(&self, name: &str, arguments: Value) -> Result<Value, Value> {
        if matches!(name, "gtd_ui_read" | "gtd_ui_write") {
            let operation = arguments
                .get("operation")
                .and_then(Value::as_str)
                .unwrap_or("");
            let allowed = if name == "gtd_ui_read" {
                UI_READS
            } else {
                UI_WRITES
            };
            if !allowed.contains(&operation)
                || arguments
                    .as_object()
                    .is_none_or(|o| o.keys().any(|k| k != "operation" && k != "arguments"))
            {
                return Err(
                    json!({"code":"invalid_arguments","message":"Unsupported UI operation"}),
                );
            }
            return self
                .execute_ui(
                    operation,
                    arguments.get("arguments").cloned().unwrap_or(Value::Null),
                )
                .await;
        }
        self.execute_policy(name, arguments, crate::store::content::Policy::Agent)
            .await
    }
    pub async fn execute_ui(&self, name: &str, arguments: Value) -> Result<Value, Value> {
        self.execute_policy(name, arguments, crate::store::content::Policy::Human)
            .await
    }
    async fn execute_policy(
        &self,
        name: &str,
        arguments: Value,
        policy: crate::store::content::Policy,
    ) -> Result<Value, Value> {
        let app = self.clone();
        let operation = known_operation(name);
        tokio::task::spawn_blocking(move || {
            let call = app.diagnostics.begin(operation);
            let result = (|| -> Result<Value, StoreError> {
                let read = UI_READS.contains(&operation) && operation != "show_gtd";
                let mut reader;
                let mut writer;
                let store: &mut Store = if let Some(pool) = app.reads.as_ref().filter(|_| read) {
                    reader = pool.acquire()?;
                    &mut reader
                } else {
                    writer = app.store.lock().map_err(|_| StoreError::Invalid("Task store unavailable".into()))?;
                    &mut writer
                };
                store.set_content_policy(policy);
                let agent=policy==crate::store::content::Policy::Agent;
                let request_id=arguments.get("request_id").and_then(Value::as_str).map(str::to_owned);
                if agent && matches!(operation,"activity_summary"|"activity_day"|"request_results"|"view_snapshot"|"priority_grid") {return Err(StoreError::Invalid("This operation is available only to the app".into()));}
                let mut value = match operation {
                    "show_gtd" => {
                        let input: ShowGtd = parse(arguments)?;
                        if let Some(id) = &input.series_id
                            && (input.view != GtdView::Repeating || uuid::Uuid::parse_str(id).is_err()) {
                                return Err(StoreError::Invalid("series_id requires view=repeating and a valid series ID".into()));
                            }
                        if input.view==GtdView::Results {
                            store.request_results(crate::activity::ResultsQuery{from_request_ids:input.from_request_ids.ok_or_else(||StoreError::Invalid("Results requires from_request_ids".into()))?,agent_context:agent,cursor:input.cursor,limit:input.limit,..Default::default()})?
                        } else {
                            if input.from_request_ids.is_some() || input.cursor.is_some() || input.limit.is_some(){return Err(StoreError::Invalid("from_request_ids requires view=results".into()));}
                            json!({"view":input.view,"series_id":input.series_id,"app":"gtd","response_version":2})
                        }
                    },
                    "capture_item" => projection::mutation(&store.capture(parse(arguments)?)?),
                    "list_items" | "show_tasks" => {
                        let mut input: ListItems = parse(arguments)?;
                        input.agent_context=agent;
                        if operation=="show_tasks" {crate::activity::show_task_defaults(&mut input);}
                        if agent { input.detail=Some(Detail::Full); input.include_agent_notes=true; }
                        if operation=="show_tasks" && input.sort!=Some(TaskSort::Updated) && input.task_id.is_none() && input.task_ids.is_none(){input.group_recurrences=true;}
                        if input.task_id.is_some() || input.task_ids.is_some(){input.group_recurrences=false;}
                        let group_recurrences = input.group_recurrences;
                        let detail = input.effective_detail();
                        let include_agent_notes = input.include_agent_notes;
                        let scope = input.effective_scope();
                        let sort = input.effective_sort();
                        let explicit = input.task_id.is_some();
                        let result = store.list(input)?;
                        let mut result = json!({"evaluated_at":result.evaluated_at,"next_change_at":result.next_change_at,"items":result.items.iter().map(|t|projection::page_record_with_agent_notes(t,detail,explicit,include_agent_notes)).collect::<Vec<_>>(), "next_offset":result.next_offset,"next_cursor":result.next_cursor,"complete":result.next_cursor.is_none(),"history":result.history.iter().map(|c|projection::change(c,Detail::Summary)).collect::<Vec<_>>(),"next_history_after":result.next_history_after,"response_version":2});
                        result["scope"] = json!(scope);
                        result["detail"] = json!(detail);
                        result["sort"] = json!(sort);
                        result["group_recurrences"] = json!(group_recurrences);
                        result
                    },
                    "update_item" => projection::mutation(&store.update(parse(arguments)?)?),
                    "undo_change" => projection::mutation(&store.undo(parse(arguments)?)?),
                    "apply_changes" => {
                        let result = store.apply_changes(parse(arguments)?)?;
                        json!({"results":result.results.iter().map(|r|json!({"entity_id":r.task.id,"entity_type":r.task.entity_type,"version":r.task.version,"change_id":r.change.id,"operation":r.change.operation,"replayed":result.replayed})).collect::<Vec<_>>(),"replayed":result.replayed,"response_version":2})
                    },
                    "list_changes" => {
                        let mut input: ListChanges = parse(arguments)?;
                        input.agent_context=agent;
                        let detail = if input.change_id.is_some() {input.detail.unwrap_or(Detail::Summary)} else {Detail::Summary};
                        let result = store.changes(input)?;
                        projection::changes(&result,detail)
                    },
                    "create_project" => projection::mutation(&store.create_project(parse(arguments)?)?),
                    "update_project" => projection::mutation(&store.update_project(parse(arguments)?)?),
                    "list_projects" | "show_projects" => { let mut input: ListProjects=parse(arguments)?; input.agent_context=agent; if agent {input.detail=Some(Detail::Full);input.include_agent_notes=true;} store.projects(input)? },
                    "view_snapshot" => {
                        use crate::view::{SnapshotQuery, SnapshotRequest};
                        let data = match parse::<SnapshotRequest>(arguments)?.query {
                            SnapshotQuery::Home(query) => store.home_view(query)?["data"].take(),
                            SnapshotQuery::Tasks(query) => crate::view::task_list(&store.list((*query).clone())?, &query),
                            SnapshotQuery::Charts(query) => store.activity_summary(query)?,
                        };
                        json!({"kind":"full","token":null,"data":data})
                    }
                    "activity_summary"=>store.activity_summary(parse(arguments)?)?,
                    "activity_day"=>store.activity_day(parse(arguments)?)?,
                    "priority_grid"=>store.priority_grid(parse(arguments)?)?,
                    "request_results"=>store.request_results(parse(arguments)?)?,
                    "sync_state" => {let mut input:SyncState=parse(arguments)?;input.agent_context=agent;store.sync_state(input)?},
                    "create_recurrence"=>projection::mutation(&store.create_recurrence(parse(arguments)?)?),
                    "update_recurrence"=>projection::mutation(&store.update_recurrence(parse(arguments)?)?),
                    "list_occurrences"=>{let mut input:crate::recurrence_model::ListOccurrences=parse(arguments)?;input.agent_context=agent;if agent {input.include_agent_notes=true;}store.list_occurrences(input)?},
                    _ => return Err(StoreError::Invalid("Unknown operation".into())),
                };
                if UI_WRITES.contains(&operation){value["request_id"]=json!(request_id);}
                value["environment"] = json!(store.environment());
                Ok(value)
            })();
            match result {
                Ok(value) => { app.diagnostics.finish(&call, "success", None, Some(&value)); Ok(value) }
                Err(error) => {
                    app.diagnostics.finish(&call, "error", Some(error.code()), None);
                    Err(json!({"code":error.code(),"message":error.to_string(),"retryable":matches!(error,StoreError::SearchUnavailable),"environment":app.store.lock().ok().map(|store|store.environment())}))
                }
            }
        }).await.unwrap_or_else(|_| Err(json!({"code":"internal_error","message":"Operation interrupted. Read current state or retry identical arguments and request_id."})))
    }
}

pub const UI_READS: &[&str] = &[
    "view_snapshot",
    "activity_summary",
    "activity_day",
    "priority_grid",
    "request_results",
    "show_gtd",
    "list_items",
    "show_tasks",
    "list_projects",
    "show_projects",
    "list_occurrences",
    "list_changes",
    "sync_state",
];
pub const UI_WRITES: &[&str] = &[
    "capture_item",
    "update_item",
    "undo_change",
    "apply_changes",
    "create_project",
    "update_project",
    "create_recurrence",
    "update_recurrence",
];
