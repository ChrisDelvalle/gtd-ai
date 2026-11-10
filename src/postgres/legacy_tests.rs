//! Synthetic migration rehearsal, sharing the isolated PostgreSQL fixture.
use super::{
    legacy::{Snapshot, Source},
    tests::{ISSUER, fixture, principal},
    *,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn input<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

#[test]
#[ignore = "Manual deterministic migration test; fresh Docker database, no production data or models"]
fn import_preserves_content_and_is_atomic_and_retry_safe() {
    let (_container, mut admin, runtime, _, _) = fixture();
    let c = Uuid::new_v4();
    admin.execute("INSERT INTO gtd.accounts(id,issuer,subject,username,enabled,enrollment) VALUES($1,$2,'c','c',true,'active')", &[&c, &ISSUER]).unwrap();
    admin
        .execute(
            "INSERT INTO gtd.account_state(account_id,identity) VALUES($1,$2)",
            &[&c, &Uuid::new_v4()],
        )
        .unwrap();
    let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.sqlite3");
    let mut old = crate::store::Store::open(&path).unwrap();
    let project = old.create_project(input(json!({"request_id":"project","title":"Synthetic project","brief":"Finish the fixture work.","notes":"🪴".repeat(9000),"agent_notes":"Synthetic project handoff.","reason":"Import fixture"}))).unwrap();
    let first = old.capture(input(json!({"request_id":"first","title":"First step 🪴","brief":"Prepare the fixture.","notes":"## Instructions\n\nKeep **this formatting**.\n","agent_notes":"Synthetic handoff\n\nPreserve whitespace.  ","status":"next","importance":"high","estimated_minutes":15,"effort":"low","project_id":project.task.id,"reason":"Import fixture"}))).unwrap();
    old.capture(input(json!({"request_id":"dependent","title":"Second step","brief":"Use the prepared fixture.","status":"next","importance":"critical","estimated_minutes":10,"effort":"low","blocked_by":[first.task.id],"project_id":project.task.id,"reason":"Import fixture"}))).unwrap();
    let deleted = old.capture(input(json!({"request_id":"deleted","title":"Discarded capture","importance":"normal","reason":"Import fixture"}))).unwrap();
    old.undo(input(json!({"request_id":"undo-deleted","change_id":deleted.change.id,"expected_version":deleted.task.version,"reason":"Import fixture"}))).unwrap();
    old.create_recurrence(input(json!({"request_id":"series","template":{"title":"Recurring fixture","brief":"Review the fixture.","agent_notes":"Synthetic recurrence context.","importance":"normal","estimated_minutes":10,"effort":"low"},"rule":{"start_date":"2090-01-01","frequency":"daily","count":2},"reason":"Import fixture"}))).unwrap();
    old.materialize_recurrences("2090-01-02").unwrap();
    // A true committed WAL snapshot is read while the original writer remains open.
    let mut db = rusqlite::Connection::open(&path).unwrap();
    let source = Source {
        identity: db
            .query_row(
                "SELECT value FROM store_meta WHERE key='identity'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
            .parse()
            .unwrap(),
        environment: old.environment(),
    };
    let raw_request = " [ \"legacy_operation\", {\"old_argument\":true} ] ";
    let raw_receipt = " { \"legacy_receipt\" : {\"retained\": \"é 🪴\\n\"} } \n";
    db.execute(
        "INSERT INTO requests VALUES('legacy-retry',?1,?2)",
        [raw_request, raw_receipt],
    )
    .unwrap();
    db.execute(
        "INSERT INTO search_state VALUES('derived-index','discard-me')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO search_sessions VALUES('old-cursor','old-store','query',0,9999999999,'[]')",
        [],
    )
    .unwrap();
    let snapshot = Snapshot::open(&path, &source).unwrap();
    assert!(snapshot.report().counts["tasks"] >= 7);
    assert!(snapshot.report().counts["action_groups"] >= 2);
    assert!(snapshot.report().counts["search_state"] >= 1);
    assert_eq!(
        snapshot.report(),
        Snapshot::open(&path, &source).unwrap().report()
    );
    assert!(matches!(
        Snapshot::open(
            &path,
            &Source {
                identity: Uuid::new_v4(),
                ..source.clone()
            }
        ),
        Err(Error::SourceMismatch)
    ));
    assert!(matches!(
        Snapshot::open(
            &path,
            &Source {
                environment: "demo".into(),
                ..source.clone()
            }
        ),
        Err(Error::SourceMismatch)
    ));
    assert!(matches!(
        snapshot.import(&store, &principal("a")),
        Err(Error::ImportConflict)
    ));
    assert!(matches!(
        snapshot.import(&store, &principal("missing")),
        Err(Error::AccountUnavailable)
    ));

    // Simulate a failure after records/history are inserted but before the receipt
    // can commit. No state, high-water mark, or partial import survives.
    admin.batch_execute("CREATE FUNCTION gtd.reject_fixture_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic interrupted import'; END $$;
        CREATE TRIGGER fixture_reject BEFORE INSERT ON gtd.legacy_imports FOR EACH ROW EXECUTE FUNCTION gtd.reject_fixture_import();").unwrap();
    assert!(snapshot.import(&store, &principal("c")).is_err());
    store
        .read(&principal("c"), |tx| {
            assert_eq!(tx.high(), 0);
            for table in [
                "tasks",
                "changes",
                "requests",
                "revisions",
                "action_groups",
                "dependencies",
                "search_state",
                "legacy_imports",
            ] {
                assert_eq!(
                    tx.tx
                        .query_one(&format!("SELECT count(*) FROM gtd.{table}"), &[])?
                        .get::<_, i64>(0),
                    0
                );
            }
            Ok(())
        })
        .unwrap();
    admin.batch_execute("DROP TRIGGER fixture_reject ON gtd.legacy_imports; DROP FUNCTION gtd.reject_fixture_import();").unwrap();
    assert!(!snapshot.import(&store, &principal("c")).unwrap());
    assert!(snapshot.import(&store, &principal("c")).unwrap());
    store
        .read(&principal("c"), |tx| snapshot.verify_in(tx))
        .unwrap();
    store
        .read(&principal("c"), |tx| {
            assert_eq!(tx.high(), snapshot.report().high);
            assert_ne!(tx.identity(), source.identity);
            let receipt = tx.tx.query_one(
                "SELECT request,response FROM gtd.requests WHERE id='legacy-retry'",
                &[],
            )?;
            assert_eq!(receipt.get::<_, String>(0), raw_request);
            assert_eq!(receipt.get::<_, String>(1), raw_receipt);
            assert_eq!(
                tx.tx
                    .query_one(
                        "SELECT count(*) FROM gtd.tasks WHERE document::jsonb->>'deleted'='true'",
                        &[]
                    )?
                    .get::<_, i64>(0),
                1
            );
            assert_eq!(
                tx.tx
                    .query_one(
                        "SELECT count(*) FROM gtd.tasks WHERE series_id IS NOT NULL",
                        &[]
                    )?
                    .get::<_, i64>(0),
                2
            );
            assert_eq!(
                tx.tx
                    .query_one("SELECT count(*) FROM gtd.dependencies", &[])?
                    .get::<_, i64>(0),
                1
            );
            assert_eq!(
                tx.tx
                    .query_one("SELECT count(*) FROM gtd.search_sessions", &[])?
                    .get::<_, i64>(0),
                0
            );
            assert_eq!(
                tx.tx
                    .query_one(
                        "SELECT count(*) FROM gtd.search_state WHERE key='derived-index'",
                        &[]
                    )?
                    .get::<_, i64>(0),
                0
            );
            Ok(())
        })
        .unwrap();
    verify_sync(&store, &first.task, snapshot.report().counts["tasks"] - 1);
    // Replaying after subsequent writes cannot overwrite those writes.
    let later = store.execute(&principal("c"), crate::store::content::Policy::Agent, "test",
        WriteOperation::Update(input(json!({"request_id":"later-pg-edit","task_id":first.task.id,
            "expected_version":first.task.version+1,"title":"Edited after migration","reason":"Synthetic post-import edit"})))
    ).unwrap();
    let next = later["change"]["id"].as_i64().unwrap();
    // Retry the exact committed SQLite request after later PostgreSQL writes.
    let (old_request, old_receipt): (String, String) = db
        .query_row(
            "SELECT request,response FROM requests WHERE id='first'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let original_request: Value = serde_json::from_str(&old_request).unwrap();
    let mut expected: Value = serde_json::from_str(&old_receipt).unwrap();
    expected["replayed"] = json!(true);
    assert_eq!(
        store
            .execute(
                &principal("c"),
                crate::store::content::Policy::Agent,
                "test",
                WriteOperation::Capture(input(original_request[1].clone()))
            )
            .unwrap(),
        expected
    );
    assert_eq!(next, snapshot.report().high + 2);
    assert!(snapshot.import(&store, &principal("c")).unwrap());
    assert!(
        store
            .read(&principal("c"), |tx| snapshot.verify_in(tx))
            .is_err()
    );
    assert_eq!(
        store.read(&principal("c"), |tx| Ok(tx.high())).unwrap(),
        next
    );
    assert_eq!(
        store
            .read(&principal("b"), |tx| Ok(tx
                .tx
                .query_one("SELECT count(*) FROM gtd.tasks", &[])?
                .get::<_, i64>(0)))
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .read(&principal("b"), |tx| Ok(tx
                .tx
                .query_one("SELECT count(*) FROM gtd.legacy_imports", &[])?
                .get::<_, i64>(0)))
            .unwrap(),
        0
    );

    let old_undo: String = db
        .query_row(
            "SELECT response FROM requests WHERE id='undo-deleted'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let old_undo: crate::model::MutationResult = serde_json::from_str(&old_undo).unwrap();
    let restored=store.execute(&principal("c"),crate::store::content::Policy::Agent,"test",
        WriteOperation::Undo(input(json!({"request_id":"restore-imported-task","change_id":old_undo.change.id,
            "expected_version":old_undo.task.version,"reason":"Synthetic historical undo after import"})))
    ).unwrap();
    assert_eq!(restored["task"]["deleted"], false);
    assert_eq!(restored["task"]["title"], "Discarded capture");
    assert_eq!(restored["task"]["version"], old_undo.task.version + 1);

    // A changed source is not an idempotent retry. An uncommitted SQLite write
    // must not contaminate the snapshot; committed source changes must be seen.
    let write = db.transaction().unwrap();
    write
        .execute("INSERT INTO requests VALUES('later','request','{}')", [])
        .unwrap();
    assert_eq!(
        Snapshot::open(&path, &source).unwrap().report(),
        snapshot.report()
    );
    write.commit().unwrap();
    let changed = Snapshot::open(&path, &source).unwrap();
    assert_ne!(changed.report().digest, snapshot.report().digest);
    assert!(matches!(
        changed.import(&store, &principal("c")),
        Err(Error::ImportConflict)
    ));
    db.execute_batch("PRAGMA user_version=12").unwrap();
    assert!(matches!(
        Snapshot::open(&path, &source),
        Err(Error::LegacySource)
    ));
    // The rejected reader did not migrate the source back to an older version.
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        12
    );
}

fn verify_sync(store: &Store, original: &crate::model::Task, retained: usize) {
    use crate::model::SyncState;
    let read = |subject: &str, cursor: Option<String>, agent_context: bool, limit| {
        store.read(&principal(subject), |tx| {
            tx.read_sync_page(&SyncState {
                cursor,
                agent_context,
                limit: Some(limit),
            })
        })
    };
    let first = read("c", None, true, 100).unwrap();
    // A complete oversized record is returned alone, never omitted or summarized.
    assert_eq!(first["records"].as_array().unwrap().len(), 1);
    assert!(serde_json::to_vec(&first).unwrap().len() > crate::projection::PAGE_BYTES);
    assert_eq!(
        first["records"][0]["agent_notes"],
        "Synthetic project handoff."
    );
    assert_eq!(
        first["records"][0]["notes"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        9000
    );
    let cursor = first["next_cursor"].as_str().unwrap().to_string();
    assert!(matches!(
        read("b", Some(cursor.clone()), true, 100),
        Err(Error::ResetRequired)
    ));
    assert!(matches!(
        read("c", Some(cursor.clone()), false, 100),
        Err(Error::ResetRequired)
    ));
    assert!(matches!(read("c", None, true, 0), Err(Error::PageSize)));
    let ui = read("c", None, false, 100).unwrap();
    assert!(serde_json::to_vec(&ui).unwrap().len() < crate::projection::PAGE_BYTES);
    assert!(
        ui["records"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r.get("agent_notes").is_none() && r.get("notes").is_none())
    );

    let decoded = (0..cursor.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&cursor[i..i + 2], 16).unwrap())
        .collect::<Vec<_>>();
    let mut foreign: Value = serde_json::from_slice(&decoded).unwrap();
    foreign["environment"] = json!("production");
    let foreign: String = serde_json::to_vec(&foreign)
        .unwrap()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(matches!(
        read("c", Some(foreign), true, 100),
        Err(Error::ResetRequired)
    ));
    let legacy: String = b"{\"v\":1}".iter().map(|b| format!("{b:02x}")).collect();
    assert!(matches!(
        read("c", Some(legacy), true, 100),
        Err(Error::ResetRequired)
    ));

    // Exercise the native mutation path on imported data between snapshot pages.
    store.execute(&principal("c"), crate::store::content::Policy::Agent, "test",
        WriteOperation::Update(input(json!({
            "request_id":"sync-fixture", "task_id":original.id, "expected_version":original.version,
            "notes":"Changed after the first snapshot page", "agent_notes":"Updated synthetic handoff",
            "reason":"Synthetic sync fixture"
        })))
    ).unwrap();
    let at = first["evaluated_at"].clone();
    let mut page = first;
    let mut records = Vec::new();
    loop {
        assert_eq!(page["evaluated_at"], at);
        records.extend(page["records"].as_array().unwrap().clone());
        let Some(next) = page["next_cursor"].as_str() else {
            break;
        };
        page = read("c", Some(next.into()), true, 1).unwrap();
        assert!(
            records.len() <= retained,
            "pagination must progress without duplicates"
        );
    }
    assert_eq!(records.len(), retained);
    let old = records.iter().find(|r| r["id"] == original.id).unwrap();
    assert_eq!(old["agent_notes"], original.agent_notes);
    assert_eq!(old["notes"], original.notes);
    let delta = read(
        "c",
        Some(page["checkpoint"].as_str().unwrap().into()),
        true,
        100,
    )
    .unwrap();
    assert_eq!(delta["phase"], "changes");
    assert_eq!(delta["changes"].as_array().unwrap().len(), 1);
    assert_eq!(
        delta["changes"][0]["after"]["agent_notes"],
        "Updated synthetic handoff"
    );
    assert_eq!(delta["changes"][0]["transaction_end"], true);
    let empty = read(
        "c",
        Some(delta["checkpoint"].as_str().unwrap().into()),
        true,
        100,
    )
    .unwrap();
    assert_eq!(empty["complete"], true);
    assert_eq!(empty["changes"], json!([]));
}
