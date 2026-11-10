//! Cookie-authenticated website boundary. Separate from bearer-only MCP routes;
//! there is no HTTP flag that selects another account or relaxes content policy.
use super::{
    provisioning::{Provisioner, keycloak::Keycloak},
    website_session::{self, Grant, WebsiteSessions},
};
use crate::postgres::{Store, sessions::CookieKey};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use uuid::Uuid;

mod handlers;
#[cfg(test)]
mod tests;
const SESSION: &str = "__Host-gtd_session";
const LOGIN: &str = "__Host-gtd_login";

#[derive(Clone)]
pub struct Service {
    store: Store,
    sessions: WebsiteSessions,
    provisioning: Arc<Provisioner<Keycloak>>,
    origin: String,
    security_url: String,
    admission: Arc<Semaphore>,
    operations: Option<super::operations::Operations>,
}
impl Service {
    pub fn new(
        store: Store,
        sessions: WebsiteSessions,
        provider: Keycloak,
        website_origin: &str,
        issuer: &str,
    ) -> Result<Self, super::Error> {
        let origin = super::configured_url(website_origin)?;
        if origin.path() != "/" {
            return Err(super::Error::Configuration);
        }
        super::configured_url(issuer)?;
        Ok(Self {
            provisioning: Arc::new(Provisioner::new(store.clone(), provider)),
            store,
            sessions,
            origin: origin.origin().ascii_serialization(),
            security_url: format!("{issuer}/account/"),
            admission: Arc::new(Semaphore::new(32)),
            operations: None,
        })
    }
    pub fn with_operations(mut self, operations: super::operations::Operations) -> Self {
        self.operations = Some(operations.with_source("web"));
        self
    }
    pub fn router(self) -> Router {
        Router::new()
            .route("/api/auth/session", get(handlers::session))
            .route("/api/auth/login", post(handlers::login))
            .route("/api/auth/callback", get(handlers::callback))
            .route("/api/auth/logout", post(handlers::logout))
            .route("/api/account/timezone", post(handlers::timezone))
            .route("/api/tools/{name}", post(handlers::tool))
            .route("/api/view", post(handlers::view))
            .route("/api/users", get(handlers::users))
            .route("/api/logs", get(handlers::logs))
            .route("/api/health", get(handlers::health))
            .route(
                "/api/users/requests/{id}",
                get(handlers::administration_request),
            )
            .route(
                "/api/users/operations/{id}",
                get(handlers::administration_operation),
            )
            .route("/api/users/operations", post(handlers::administer))
            .route("/api/users/operations/{id}/resume", post(handlers::resume))
            .layer(DefaultBodyLimit::max(128 * 1024))
            .layer(middleware::from_fn_with_state(self.clone(), guard))
            .with_state(self)
            .merge(crate::web_assets::router())
    }
    fn grant(&self, headers: &HeaderMap, write: bool) -> Result<Grant, Failure> {
        let cookie = cookie(headers, SESSION)?.ok_or(website_session::Error::SignIn)?;
        let grant = self.sessions.authenticate(&cookie)?;
        // Identity is resolved from the cookie; these are equality guards only.
        // An old tab cannot silently send its draft into the newly signed-in account.
        if unique(headers, "x-gtd-account") != Some(grant.account.id().to_string().as_str())
            || unique(headers, "x-gtd-environment") != Some(self.store.environment().as_str())
        {
            return Err(website_session::Error::AccountChanged.into());
        }
        if write {
            grant.verify_csrf(
                unique(headers, "x-gtd-csrf").ok_or(website_session::Error::InvalidRequest)?,
            )?;
        }
        Ok(grant)
    }
    async fn run(
        &self,
        work: impl FnOnce() -> Result<Response, Failure> + Send + 'static,
    ) -> Response {
        let Ok(permit) = self.admission.clone().try_acquire_owned() else {
            return Failure::busy().into_response();
        };
        // No retries. The permit remains held if a client disconnects or times
        // out; durable request IDs reconcile an uncertain administration/write.
        match tokio::time::timeout(
            Duration::from_secs(60),
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                work()
            }),
        )
        .await
        {
            Ok(Ok(Ok(response))) => response,
            Ok(Ok(Err(error))) => error.into_response(),
            Err(_) => failure(
                StatusCode::GATEWAY_TIMEOUT,
                "response_unconfirmed",
                "The response could not be confirmed. Check the operation before retrying.",
            ),
            _ => Failure::busy().into_response(),
        }
    }
}

