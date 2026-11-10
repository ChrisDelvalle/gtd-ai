use crate::{
    application::{Application, known_operation},
    diagnostics::LogQuery,
    server::guard_environment,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};

/// Explicit browser origins only: no paths, credentials, wildcards, or suffix matching.
#[derive(Clone, Debug)]
pub struct AllowedOrigins(Arc<BTreeSet<String>>);

impl AllowedOrigins {
    pub fn from_config(multiple: Option<&str>, legacy: Option<&str>) -> Result<Self, &'static str> {
        let value = multiple.or(legacy).unwrap_or("https://todo.home");
        let mut origins = BTreeSet::new();
        for origin in value.split(',').map(str::trim) {
            let parsed =
                url::Url::parse(origin).map_err(|_| "Invalid website origin configuration")?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none_or(|host| host.contains('*'))
                || parsed.origin().ascii_serialization() != origin
            {
                return Err(
                    "Website origins must be exact HTTP(S) origins without paths or credentials",
                );
            }
            origins.insert(origin.to_owned());
        }
        Ok(Self(Arc::new(origins)))
    }

    fn contains(&self, origin: &str) -> bool {
        self.0.contains(origin)
    }
}

#[derive(Clone)]
pub struct WebState {
    pub app: Application,
    pub origins: AllowedOrigins,
    pub health_socket: PathBuf,
    pub auth: Option<crate::web_auth::Backend>,
}

pub use crate::web_assets::assets_dir;
pub fn router(state: WebState) -> Router {
    use crate::web_auth;
    use axum_login::{
        AuthManagerLayerBuilder,
        tower_sessions::{SessionManagerLayer, cookie::SameSite},
    };
    let protected = Router::new()
        .route("/api/tools/{name}", post(tool))
        .route("/api/view", post(view))
        .route("/api/logs", get(logs))
        .route("/api/health", get(health));
    let routes = if let Some(auth) = state.auth.clone() {
        let sessions = SessionManagerLayer::new(auth.store.clone())
            .with_name(if auth.secure {
                "__Host-gtd_session"
            } else {
                "gtd_test_session"
            })
            .with_secure(auth.secure)
            .with_http_only(true)
            .with_same_site(SameSite::Lax);
        protected
            .route_layer(middleware::from_fn(web_auth::require_auth))
            .route("/api/auth/session", get(web_auth::status))
            .route(
                "/api/auth/login",
                post(web_auth::login).layer(DefaultBodyLimit::max(4096)),
            )
            .route("/api/auth/logout", post(web_auth::logout))
            .layer(AuthManagerLayerBuilder::new(auth, sessions).build())
    } else {
        protected.route(
            "/api/auth/session",
            get(|State(state): State<WebState>| async move {
                let environment = state
                    .app
                    .store
                    .lock()
                    .map(|store| store.environment())
                    .unwrap_or("unknown".into());
                Json(json!({"authenticated":true,"enabled":false,"environment":environment}))
            }),
        )
    };
    routes
        .merge(crate::web_assets::routes())
        .layer(DefaultBodyLimit::max(128 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

async fn guard(State(state): State<WebState>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let operation = match path.as_str() {
        "/api/logs" => "http.logs",
        "/api/health" => "http.health",
        "/api/view" => "http.view",
        _ if path.starts_with("/api/tools/") => "http.tool",
        _ => "http.asset",
    };
    let diagnostic = state.app.diagnostics.clone();
    let call = tokio::task::spawn_blocking(move || diagnostic.begin(operation))
        .await
        .ok();
    let mut rejection = None;
    if matches!(request.method(), &Method::GET | &Method::HEAD)
        && !crate::web_assets::valid_shell_path(&path)
    {
        rejection = Some((StatusCode::NOT_FOUND, "not_found"));
    }
    // Session cookies are ambient. Require an exact configured
    // Origin, JSON, and a non-simple header for every POST. No CORS is enabled.
    if request.method() != Method::GET && request.method() != Method::HEAD {
        if request.method() != Method::POST {
            rejection = Some((StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed"));
        } else if request.headers().get_all(header::ORIGIN).iter().count() != 1
            || !request
                .headers()
                .get(header::ORIGIN)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|origin| state.origins.contains(origin))
            || request
                .headers()
                .get("x-gtd-request")
                .and_then(|v| v.to_str().ok())
                != Some("1")
            || request
                .headers()
                .get("sec-fetch-site")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v != "same-origin" && v != "none")
        {
            rejection = Some((StatusCode::FORBIDDEN, "origin_rejected"));
        } else if request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap().trim())
            != Some("application/json")
        {
            rejection = Some((StatusCode::UNSUPPORTED_MEDIA_TYPE, "json_required"));
        }
    }
    let mut response = match rejection {
        Some((status, code)) => (
            status,
            Json(json!({"code":code,"message":"Request rejected"})),
        )
            .into_response(),
        None => next.run(request).await,
    };
    crate::web_assets::headers(&path, &mut response);
    if let Some(call) = call {
        let diagnostic = state.app.diagnostics.clone();
        let failed = response.status().is_client_error() || response.status().is_server_error();
        let code = rejection
            .map(|(_, c)| c)
            .or(if failed { Some("http_error") } else { None });
        let _ = tokio::task::spawn_blocking(move || {
            diagnostic.finish(&call, if failed { "error" } else { "success" }, code, None)
        })
        .await;
    }
    response
}

async fn tool(
    State(state): State<WebState>,
    Path(name): Path<String>,
    headers: HeaderMap,
    Json(arguments): Json<Value>,
) -> Response {
    if known_operation(&name) == "unknown_tool" {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"code":"not_found","message":"Unknown operation"})),
        )
            .into_response();
    }
    let expected = if headers.get_all("x-gtd-environment").iter().count() > 1 {
        Some("")
    } else {
        headers
            .get("x-gtd-environment")
            .map(|value| value.to_str().unwrap_or(""))
    };
    if let Err(error) = guard_environment(&state.app, &name, expected).await {
        return (StatusCode::CONFLICT, Json(error)).into_response();
    }
    match state.app.execute_ui(&name, arguments).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            let status = match error["code"].as_str() {
                Some("conflict" | "request_id_conflict") => StatusCode::CONFLICT,
                Some("not_found") => StatusCode::NOT_FOUND,
                Some("search_unavailable") => StatusCode::SERVICE_UNAVAILABLE,
                Some("invalid_input") => StatusCode::BAD_REQUEST,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, Json(error)).into_response()
        }
    }
}

