mod support;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};
use tempfile::TempDir;
use todo_mcp::{model::*, store::Store};

fn input<T: DeserializeOwned>(value: Value) -> T {
    support::input(value)
}
fn fixture() -> (TempDir, Store) {
    let dir = TempDir::new().unwrap();
    let store = Store::open(dir.path().join("integration.db")).unwrap();
    (dir, store)
}
fn defaults(title: &str) -> Value {
    json!({"estimated_minutes":30,"effort":"medium","importance":"normal","title":title,"due_offset_days":0,"review_offset_days":0})
}
fn series(store: &mut Store, key: &str, count: u32) -> Task {
    store.create_recurrence(input(json!({"request_id":key,"template":defaults(key),"rule":{"start_date":"2090-01-01","frequency":"daily","count":count},"reason":"Synthetic integration fixture"}))).unwrap().task
}
fn tasks(store: &mut Store) -> Vec<Task> {
    store
        .list(input(json!({"view":"all","sort":"created","limit":100})))
        .unwrap()
        .items
}
fn update(store: &mut Store, task: &Task, key: &str, patch: Value) -> MutationResult {
    let mut value = json!({"request_id":key,"task_id":task.id,"expected_version":task.version,"reason":"Synthetic integration update"});
    value
        .as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    store.update(input(value)).unwrap()
}
fn current(store: &mut Store, task: &Task) -> Task {
    store
        .list(input(json!({"task_id":task.id,"include_deleted":true})))
        .unwrap()
        .items
        .remove(0)
}

#[test]
fn explicit_confirmation_ids_never_collapse_distinct_occurrences() {
    let (_dir, mut store) = fixture();
    series(&mut store, "selected-confirmation", 3);
    store.materialize_recurrences("2090-01-03").unwrap();
    let ids: Vec<_> = tasks(&mut store).into_iter().map(|t| t.id).collect();
    let selected = store
        .list(input(json!({"task_ids":ids,"group_recurrences":true})))
        .unwrap();
    assert_eq!(selected.items.len(), 3);
    assert!(
        selected
            .items
            .iter()
            .all(|t| t.pending_occurrence_count.is_none())
    );
}

#[test]
fn grouped_representative_matches_flat_sort_and_counts_only_filtered_pending_rows() {
    let (_dir, mut store) = fixture();
    series(&mut store, "representatives", 4);
    store.materialize_recurrences("2090-01-04").unwrap();
    let initial = tasks(&mut store);
    update(
        &mut store,
        &initial[0],
        "postpone",
        json!({"due_date":"2090-02-01","status":"waiting"}),
    );
    update(
        &mut store,
        &initial[3],
        "urgent",
        json!({"due_date":"2089-12-31"}),
    );
    update(
        &mut store,
        &initial[1],
        "latest",
        json!({"notes":"Latest update"}),
    );
    for sort in ["action", "due", "updated", "created"] {
        let flat = store.list(input(json!({"sort":sort}))).unwrap();
        let grouped = store
            .list(input(json!({"sort":sort,"group_recurrences":true})))
            .unwrap();
        assert_eq!(grouped.items.len(), 1);
        assert_eq!(
            grouped.items[0].id, flat.items[0].id,
            "representative for {sort}"
        );
        assert_eq!(grouped.items[0].pending_occurrence_count, Some(4));
        assert!(
            flat.items
                .iter()
                .all(|task| task.pending_occurrence_count.is_none())
        );
    }
    let filtered = store
        .list(input(
            json!({"due_from":"2090-01-01","due_through":"2090-01-04","group_recurrences":true}),
        ))
        .unwrap();
    assert_eq!(filtered.items.len(), 1);
    assert_eq!(filtered.items[0].pending_occurrence_count, Some(2));
    assert_eq!(filtered.items[0].id, initial[1].id);
}

