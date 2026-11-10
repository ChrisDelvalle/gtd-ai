use super::*;
use crate::postgres::{
    Environment,
    tests::{fixture, principal},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Barrier, mpsc},
    thread,
    time::Duration,
};

#[test]
#[ignore = "Manual deterministic session-storage test; disposable PostgreSQL only, no live models"]
fn login_binding_expiry_refresh_serialization_and_logout() {
    let (_container, mut database, config, a, _) = fixture();
    let store = Store::connect(config.clone(), Environment::Staging, 4).unwrap();
    let sessions = Sessions::new(store.clone());
    let login = CookieKey::random();
    let other = CookieKey::random();
    let state = "synthetic-state-with-more-than-32-characters";
    sessions
        .save_login(state, &login, &json!({"nonce":"fixture","pkce":"fixture"}))
        .unwrap();
    assert_eq!(
        sessions.consume_login::<Value>(state, &other).unwrap_err(),
        Error::Missing
    );
    assert_eq!(
        sessions.consume_login::<Value>(state, &login).unwrap()["nonce"],
        "fixture"
    );
    assert_eq!(
        sessions.consume_login::<Value>(state, &login).unwrap_err(),
        Error::Missing
    );
    sessions
        .save_login(state, &login, &json!({"nonce":"expired"}))
        .unwrap();
    database
        .execute(
            "UPDATE gtd.web_logins SET expires_at=now()-interval '1 second'",
            &[],
        )
        .unwrap();
    assert_eq!(
        sessions.consume_login::<Value>(state, &login).unwrap_err(),
        Error::Missing
    );
    let key = CookieKey::random();
    let remember = CookieKey::random();
    let now = chrono::Utc::now().timestamp();
    let expires = sessions
        .create(&key, &principal("a"), &json!({"rotation":0}), false)
        .unwrap();
    assert!((expires - now - 12 * 3600).abs() < 2);
    let long = sessions
        .create(&remember, &principal("b"), &json!({"rotation":0}), true)
        .unwrap();
    assert!((long - now - 30 * 24 * 3600).abs() < 2);
    let saved = sessions
        .with_session::<Value, _>(&key, |document, binding| {
            assert_eq!(binding.account_id, a);
            assert_eq!(binding.expires_at, expires);
            Ok((document, None))
        })
        .unwrap();
    assert_eq!(saved["rotation"], 0);
    assert!(CookieKey::parse("caller-account-id").is_err());
    let barrier = Arc::new(Barrier::new(3));
    let handles = [0, 1].map(|_| {
        let sessions = sessions.clone();
        let key = CookieKey::parse(key.value()).unwrap();
        let barrier = barrier.clone();
        thread::spawn(move || {
            barrier.wait();
            sessions
                .with_session::<Value, _>(&key, |mut doc, _| {
                    let old = doc["rotation"].as_i64().unwrap();
                    doc["rotation"] = json!(old + 1);
                    Ok((old, Some(doc)))
                })
                .unwrap()
        })
    });
    barrier.wait();
    let mut outcomes = handles.map(|h| h.join().unwrap());
    outcomes.sort();
    assert_eq!(outcomes, [0, 1]);
    sessions
        .with_session::<Value, _>(&key, |_, bound| {
            assert_eq!(bound.expires_at, expires);
            Ok(((), None))
        })
        .unwrap();
    // A logout waits for the row's in-flight refresh, then deletes it; no stale
    // save can recreate the session after the logout transaction commits.
    let (entered, wait) = mpsc::channel();
    let (finish, finished) = mpsc::channel();
    let active = sessions.clone();
    let active_key = CookieKey::parse(key.value()).unwrap();
    let refresh = thread::spawn(move || {
        active.with_session::<Value, _>(&active_key, |mut doc, _| {
            entered.send(()).unwrap();
            finished.recv_timeout(Duration::from_secs(5)).unwrap();
            doc["rotation"] = json!(3);
            Ok(((), Some(doc)))
        })
    });
    wait.recv_timeout(Duration::from_secs(5)).unwrap();
    let logout = sessions.clone();
    let logout_key = CookieKey::parse(key.value()).unwrap();
    let remove = thread::spawn(move || logout.delete::<Value>(&logout_key));
    finish.send(()).unwrap();
    refresh.join().unwrap().unwrap();
    assert!(remove.join().unwrap().unwrap().is_some());
    assert_eq!(
        sessions
            .with_session::<Value, _>(&key, |_, _| Ok(((), None)))
            .unwrap_err(),
        Error::Missing
    );
    let mut runtime = config.connect(postgres::NoTls).unwrap();
    assert!(
        runtime
            .query("SELECT * FROM gtd.web_sessions", &[])
            .is_err()
    );
    assert!(runtime.query("SELECT * FROM gtd.web_logins", &[]).is_err());
    assert!(
        !runtime
            .query_one("SELECT gtd.web_session_replace($1,'{}')", &[&key.hash()])
            .unwrap()
            .get::<_, bool>(0)
    );
    let foreign = sessions.create(
        &CookieKey::random(),
        &principal("uninvited"),
        &json!({}),
        false,
    );
    assert_eq!(foreign.unwrap_err(), Error::Missing);
    database
        .execute(
            "UPDATE gtd.web_sessions SET expires_at=now()-interval '1 second'",
            &[],
        )
        .unwrap();
    assert_eq!(
        sessions
            .with_session::<Value, _>(&remember, |_, _| Ok(((), None)))
            .unwrap_err(),
        Error::Missing
    );
    assert_eq!(sessions.cleanup().unwrap(), 1);
}
