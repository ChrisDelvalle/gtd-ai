//! Loopback-only deterministic Meilisearch protocol fixture, shared by storage tests.
#![allow(dead_code)]
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
#[derive(Default)]
pub struct Index {
    pub docs: BTreeMap<String, Value>,
    pub settings: Value,
}
#[derive(Clone)]
pub struct Task {
    method: String,
    pub path: String,
    pub body: Value,
    pub finished: Option<Value>,
}
#[derive(Default)]
pub struct State {
    pub indices: HashMap<String, Index>,
    pub tasks: HashMap<i64, Task>,
    pub next: i64,
    pub hold: bool,
    pub delay: Duration,
    pub searches: Vec<(usize, usize)>,
    pub stats_fence: Option<PathBuf>,
    pub search_bodies: Vec<Value>,
    pub override_hits: Option<Vec<Value>>,
    pub stats_callback: Option<Box<dyn FnOnce() + Send>>,
}
pub struct Mock {
    pub url: String,
    pub state: Arc<Mutex<State>>,
    pub stop: Arc<AtomicBool>,
    pub worker: Option<thread::JoinHandle<()>>,
}
impl Mock {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let shared = state.clone();
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // macOS may inherit the listener's nonblocking mode.
                        // Large request bodies arrive across multiple reads.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .unwrap();
                        let (method, path, body) = request(&mut stream);
                        let delay = if path.ends_with("/search") {
                            shared.lock().unwrap().delay
                        } else {
                            Duration::ZERO
                        };
                        thread::sleep(delay);
                        let (status, value) =
                            respond(&mut shared.lock().unwrap(), &method, &path, body);
                        let body = serde_json::to_vec(&value).unwrap();
                        let _ = write!(
                            stream,
                            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(&body);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        Self {
            url,
            state,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}
fn request(stream: &mut TcpStream) -> (String, String, Value) {
    let mut bytes = Vec::new();
    let boundary = loop {
        let mut chunk = [0; 4096];
        let n = stream.read(&mut chunk).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(position) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let header = String::from_utf8(bytes[..boundary].to_vec()).unwrap();
    let first: Vec<_> = header.lines().next().unwrap().split_whitespace().collect();
    let length = header
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|n| n.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < boundary + length {
        let mut chunk = [0; 4096];
        let n = stream.read(&mut chunk).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&chunk[..n]);
    }
    (
        first[0].into(),
        first[1].into(),
        if length == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&bytes[boundary..boundary + length]).unwrap()
        },
    )
}
fn respond(state: &mut State, method: &str, path: &str, body: Value) -> (u16, Value) {
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    if method == "GET" && parts[0] == "tasks" {
        let id: i64 = parts[1].parse().unwrap();
        let Some(task) = state.tasks.get(&id).cloned() else {
            return (404, json!({"code":"task_not_found"}));
        };
        if state.hold {
            return (200, json!({"status":"enqueued"}));
        }
        let result = if let Some(finished) = task.finished {
            finished
        } else {
            let p: Vec<_> = task.path.trim_matches('/').split('/').collect();
            let index = if p.len() == 1 {
                task.body["uid"].as_str().unwrap()
            } else {
                p[1]
            }
            .to_string();
            let failure = if task.method == "DELETE" {
                state.indices.remove(&index);
                None
            } else if p.len() == 1 {
                if let std::collections::hash_map::Entry::Vacant(e) = state.indices.entry(index) {
                    e.insert(Index::default());
                    None
                } else {
                    Some("index_already_exists")
                }
            } else if let Some(target) = state.indices.get_mut(&index) {
                if p[2] == "settings" {
                    target.settings = task.body;
                } else {
                    for doc in task.body.as_array().unwrap() {
                        target
                            .docs
                            .insert(doc["id"].as_str().unwrap().into(), doc.clone());
                    }
                }
                None
            } else {
                Some("index_not_found")
            };
            let result = failure
                .map(|code| json!({"status":"failed","error":{"code":code}}))
                .unwrap_or(json!({"status":"succeeded"}));
            state.tasks.get_mut(&id).unwrap().finished = Some(result.clone());
            result
        };
        return (200, result);
    }
    if method == "GET" && parts.len() == 2 {
        return if state.indices.contains_key(parts[1]) {
            (200, json!({"uid":parts[1]}))
        } else {
            (404, json!({"code":"index_not_found"}))
        };
    }
    if method == "GET" && parts.last() == Some(&"stats") {
        if let Some(callback) = state.stats_callback.take() {
            callback();
        }
        if let Some(path) = state.stats_fence.take() {
            Connection::open(path)
                .unwrap()
                .execute(
                    "UPDATE search_state SET value=?1 WHERE key='lease'",
                    [format!(
                        "{}:replacement-owner",
                        chrono::Utc::now().timestamp() + 30
                    )],
                )
                .unwrap();
        }
        return state
            .indices
            .get(parts[1])
            .map(|i| (200, json!({"numberOfDocuments":i.docs.len()})))
            .unwrap_or((404, json!({"code":"index_not_found"})));
    }
    if method == "POST" && parts.last() == Some(&"search") {
        let offset = body["offset"].as_u64().unwrap() as usize;
        let limit = body["limit"].as_u64().unwrap() as usize;
        state.searches.push((offset, limit));
        state.search_bodies.push(body.clone());
        let Some(index) = state.indices.get(parts[1]) else {
            return (404, json!({"code":"index_not_found"}));
        };
        if index.docs.values().any(|d| d.get("account_id").is_some()) {
            assert!(
                body["filter"]
                    .as_str()
                    .is_some_and(|v| v.starts_with("account_id = "))
            );
        }
        if let Some(hits) = &state.override_hits {
            return (200, json!({"hits":hits}));
        }
        let cap = index.settings["pagination"]["maxTotalHits"]
            .as_u64()
            .unwrap() as usize;
        let words: Vec<_> = body["q"].as_str().unwrap().split_whitespace().collect();
        let ids: Vec<_> = index
            .docs
            .values()
            .filter(|doc| {
                if let Some(account) = doc["account_id"].as_str()
                    && body["filter"].as_str() != Some(&format!("account_id = \"{account}\""))
                {
                    return false;
                }
                words
                    .iter()
                    .all(|word| doc.to_string().to_lowercase().contains(word))
            })
            .map(|doc| {
                let fields = body["attributesToRetrieve"].as_array().unwrap();
                Value::Object(
                    fields
                        .iter()
                        .map(|field| {
                            let key = field.as_str().unwrap();
                            (key.to_string(), doc[key].clone())
                        })
                        .collect(),
                )
            })
            .take(cap)
            .collect();
        return (
            200,
            json!({"hits":ids.into_iter().skip(offset).take(limit).collect::<Vec<_>>()}),
        );
    }
    state.next += 1;
    let id = state.next;
    state.tasks.insert(
        id,
        Task {
            method: method.into(),
            path: path.into(),
            body,
            finished: None,
        },
    );
    (202, json!({"taskUid":id}))
}
