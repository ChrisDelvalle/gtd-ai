use super::*;
use crate::postgres::{
    Environment,
    tests::{ISSUER, fixture, principal},
};

fn recent(principal: &Principal) -> WebsiteIdentity<'_> {
    WebsiteIdentity::from_verified_session(principal, chrono::Utc::now().timestamp())
}

fn session(issuer: String, subject: String, generation: Option<Uuid>) -> Principal {
    Principal::verified_session(
        issuer,
        subject,
        generation,
        Some(chrono::Utc::now().timestamp() + 2),
    )
}

fn invite(name: &str) -> Command {
    Command::Invite {
        username: name.into(),
        display_name: Some("Fixture user".into()),
    }
}
fn enroll(store: &Store, identity: &WebsiteIdentity<'_>, name: &str) -> (Operation, Principal) {
    let op = store
        .begin_administration(identity, Uuid::new_v4(), invite(name))
        .unwrap();
    let work = store.claim_administration(identity, op.id).unwrap();
    let attempt = work.operation.attempt.unwrap();
    store
        .bind_invitation(identity, op.id, attempt, name)
        .unwrap();
    store
        .complete_administration(identity, op.id, attempt)
        .unwrap();
    (op, session(ISSUER.into(), name.into(), Some(attempt)))
}
fn assert_unavailable(store: &Store, principal: &Principal) {
    assert!(matches!(
        store.read(principal, |_| Ok(())),
        Err(crate::postgres::Error::AccountUnavailable)
    ));
}