async fn view(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(request): Json<crate::view::ViewRequest>,
) -> Response {
    let expected = if headers.get_all("x-gtd-environment").iter().count() > 1 {
        Some("")
    } else {
        headers
            .get("x-gtd-environment")
            .map(|v| v.to_str().unwrap_or(""))
    };
    if let Err(error) = guard_environment(&state.app, "list_items", expected).await {
        return (StatusCode::CONFLICT, Json(error)).into_response();
    }
    match state.app.view(request).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            let status = match error["code"].as_str() {
                Some("invalid_input") => StatusCode::BAD_REQUEST,
                Some("reset_required") => StatusCode::CONFLICT,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, Json(error)).into_response()
        }
    }
}

async fn logs(State(state): State<WebState>, Query(query): Query<LogQuery>) -> Response {
    match tokio::task::spawn_blocking(move || state.app.diagnostics.list(query)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(message)) => {
            (StatusCode::BAD_REQUEST, Json(json!({"message":message}))).into_response()
        }
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"message":"Diagnostics unavailable"})),
        )
            .into_response(),
    }
}

async fn health(State(state): State<WebState>) -> Json<Value> {
    let app = state.app.clone();
    let (database, diagnostics, environment, search) = tokio::task::spawn_blocking(move || {
        let store = app.store.lock();
        match store {
            Ok(store) => (
                store.health().is_ok(),
                app.diagnostics.health(),
                store.environment(),
                store.search_health(),
            ),
            Err(_) => (
                false,
                app.diagnostics.health(),
                "unknown".into(),
                json!({"ready":false}),
            ),
        }
    })
    .await
    .unwrap_or((
        false,
        json!({"available":false,"failure_markers":["health check interrupted"]}),
        "unknown".into(),
        json!({"ready":false}),
    ));
    let output = tokio::process::Command::new("curl")
        .args(["--silent", "--fail", "--max-time", "3", "--unix-socket"])
        .arg(&state.health_socket)
        .arg("http://localhost/health?details=true")
        .kill_on_drop(true)
        .output()
        .await;
    let raw = output
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok());
    let tunnel = raw.map(|raw| {
        // Deliberate allowlist: never forward admin endpoints, identifiers, headers, or raw component errors.
        json!({"reachable":true, "live":raw["live"], "ready":raw["ready"],
            "last_poll_success":raw.pointer("/components/control-plane/details/last_success"),
            "consecutive_failures":raw.pointer("/components/control-plane/details/consecutive_failures"),
            "requests_completed":raw.pointer("/components/dispatcher/details/completed"),
            "failures":raw.pointer("/components/dispatcher/details/failures"),
            "timeouts":raw.pointer("/components/dispatcher/details/timeouts"),
            "responses_accepted":raw.pointer("/components/response-delivery/details/accepted")})
    }).unwrap_or(json!({"reachable":false,"ready":false}));
    Json(
        json!({"database":database,"tunnel":tunnel,"diagnostics":diagnostics,"environment":environment,"search":search,
        "version":env!("CARGO_PKG_VERSION"),"checked_at":chrono::Utc::now().to_rfc3339()}),
    )
}

pub async fn serve(
    app: Application,
    listen: &str,
    origins: AllowedOrigins,
    socket: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let environment = app
        .store
        .lock()
        .map_err(|_| "Task store unavailable")?
        .environment();
    let auth = crate::web_auth::configuration(&environment, listen)?;
    app.diagnostics
        .event("web.start", "success", "Web service started");
    let diagnostics = app.diagnostics.clone();
    axum::serve(
        listener,
        router(WebState {
            app,
            origins,
            health_socket: socket,
            auth,
        }),
    )
    .with_graceful_shutdown(crate::supervisor::shutdown_signal())
    .await?;
    diagnostics.event("web.stop", "success", "Web service stopped");
    Ok(())
}
