//! Shared Meilisearch transport, projection and query contract. No database or
//! record-URL network access lives here. Callers supply only trusted index names.
use crate::{
    model::{Task, TaskLink},
    store::StoreError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
type Result<T> = std::result::Result<T, StoreError>;
pub(crate) const BUDGET: Duration = Duration::from_secs(4);
pub(crate) const LEASE_SECONDS: i64 = 30;
pub(crate) const GC_GRACE_SECONDS: i64 = 600;
pub(crate) const CHUNK: usize = 1000;
pub(crate) const CHUNK_BYTES: usize = 1024 * 1024;
pub(crate) const SEARCH_PAGE: usize = 1000;

pub(crate) fn key(q: &str, h: i64) -> String {
    format!("{:x}", Sha256::digest(format!("{h}:{q}")))
}
pub(crate) fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or(StoreError::SearchUnavailable)
}
/// Operator-owned configuration. Never accepted in a task/tool request.
/// No Debug implementation: search keys must not appear in diagnostics.
#[derive(Clone)]
pub struct SearchConfig {
    url: String,
    token: String,
}
impl SearchConfig {
    pub fn from_env() -> Result<Self> {
        let url = std::env::var("TODO_SEARCH_URL").map_err(|_| StoreError::SearchUnavailable)?;
        let token = std::fs::read_to_string(
            std::env::var("TODO_SEARCH_KEY_FILE").map_err(|_| StoreError::SearchUnavailable)?,
        )
        .map_err(|_| StoreError::SearchUnavailable)?;
        Self::new(url, token)
    }
    pub fn new(url: String, token: String) -> Result<Self> {
        let parsed = url::Url::parse(&url).map_err(|_| StoreError::SearchUnavailable)?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || token.trim().is_empty()
        {
            return Err(StoreError::SearchUnavailable);
        }
        Ok(Self {
            url: url.trim_end_matches('/').into(),
            token: token.trim().into(),
        })
    }
}
#[derive(Debug)]
pub(crate) enum RemoteError {
    Missing,
    Exists,
    Unavailable,
}
impl From<RemoteError> for StoreError {
    fn from(_: RemoteError) -> Self {
        Self::SearchUnavailable
    }
}
pub(crate) struct Engine {
    client: reqwest::blocking::Client,
    url: String,
    token: String,
    pub(crate) prefix: String,
    pub(crate) deadline: Instant,
}
impl Engine {
    pub(crate) fn new(config: &SearchConfig, prefix: String, deadline: Instant) -> Result<Self> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_millis(600))
                .build()
                .map_err(|_| StoreError::SearchUnavailable)?,
            url: config.url.clone(),
            token: config.token.clone(),
            prefix,
            deadline,
        })
    }
    pub(crate) fn index(&self, high: i64) -> String {
        format!("{}{high}", self.prefix)
    }
    pub(crate) fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> std::result::Result<Value, RemoteError> {
        let timeout = remaining(self.deadline).map_err(|_| RemoteError::Unavailable)?;
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.url))
            .bearer_auth(&self.token)
            .timeout(timeout);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().map_err(|_| RemoteError::Unavailable)?;
        let success = response.status().is_success();
        let value: Value = response.json().map_err(|_| RemoteError::Unavailable)?;
        remaining(self.deadline).map_err(|_| RemoteError::Unavailable)?;
        if success {
            return Ok(value);
        }
        Err(match value["code"].as_str() {
            Some("index_not_found" | "task_not_found") => RemoteError::Missing,
            Some("index_already_exists") => RemoteError::Exists,
            _ => RemoteError::Unavailable,
        })
    }
    pub(crate) fn submit(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> std::result::Result<i64, RemoteError> {
        self.request(method, path, body)?["taskUid"]
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or(RemoteError::Unavailable)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Published {
    pub(crate) high: i64,
    pub(crate) index: String,
    pub(crate) count: usize,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
pub(crate) enum Phase {
    Create,
    Settings,
    Documents,
    Publish,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Job {
    pub(crate) published: Published,
    pub(crate) phase: Phase,
    pub(crate) pending: Option<i64>,
    pub(crate) offset: usize,
    pub(crate) pending_count: usize,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Garbage {
    pub(crate) index: String,
    pub(crate) pending: i64,
}
fn searchable_url(link: &TaskLink) -> Vec<String> {
    let mut text = vec![link.url.clone()];
    // Charabia retains '=' inside words. Index decoded parameter values as well
    // so an event ID such as '?eid=reserved-block' can match 'reserved block'.
    // Keep the original URL, and retain the engine's standard tokenization rules.
    if let Ok(url) = url::Url::parse(&link.url) {
        text.extend(
            url.query_pairs()
                .map(|(_, value)| value.into_owned())
                .filter(|value| !value.is_empty()),
        );
    }
    text
}
pub(crate) fn document(task: &Task) -> Value {
    let links = task.links.iter().chain(task.work_sessions.iter());
    json!({"id":task.id,"entity_type":task.entity_type,"revision":task.last_change_id,"title":task.title,"brief":task.brief,"notes":task.notes,"agent_notes":task.agent_notes,"location":task.location,"completion_result":task.completion_result,"labels":links.clone().filter_map(|l|l.label.clone()).collect::<Vec<_>>(),"urls":links.flat_map(searchable_url).collect::<Vec<_>>()})
}
pub(crate) fn settings(count: usize, owned: bool) -> Value {
    json!({"searchableAttributes":["title","brief","notes","labels","location","urls","completion_result","agent_notes"],"filterableAttributes": if owned { vec!["entity_type", "account_id"] } else { vec!["entity_type"] },"pagination":{"maxTotalHits":count.max(SEARCH_PAGE)},"typoTolerance":{"enabled":true},"searchCutoffMs":10000})
}
pub(crate) fn validated_query(q: &str) -> Result<String> {
    use charabia::Tokenize;
    if q.chars().count() > 500
        || q.contains('"')
        || q.split_whitespace().any(|term| term.starts_with('-'))
    {
        return Err(StoreError::Invalid("Search supports 1–10 words and at most 500 characters; quotes and exclusion operators are not supported".into()));
    }
    let words: Vec<String> = q
        .tokenize()
        .filter(|token| token.is_word())
        .map(|token| token.lemma().to_owned())
        .collect();
    if !(1..=10).contains(&words.len()) || words.iter().any(|word| word.contains(['"', '-'])) {
        return Err(StoreError::Invalid(
            "Search requires 1–10 words; punctuation-only and longer queries are not supported"
                .into(),
        ));
    }
    Ok(words.join(" "))
}