#[test]
fn grouped_pagination_keeps_snapshot_counts_and_does_not_repeat_series() {
    let (_dir, mut store) = fixture();
    let one = series(&mut store, "one", 3);
    let two = series(&mut store, "two", 3);
    store.materialize_recurrences("2090-01-03").unwrap();
    let first = store
        .list(input(json!({"group_recurrences":true,"limit":1})))
        .unwrap();
    assert_eq!(
        first.items[0].occurrence.as_ref().unwrap().series_id,
        one.id
    );
    assert_eq!(first.items[0].pending_occurrence_count, Some(3));
    let second_task = tasks(&mut store)
        .into_iter()
        .find(|task| task.occurrence.as_ref().unwrap().series_id == two.id)
        .unwrap();
    update(
        &mut store,
        &second_task,
        "complete-between-pages",
        json!({"status":"done"}),
    );
    series(&mut store, "new-between-pages", 1);
    store.materialize_recurrences("2090-01-03").unwrap();
    let second = store
        .list(input(
            json!({"group_recurrences":true,"limit":1,"cursor":first.next_cursor}),
        ))
        .unwrap();
    assert_eq!(
        second.items[0].occurrence.as_ref().unwrap().series_id,
        two.id
    );
    assert_eq!(second.items[0].pending_occurrence_count, Some(3));
    assert!(second.next_cursor.is_none());
    let fresh = store
        .list(input(json!({"group_recurrences":true})))
        .unwrap();
    assert_eq!(fresh.items.len(), 3);
    assert_eq!(
        fresh
            .items
            .iter()
            .find(|task| task.occurrence.as_ref().unwrap().series_id == two.id)
            .unwrap()
            .pending_occurrence_count,
        Some(2)
    );
}

#[test]
fn skipped_done_and_archived_occurrences_are_not_pending_groups() {
    let (_dir, mut store) = fixture();
    let series = series(&mut store, "states", 4);
    store.materialize_recurrences("2090-01-04").unwrap();
    let initial = tasks(&mut store);
    let skipped=store.update_recurrence(input(json!({"request_id":"skip","series_id":series.id,"expected_version":series.version,"scope":"this","action":"skip","original_date":"2090-01-01","expected_occurrence_version":initial[0].version,"reason":"Synthetic skip"}))).unwrap().task;
    update(&mut store, &initial[1], "done", json!({"status":"done"}));
    update(&mut store, &initial[2], "archive", json!({"archived":true}));
    for filter in [
        json!({}),
        json!({"status":"next"}),
        json!({"review_on":"2090-01-31"}),
    ] {
        let mut args = filter;
        args["group_recurrences"] = json!(true);
        let listed = store.list(input(args)).unwrap();
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].id, initial[3].id);
        assert_eq!(listed.items[0].pending_occurrence_count, Some(1));
    }
    let all = store
        .list(input(json!({"view":"all","group_recurrences":true})))
        .unwrap();
    assert_eq!(all.items.len(), 4);
    for task in &all.items {
        assert_eq!(
            task.pending_occurrence_count,
            if task.id == initial[3].id {
                Some(1)
            } else {
                None
            }
        );
    }
    assert_eq!(current(&mut store, &skipped).id, skipped.id);
    update(
        &mut store,
        &skipped,
        "archive-skip",
        json!({"archived":true}),
    );
    let archive = store
        .list(input(json!({"status":"archived","group_recurrences":true})))
        .unwrap();
    assert_eq!(archive.items.len(), 2);
    assert!(
        archive
            .items
            .iter()
            .all(|task| task.pending_occurrence_count.is_none())
    );
}