#[test]
#[ignore = "Manual deterministic PostgreSQL test; disposable Docker only, no live models"]
fn invitations_require_admin_recent_auth_and_bound_identity() {
    let (_container, mut database, config, a, _b) = fixture();
    let store = Store::connect(config.clone(), Environment::Staging, 2).unwrap();
    let pa = principal("a");
    let pb = principal("b");
    assert_eq!(
        store
            .begin_administration(&recent(&pa), Uuid::new_v4(), invite("guest"))
            .unwrap_err(),
        Error::Forbidden
    );
    database
        .execute(
            "UPDATE gtd.accounts SET administrator=true WHERE id=$1",
            &[&a],
        )
        .unwrap();
    let identity = recent(&pa);
    for timestamp in [
        chrono::Utc::now().timestamp() - 301,
        chrono::Utc::now().timestamp() + 60,
    ] {
        let expired = WebsiteIdentity::from_verified_session(&pa, timestamp);
        assert_eq!(
            store
                .begin_administration(&expired, Uuid::new_v4(), invite("guest"))
                .unwrap_err(),
            Error::Reauthentication
        );
    }
    assert_eq!(
        store.list_accounts(&recent(&pb), None, 20).unwrap_err(),
        Error::Forbidden
    );
    for name in ["", "Uppercase", "space name", "-bad", "has\nnewline"] {
        assert_eq!(
            store
                .begin_administration(&identity, Uuid::new_v4(), invite(name))
                .unwrap_err(),
            Error::InvalidRequest
        );
    }
    assert_eq!(
        store
            .begin_administration(&identity, Uuid::new_v4(), invite("a"))
            .unwrap_err(),
        Error::UsernameUnavailable
    );
    let request = Uuid::new_v4();
    let op = store
        .begin_administration(&identity, request, invite("guest"))
        .unwrap();
    let stale_identity =
        WebsiteIdentity::from_verified_session(&pa, chrono::Utc::now().timestamp() - 600);
    assert_eq!(
        store
            .administration_request(&stale_identity, request)
            .unwrap()
            .unwrap()
            .id,
        op.id
    );
    assert_eq!(
        store
            .administration_operation(&stale_identity, op.id)
            .unwrap()
            .unwrap()
            .state,
        OperationState::Pending
    );
    assert!(
        store
            .administration_request(&identity, Uuid::new_v4())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .administration_request(&recent(&pb), request)
            .unwrap_err(),
        Error::Forbidden
    );
    assert_eq!(
        store
            .administration_operation(&recent(&pb), op.id)
            .unwrap_err(),
        Error::Forbidden
    );
    database
        .execute(
            "UPDATE gtd.accounts SET administrator=true WHERE subject='b'",
            &[],
        )
        .unwrap();
    assert!(
        store
            .administration_request(&recent(&pb), request)
            .unwrap()
            .is_none()
    );
    database
        .execute(
            "UPDATE gtd.accounts SET administrator=false WHERE subject='b'",
            &[],
        )
        .unwrap();
    // Inspection never claims a lease, appends another event, or contacts the provider.
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM gtd.admin_events WHERE operation_id=$1",
                &[&op.id]
            )
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    let retry = store
        .begin_administration(&identity, request, invite("guest"))
        .unwrap();
    assert_eq!(op.id, retry.id);
    assert_eq!(op.target_id, retry.target_id);
    assert_eq!(
        store
            .begin_administration(&identity, request, invite("other"))
            .unwrap_err(),
        Error::RequestConflict
    );
    assert_eq!(
        store
            .begin_administration(&identity, Uuid::new_v4(), invite("guest"))
            .unwrap_err(),
        Error::UsernameUnavailable
    );
    assert!(store.claim_administration(&recent(&pb), op.id).is_err());
    let work = store.claim_administration(&identity, op.id).unwrap();
    assert_eq!(
        store
            .begin_administration(
                &identity,
                Uuid::new_v4(),
                Command::Regenerate {
                    target_id: op.target_id
                }
            )
            .unwrap_err(),
        Error::Pending
    );
    let attempt = work.operation.attempt.unwrap();
    assert_eq!(work.username.as_deref(), Some("guest"));
    assert!(work.subject.is_none());
    assert!(matches!(
        store.claim_administration(&identity, op.id),
        Err(Error::Busy)
    ));
    assert_eq!(
        store
            .complete_administration(&identity, op.id, attempt)
            .unwrap_err(),
        Error::Expired
    );
    store
        .bind_invitation(&identity, op.id, attempt, "provider-subject")
        .unwrap();
    store
        .bind_invitation(&identity, op.id, attempt, "provider-subject")
        .unwrap();
    assert_eq!(
        store
            .bind_invitation(&identity, op.id, attempt, "different-subject")
            .unwrap_err(),
        Error::IdentityConflict
    );
    let pg = session(ISSUER.into(), "provider-subject".into(), Some(attempt));
    assert_unavailable(&store, &pg); // Provider bind is not an access grant.
    store
        .complete_administration(&identity, op.id, attempt)
        .unwrap();
    let foreign_id = Uuid::new_v4();
    database.execute("INSERT INTO gtd.accounts(id,issuer,subject,username,administrator,enabled,enrollment) VALUES($1,'https://other.invalid/realm','foreign','foreign',true,true,'active')", &[&foreign_id]).unwrap();
    let foreign_principal = Principal::verified_session(
        "https://other.invalid/realm".into(),
        "foreign".into(),
        None,
        Some(chrono::Utc::now().timestamp()),
    );
    assert!(
        store
            .administration_operation(&recent(&foreign_principal), op.id)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        store.claim_administration(&recent(&foreign_principal), op.id),
        Err(Error::TargetUnavailable)
    ));
    assert_unavailable(&store, &principal("provider-subject"));
    assert_unavailable(
        &store,
        &session(ISSUER.into(), "guest".into(), Some(attempt)),
    );
    assert_unavailable(
        &store,
        &session(
            ISSUER.into(),
            "provider-subject".into(),
            Some(Uuid::new_v4()),
        ),
    );
    let actual = store
        .read(&pg, |tx| {
            assert!(!tx.account().administrator());
            assert_eq!(
                tx.tx
                    .query_one("SELECT count(*) FROM gtd.tasks", &[])?
                    .get::<_, i64>(0),
                0
            );
            Ok(tx.account().id())
        })
        .unwrap();
    assert_eq!(actual, op.target_id);
    assert_eq!(store.read(&pg, |tx| Ok(tx.account().id())).unwrap(), actual);
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM gtd.admin_events WHERE target_id=$1 AND event='activated'",
                &[&actual]
            )
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    assert_eq!(
        store
            .begin_administration(&identity, request, invite("guest"))
            .unwrap()
            .state,
        OperationState::Complete
    );
    let users = store.list_accounts(&identity, None, 100).unwrap();
    assert_eq!(users.as_array().unwrap().len(), 3);
    assert_eq!(
        users
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["id"] == actual.to_string())
            .unwrap()["state"],
        "active"
    );
    let page = store.list_accounts(&identity, None, 1).unwrap();
    let after = Uuid::parse_str(page[0]["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        store
            .list_accounts(&identity, Some(after), 100)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // Runtime credentials cannot bypass the API through tables or helper functions.
    let mut runtime = config.connect(postgres::NoTls).unwrap();
    for query in [
        "SELECT * FROM gtd.accounts",
        "SELECT * FROM gtd.invitations",
        "SELECT * FROM gtd.admin_operations",
        "SELECT * FROM gtd.admin_events",
        "SELECT gtd.admin_result(gen_random_uuid())",
        "SELECT gtd.admin_lock()",
    ] {
        assert!(
            runtime.query(query, &[]).is_err(),
            "Runtime privilege leak: {query}"
        );
    }
    assert!(runtime.query_one("SELECT gtd.admin_begin($1::text::jsonb,$2,'{\"action\":\"invite\",\"username\":\"rogue\",\"administrator\":true}'::jsonb)",
        &[&identity.context(),&Uuid::new_v4()]).is_err());
    let journal: String = database
        .query_one(
            "SELECT jsonb_agg(to_jsonb(o))::text FROM gtd.admin_operations o",
            &[],
        )
        .unwrap()
        .get(0);
    assert!(!journal.contains("password"));
    assert!(!journal.contains("access_token"));
    assert!(
        database
            .execute("DELETE FROM gtd.admin_events", &[])
            .is_err()
    );
    let no_admin_tool = store.execute_tool(&pa, "admin_begin", json!({}));
    assert!(no_admin_tool.is_err());
}

#[test]
#[ignore = "Manual deterministic PostgreSQL test; disposable Docker only, no live models"]
fn expired_revoked_and_interrupted_operations_never_grant_access() {
    let (_container, mut database, config, a, _) = fixture();
    database
        .execute(
            "UPDATE gtd.accounts SET administrator=true WHERE id=$1",
            &[&a],
        )
        .unwrap();
    let store = Store::connect(config, Environment::Staging, 2).unwrap();
    let pa = principal("a");
    let identity = recent(&pa);
    let (op, old) = enroll(&store, &identity, "expired-guest");
    database.execute("UPDATE gtd.invitations SET created_at=now()-interval '8 days',expires_at=now()-interval '1 day' WHERE id=$1",&[&op.target_id]).unwrap();
    assert_unavailable(&store, &old);
    let users = store.list_accounts(&identity, None, 100).unwrap();
    assert_eq!(
        users
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["id"] == op.target_id.to_string())
            .unwrap()["state"],
        "expired"
    );
    let regen = store
        .begin_administration(
            &identity,
            Uuid::new_v4(),
            Command::Regenerate {
                target_id: op.target_id,
            },
        )
        .unwrap();
    let first = store.claim_administration(&identity, regen.id).unwrap();
    let first_attempt = first.operation.attempt.unwrap();
    // Process dies after sending credentials. Recovered attempt fences the old one.
    database
        .execute(
            "UPDATE gtd.admin_operations SET lease_until=now()-interval '1 second' WHERE id=$1",
            &[&regen.id],
        )
        .unwrap();
    let second = store.claim_administration(&identity, regen.id).unwrap();
    let second_attempt = second.operation.attempt.unwrap();
    assert_ne!(first_attempt, second_attempt);
    assert_eq!(
        store
            .complete_administration(&identity, regen.id, first_attempt)
            .unwrap_err(),
        Error::StaleAttempt
    );
    store
        .complete_administration(&identity, regen.id, second_attempt)
        .unwrap();
    assert_unavailable(&store, &old);
    assert_unavailable(
        &store,
        &session(ISSUER.into(), "expired-guest".into(), Some(first_attempt)),
    );
    let current = session(ISSUER.into(), "expired-guest".into(), Some(second_attempt));
    // Revocation before the first login is immediate, even during a provider outage.
    let revoke = store
        .begin_administration(
            &identity,
            Uuid::new_v4(),
            Command::Revoke {
                target_id: op.target_id,
            },
        )
        .unwrap();
    assert_unavailable(&store, &current);
    let work = store.claim_administration(&identity, revoke.id).unwrap();
    store
        .complete_administration(&identity, revoke.id, work.operation.attempt.unwrap())
        .unwrap();
    assert_eq!(
        store
            .begin_administration(
                &identity,
                Uuid::new_v4(),
                Command::Regenerate {
                    target_id: op.target_id
                }
            )
            .unwrap_err(),
        Error::TargetUnavailable
    );

    // Revocation can cancel an outstanding create before its provider response.
    let pending = store
        .begin_administration(&identity, Uuid::new_v4(), invite("pending-guest"))
        .unwrap();
    let work = store.claim_administration(&identity, pending.id).unwrap();
    store
        .begin_administration(
            &identity,
            Uuid::new_v4(),
            Command::Revoke {
                target_id: pending.target_id,
            },
        )
        .unwrap();
    assert_eq!(
        store
            .bind_invitation(
                &identity,
                pending.id,
                work.operation.attempt.unwrap(),
                "late-provider-user"
            )
            .unwrap_err(),
        Error::StaleAttempt
    );
    assert_eq!(
        store
            .claim_administration(&identity, pending.id)
            .unwrap()
            .operation
            .state,
        OperationState::Cancelled
    );
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM gtd.accounts WHERE id=$1",
                &[&pending.target_id]
            )
            .unwrap()
            .get::<_, i64>(0),
        0
    );
}

