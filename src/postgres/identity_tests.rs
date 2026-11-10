use super::{tests::fixture, *};
use crate::identity::{
    http::Service,
    tests::{cached_verifier, claims, signed},
};
use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

#[test]
#[ignore = "Manual deterministic Node HTTP/Rust/RLS check; pinned disposable PostgreSQL, no live models"]
fn authenticated_node_adapter_preserves_native_contract_and_isolation() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let (_container, mut admin, config, a, b) = fixture();
    admin.execute("DELETE FROM gtd.tasks", &[]).unwrap();
    let store = Store::connect(config, Environment::Staging, 1).unwrap();
    let diagnostic_dir = tempfile::tempdir().unwrap();
    let diagnostics =
        crate::diagnostics::Diagnostics::open(&diagnostic_dir.path().join("service.db"), "account")
            .unwrap();
    let operations =
        crate::identity::operations::Operations::new(diagnostics.clone(), None).unwrap();
    let service = Service::new(
        store,
        cached_verifier(),
        "https://gtd.invalid/.well-known/oauth-protected-resource/mcp",
    )
    .unwrap()
    .with_operations(operations);
    // Keep synchronous pool/provider clients owned outside the async runtime;
    // their final destructors must run after its server tasks have stopped.
    let app = service.clone().router();
    let benchmark = std::env::var("GTD_ACTIVITY_BENCH").as_deref() == Ok("1");
    let baseline = benchmark.then(|| service.clone().with_separate_widget_binding().router());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (address, baseline_address) = runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let baseline_address = if let Some(baseline) = baseline {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, baseline).await.unwrap() });
            Some(format!("http://{address}"))
        } else {
            None
        };
        (address, baseline_address)
    });
    let payload = json!({"kind":"disposable-account-http","backendOrigin":format!("http://{address}"),"baselineOrigin":baseline_address,
        "a":{"id":a.to_string(),"token":signed(&claims("a"))},
        "b":{"id":b.to_string(),"token":signed(&claims("b"))}});
    let mut child = Command::new("node")
        .arg("adapter/tests/native-integration.mjs")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&payload).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Node native integration failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["passed"], true);
    assert_eq!(report["live_models"], 0);
    if benchmark {
        println!("GTD_WIDGET_HTTP={report}");
    }
    let logs = diagnostics.list(Default::default()).unwrap();
    let text = logs.to_string();
    for secret in [
        payload["a"]["token"].as_str().unwrap(),
        payload["b"]["token"].as_str().unwrap(),
        payload["a"]["id"].as_str().unwrap(),
        payload["b"]["id"].as_str().unwrap(),
    ] {
        assert!(!text.contains(secret));
    }
    let events = logs["events"].as_array().unwrap();
    assert!(events.len() > 5);
    assert!(
        events
            .iter()
            .all(|e| e["source"] == "mcp" && e["task_id"].is_null() && e["change_id"].is_null())
    );
}

