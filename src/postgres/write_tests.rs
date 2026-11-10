//! Business operations against the real non-owner runtime role, in disposable PG.
use super::{
    tests::{fixture, principal},
    *,
};
use crate::{
    model::{MutationResult, Status, Task},
    store::{content::Policy, mutation::Operation},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub(super) fn input<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}
fn command(name: &str, v: Value) -> Operation {
    match name {
        "capture" => Operation::Capture(input(v)),
        "update" => Operation::Update(input(v)),
        "undo" => Operation::Undo(input(v)),
        "batch" => Operation::Batch(input(v)),
        "project" => Operation::CreateProject(input(v)),
        "update_project" => Operation::UpdateProject(input(v)),
        "recurrence" => Operation::CreateRecurrence(input(v)),
        "update_recurrence" => Operation::UpdateRecurrence(input(v)),
        _ => panic!("unknown fixture operation"),
    }
}
fn execute(store: &Store, account: &str, name: &str, v: Value) -> Result<Value> {
    store.execute(&principal(account), Policy::Agent, "test", command(name, v))
}
pub(super) fn run(store: &Store, account: &str, name: &str, v: Value) -> MutationResult {
    input(execute(store, account, name, v).unwrap())
}
pub(super) fn capture(key: &str) -> Value {
    json!({"request_id":key,"title":key,"brief":"Complete the disposable fixture.","agent_notes":"Synthetic context only.","importance":"normal","estimated_minutes":15,"effort":"low","status":"next","reason":"Deterministic fixture"})
}
pub(super) fn patch(task: &Task, key: &str, fields: Value) -> Value {
    let mut v = json!({"request_id":key,"task_id":task.id,"expected_version":task.version,"reason":"Deterministic fixture"});
    v.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    v
}
pub(super) fn task(store: &Store, account: &str, id: &str) -> Task {
    store
        .read(&principal(account), |tx| {
            let row = tx.tx.query_one(
                "SELECT document FROM gtd.tasks WHERE account_id=$1 AND id=$2",
                &[&tx.account.id, &id],
            )?;
            Ok(serde_json::from_str(&row.get::<_, String>(0))?)
        })
        .unwrap()
}
pub(super) fn high(store: &Store, account: &str) -> i64 {
    store.read(&principal(account), |tx| Ok(tx.high())).unwrap()
}
fn expect_code(result: Result<Value>, code: &str) {
    match result {
        Err(Error::Business(error)) => assert_eq!(error.code(), code),
        other => panic!("expected {code}, got {other:?}"),
    }
}
fn undo(result: &MutationResult, key: &str) -> Value {
    json!({"request_id":key,"change_id":result.change.id,"expected_version":result.task.version,"reason":"Deterministic undo"})
}

