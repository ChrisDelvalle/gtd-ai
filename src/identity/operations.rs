//! Sanitized service diagnostics. Administrators may inspect service metadata,
//! never another account's task bodies, audit contents or credentials.
use crate::diagnostics::{Call, Diagnostics, LogQuery};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
pub struct Operations {
    log: Diagnostics,
    tunnel: Option<(url::Url, reqwest::blocking::Client)>,
}
impl Operations {
    pub fn new(log: Diagnostics, tunnel_origin: Option<&str>) -> Result<Self, super::Error> {
        let tunnel = tunnel_origin
            .map(|origin| {
                let url = url::Url::parse(origin).map_err(|_| super::Error::Configuration)?;
                if url.scheme() != "http"
                    || url.host_str() != Some("127.0.0.1")
                    || url.port().is_none()
                    || url.path() != "/"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err(super::Error::Configuration);
                }
                let client = reqwest::blocking::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(1))
                    .build()
                    .map_err(|_| super::Error::Configuration)?;
                Ok((url, client))
            })
            .transpose()?;
        Ok(Self { log, tunnel })
    }
    pub fn with_source(&self, source: &'static str) -> Self {
        Self {
            log: self.log.with_source(source),
            tunnel: self.tunnel.clone(),
        }
    }
    pub(super) async fn begin(&self, operation: &'static str, id: Uuid) -> Option<Call> {
        let log = self.log.clone();
        tokio::task::spawn_blocking(move || {
            let call = log.begin(operation);
            log.annotate(&call, &format!("Request {id}"));
            call
        })
        .await
        .ok()
    }
    pub(super) async fn finish(&self, call: Call, status: axum::http::StatusCode) {
        let log = self.log.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let failed = status.is_client_error() || status.is_server_error();
            // Deliberately no result value: even record IDs and change IDs stay
            // out of this service-wide administrative log.
            log.finish(
                &call,
                if failed { "error" } else { "success" },
                Some(if failed { "http_error" } else { "http_success" }),
                None,
            );
        })
        .await;
    }
    pub(super) fn logs(&self, query: LogQuery) -> Result<Value, String> {
        self.log.list(query)
    }
    pub(super) fn health(&self) -> Value {
        self.log.health()
    }
    pub(super) fn tunnel_health(&self) -> Value {
        let Some((url, client)) = &self.tunnel else {
            return json!({"configured":false,"reachable":false,"ready":false});
        };
        let status = |path| {
            client
                .get(url.join(path).expect("fixed health route"))
                .send()
                .ok()
                .map(|r| r.status())
        };
        let live = status("healthz");
        let ready = status("readyz");
        json!({"configured":true,"reachable":live.is_some() || ready.is_some(),
            "live":live.is_some_and(|s|s==reqwest::StatusCode::OK),"ready":ready.is_some_and(|s|s==reqwest::StatusCode::OK)})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_private_health_origins_are_accepted() {
        let directory = tempfile::tempdir().unwrap();
        let log = Diagnostics::open(&directory.path().join("service.db"), "web").unwrap();
        for origin in [
            "https://public.invalid",
            "http://127.0.0.1",
            "http://127.0.0.1:8080/mcp",
            "http://user:secret@127.0.0.1:8080",
            "http://127.0.0.1:8080/?redirect=1",
        ] {
            assert!(Operations::new(log.clone(), Some(origin)).is_err());
        }
        assert!(Operations::new(log, Some("http://127.0.0.1:8080")).is_ok());
    }
}