#[test]
fn mixed_batch_undo_is_scoped_and_secondary_overlap_rolls_everything_back() {
    let (_dir, mut store) = fixture();
    let batch: ApplyChanges = input(
        json!({"request_id":"mixed","operations":[{"operation":"create_recurrence","template":defaults("Series"),"rule":{"start_date":"2090-01-01","frequency":"daily","count":2},"reason":"Synthetic series"},{"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Unrelated capture","reason":"Synthetic ordinary task"}]}),
    );
    let result = store.apply_changes(batch.clone()).unwrap();
    assert!(store.apply_changes(batch).unwrap().replayed);
    let undone=store.undo(input(json!({"request_id":"undo-series-only","change_id":result.results[0].change.id,"expected_version":1,"reason":"Synthetic grouped undo"}))).unwrap();
    assert!(!current(&mut store, &result.results[1].task).deleted);
    let restored=store.undo(input(json!({"request_id":"redo-series-only","change_id":undone.change.id,"expected_version":undone.task.version,"reason":"Synthetic grouped redo"}))).unwrap().task;
    store.materialize_recurrences("2090-01-02").unwrap();
    let task = tasks(&mut store)
        .into_iter()
        .find(|task| task.occurrence.is_some())
        .unwrap();
    let collision=store.apply_changes(input(json!({"request_id":"overlapping-scopes","operations":[{"operation":"update_recurrence","series_id":restored.id,"expected_version":restored.version,"scope":"all","action":"edit","template":defaults("Changed"),"reason":"Synthetic scoped update"},{"operation":"update","task_id":task.id,"expected_version":task.version+1,"notes":"Should roll back","reason":"Synthetic overlapping update"}]})));
    assert_eq!(collision.unwrap_err().code(), "invalid_input");
    assert_eq!(current(&mut store, &task), task);
    assert_eq!(
        store
            .list_occurrences(input(json!({"series_id":restored.id})))
            .unwrap()["series"]["version"],
        restored.version
    );
}

#[test]
fn scoped_undo_refuses_later_child_changes_without_partially_reverting_siblings() {
    let (_dir, mut store) = fixture();
    let series = series(&mut store, "undo", 2);
    store.materialize_recurrences("2090-01-02").unwrap();
    let changed=store.update_recurrence(input(json!({"request_id":"scoped-update","series_id":series.id,"expected_version":series.version,"scope":"all","action":"edit","template":defaults("Changed together"),"reason":"Synthetic scoped update"}))).unwrap();
    let children = tasks(&mut store);
    update(
        &mut store,
        &children[0],
        "later-child",
        json!({"notes":"Keep this later edit"}),
    );
    let before = tasks(&mut store);
    let result=store.undo(input(json!({"request_id":"unsafe-undo","change_id":changed.change.id,"expected_version":changed.task.version,"reason":"Synthetic conflict guard"})));
    assert_eq!(result.unwrap_err().code(), "conflict");
    assert_eq!(tasks(&mut store), before);
    assert_eq!(
        store
            .list_occurrences(input(json!({"series_id":series.id})))
            .unwrap()["series"]["version"],
        changed.task.version
    );
}

#[test]
fn project_completion_and_series_end_validate_the_atomic_final_state() {
    let (_dir, mut store) = fixture();
    let project=store.create_project(input(json!({"request_id":"project","title":"Recurring project","reason":"Synthetic project fixture"}))).unwrap().task;
    let mut template = defaults("Future project action");
    template["project_id"] = json!(project.id);
    let series=store.create_recurrence(input(json!({"request_id":"project-series","template":template,"rule":{"start_date":"2090-01-01","frequency":"daily","count":2},"reason":"Synthetic future recurrence"}))).unwrap().task;
    let result=store.apply_changes(input(json!({"request_id":"finish-project","operations":[{"operation":"update_project","project_id":project.id,"expected_version":project.version,"status":"done","reason":"Synthetic project completion"},{"operation":"update_recurrence","series_id":series.id,"expected_version":series.version,"scope":"all","action":"end","reason":"Synthetic series end"}]}))).unwrap();
    let end = &result.results[1];
    assert_eq!(store.undo(input(json!({"request_id":"resume-under-closed-project","change_id":end.change.id,"expected_version":end.task.version,"reason":"Synthetic membership guard"}))).unwrap_err().code(),"conflict");
    let restored=store.apply_changes(input(json!({"request_id":"restore-both","operations":[{"operation":"undo","change_id":end.change.id,"expected_version":end.task.version,"reason":"Restore the series in one atomic batch"},{"operation":"undo","change_id":result.results[0].change.id,"expected_version":result.results[0].task.version,"reason":"Restore its project in the same batch"}]}))).unwrap();
    assert_eq!(restored.results[1].task.status, Status::Active);
    assert!(
        restored.results[0]
            .task
            .recurrence
            .as_ref()
            .unwrap()
            .ended_on
            .is_none()
    );
    assert_eq!(store.materialize_recurrences("2090-01-02").unwrap(), 2);
}