struct Failure {
    status: StatusCode,
    code: &'static str,
    message: String,
}
impl Failure {
    fn busy() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "service_unavailable",
            message: "GTD is temporarily unavailable".into(),
        }
    }
    fn invalid() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            message: "Request could not be verified".into(),
        }
    }
}
impl From<website_session::Error> for Failure {
    fn from(error: website_session::Error) -> Self {
        use website_session::Error::*;
        let (status, code) = match error {
            SignIn => (StatusCode::UNAUTHORIZED, "authentication_required"),
            Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "identity_unavailable"),
            AccountChanged => (StatusCode::CONFLICT, "account_changed"),
            InvalidRequest => (StatusCode::FORBIDDEN, "request_rejected"),
        };
        Self {
            status,
            code,
            message: error.to_string(),
        }
    }
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        failure(self.status, self.code, &self.message)
    }
}
fn failure(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({"code":code,"message":message}))).into_response()
}
fn unique<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    if headers.get_all(name).iter().count() != 1 {
        return None;
    }
    headers.get(name)?.to_str().ok()
}
fn cookie(headers: &HeaderMap, name: &str) -> Result<Option<CookieKey>, Failure> {
    let mut found = None;
    for line in headers.get_all(header::COOKIE) {
        let line = line.to_str().map_err(|_| Failure::invalid())?;
        if line.len() > 8192 {
            return Err(Failure::invalid());
        }
        for part in line.split(';') {
            if let Some((key, value)) = part.trim().split_once('=')
                && key == name
            {
                if found.is_some() {
                    return Err(Failure::invalid());
                }
                found = Some(CookieKey::parse(value).map_err(|_| website_session::Error::SignIn)?);
            }
        }
    }
    Ok(found)
}
fn optional_session_cookie(headers: &HeaderMap) -> Result<Option<CookieKey>, Failure> {
    match cookie(headers, SESSION) {
        Ok(key) => Ok(key),
        Err(error) if error.status == StatusCode::UNAUTHORIZED => Ok(None),
        Err(error) => Err(error),
    }
}
fn set_cookie(response: &mut Response, name: &str, value: &str, age: Option<i64>) {
    let age = age
        .map(|v| format!("; Max-Age={}", v.max(0)))
        .unwrap_or_default();
    let value = format!("{name}={value}; Path=/; Secure; HttpOnly; SameSite=Lax{age}");
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&value).expect("server-generated cookie"),
    );
}
fn valid_post(headers: &HeaderMap, origin: &str) -> bool {
    unique(headers, "origin") == Some(origin)
        && unique(headers, "x-gtd-request") == Some("1")
        && unique(headers, "content-type")
            .is_some_and(|v| v.split(';').next().unwrap().trim() == "application/json")
        && (!headers.contains_key("sec-fetch-site")
            || matches!(
                unique(headers, "sec-fetch-site"),
                Some("same-origin" | "none")
            ))
}
async fn guard(State(service): State<Service>, mut request: Request, next: Next) -> Response {
    let id = super::http::request_id(request.headers());
    let started = Instant::now();
    let operation = match request.uri().path() {
        "/api/auth/session" => "session",
        "/api/auth/login" => "login",
        "/api/auth/callback" => "callback",
        "/api/auth/logout" => "logout",
        "/api/account/timezone" => "timezone",
        "/api/users" => "users",
        "/api/users/operations" => "administration",
        "/api/view" => "view",
        "/api/logs" => "logs",
        "/api/health" => "health",
        p if p.starts_with("/api/tools/") => {
            crate::application::known_operation(p.trim_start_matches("/api/tools/"))
        }
        _ => "other",
    };
    let call = if let Some(operations) = &service.operations {
        operations.begin(operation, id).await
    } else {
        None
    };
    let rejected = request.headers().contains_key(header::AUTHORIZATION)
        || (request.method() != Method::GET
            && request.method() != Method::HEAD
            && (request.method() != Method::POST
                || !valid_post(request.headers(), &service.origin)));
    request.extensions_mut().insert(id);
    request
        .headers_mut()
        .insert("x-request-id", id.to_string().parse().unwrap());
    let mut response = if rejected {
        failure(
            StatusCode::FORBIDDEN,
            "request_rejected",
            "Request could not be verified",
        )
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert("x-request-id", id.to_string().parse().unwrap());
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'; base-uri 'none'"),
    );
    if let (Some(operations), Some(call)) = (&service.operations, call) {
        operations.finish(call, response.status()).await;
    }
    eprintln!(
        "{}",
        json!({"component":"website-http","request_id":id,"operation":operation,
        "status":response.status().as_u16(),"duration_ms":started.elapsed().as_millis()})
    );
    response
}
