use axum::{
    body::Body,
    http::{Request, StatusCode, header::SET_COOKIE},
    response::Response,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{
    application::Application,
    diagnostics::Diagnostics,
    store::Store,
    web::{AllowedOrigins, WebState, router},
    web_auth::Backend,
};
use tower::ServiceExt;

const PASSWORD: &str = "password"; // Disposable fixture only; bcrypt project's published test vector.
const HASH: &str = "$2a$04$UuTkLRZZ6QofpDOlMz32MuuxEHA43WOemOYHPz6.SjsVsyO1tDU96";
fn setup(dir: &TempDir) -> WebState {
    let file = dir.path().join("credentials.json");
    if !file.exists() {
        std::fs::write(
            &file,
            json!({"username":"owner","password_hash":HASH}).to_string(),
        )
        .unwrap();
    }
    WebState {
        app: Application::new(
            Store::open(dir.path().join("tasks.db"))
                .unwrap()
                .with_origin("website"),
            Diagnostics::open(&dir.path().join("logs.db"), "web").unwrap(),
        ),
        origins: AllowedOrigins::from_config(None, None).unwrap(),
        health_socket: dir.path().join("missing.sock"),
        auth: Some(Backend::open(file, dir.path().join("sessions.db"), true).unwrap()),
    }
}
async fn req(
    state: &WebState,
    path: &str,
    cookie: Option<&str>,
    body: Option<Value>,
    origin: &str,
) -> Response {
    let mut request = Request::builder().uri(path).header("host", "todo.home");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if body.is_some() {
        request = request
            .method("POST")
            .header("content-type", "application/json")
            .header("x-gtd-request", "1")
            .header("origin", origin);
    }
    router(state.clone())
        .oneshot(
            request
                .body(
                    body.map(|b| Body::from(b.to_string()))
                        .unwrap_or_else(Body::empty),
                )
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn login(state: &WebState, remember: bool) -> (String, String) {
    let response = req(
        state,
        "/api/auth/login",
        None,
        Some(json!({"username":"owner","password":PASSWORD,"remember":remember})),
        "https://todo.home",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let header = response.headers()[SET_COOKIE].to_str().unwrap().to_owned();
    (header.split(';').next().unwrap().to_owned(), header)
}
#[tokio::test]
async fn all_private_routes_require_session_but_login_assets_are_accessible() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    for (path, data) in [
        ("/api/health", None),
        ("/api/logs", None),
        ("/api/tools/list_items", Some(json!({}))),
        (
            "/api/view",
            Some(json!({"view":"home","review_on":"2026-10-09"})),
        ),
        (
            "/api/tools/capture_item",
            Some(json!({"title":"unauthorized"})),
        ),
    ] {
        let response = req(&state, path, None, data, "https://todo.home").await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(body(response).await["code"], "authentication_required");
    }
    let status = body(req(&state, "/api/auth/session", None, None, "").await).await;
    assert_eq!(status["authenticated"], false);
    assert_eq!(
        req(&state, "/", None, None, "").await.status(),
        StatusCode::OK
    );
    for path in [
        "/tasks/not-an-id",
        "/projects/not-an-id",
        "/repeating/not-an-id",
        "/unknown",
        "/missing.js",
    ] {
        assert_eq!(
            req(&state, path, None, None, "").await.status(),
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    for path in [
        "/tasks",
        "/projects",
        "/repeating",
        "/review",
        "/activity",
        "/help",
        "/tasks/12345678-1234-1234-1234-123456789abc",
    ] {
        assert_eq!(
            req(&state, path, None, None, "").await.status(),
            StatusCode::OK,
            "{path}"
        );
    }
    assert_eq!(
        state
            .app
            .execute("list_items", json!({"view":"all"}))
            .await
            .unwrap()["items"],
        json!([])
    );
}
#[tokio::test]
async fn persistent_cookie_survives_restart_and_is_not_stored_as_a_bearer_token() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let (cookie, header) = login(&state, true).await;
    for attr in [
        "__Host-gtd_session=",
        "HttpOnly",
        "SameSite=Lax",
        "Secure",
        "Path=/",
        "Max-Age=",
    ] {
        assert!(header.contains(attr), "{attr}");
    }
    assert!(!header.contains("Domain="));
    drop(state);
    let state = setup(&dir);
    assert_eq!(
        body(req(&state, "/api/auth/session", Some(&cookie), None, "").await).await["authenticated"],
        true
    );
    assert_eq!(
        req(&state, "/api/health", Some(&cookie), None, "")
            .await
            .status(),
        StatusCode::OK
    );
    let db = rusqlite::Connection::open(dir.path().join("sessions.db")).unwrap();
    let (key, data): (String, String) = db
        .query_row("SELECT key,data FROM sessions", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert!(!key.contains(cookie.split('=').nth(1).unwrap()));
    assert!(!data.contains(HASH));
    assert!(!data.contains(PASSWORD));
    let tasks = rusqlite::Connection::open(dir.path().join("tasks.db")).unwrap();
    assert_eq!(
        tasks
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('sessions','login_attempts')",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
#[tokio::test]
async fn logout_revokes_replayed_cookie_and_login_rotates_it() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let (old, _) = login(&state, true).await;
    let response = req(
        &state,
        "/api/auth/login",
        Some(&old),
        Some(json!({"username":"owner","password":PASSWORD,"remember":true})),
        "https://todo.home",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let new = response.headers()[SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_ne!(old, new);
    assert_eq!(
        req(&state, "/api/health", Some(&old), None, "")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        req(
            &state,
            "/api/auth/logout",
            Some(&new),
            Some(json!({})),
            "https://todo.home"
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        req(&state, "/api/health", Some(&new), None, "")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn browser_session_has_no_max_age_and_a_server_side_twelve_hour_limit() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let (_, header) = login(&state, false).await;
    assert!(!header.contains("Max-Age="));
    let db = rusqlite::Connection::open(dir.path().join("sessions.db")).unwrap();
    let expires: i64 = db
        .query_row("SELECT expires FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert!((43190..=43200).contains(&(expires - chrono::Utc::now().timestamp())));
}
#[tokio::test]
async fn password_change_and_expiration_invalidate_sessions_without_restarting() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let (cookie, _) = login(&state, true).await;
    std::fs::write(
        dir.path().join("credentials.json"),
        json!({"username":"owner","password_hash":bcrypt::hash("new secret",4).unwrap()})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        req(&state, "/api/health", Some(&cookie), None, "")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    std::fs::write(
        dir.path().join("credentials.json"),
        json!({"username":"owner","password_hash":HASH}).to_string(),
    )
    .unwrap();
    let (cookie, _) = login(&state, true).await;
    let db = rusqlite::Connection::open(dir.path().join("sessions.db")).unwrap();
    db.execute("UPDATE sessions SET expires=0", []).unwrap();
    assert_eq!(
        req(&state, "/api/health", Some(&cookie), None, "")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn cross_site_login_logout_and_writes_are_rejected() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let (cookie, _) = login(&state, true).await;
    for path in [
        "/api/auth/login",
        "/api/auth/logout",
        "/api/tools/capture_item",
        "/api/view",
    ] {
        let response = req(
            &state,
            path,
            Some(&cookie),
            Some(json!({"username":"owner","password":PASSWORD,"title":"blocked"})),
            "https://evil.example",
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let request = Request::builder()
        .uri("/api/auth/login")
        .method("POST")
        .header("origin", "https://todo.home")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(Body::from("username=owner&password=password"))
        .unwrap();
    assert_eq!(
        router(state.clone())
            .oneshot(request)
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        req(&state, "/api/health", Some(&cookie), None, "")
            .await
            .status(),
        StatusCode::OK
    );
}
#[tokio::test]
async fn throttle_survives_restart_and_authentication_never_logs_passwords() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    for _ in 0..5 {
        assert_eq!(
            req(
                &state,
                "/api/auth/login",
                None,
                Some(json!({"username":"owner","password":"private-password-sentinel"})),
                "https://todo.home"
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    drop(state);
    let state = setup(&dir);
    let response = req(
        &state,
        "/api/auth/login",
        None,
        Some(json!({"username":"owner","password":PASSWORD})),
        "https://todo.home",
    )
    .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers().contains_key("retry-after"));
    let logs = state
        .app
        .diagnostics
        .list(Default::default())
        .unwrap()
        .to_string();
    assert!(!logs.contains("private-password-sentinel"));
    assert!(!logs.contains(HASH));
}
#[tokio::test]
async fn invalid_credential_file_fails_closed_and_is_never_exposed() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let (cookie, _) = login(&state, true).await;
    std::fs::write(dir.path().join("credentials.json"), "broken-private-secret").unwrap();
    let response = req(&state, "/api/health", Some(&cookie), None, "").await;
    assert!(response.status().is_server_error());
    let text = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(!text.contains("broken-private-secret"));
    assert!(
        Backend::open(
            dir.path().join("credentials.json"),
            dir.path().join("sessions.db"),
            true
        )
        .is_err()
    );
}

#[tokio::test]
async fn logged_out_session_cannot_be_resurrected_by_an_in_flight_save() {
    use axum_login::tower_sessions::SessionStore;
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let (cookie, _) = login(&state, true).await;
    let id = cookie.split('=').nth(1).unwrap().parse().unwrap();
    let store = &state.auth.as_ref().unwrap().store;
    let record = store.load(&id).await.unwrap().unwrap();
    req(
        &state,
        "/api/auth/logout",
        Some(&cookie),
        Some(json!({})),
        "https://todo.home",
    )
    .await;
    store.save(&record).await.unwrap();
    assert!(store.load(&id).await.unwrap().is_none());
    assert_eq!(
        req(&state, "/api/health", Some(&cookie), None, "")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn separate_environments_never_accept_each_others_sessions() {
    let first = TempDir::new().unwrap();
    let second = TempDir::new().unwrap();
    let production = setup(&first);
    let isolated = setup(&second);
    let (cookie, _) = login(&production, true).await;
    assert_eq!(
        req(&isolated, "/api/health", Some(&cookie), None, "")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}
#[test]
fn startup_requires_auth_and_test_bypass_cannot_expose_production() {
    for (environment, listen, bypass) in [
        ("production", "127.0.0.1:0", false),
        ("production", "127.0.0.1:0", true),
        ("test", "0.0.0.0:0", true),
    ] {
        let dir = TempDir::new().unwrap();
        let result = std::process::Command::new(env!("CARGO_BIN_EXE_todo-mcp"))
            .args(["--web", "--listen", listen])
            .env_remove("TODO_WEB_AUTH_FILE")
            .env_remove("TODO_WEB_SESSION_DB")
            .env_remove("TODO_SEARCH_URL")
            .env("TODO_DB_PATH", dir.path().join("tasks.db"))
            .env("TODO_ENVIRONMENT", environment)
            .env("TODO_WEB_AUTH_TEST_BYPASS", if bypass { "1" } else { "0" })
            .output()
            .unwrap();
        assert!(!result.status.success());
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(
            error.contains(if bypass {
                "Authentication bypass requires"
            } else {
                "TODO_WEB_AUTH_FILE"
            }),
            "{error}"
        );
    }
}

#[test]
fn session_store_refuses_task_or_diagnostic_database() {
    let dir = TempDir::new().unwrap();
    let _state = setup(&dir);
    for name in ["tasks.db", "logs.db"] {
        assert!(
            Backend::open(
                dir.path().join("credentials.json"),
                dir.path().join(name),
                true
            )
            .is_err()
        );
        let db = rusqlite::Connection::open(dir.path().join(name)).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='sessions'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn longer_throttle_returns_accurate_retry_delay() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let db = rusqlite::Connection::open(dir.path().join("sessions.db")).unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    for _ in 0..20 {
        db.execute("INSERT INTO login_attempts(at) VALUES (?)", [now - 120])
            .unwrap();
    }
    let response = req(
        &state,
        "/api/auth/login",
        None,
        Some(json!({"username":"owner","password":PASSWORD})),
        "https://todo.home",
    )
    .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let retry: i64 = response.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((770..=780).contains(&retry));
}

#[tokio::test]
async fn composed_home_uses_the_existing_session_and_omission_boundaries() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    state.app.execute("capture_item", json!({
        "request_id":"view-auth-fixture", "reason":"Disposable fixture", "title":"Private task","brief":"Review the private fixture.",
        "status":"next", "importance":"normal", "estimated_minutes":15, "effort":"low",
        "notes":"Human description", "agent_notes":"PRIVATE_AGENT_SENTINEL"
    })).await.unwrap();
    let (cookie, _) = login(&state, true).await;
    let response = req(
        &state,
        "/api/view",
        Some(&cookie),
        Some(json!({"view":"home","review_on":"2026-10-09","loading":"featured"})),
        "https://todo.home",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let data = body(response).await;
    assert_eq!(
        data["data"]["next"]["items"][0]["notes"],
        "Human description"
    );
    assert!(!data.to_string().contains("PRIVATE_AGENT_SENTINEL"));
    assert_eq!(
        req(
            &state,
            "/api/view",
            Some(&cookie),
            Some(json!({"view":"home","review_on":"2026-10-09","include_agent_notes":true})),
            "https://todo.home"
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    req(
        &state,
        "/api/auth/logout",
        Some(&cookie),
        Some(json!({})),
        "https://todo.home",
    )
    .await;
    assert_eq!(
        req(
            &state,
            "/api/view",
            Some(&cookie),
            Some(json!({"view":"home","review_on":"2026-10-09"})),
            "https://todo.home"
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}
