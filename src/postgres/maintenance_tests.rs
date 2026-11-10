use super::{
    tests::{fixture, principal},
    write_tests::{capture, high, input, run, task},
    *,
};
use crate::{
    model::{Change, Status},
    recurrence_model::Series,
};
use serde_json::{Value, json};

#[test]
#[ignore = "Manual deterministic account maintenance check; disposable Docker, no production or models"]
fn calendar_zone_is_pinned_and_catchup_is_bounded_and_account_local() {
    let (_container, mut admin, runtime, _a, b) = fixture();
    admin
        .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
        .unwrap();
    let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
    store
        .set_account_timezone(&principal("a"), "America/New_York", "Pacific/Kiritimati")
        .unwrap();
    let today = crate::clock::now()
        .with_timezone(&chrono_tz::Pacific::Kiritimati)
        .date_naive();
    let start = (today - chrono::Days::new(204)).to_string();
    let defaults = json!({"title":"Catch-up fixture","brief":"Complete the fixture.","agent_notes":"Synthetic scheduled work.","importance":"normal","status":"next","estimated_minutes":5,"effort":"low"});
    let series = run(
        &store,
        "a",
        "recurrence",
        json!({"request_id":"backlog","rule":{"start_date":start,"frequency":"daily","count":205},"template":defaults,"reason":"Fixture"}),
    );
    assert_eq!(
        series.task.recurrence.as_ref().unwrap().timezone,
        "Pacific/Kiritimati"
    );
    let count = |subject: &str| {
        store.read(&principal(subject),|tx|Ok(tx.tx.query_one("SELECT count(*) FROM gtd.tasks WHERE account_id=$1 AND series_id IS NOT NULL",&[&tx.account.id])?.get::<_,i64>(0))).unwrap()
    };
    assert_eq!(count("a"), 100);
    // Move the account default more than a day earlier. Existing schedules must
    // still catch up through their own pinned calendar day.
    store
        .set_account_timezone(&principal("a"), "Pacific/Kiritimati", "Etc/GMT+12")
        .unwrap();
    let slice = store.maintain_account(&principal("a")).unwrap();
    assert_eq!(slice.materialized, 100);
    assert!(slice.budget_reached);
    assert_eq!(count("a"), 200);
    let other = run(&store, "b", "capture", capture("other-account"));
    assert_eq!(
        store
            .maintain_account(&principal("b"))
            .unwrap()
            .materialized,
        0
    );
    assert_eq!(task(&store, "b", &other.task.id), other.task);
    let final_slice = store.maintain_account(&principal("a")).unwrap();
    assert_eq!(final_slice.materialized, 5);
    assert!(!final_slice.budget_reached);
    assert_eq!(count("a"), 205);
    let settled = high(&store, "a");
    let idle = store.maintain_account(&principal("a")).unwrap();
    assert_eq!(idle.materialized, 0);
    assert_eq!(idle.changes, 0);
    assert_eq!(high(&store, "a"), settled);
    assert_eq!(
        task(&store, "a", &series.task.id)
            .recurrence
            .unwrap()
            .timezone,
        "Pacific/Kiritimati"
    );

    let fixed = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:30:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let mut legacy: Value = serde_json::to_value(series.task.recurrence.unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("timezone");
    let legacy: Series = input(legacy);
    assert_eq!(legacy.timezone, "America/New_York");
    assert_eq!(legacy.date_at(fixed).unwrap(), "2025-12-31");
    assert!(
        serde_json::to_value(&legacy)
            .unwrap()
            .get("timezone")
            .is_none()
    );
    let tokyo = Series {
        timezone: "Asia/Tokyo".into(),
        ..legacy.clone()
    };
    assert_eq!(tokyo.date_at(fixed).unwrap(), "2026-01-01");
    assert!(
        Series {
            timezone: "Invalid/Zone".into(),
            ..legacy
        }
        .date_at(fixed)
        .is_err()
    );

    // Seed a valid historical timed hold, captured before its availability date.
    // This simulates an offline service returning after the boundary without
    // changing the process clock or modifying an existing immutable revision.
    let mut held = other.task.clone();
    held.id = Uuid::new_v4().to_string();
    held.status = Status::Blocked;
    held.planning.not_before = Some(input(
        json!({"date":"2001-01-01","timezone":"America/New_York"}),
    ));
    held.created_at = "2000-01-01T00:00:00.000Z".into();
    held.updated_at = held.created_at.clone();
    store.write(&principal("b"),|tx| {
        held.last_change_id=tx.next_revision()?;
        let change=Change{id:held.last_change_id,task_id:held.id.clone(),entity_type:held.entity_type,operation:"capture".into(),reason:"Historical synthetic availability fixture".into(),before:None,after:held.clone(),undoes_change_id:None,created_at:held.created_at.clone(),origin:"test".into()};
        let doc=serde_json::to_string(&held)?;
        tx.tx.execute("INSERT INTO gtd.tasks(account_id,id,document) VALUES($1,$2,$3)",&[&b,&held.id,&doc])?;
        tx.tx.execute("INSERT INTO gtd.changes(account_id,id,task_id,document,entity_type,batch_id,token) VALUES($1,$2,$3,$4,'task','historical-timing-fixture',$5)",&[&b,&change.id,&held.id,&serde_json::to_string(&change)?,&Uuid::new_v4().to_string()])?;
        tx.tx.execute("INSERT INTO gtd.revisions(account_id,seq,entity_id,entity_type,document) VALUES($1,$2,$3,'task',$4)",&[&b,&change.id,&held.id,&doc])?;
        Ok(())
    }).unwrap();
    let before = high(&store, "b");
    let page = store
        .sync_state(
            &principal("b"),
            &crate::model::SyncState {
                agent_context: true,
                limit: Some(100),
                ..Default::default()
            },
        )
        .unwrap();
    let found = page["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == held.id)
        .unwrap();
    assert_eq!(found["status"], "next");
    assert_eq!(found["version"], 2);
    assert_eq!(high(&store, "b"), before + 1);
    store.settle_availability(&principal("b")).unwrap();
    store
        .home_view(
            &principal("b"),
            input(json!({"review_on":"2026-10-16","loading":"top-three"})),
        )
        .unwrap();
    store
        .list(&principal("b"), input(json!({"task_id":held.id})))
        .unwrap();
    store
        .projects(&principal("b"), input(json!({"limit":1})))
        .unwrap();
    assert_eq!(high(&store, "b"), before + 1);
    assert_eq!(high(&store, "a"), settled);
    admin
        .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&b])
        .unwrap();
    assert!(matches!(
        store.maintain_account(&principal("b")),
        Err(Error::AccountUnavailable)
    ));
}
