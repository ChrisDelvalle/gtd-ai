//! Private Rust HTTP boundary for the forthcoming Streamable HTTP adapter.
//! This router is opt-in and has no listener in the production supervisor yet.
//! Bind only to the private adapter transport; it never accepts cookies or an
//! account selector. Website sessions have a separate OIDC boundary.
use super::{Error, Verifier, configured_url};
use crate::postgres::{self, Store};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, FromRequest, Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use uuid::Uuid;

#[derive(Clone)]
pub struct Service {
    store: Store,
    verifier: Verifier,
    chatgpt: Option<(String, Verifier)>,
    metadata: String,
    admission: Arc<Semaphore>,
    operations: Option<super::operations::Operations>,
    #[cfg(test)]
    separate_widget_binding: bool,
}
impl Service {
    pub fn new(
        store: Store,
        verifier: Verifier,
        protected_resource_metadata: &str,
    ) -> Result<Self, Error> {
        configured_url(protected_resource_metadata)?;
        Ok(Self {
            store,
            verifier,
            chatgpt: None,
            metadata: protected_resource_metadata.into(),
            admission: Arc::new(Semaphore::new(32)),
            operations: None,
            #[cfg(test)]
            separate_widget_binding: false,
        })
    }
    pub fn with_operations(mut self, operations: super::operations::Operations) -> Self {
        self.operations = Some(operations.with_source("mcp"));
        self
    }
    pub fn with_chatgpt_resource(mut self, resource: &str) -> Result<Self, Error> {
        self.chatgpt = Some((
            resource.into(),
            self.verifier.clone().for_resource(resource)?,
        ));
        Ok(self)
    }
    #[cfg(test)]
    pub(crate) fn with_separate_widget_binding(mut self) -> Self {
        self.separate_widget_binding = true;
        self
    }
    pub fn router(self) -> Router {
        let routes = Router::new()
            .route("/internal/contract", get(contract))
            .route("/internal/ready", get(ready))
            .route("/internal/profile", get(profile))
            .route("/internal/tools/{name}", post(tool))
            .route("/internal/mcp/{name}", post(mcp_tool));
        routes
            // Allow wire encoding and complete records; business limits still apply.
            .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
            .layer(middleware::from_fn_with_state(self.clone(), correlate))
            .with_state(self)
    }
}

/// The adapter may carry a safe UUID through to Rust. No arbitrary client text
/// enters logs or response headers; malformed/duplicate IDs get replaced.
pub(super) fn request_id(headers: &HeaderMap) -> Uuid {
    if headers.get_all("x-request-id").iter().count() == 1
        && let Some(id) = headers.get("x-request-id").and_then(|v| v.to_str().ok())
        && id.len() == 36
        && let Ok(id) = Uuid::parse_str(id)
    {
        return id;
    }
    Uuid::new_v4()
}
async fn correlate(State(service): State<Service>, mut request: Request, next: Next) -> Response {
    let id = request_id(request.headers());
    let started = Instant::now();
    let operation = if request.uri().path() == "/internal/profile" {
        "profile"
    } else if request.uri().path() == "/internal/ready" {
        "ready"
    } else if let Some(name) = request
        .uri()
        .path()
        .strip_prefix("/internal/tools/")
        .or_else(|| request.uri().path().strip_prefix("/internal/mcp/"))
    {
        match name {
            "get_profile" => "get_profile",
            "gtd_ui_read" => "gtd_ui_read",
            "gtd_ui_write" => "gtd_ui_write",
            _ => crate::application::known_operation(name),
        }
    } else {
        "unknown"
    };
    let call = if let Some(operations) = &service.operations {
        operations.begin(operation, id).await
    } else {
        None
    };
    request.extensions_mut().insert(id);
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&id.to_string()).unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let (Some(operations), Some(call)) = (&service.operations, call) {
        operations.finish(call, response.status()).await;
    }
    eprintln!(
        "{}",
        json!({"component":"account-http","request_id":id.to_string(),
            "operation":operation,"status":response.status().as_u16(),"duration_ms":started.elapsed().as_millis()})
    );
    response
}

