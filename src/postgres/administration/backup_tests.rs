//! The lifecycle lock spans provider I/O and journal commits without consuming
//! the task pool. These are deterministic local database checks, not host tests.
use super::*;
use crate::postgres::{
    Environment,
    tests::{fixture, principal},
};

#[test]
#[ignore = "Manual deterministic backup coordination test; disposable PostgreSQL, no live models"]
fn backup_gate_spans_journal_commits_without_blocking_tasks_or_leaking_pool_state() {
    let (_container, mut operator, config, a, _) = fixture();
    operator
        .execute(
            "UPDATE gtd.accounts SET administrator=true WHERE id=$1",
            &[&a],
        )
        .unwrap();
    // A single task connection must remain sufficient while provider I/O runs.
    let store = Store::connect(config, Environment::Staging, 1).unwrap();
    let p = principal("a");
    let identity = WebsiteIdentity::from_verified_session(&p, chrono::Utc::now().timestamp());
    let op = store
        .begin_administration(
            &identity,
            Uuid::new_v4(),
            Command::Invite {
                username: "backup-fixture".into(),
                display_name: None,
            },
        )
        .unwrap();
    operator
        .batch_execute("SELECT pg_advisory_lock(214716023,1)")
        .unwrap();
    assert!(matches!(store.provisioning_session(), Err(Error::Busy)));
    assert_eq!(store.read(&p, |tx| Ok(tx.account().id())).unwrap(), a);
    operator
        .batch_execute("SELECT pg_advisory_unlock(214716023,1)")
        .unwrap();

    let mut lifecycle = store.provisioning_session().unwrap();
    let work = lifecycle.claim(&identity, op.id).unwrap();
    let attempt = work.operation.attempt.unwrap();
    // The first journal transaction has committed. The lock must still exist
    // throughout provider calls and subsequent bind/complete transactions.
    assert!(
        !operator
            .query_one("SELECT pg_try_advisory_lock(214716023,1)", &[])
            .unwrap()
            .get::<_, bool>(0)
    );
    assert!(matches!(store.provisioning_session(), Err(Error::Busy)));
    store
        .write(&p, |tx| {
            assert_eq!(tx.account().id(), a);
            Ok(())
        })
        .unwrap();
    lifecycle
        .bind(&identity, op.id, attempt, "backup-fixture-subject")
        .unwrap();
    lifecycle.complete(&identity, op.id, attempt).unwrap();
    assert!(
        !operator
            .query_one("SELECT pg_try_advisory_lock(214716023,1)", &[])
            .unwrap()
            .get::<_, bool>(0)
    );
    drop(lifecycle);
    assert!(
        operator
            .query_one("SELECT pg_try_advisory_lock(214716023,1)", &[])
            .unwrap()
            .get::<_, bool>(0)
    );
    // Pool reuse did not inherit the provider session lock.
    store.read(&p, |_| Ok(())).unwrap();
    operator
        .batch_execute("SELECT pg_advisory_unlock(214716023,1)")
        .unwrap();

    // An early-returning failure closes its connection as well.
    let mut failed = store.provisioning_session().unwrap();
    assert!(failed.claim(&identity, Uuid::new_v4()).is_err());
    drop(failed);
    assert!(
        operator
            .query_one("SELECT pg_try_advisory_lock(214716023,1)", &[])
            .unwrap()
            .get::<_, bool>(0)
    );
}