#[test]
#[ignore = "Manual deterministic mutation checks; disposable Docker only, no model or production data"]
fn mutations_preserve_atomicity_retries_dependencies_and_coupled_undo() {
    let (_container, mut admin, runtime, a, b) = fixture();
    // The policy fixture's minimal raw rows are intentionally not Task documents.
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let store = Store::connect(runtime, Environment::Staging, 4).unwrap();
    let human = json!({"request_id":"human-inbox","title":"Capture only","importance":"normal","reason":"Synthetic inbox"});
    assert!(
        store
            .execute(
                &principal("a"),
                Policy::Human,
                "web",
                command("capture", human.clone())
            )
            .is_ok()
    );
    let mut agent = human;
    agent["request_id"] = json!("agent-inbox");
    expect_code(
        execute(&store, "a", "capture", agent.clone()),
        "invalid_input",
    );
    agent["agent_notes"] = json!("Context for later clarification.");
    let inbox = run(&store, "a", "capture", agent);
    expect_code(
        execute(
            &store,
            "a",
            "update",
            patch(
                &inbox.task,
                "missing-brief",
                json!({"status":"next","estimated_minutes":5,"effort":"trivial"}),
            ),
        ),
        "invalid_input",
    );
    let clarified = run(
        &store,
        "a",
        "update",
        patch(
            &inbox.task,
            "clarify",
            json!({"status":"next","brief":"Perform this fixture.","estimated_minutes":5,"effort":"trivial"}),
        ),
    );
    assert_eq!(clarified.task.status, Status::Next);
    let other = run(&store, "b", "capture", capture("first"));
    let first = run(&store, "a", "capture", capture("first"));
    assert_ne!(first.task.id, other.task.id); // same retry key is account-local
    let mut blocked = capture("dependent");
    blocked["blocked_by"] = json!([first.task.id]);
    let dependent = run(&store, "a", "capture", blocked);
    assert_eq!(dependent.task.status, Status::Blocked);
    assert!(!dependent.task.manual_block);
    let baseline = high(&store, "a");
    let cycle = patch(
        &first.task,
        "cycle",
        json!({"blocked_by":[dependent.task.id]}),
    );
    expect_code(execute(&store, "a", "update", cycle), "invalid_input");
    assert_eq!(high(&store, "a"), baseline);
    assert!(task(&store, "a", &first.task.id).blocked_by.is_empty());
    // Foreign UUID and nonexistent UUID produce the same unavailable-record class.
    for (key, id) in [
        ("foreign", other.task.id.clone()),
        ("missing", Uuid::new_v4().to_string()),
    ] {
        expect_code(
            execute(
                &store,
                "a",
                "update",
                patch(&first.task, key, json!({"blocked_by":[id]})),
            ),
            "conflict",
        );
        expect_code(
            execute(
                &store,
                "a",
                "update",
                json!({"request_id":format!("read-{key}"),"task_id":id,"expected_version":1,"title":"No access","reason":"Cross-account fixture"}),
            ),
            "not_found",
        );
    }
    expect_code(
        execute(&store, "a", "undo", undo(&first, "referenced-delete")),
        "conflict",
    );
    assert_eq!(high(&store, "a"), baseline);
    let started = run(
        &store,
        "a",
        "update",
        patch(&dependent.task, "start-blocked", json!({"started":true})),
    );
    assert!(started.task.planning.started);
    assert_eq!(started.task.status, Status::Blocked);
    let completed = run(
        &store,
        "a",
        "update",
        patch(
            &first.task,
            "complete",
            json!({"status":"done","completion_result":"Fixture complete"}),
        ),
    );
    let unblocked = task(&store, "a", &dependent.task.id);
    assert_eq!(unblocked.status, Status::Next);
    assert_eq!(unblocked.version, started.task.version + 1);
    assert_eq!(high(&store, "a"), completed.change.id + 1);
    let reverted = run(&store, "a", "undo", undo(&completed, "undo-complete"));
    assert_eq!(reverted.task.status, Status::Next);
    let restored = task(&store, "a", &dependent.task.id);
    assert_eq!(restored.status, Status::Blocked);
    assert!(restored.planning.started);
    // Manual holds survive prerequisites completing; selecting Next releases only the hold.
    let held = run(
        &store,
        "a",
        "update",
        patch(&restored, "hold", json!({"status":"blocked"})),
    );
    assert!(held.task.manual_block);
    let completed2 = run(
        &store,
        "a",
        "update",
        patch(&reverted.task, "complete-again", json!({"status":"done"})),
    );
    assert_eq!(
        task(&store, "a", &dependent.task.id).version,
        held.task.version
    );
    let released = run(
        &store,
        "a",
        "update",
        patch(&held.task, "release", json!({"status":"next"})),
    );
    assert_eq!(released.task.status, Status::Next);
    assert!(!released.task.manual_block);
    let reopened = run(
        &store,
        "a",
        "update",
        patch(&completed2.task, "reopen", json!({"status":"next"})),
    );
    assert_eq!(
        task(&store, "a", &dependent.task.id).status,
        Status::Blocked
    );
    let completed3 = run(
        &store,
        "a",
        "update",
        patch(&reopened.task, "complete-third", json!({"status":"done"})),
    );
    let current = task(&store, "a", &dependent.task.id);
    run(
        &store,
        "a",
        "update",
        patch(&current, "intervening", json!({"notes":"A newer edit."})),
    );
    let before_conflict = high(&store, "a");
    expect_code(
        execute(&store, "a", "undo", undo(&completed3, "conflicted-undo")),
        "conflict",
    );
    assert_eq!(high(&store, "a"), before_conflict);
    assert_eq!(task(&store, "a", &first.task.id).status, Status::Done);
    let mut wrong = capture("first");
    wrong["title"] = json!("Different arguments");
    expect_code(
        execute(&store, "a", "capture", wrong),
        "request_id_conflict",
    );
    let replay = execute(&store, "a", "capture", capture("first")).unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["task"]["version"], 1);
    // Both records in a failed batch, history, receipts and high-water mark roll back.
    let current = task(&store, "a", &dependent.task.id);
    let one = task(&store, "a", &first.task.id);
    let mut p1 = patch(&one, "ignored", json!({"title":"Must roll back"}));
    p1.as_object_mut().unwrap().remove("request_id");
    p1["operation"] = json!("update");
    let mut p2 = patch(&current, "ignored", json!({"title":"Conflict"}));
    p2.as_object_mut().unwrap().remove("request_id");
    p2["operation"] = json!("update");
    p2["expected_version"] = json!(0);
    expect_code(
        execute(
            &store,
            "a",
            "batch",
            json!({"request_id":"bad-batch","operations":[p1,p2]}),
        ),
        "conflict",
    );
    assert_eq!(task(&store, "a", &first.task.id), one);
    assert_eq!(high(&store, "a"), before_conflict);
    // Fail at receipt insertion, after current rows, immutable history and high are written.
    admin.batch_execute("CREATE FUNCTION gtd.reject_fixture_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='interrupted' THEN RAISE EXCEPTION 'synthetic interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_write BEFORE INSERT ON gtd.requests FOR EACH ROW EXECUTE FUNCTION gtd.reject_fixture_write();").unwrap();
    assert!(execute(&store, "a", "capture", capture("interrupted")).is_err());
    assert_eq!(high(&store, "a"), before_conflict);
    admin
        .batch_execute(
            "DROP TRIGGER fixture_write ON gtd.requests; DROP FUNCTION gtd.reject_fixture_write();",
        )
        .unwrap();
    run(&store, "a", "capture", capture("interrupted"));
    // Concurrent exact requests commit once; all other callers receive the same receipt.
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let store = store.clone();
            std::thread::spawn(move || {
                execute(&store, "a", "capture", capture("concurrent")).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r["replayed"] == false).count(), 1);
    assert!(
        results
            .iter()
            .all(|r| r["task"]["id"] == results[0]["task"]["id"])
    );
    // Historical committed receipt is replayed before new requiredness validation.
    let legacy = json!({"request_id":"historical","title":"Old title-only record","reason":"Historical fixture"});
    let fingerprint = command("capture", legacy.clone()).fingerprint().unwrap();
    let raw = " {\"old_field\": {\"preserved\": true}, \"replayed\":false} ";
    admin.execute("INSERT INTO gtd.requests(account_id,id,request,response) VALUES($1,'historical',$2,$3)",&[&a,&fingerprint,&raw]).unwrap();
    let replay = execute(&store, "a", "capture", legacy).unwrap();
    assert_eq!(replay["old_field"]["preserved"], true);
    assert_eq!(
        admin
            .query_one(
                "SELECT response FROM gtd.requests WHERE account_id=$1 AND id='historical'",
                &[&a]
            )
            .unwrap()
            .get::<_, String>(0),
        raw
    );
    assert_eq!(task(&store, "b", &other.task.id), other.task);
    assert_eq!(
        admin
            .query_one(
                "SELECT count(*) FROM gtd.dependencies WHERE account_id=$1",
                &[&b]
            )
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    // Disablement blocks a fresh request and even a cached historical retry.
    admin
        .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&a])
        .unwrap();
    assert!(matches!(
        execute(&store, "a", "capture", capture("first")),
        Err(Error::AccountUnavailable)
    ));
}