async fn profile(State(service): State<Service>, request: Request) -> Response {
    invoke(service, request, "get_profile".into(), false, false).await
}
async fn ready(State(service): State<Service>) -> Response {
    let Ok(permit) = service.admission.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"ready":false})),
        )
            .into_response();
    };
    let checked = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        service.store.health()
    })
    .await;
    let ready = matches!(checked, Ok(Ok(())));
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({"ready":ready})),
    )
        .into_response()
}
async fn contract(State(service): State<Service>, request: Request) -> Response {
    if request.headers().contains_key(header::ORIGIN) || request.uri().query().is_some() {
        let id = *request.extensions().get::<Uuid>().unwrap();
        return failure(StatusCode::BAD_REQUEST, "invalid_request", id);
    }
    Json(super::contract::document(service.store.environment())).into_response()
}
async fn tool(
    State(service): State<Service>,
    Path(name): Path<String>,
    request: Request,
) -> Response {
    invoke(service, request, name, true, false).await
}
async fn mcp_tool(
    State(service): State<Service>,
    Path(name): Path<String>,
    request: Request,
) -> Response {
    invoke(service, request, name, true, true).await
}
fn binding(headers: &HeaderMap, key: &str) -> Result<Option<String>, ()> {
    if headers.get_all(key).iter().count() > 1 {
        return Err(());
    }
    headers
        .get(key)
        .map(|v| {
            v.to_str()
                .ok()
                .filter(|s| !s.is_empty() && s.len() <= 64)
                .map(str::to_owned)
                .ok_or(())
        })
        .transpose()
}
async fn invoke(
    service: Service,
    request: Request,
    name: String,
    has_body: bool,
    mcp: bool,
) -> Response {
    let id = *request
        .extensions()
        .get::<Uuid>()
        .expect("correlation middleware");
    if request.headers().contains_key(header::ORIGIN) || request.uri().query().is_some() {
        return failure(StatusCode::BAD_REQUEST, "invalid_request", id);
    }
    let mut resources = request.headers().get_all("x-gtd-mcp-resource").iter();
    let verifier = match resources.next() {
        None => service.verifier.clone(),
        Some(resource) => match &service.chatgpt {
            Some((expected, verifier))
                if (mcp || !has_body)
                    && resource == expected.as_str()
                    && resources.next().is_none() =>
            {
                verifier.clone()
            }
            _ => return failure(StatusCode::BAD_REQUEST, "invalid_request", id),
        },
    };
    let authorization = if request
        .headers()
        .get_all(header::AUTHORIZATION)
        .iter()
        .count()
        == 1
    {
        request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
    } else {
        None
    };
    let Some(authorization) = authorization
        .filter(|v| v.len() <= super::MAX_TOKEN + 7)
        .map(str::to_owned)
    else {
        return auth_failure(Error::InvalidToken, &service.metadata, id);
    };
    let (Ok(account), Ok(environment)) = (
        binding(request.headers(), "x-gtd-expected-account"),
        binding(request.headers(), "x-gtd-expected-environment"),
    ) else {
        return failure(StatusCode::BAD_REQUEST, "invalid_request", id);
    };
    let widget_launch =
        if mcp && matches!(name.as_str(), "show_gtd" | "show_tasks" | "show_projects") {
            let mut values = request.headers().get_all("x-gtd-widget-launch").iter();
            match (values.next().and_then(|v| v.to_str().ok()), values.next()) {
                (Some("requested"), None) => postgres::LaunchMode::Requested,
                (Some("full"), None) => postgres::LaunchMode::Full,
                (Some("deferred"), None) => postgres::LaunchMode::Deferred,
                (Some("nearby"), None) => postgres::LaunchMode::Nearby,
                (Some("summaries"), None) => postgres::LaunchMode::Summaries,
                _ => postgres::LaunchMode::Legacy,
            }
        } else {
            postgres::LaunchMode::Legacy
        };
    let Ok(permit) = service.admission.clone().try_acquire_owned() else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "service_busy", id);
    };
    let arguments = if has_body {
        match tokio::time::timeout(
            Duration::from_secs(5),
            Json::<Value>::from_request(request, &service),
        )
        .await
        {
            Ok(Ok(Json(value))) => value,
            Ok(Err(error)) => return failure(error.status(), "invalid_request", id),
            Err(_) => return failure(StatusCode::REQUEST_TIMEOUT, "invalid_request", id),
        }
    } else {
        json!({})
    };
    let metadata = service.metadata.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::task::spawn_blocking(move || {
            // The permit stays with a blocking operation even if its client times out.
            let _permit = permit;
            let operation_started = Instant::now();
            let principal = verifier
                .verify(&authorization)
                .map_err(BoundaryError::Token)?;
            let verified_at = Instant::now();
            // Stale widgets cannot replay a draft into whichever account is
            // currently linked. Pins are equality checks, never identity input.
            if matches!(name.as_str(), "gtd_ui_read" | "gtd_ui_write")
                && (account.is_none() || environment.is_none())
            {
                return Err(BoundaryError::Application(postgres::Error::Binding("account_changed")));
            }
            #[cfg(test)]
            let pinned = account.is_some() || environment.is_some();
            let principal = principal.with_binding(account, environment);
            #[cfg(test)]
            if pinned && service.separate_widget_binding {
                service.store.read(&principal, |_| Ok(())).map_err(BoundaryError::Application)?;
            }
            if !has_body {
                // Adapter-only context, separate from the public profile schema.
                return service.store.read(&principal, |tx| {
                    let a = tx.account();
                    Ok(json!({"id":a.id().to_string(),"name":a.display_name().unwrap_or(a.username()),
                        "nickname":a.username(),"timezone":a.timezone().name()}))
                }).map_err(BoundaryError::Application);
            }
            let auth_ms = verified_at.duration_since(operation_started).as_millis();
            let (value, bundle) = if mcp && !matches!(widget_launch, postgres::LaunchMode::Legacy) {
                service.store.widget_display(&principal, &name, arguments, widget_launch)
                    .map_err(BoundaryError::Application)?
            } else {
                let value = service.store.execute_tool(&principal, &name, arguments)
                    .map_err(BoundaryError::Application)?;
                (value, None)
            };
            if !mcp {
                return Ok(value);
            }
            let home = name == "show_gtd" && value["view"] == "home";
            let work_ms = verified_at.elapsed().as_millis();
            let serialization = Instant::now();
            let mut result = super::contract::result(&name, value);
            if let Some(bundle) = bundle {
                result["_meta"] = json!({"gtd/widgetBundle":bundle});
            } else if home && let Ok(Some(seed)) = service.store.widget_home_seed(&principal) {
                result["_meta"] = json!({"gtd/homeSnapshot":seed});
            }
            if !matches!(widget_launch, postgres::LaunchMode::Legacy) {
                eprintln!("{}", json!({"component":"widget-launch","request_id":id,"operation":name,
                    "auth_ms":auth_ms,"work_ms":work_ms,"result_ms":serialization.elapsed().as_millis()}));
            }
            Ok(result)
        }),
    )
    .await;
    match result {
        Ok(Ok(Ok(value))) => Json(value).into_response(),
        Ok(Ok(Err(BoundaryError::Token(error)))) => auth_failure(error, &metadata, id),
        Ok(Ok(Err(BoundaryError::Application(error)))) => application_failure(error, id),
        Err(_) => failure(StatusCode::GATEWAY_TIMEOUT, "response_unconfirmed", id),
        _ => failure(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", id),
    }
}
enum BoundaryError {
    Token(Error),
    Application(postgres::Error),
}
pub(super) fn application_failure(error: postgres::Error, id: Uuid) -> Response {
    match error {
        postgres::Error::Binding(code)=>(StatusCode::CONFLICT,Json(json!({"code":code,"message":error.to_string(),"retryable":false,"request_id":id.to_string()}))).into_response(),
        postgres::Error::AccountUnavailable=>failure(StatusCode::FORBIDDEN,"account_unavailable",id),
        postgres::Error::Business(error)=> {
            // Domain errors intentionally have user-facing messages. Never echo
            // PostgreSQL/provider/JSON decoding errors or request bodies.
            let value=json!({"code":error.code(),"message":error.to_string(),"request_id":id.to_string(),
                "retryable":matches!(error,crate::store::StoreError::SearchUnavailable)});
            let status=match error.code() {
                "conflict" | "request_id_conflict" => StatusCode::CONFLICT,
                "not_found" => StatusCode::NOT_FOUND,
                "search_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::BAD_REQUEST,
            };
            (status,Json(value)).into_response()
        },
        postgres::Error::ResetRequired=>(StatusCode::CONFLICT,Json(json!({"code":"reset_required","message":error.to_string(),"request_id":id.to_string()}))).into_response(),
        postgres::Error::PageSize=>(StatusCode::BAD_REQUEST,Json(json!({"code":"invalid_arguments","message":error.to_string(),"request_id":id.to_string()}))).into_response(),
        _=>failure(StatusCode::SERVICE_UNAVAILABLE,"service_unavailable",id),
    }
}
fn failure(status: StatusCode, code: &'static str, id: Uuid) -> Response {
    (
        status,
        Json(json!({"error":code,"request_id":id.to_string()})),
    )
        .into_response()
}
fn auth_failure(error: Error, metadata: &str, id: Uuid) -> Response {
    let (status, code) = match error {
        Error::InvalidToken => (StatusCode::UNAUTHORIZED, "invalid_token"),
        Error::InsufficientScope => (StatusCode::FORBIDDEN, "insufficient_scope"),
        Error::Unavailable | Error::Configuration => {
            (StatusCode::SERVICE_UNAVAILABLE, "identity_unavailable")
        }
    };
    let mut response = failure(status, code, id);
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        let value = format!(
            "Bearer resource_metadata=\"{metadata}\", error=\"{code}\", scope=\"gtd:access\""
        );
        if let Ok(value) = HeaderValue::from_str(&value) {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, value);
        }
    } else {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("30"));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn correlation_and_challenges_do_not_echo_untrusted_input() {
        let id = Uuid::new_v4();
        let mut headers = HeaderMap::new();
        headers.insert("x-request-id", id.to_string().parse().unwrap());
        assert_eq!(request_id(&headers), id);
        headers.append("x-request-id", id.to_string().parse().unwrap());
        assert_ne!(request_id(&headers), id);
        headers.insert(
            "x-request-id",
            HeaderValue::from_static("arbitrary client text"),
        );
        assert_ne!(request_id(&headers), id);
        for error in [
            Error::InvalidToken,
            Error::InsufficientScope,
            Error::Unavailable,
        ] {
            let response = auth_failure(
                error,
                "https://gtd.invalid/.well-known/oauth-protected-resource",
                id,
            );
            if error == Error::Unavailable {
                assert_eq!(response.headers()[header::RETRY_AFTER], "30");
            } else {
                assert!(
                    response.headers()[header::WWW_AUTHENTICATE]
                        .to_str()
                        .unwrap()
                        .contains("resource_metadata=")
                );
            }
        }
    }
}