struct Client {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<Value>,
    id: u64,
}
impl Client {
    fn start(path: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_todo-mcp"))
            .args(["--db", path.to_str().unwrap()])
            .env("TODO_WIDGET_ENABLED", "0")
            .env_remove("TODO_SEARCH_URL")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender
                    .send(serde_json::from_str(&line.unwrap()).unwrap())
                    .is_err()
                {
                    break;
                }
            }
        });
        let mut client = Self {
            child,
            stdin,
            replies,
            id: 0,
        };
        let reply=client.request("initialize",json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"recurrence-integration","version":"1"}}));
        assert!(reply["result"].is_object());
        writeln!(
            client.stdin,
            "{}",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .unwrap();
        client.stdin.flush().unwrap();
        client
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.id += 1;
        writeln!(
            self.stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params})
        )
        .unwrap();
        self.stdin.flush().unwrap();
        loop {
            let reply = self.replies.recv_timeout(Duration::from_secs(20)).unwrap();
            if reply["id"] == self.id {
                return reply;
            }
        }
    }
    fn tool(&mut self, name: &str, args: Value) -> Value {
        self.request(
            "tools/call",
            json!({"name":name,"arguments":support::operation(name,args)}),
        )
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn actual_mcp_tools_adopt_and_edit_a_series_through_atomic_batch_contracts() {
    let dir = TempDir::new().unwrap();
    let mut client = Client::start(&dir.path().join("mcp.db"));
    let discovery = client.request("tools/list", json!({}));
    for name in ["create_recurrence", "update_recurrence", "list_occurrences"] {
        assert!(
            discovery["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == name)
        );
    }
    let capture = client.tool(
        "capture_item",
        json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"capture","title":"Adopt me","reason":"Synthetic MCP fixture"}),
    );
    assert_eq!(capture["result"]["isError"], false);
    let task = &capture["result"]["structuredContent"]["task"];
    let create_args = json!({"request_id":"adopt","task_id":task["id"],"expected_task_version":task["version"],"template":defaults("Repeat"),"rule":{"start_date":"2090-01-01","frequency":"daily","count":2},"reason":"Synthetic MCP adoption"});
    let created = client.tool("create_recurrence", create_args.clone());
    assert_eq!(created["result"]["isError"], false, "{created}");
    let series = &created["result"]["structuredContent"]["series"];
    assert!(series.get("recurrence").is_none());
    assert!(series["recurrence_summary"].is_object());
    assert_eq!(
        client.tool("create_recurrence", create_args)["result"]["structuredContent"]["replayed"],
        true
    );
    let edited=client.tool("apply_changes",json!({"request_id":"batch-edit","operations":[{"operation":"update_recurrence","series_id":series["id"],"expected_version":series["version"],"scope":"all","action":"edit","template":defaults("Updated over MCP"),"reason":"Synthetic MCP edit"},{"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"Another task","reason":"Synthetic MCP capture"}]}));
    assert_eq!(edited["result"]["isError"], false, "{edited}");
    assert_eq!(
        edited["result"]["structuredContent"]["results"][0]["entity_type"],
        "recurrence"
    );
    let read = client.tool(
        "list_occurrences",
        json!({"series_id":series["id"],"from":"2090-01-01"}),
    );
    assert_eq!(read["result"]["isError"], false);
    assert_eq!(
        read["result"]["structuredContent"]["series"]["title"],
        "Updated over MCP"
    );
    assert_eq!(
        read["result"]["structuredContent"]["occurrences"][0]["task"]["id"],
        task["id"]
    );
    let shown = client.tool("show_tasks", json!({}));
    assert_eq!(shown["result"]["isError"], false);
    assert_eq!(
        shown["result"]["structuredContent"]["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
