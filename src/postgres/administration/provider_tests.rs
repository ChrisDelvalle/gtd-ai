//! Real database and HTTP client; the loopback provider models response loss
//! after commit. Actual pinned-Keycloak acceptance is recorded separately.
use super::*;
use crate::{
    identity::provisioning::{self, Provisioner, keycloak::Keycloak},
    postgres::{
        Environment,
        tests::{ISSUER, fixture, principal},
    },
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

#[derive(Default)]
struct State {
    users: HashMap<String, Value>,
    password_hashes: HashMap<String, String>,
    requests: Vec<(String, String)>,
    fail_after_write: bool,
    corrupt_verification: bool,
}
struct Mock {
    address: String,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(&self.address);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
impl Mock {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let state = Arc::new(Mutex::new(State::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let child_state = state.clone();
        let child_stop = stop.clone();
        let worker = thread::spawn(move || {
            for socket in listener.incoming() {
                if child_stop.load(Ordering::Relaxed) {
                    break;
                }
                let mut socket = socket.unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let parts: Vec<_> = line.split_whitespace().map(str::to_owned).collect();
                let method = parts[0].clone();
                let path = parts[1].clone();
                let mut length = 0;
                let mut authorized = false;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse::<usize>().unwrap();
                        }
                        if name.eq_ignore_ascii_case("authorization") {
                            authorized = value.trim() == "Bearer fixture-service-token";
                        }
                    }
                }
                assert!(length < 64 * 1024);
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                drop(reader);
                let url = url::Url::parse(&format!("http://fixture{path}")).unwrap();
                let mut state = child_state.lock().unwrap();
                state.requests.push((method.clone(), url.path().into()));
                let (status, value) = if url.path() == "/realms/gtd/protocol/openid-connect/token" {
                    (
                        200,
                        json!({"access_token":"fixture-service-token","expires_in":60,"token_type":"Bearer"}),
                    )
                } else if !authorized {
                    (401, json!({}))
                } else {
                    route(&mut state, &method, &url, &bytes)
                };
                let body = serde_json::to_vec(&value).unwrap();
                let reason = if status == 204 {
                    "No Content"
                } else {
                    "Fixture"
                };
                if status == 204 {
                    write!(
                        socket,
                        "HTTP/1.1 204 {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .unwrap();
                } else {
                    write!(socket,"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                    socket.write_all(&body).unwrap();
                }
            }
        });
        Self {
            address,
            state,
            stop,
            worker: Some(worker),
        }
    }
    fn client(&self) -> Keycloak {
        Keycloak::new(
            &format!("http://{}/", self.address),
            ISSUER,
            "gtd",
            "fixture-admin",
            "fixture-secret".into(),
            vec!["gtd-web".into(), "gtd-chatgpt".into(), "gtd-claude".into()],
        )
        .unwrap()
    }
}
fn route(state: &mut State, method: &str, url: &url::Url, bytes: &[u8]) -> (u16, Value) {
    let path = url.path().strip_prefix("/admin/realms/gtd/users").unwrap();
    if path.is_empty() {
        if method == "GET" {
            let name = url
                .query_pairs()
                .find(|(k, _)| k == "username")
                .unwrap()
                .1
                .into_owned();
            return (
                200,
                json!(
                    state
                        .users
                        .values()
                        .filter(|u| u["username"] == name)
                        .collect::<Vec<_>>()
                ),
            );
        }
        let mut user: Value = serde_json::from_slice(bytes).unwrap();
        if state
            .users
            .values()
            .any(|u| u["username"] == user["username"])
        {
            return (409, json!({}));
        }
        let id = Uuid::new_v4().to_string();
        user["id"] = json!(id);
        user["requiredActions"] = json!([]);
        state.users.insert(id, user);
        return (201, json!({}));
    }
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let id = parts[0];
    if parts.len() > 1 {
        return (if parts[1] == "logout" { 204 } else { 404 }, json!({}));
    }
    let Some(user) = state.users.get_mut(id) else {
        return (404, json!({}));
    };
    if method == "GET" {
        return (200, user.clone());
    }
    let mut update: Value = serde_json::from_slice(bytes).unwrap();
    if let Some(credentials) = update.as_object_mut().unwrap().remove("credentials") {
        assert_eq!(credentials[0]["temporary"], true);
        state.password_hashes.insert(
            id.into(),
            format!(
                "{:x}",
                Sha256::digest(credentials[0]["value"].as_str().unwrap().as_bytes())
            ),
        );
    }
    user.as_object_mut()
        .unwrap()
        .extend(update.as_object().unwrap().clone());
    if state.corrupt_verification {
        user["attributes"]["gtd_generation"] = json!([Uuid::new_v4().to_string()]);
    }
    if std::mem::take(&mut state.fail_after_write) {
        return (503, json!({}));
    }
    (204, json!({}))
}

#[test]
#[ignore = "Manual deterministic provisioning test; disposable PostgreSQL and loopback HTTP, no live models"]
fn provider_response_loss_recovers_without_duplicates_or_credential_replay() {
    let (_container, mut database, config, a, _) = fixture();
    database
        .execute(
            "UPDATE gtd.accounts SET administrator=true WHERE id=$1",
            &[&a],
        )
        .unwrap();
    let store = Store::connect(config, Environment::Staging, 2).unwrap();
    let p = principal("a");
    let identity = WebsiteIdentity::from_verified_session(&p, chrono::Utc::now().timestamp());
    let mock = Mock::start();
    let runner = Provisioner::new(store.clone(), mock.client());
    let op = store
        .begin_administration(
            &identity,
            Uuid::new_v4(),
            Command::Invite {
                username: "guest".into(),
                display_name: None,
            },
        )
        .unwrap();
    mock.state.lock().unwrap().fail_after_write = true;
    assert!(matches!(
        runner.resume(&identity, op.id),
        Err(provisioning::Error::ProviderUnavailable)
    ));
    let old_generation = database
        .query_one(
            "SELECT credential_generation FROM gtd.accounts WHERE id=$1",
            &[&op.target_id],
        )
        .unwrap()
        .get::<_, Uuid>(0);
    assert!(
        !database
            .query_one(
                "SELECT enabled FROM gtd.accounts WHERE id=$1",
                &[&op.target_id]
            )
            .unwrap()
            .get::<_, bool>(0)
    );
    assert!(matches!(
        runner.resume(&identity, op.id),
        Err(provisioning::Error::Administration(Error::Busy))
    ));
    database
        .execute(
            "UPDATE gtd.admin_operations SET lease_until=now()-interval '1 second' WHERE id=$1",
            &[&op.id],
        )
        .unwrap();
    let result = runner.resume(&identity, op.id).unwrap();
    assert_eq!(result.operation.state, OperationState::Complete);
    assert_ne!(result.operation.attempt, Some(old_generation));
    let password = result.temporary_password.unwrap().expose_once();
    let requests = mock.state.lock().unwrap().requests.len();
    let replay = runner.resume(&identity, op.id).unwrap();
    assert!(replay.temporary_password.is_none());
    assert_eq!(replay.operation.id, op.id);
    let state = mock.state.lock().unwrap();
    assert_eq!(state.requests.len(), requests);
    assert_eq!(state.users.len(), 1);
    let (subject, user) = state.users.iter().next().unwrap();
    assert_eq!(
        state.password_hashes[subject],
        format!("{:x}", Sha256::digest(password.as_bytes()))
    );
    assert_eq!(user["requiredActions"], json!(["UPDATE_PASSWORD"]));
    assert!(
        state
            .requests
            .iter()
            .any(|(method, path)| method == "POST" && path.ends_with("/logout"))
    );
    for client in ["gtd-web", "gtd-chatgpt", "gtd-claude"] {
        assert!(
            state
                .requests
                .iter()
                .any(|(method, path)| method == "DELETE"
                    && path.ends_with(&format!("/consents/{client}")))
        );
    }
    let current = Principal::verified_session(
        ISSUER.into(),
        subject.clone(),
        result.operation.attempt,
        Some(chrono::Utc::now().timestamp() + 2),
    );
    drop(state);
    assert_eq!(
        store.read(&current, |tx| Ok(tx.account().id())).unwrap(),
        op.target_id
    );
    let journal = database
        .query_one(
            "SELECT jsonb_agg(to_jsonb(o))::text FROM gtd.admin_operations o",
            &[],
        )
        .unwrap()
        .get::<_, String>(0);
    assert!(!journal.contains(&password));
    // Another identity with the same username cannot be adopted into GTD.
    let foreign = store
        .begin_administration(
            &identity,
            Uuid::new_v4(),
            Command::Invite {
                username: "occupied".into(),
                display_name: None,
            },
        )
        .unwrap();
    mock.state.lock().unwrap().users.insert("foreign-subject".into(),json!({"id":"foreign-subject","username":"occupied","attributes":{"gtd_account_id":[Uuid::new_v4().to_string()]}}));
    assert!(matches!(
        runner.resume(&identity, foreign.id),
        Err(provisioning::Error::IdentityConflict)
    ));
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM gtd.accounts WHERE id=$1",
                &[&foreign.target_id]
            )
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    // A successful HTTP update without the required state never enables access.
    let corrupt = store
        .begin_administration(
            &identity,
            Uuid::new_v4(),
            Command::Invite {
                username: "corrupt".into(),
                display_name: None,
            },
        )
        .unwrap();
    mock.state.lock().unwrap().corrupt_verification = true;
    assert!(matches!(
        runner.resume(&identity, corrupt.id),
        Err(provisioning::Error::Verification)
    ));
    assert!(
        !database
            .query_one(
                "SELECT enabled FROM gtd.accounts WHERE id=$1",
                &[&corrupt.target_id]
            )
            .unwrap()
            .get::<_, bool>(0)
    );
}
