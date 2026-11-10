//! Internal website screen reads. This is not a public MCP operation.
use crate::model::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum LoadingPolicy {
    #[default]
    OnDemand,
    Featured,
    TopThree,
    LookAhead,
}
#[derive(Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum View {
    #[default]
    Home,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ViewRequest {
    #[serde(default)]
    pub view: View,
    pub review_on: String,
    #[serde(default)]
    pub loading: LoadingPolicy,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(tag = "view", content = "arguments", rename_all = "snake_case")]
pub enum SnapshotQuery {
    Home(ViewRequest),
    Tasks(Box<ListItems>),
    Charts(crate::activity::ChartQuery),
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SnapshotRequest {
    pub query: SnapshotQuery,
    pub token: Option<String>,
    #[serde(default)]
    pub reuse_home_notes: bool,
    #[serde(default)]
    pub sparse_chart: bool,
}

pub fn task_list(result: &ListResult, input: &ListItems) -> Value {
    let items: Vec<_> = result
        .items
        .iter()
        .map(|task| {
            let mut value = crate::projection::page_record_with_agent_notes(
                task,
                input.effective_detail(),
                input.task_id.is_some(),
                input.include_agent_notes,
            );
            if let Some(count) = result.blocking_counts.get(&task.id) {
                value["blocking_count"] = json!(count);
            }
            value
        })
        .collect();
    json!({"evaluated_at":result.evaluated_at,"next_change_at":result.next_change_at,
        "items":items,
        "next_offset":result.next_offset,"next_cursor":result.next_cursor,"complete":result.next_cursor.is_none(),
        "history":result.history.iter().map(|c|crate::projection::change(c,Detail::Summary)).collect::<Vec<_>>(),
        "next_history_after":result.next_history_after,"response_version":2,
        "scope":input.effective_scope(),"detail":input.effective_detail(),"sort":input.effective_sort(),"group_recurrences":input.group_recurrences})
}