#[test]
#[ignore = "Manual deterministic identity-to-RLS check; pinned disposable PostgreSQL, no live models"]
fn verified_http_identity_resolves_current_account_without_username_fallback() {
    let (_container, mut admin, config, a, b) = fixture();
    admin.execute("DELETE FROM gtd.tasks", &[]).unwrap();
    let store = Store::connect(config, Environment::Staging, 1).unwrap();
    let verifier = cached_verifier();
    let service = Service::new(
        store,
        verifier,
        "https://gtd.invalid/.well-known/oauth-protected-resource",
    )
    .unwrap();
    let app = service.router();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let send = |token: Option<&str>, path: &str, extra: Option<(&str, &str)>| {
        let mut request = Request::builder().uri(path);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, token);
        }
        if let Some((key, value)) = extra {
            request = request.header(key, value);
        }
        let response = runtime
            .block_on(app.clone().oneshot(request.body(Body::empty()).unwrap()))
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = runtime
            .block_on(response.into_body().collect())
            .unwrap()
            .to_bytes();
        let json: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert!(Uuid::parse_str(headers["x-request-id"].to_str().unwrap()).is_ok());
        (status, headers, json)
    };
    let a_token = signed(&claims("a"));
    let b_token = signed(&claims("b"));
    let tool = |token: &str, name: &str, value: Value| {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/internal/tools/{name}"))
            .header(header::AUTHORIZATION, token)
            .header(
                "x-gtd-expected-account",
                if token == a_token {
                    a.to_string()
                } else {
                    b.to_string()
                },
            )
            .header("x-gtd-expected-environment", "staging")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap();
        let response = runtime.block_on(app.clone().oneshot(request)).unwrap();
        let status = response.status();
        let body = runtime
            .block_on(response.into_body().collect())
            .unwrap()
            .to_bytes();
        (status, serde_json::from_slice::<Value>(&body).unwrap())
    };
    assert_eq!(
        send(None, "/internal/profile", None).0,
        StatusCode::UNAUTHORIZED
    );
    let (status, _, health) = send(None, "/internal/ready", None);
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health, json!({"ready":true}));
    let id = Uuid::new_v4().to_string();
    let (status, headers, body) = send(
        Some(&a_token),
        "/internal/profile",
        Some(("x-request-id", &id)),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-request-id"], id);
    assert_eq!(
        body,
        json!({"id":a.to_string(),"name":"a","nickname":"a","timezone":"America/New_York"})
    );
    let (_, _, body) = send(
        Some(&a_token),
        "/internal/profile",
        Some(("x-account-id", &b.to_string())),
    );
    assert_eq!(body["id"], a.to_string());
    assert_eq!(
        send(Some(&b_token), "/internal/profile", None).2["id"],
        b.to_string()
    );
    // Neither cookie ambient auth nor duplicated credentials are an identity.
    assert_eq!(
        send(None, "/internal/profile", Some(("cookie", "account_id=a"))).0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(
            Some(&a_token),
            "/internal/profile",
            Some(("authorization", &b_token))
        )
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(Some(&a_token), "/internal/profile?account_id=b", None).0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        send(
            Some(&a_token),
            "/internal/profile",
            Some(("origin", "https://untrusted.invalid"))
        )
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut impostor = claims("uninvited");
    impostor["preferred_username"] = json!("owner");
    assert_eq!(
        send(Some(&signed(&impostor)), "/internal/profile", None).0,
        StatusCode::FORBIDDEN
    );
    let capture = json!({"title":"Fixture capture","importance":"normal","agent_notes":"Context owned by A.",
        "notes":"Human detail.","request_id":"same-retry-key","reason":"Fixture"});
    let (status, created) = tool(&a_token, "capture_item", capture.clone());
    assert_eq!(status, StatusCode::OK, "{created}");
    let task_id = created["task"]["id"].as_str().unwrap();
    let (_, replay) = tool(&a_token, "capture_item", capture.clone());
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["task"]["id"], task_id);
    let (status, other) = tool(&b_token, "capture_item", capture.clone());
    assert_eq!(status, StatusCode::OK);
    assert_ne!(other["task"]["id"], task_id);
    assert_eq!(other["replayed"], false);
    let (status, read) = tool(
        &a_token,
        "list_items",
        json!({"task_id":task_id,"detail":"summary","include_agent_notes":false}),
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["items"][0]["agent_notes"], "Context owned by A.");
    assert_eq!(read["items"][0]["notes"], "Human detail.");
    let (_, cross) = tool(&b_token, "list_items", json!({"task_id":task_id}));
    assert!(!cross.to_string().contains(task_id));
    assert_eq!(
        tool(&a_token, "list_items", json!({"account_id":b.to_string()})).0,
        StatusCode::BAD_REQUEST
    );
    let mut empty_handoff = capture.clone();
    empty_handoff.as_object_mut().unwrap().remove("agent_notes");
    empty_handoff["request_id"] = json!("empty-handoff");
    assert_eq!(
        tool(&a_token, "capture_item", empty_handoff.clone()).0,
        StatusCode::BAD_REQUEST
    );
    let mut bypass = empty_handoff.clone();
    bypass["policy"] = json!("human");
    assert_eq!(
        tool(&a_token, "capture_item", bypass).0,
        StatusCode::BAD_REQUEST
    );
    let (status, human) = tool(
        &a_token,
        "gtd_ui_write",
        json!({"operation":"capture_item","arguments":empty_handoff}),
    );
    assert_eq!(status, StatusCode::OK, "{human}");
    let (_, ui) = tool(
        &a_token,
        "gtd_ui_read",
        json!({"operation":"list_items","arguments":{}}),
    );
    assert!(
        ui["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i.get("agent_notes").is_none())
    );
    let (_, sync) = tool(&a_token, "sync_state", json!({"limit":1}));
    let cursor = sync["next_cursor"].clone();
    assert!(cursor.is_string());
    assert_eq!(
        tool(&b_token, "sync_state", json!({"cursor":cursor})).0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        tool(
            &a_token,
            "gtd_ui_read",
            json!({"operation":"sync_state","arguments":{"cursor":cursor}})
        )
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        tool(
            &a_token,
            "gtd_ui_read",
            json!({"operation":"capture_item","arguments":capture})
        )
        .0,
        StatusCode::BAD_REQUEST
    );
    admin
        .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&a])
        .unwrap();
    assert_eq!(
        send(Some(&a_token), "/internal/profile", None).0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        tool(&a_token, "list_items", json!({})).0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        tool(&a_token, "capture_item", capture.clone()).0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(Some(&b_token), "/internal/profile", None).0,
        StatusCode::OK
    );
    admin
        .execute(
            "UPDATE gtd.accounts SET enrollment='pending' WHERE id=$1",
            &[&b],
        )
        .unwrap();
    assert_eq!(
        send(Some(&b_token), "/internal/profile", None).0,
        StatusCode::FORBIDDEN
    );
    admin
        .execute("UPDATE gtd.schema_meta SET identity=$1", &[&Uuid::new_v4()])
        .unwrap();
    let (status, _, health) = send(None, "/internal/ready", None);
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(health, json!({"ready":false}));
}