#[test]
#[ignore = "Manual deterministic project/recurrence checks; disposable Docker only, no model or production data"]
fn project_and_recurring_operations_use_shared_rules_with_account_isolation() {
    let (_container, mut admin, runtime, _, _) = fixture();
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
    let project_args = json!({"request_id":"project","title":"Fixture project","brief":"Finish the fixture.","agent_notes":"Synthetic project handoff.","reason":"Fixture"});
    let project = run(&store, "a", "project", project_args.clone());
    let foreign = run(&store, "b", "project", project_args);
    let mut foreign_member = capture("foreign-project");
    foreign_member["project_id"] = json!(foreign.task.id);
    expect_code(execute(&store, "a", "capture", foreign_member), "conflict");
    let mut member = capture("member");
    member["project_id"] = json!(project.task.id);
    let member = run(&store, "a", "capture", member);
    let update_project = json!({"request_id":"project-done","project_id":project.task.id,"expected_version":1,"status":"done","reason":"Fixture"});
    expect_code(
        execute(&store, "a", "update_project", update_project.clone()),
        "conflict",
    );
    let mut p = update_project;
    p.as_object_mut().unwrap().remove("request_id");
    p["operation"] = json!("update_project");
    let mut t = patch(&member.task, "ignored", json!({"status":"done"}));
    t.as_object_mut().unwrap().remove("request_id");
    t["operation"] = json!("update");
    let batch = execute(
        &store,
        "a",
        "batch",
        json!({"request_id":"finish-both","operations":[p,t]}),
    )
    .unwrap();
    assert_eq!(batch["results"][0]["task"]["status"], "done");
    // Final-state validation supports either batch order and undo remains independent.
    let project_change: MutationResult = input(batch["results"][0].clone());
    run(&store, "a", "undo", undo(&project_change, "reopen-project"));
    assert_eq!(task(&store, "a", &member.task.id).status, Status::Done);
    let rule = json!({"start_date":"2090-01-01","frequency":"daily","count":3});
    let defaults = json!({"title":"Recurring fixture","brief":"Review this fixture.","agent_notes":"Shared fixture context.","importance":"normal","status":"next","estimated_minutes":10,"effort":"low"});
    let series = run(
        &store,
        "a",
        "recurrence",
        json!({"request_id":"series","template":defaults,"rule":rule,"reason":"Fixture"}),
    );
    let occurrence_args = json!({"request_id":"materialize","series_id":series.task.id,"expected_version":1,"scope":"this","action":"edit","original_date":"2090-01-01","scheduled_date":"2090-01-01","reason":"Fixture"});
    expect_code(
        execute(&store, "b", "update_recurrence", occurrence_args.clone()),
        "not_found",
    );
    let occurrence = run(&store, "a", "update_recurrence", occurrence_args);
    assert!(occurrence.task.occurrence.is_some());
    let blocker = run(&store, "a", "capture", capture("prerequisite"));
    let custom = run(
        &store,
        "a",
        "update",
        patch(
            &occurrence.task,
            "custom-occurrence",
            json!({"blocked_by":[blocker.task.id],"brief":"Keep the individual brief."}),
        ),
    );
    assert_eq!(custom.task.status, Status::Blocked);
    let updated = run(
        &store,
        "a",
        "update_recurrence",
        json!({"request_id":"default-brief","series_id":series.task.id,"expected_version":series.task.version,"action":"edit","scope":"all","brief":"A new inherited brief.","reason":"Fixture"}),
    );
    let kept = task(&store, "a", &occurrence.task.id);
    assert_eq!(kept.brief, "Keep the individual brief.");
    assert_eq!(kept.blocked_by, vec![blocker.task.id]);
    assert_eq!(kept.agent_notes, "Shared fixture context.");
    let second = run(
        &store,
        "a",
        "update_recurrence",
        json!({"request_id":"second-occurrence","series_id":series.task.id,"expected_version":updated.task.version,"action":"edit","scope":"this","original_date":"2090-01-02","scheduled_date":"2090-01-02","reason":"Fixture"}),
    );
    assert_eq!(second.task.brief, "A new inherited brief.");
    assert!(!second.task.planning.started);
    expect_code(
        execute(&store, "a", "undo", undo(&series, "undo-series")),
        "conflict",
    );
    assert_eq!(task(&store, "b", &foreign.task.id), foreign.task);
}