#[test]
#[ignore = "Manual deterministic PostgreSQL test; disposable Docker only, no live models"]
fn resets_disable_old_credentials_and_protect_last_administrator() {
    let (_container, mut database, config, a, b) = fixture();
    database
        .execute(
            "UPDATE gtd.accounts SET administrator=true WHERE id=$1",
            &[&a],
        )
        .unwrap();
    let store = Store::connect(config.clone(), Environment::Staging, 2).unwrap();
    let pa = principal("a");
    let identity = recent(&pa);
    for command in [
        Command::Disable { target_id: a },
        Command::ResetPassword { target_id: a },
    ] {
        assert_eq!(
            store
                .begin_administration(&identity, Uuid::new_v4(), command)
                .unwrap_err(),
            Error::OwnAccount
        );
        assert!(store.read(&pa, |_| Ok(())).is_ok());
    }
    assert!(
        database
            .execute(
                "UPDATE gtd.accounts SET administrator=false WHERE id=$1",
                &[&a]
            )
            .is_err()
    );
    let (op, user) = enroll(&store, &identity, "active-guest");
    store.read(&user, |_| Ok(())).unwrap();
    let reset = store
        .begin_administration(
            &identity,
            Uuid::new_v4(),
            Command::ResetPassword {
                target_id: op.target_id,
            },
        )
        .unwrap();
    assert_unavailable(&store, &user);
    let work = store.claim_administration(&identity, reset.id).unwrap();
    let generation = work.operation.attempt.unwrap();
    let updated = session(ISSUER.into(), "active-guest".into(), Some(generation));
    assert_unavailable(&store, &updated);
    store
        .complete_administration(&identity, reset.id, generation)
        .unwrap();
    assert_unavailable(&store, &user);
    store.read(&updated, |_| Ok(())).unwrap();
    // Refreshing an old provider grant can pick up the new user attribute, but
    // its original authentication time must still be refused after a reset.
    let old_grant = Principal::verified_session(
        ISSUER.into(),
        "active-guest".into(),
        Some(generation),
        Some(chrono::Utc::now().timestamp() - 60),
    );
    assert_unavailable(&store, &old_grant);
    assert_unavailable(
        &store,
        &Principal::verified_token(ISSUER.into(), "active-guest".into(), Some(generation)),
    );
    let disable = store
        .begin_administration(
            &identity,
            Uuid::new_v4(),
            Command::Disable {
                target_id: op.target_id,
            },
        )
        .unwrap();
    assert_unavailable(&store, &updated);
    let work = store.claim_administration(&identity, disable.id).unwrap();
    store
        .complete_administration(&identity, disable.id, work.operation.attempt.unwrap())
        .unwrap();
    assert_unavailable(&store, &updated);
    assert_eq!(
        store
            .begin_administration(
                &identity,
                Uuid::new_v4(),
                Command::ResetPassword {
                    target_id: op.target_id
                }
            )
            .unwrap_err(),
        Error::TargetUnavailable
    );
    assert_unavailable(&store, &updated);
    // Two simultaneous administrators cannot each disable the other and leave zero.
    database
        .execute(
            "UPDATE gtd.accounts SET administrator=true WHERE id=$1",
            &[&b],
        )
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles = [("a", b), ("b", a)].map(|(actor, target)| {
        let store = store.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let p = principal(actor);
            barrier.wait();
            store.begin_administration(
                &recent(&p),
                Uuid::new_v4(),
                Command::Disable { target_id: target },
            )
        })
    });
    let results = handles.map(|h| h.join().unwrap());
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(database.query_one("SELECT count(*) FROM gtd.accounts WHERE administrator AND enabled AND enrollment='active'",&[]).unwrap().get::<_,i64>(0),1);
}
