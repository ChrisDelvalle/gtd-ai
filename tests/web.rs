use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::{
    application::Application,
    diagnostics::Diagnostics,
    store::Store,
    web::{AllowedOrigins, WebState, router},
};
use tower::ServiceExt;

fn setup(dir: &TempDir) -> WebState {
    WebState {
        app: Application::new(
            Store::open(dir.path().join("tasks.db"))
                .unwrap()
                .with_origin("website"),
            Diagnostics::open(&dir.path().join("logs.db"), "web").unwrap(),
        ),
        origins: AllowedOrigins::from_config(None, None).unwrap(),
        health_socket: dir.path().join("missing.sock"),
        auth: None,
    }
}

#[tokio::test]
async fn hashed_assets_negotiate_compression_without_caching_private_or_missing_responses() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let assets = todo_mcp::web::assets_dir();
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(assets.join("asset-manifest.json"))
            .expect("build website before testing delivery"),
    )
    .unwrap();
    let name = manifest
        .as_object()
        .unwrap()
        .keys()
        .find(|name| name.ends_with(".css"))
        .unwrap();
    let path = format!("/assets/{name}");
    for (accept, extension, encoding) in [
        ("br, gzip", ".br", Some("br")),
        ("gzip, br;q=0", ".gz", Some("gzip")),
        ("br;q=0, gzip;q=0", "", None),
    ] {
        let response = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri(&path)
                    .header("accept-encoding", accept)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(response.headers()["vary"], "Accept-Encoding");
        assert_eq!(
            response
                .headers()
                .get("content-encoding")
                .map(|h| h.to_str().unwrap()),
            encoding
        );
        assert!(
            response.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with("text/css")
        );
        let modified = response.headers()["last-modified"].clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            &bytes[..],
            std::fs::read(assets.join("assets").join(format!("{name}{extension}"))).unwrap()
        );
        let head = router(state.clone())
            .oneshot(
                Request::builder()
                    .method("HEAD")
                    .uri(&path)
                    .header("accept-encoding", accept)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            head.headers()["content-length"].to_str().unwrap(),
            bytes.len().to_string()
        );
        assert!(
            head.into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );
        let unchanged = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri(&path)
                    .header("accept-encoding", accept)
                    .header("if-modified-since", modified)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
    }
    let range = router(state.clone())
        .oneshot(
            Request::builder()
                .uri(&path)
                .header("range", "bytes=0-9")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        range.into_body().collect().await.unwrap().to_bytes().len(),
        10
    );
    for (url, code) in [
        ("/", StatusCode::OK),
        ("/api/auth/session", StatusCode::OK),
        ("/assets/missing-ABCDEFGH.js", StatusCode::NOT_FOUND),
        ("/missing-route", StatusCode::NOT_FOUND),
    ] {
        let response = router(state.clone())
            .oneshot(Request::builder().uri(url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), code, "{url}");
        assert_eq!(response.headers()["cache-control"], "no-store", "{url}");
    }
}
async fn call(
    state: &WebState,
    name: &str,
    args: Value,
    origin: Option<&str>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method("POST")
        .uri(format!("/api/tools/{name}"))
        .header("content-type", "application/json")
        .header("x-gtd-request", "1");
    if let Some(origin) = origin {
        req = req.header("origin", origin);
    }
    let response = router(state.clone())
        .oneshot(req.body(Body::from(args.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}
#[tokio::test]
async fn website_permissions_retries_conflicts_and_shared_mcp_state() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let capture = json!({"estimated_minutes":30,"effort":"medium","importance":"normal","title":"<script>danger()</script>","notes":"private body sentinel","reason":"web test","request_id":"web-first"});
    for origin in [None, Some("https://evil.example"), Some("null")] {
        assert_eq!(
            call(&state, "capture_item", capture.clone(), origin)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let (status, first) = call(
        &state,
        "capture_item",
        capture.clone(),
        Some("https://todo.home"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["change"]["origin"], "website");
    let (_, retry) = call(&state, "capture_item", capture, Some("https://todo.home")).await;
    assert_eq!(retry["replayed"], true);
    let mcp = Application::new(
        Store::open(dir.path().join("tasks.db"))
            .unwrap()
            .with_origin("mcp"),
        Diagnostics::open(&dir.path().join("logs.db"), "mcp").unwrap(),
    );
    let changed=mcp.execute("update_item",json!({"task_id":first["task"]["id"],"expected_version":1,"status":"done","request_id":"mcp-edit","brief":"Complete the fixture action.","agent_notes":"The test confirms this particular action is complete.","reason":"external concurrent change"})).await.unwrap();
    assert_eq!(changed["change"]["origin"], "mcp");
    let (status,_)=call(&state,"update_item",json!({"task_id":first["task"]["id"],"expected_version":1,"notes":"draft","request_id":"stale-web","reason":"stale"}),Some("https://todo.home")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_,undone)=call(&state,"undo_change",json!({"change_id":changed["change"]["id"],"expected_version":2,"request_id":"undo-web","reason":"undo"}),Some("https://todo.home")).await;
    assert_eq!(undone["task"]["status"], "inbox");
    let logs = state
        .app
        .diagnostics
        .list(Default::default())
        .unwrap()
        .to_string();
    assert!(!logs.contains("private body sentinel"));
    assert!(!logs.contains("danger()"));
    assert!(logs.contains("origin_rejected"));
    assert!(logs.contains("conflict"));
}
#[tokio::test]
async fn http_read_security_and_disconnected_health() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(
        response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["database"], true);
    assert_eq!(body["tunnel"]["ready"], false);
    let req = Request::builder()
        .method("POST")
        .uri("/api/tools/capture_item")
        .header("origin", "https://todo.home")
        .header("x-gtd-request", "1")
        .header("content-type", "text/plain")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(
        router(state).oneshot(req).await.unwrap().status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
}

#[tokio::test]
async fn batch_endpoint_authorization_rollback_audit_links_and_log_privacy() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let args = json!({"request_id":"batch-private-request","operations":[
        {"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"BATCH_PRIVATE_TITLE","notes":"BATCH_PRIVATE_NOTES","reason":"BATCH_PRIVATE_REASON"},
        {"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"B","reason":"test"}
    ]});
    assert_eq!(
        call(
            &state,
            "apply_changes",
            args.clone(),
            Some("https://evil.example")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, result) = call(
        &state,
        "apply_changes",
        args.clone(),
        Some("https://todo.home"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["results"].as_array().unwrap().len(), 2);
    let (_, audit) = call(
        &state,
        "list_changes",
        json!({"change_id":result["results"][0]["change_id"],"detail":"full"}),
        Some("https://todo.home"),
    )
    .await;
    assert_eq!(audit["changes"][0]["origin"], "website");
    assert_eq!(
        audit["changes"][0]["after"]["id"],
        result["results"][0]["entity_id"]
    );
    let (_, replay) = call(&state, "apply_changes", args, Some("https://todo.home")).await;
    assert_eq!(replay["replayed"], true);
    let (_,invalid)=call(&state,"apply_changes",json!({"request_id":"invalid","operations":[{"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"X","reason":"test","extra":true}]}),Some("https://todo.home")).await;
    assert_eq!(invalid["code"], "invalid_input");
    let failed = json!({"request_id":"failed","operations":[
        {"operation":"capture","estimated_minutes":30,"effort":"medium","importance":"normal","title":"ROLLED_BACK","reason":"test"},
        {"operation":"update","task_id":result["results"][0]["entity_id"],"expected_version":99,"status":"done","reason":"test"}
    ]});
    let (status, error) = call(&state, "apply_changes", failed, Some("https://todo.home")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("Nothing in this batch was saved")
    );
    let (_, list) = call(&state, "list_items", json!({}), Some("https://todo.home")).await;
    assert_eq!(list["items"].as_array().unwrap().len(), 2);
    let logs = state.app.diagnostics.list(Default::default()).unwrap();
    let text = logs.to_string();
    assert!(text.contains("Batch change IDs: 1, 2"));
    for private in [
        "BATCH_PRIVATE_TITLE",
        "BATCH_PRIVATE_NOTES",
        "BATCH_PRIVATE_REASON",
        "batch-private-request",
        "ROLLED_BACK",
    ] {
        assert!(!text.contains(private));
    }
    let events = logs["events"].as_array().unwrap();
    assert!(
        events
            .iter()
            .any(|e| e["operation"] == "apply_changes" && e["replayed"] == true)
    );
    assert!(
        events
            .iter()
            .any(|e| e["operation"] == "apply_changes" && e["code"] == "conflict")
    );
}

#[test]
fn origin_configuration_fails_closed() {
    assert!(AllowedOrigins::from_config(None, None).is_ok());
    assert!(AllowedOrigins::from_config(None, Some("http://127.0.0.1:18084")).is_ok());
    assert!(AllowedOrigins::from_config(Some("https://todo.home"), Some("invalid legacy")).is_ok());
    for bad in [
        "",
        " ",
        "*",
        "null",
        "https://*.example.com",
        "https://todo.home/",
        "https://todo.home/path",
        "https://todo.home?x=1",
        "https://todo.home#fragment",
        "https://user:password@todo.home",
        "ftp://todo.home",
        "https://todo.home,",
        "https://todo.home:443",
        "https://todo.home https://evil.example",
    ] {
        assert!(
            AllowedOrigins::from_config(Some(bad), Some("https://todo.home")).is_err(),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn multiple_origins_share_data_and_keep_cross_origin_guards() {
    let dir = TempDir::new().unwrap();
    let mut state = setup(&dir);
    let origins = [
        "https://todo.home",
        "https://todo.example.com",
        "https://todo.private.example",
    ];
    state.origins = AllowedOrigins::from_config(Some(&origins.join(", ")), None).unwrap();
    let (_, saved) = call(
        &state,
        "capture_item",
        json!({"estimated_minutes":30,"effort":"medium","importance":"normal","title":"Remote access test", "reason":"test", "request_id":"remote-origin"}),
        Some(origins[1]),
    )
    .await;
    assert!(saved["task"]["id"].is_string());
    for origin in origins {
        let (status, list) = call(&state, "list_items", json!({}), Some(origin)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list["items"][0]["id"], saved["task"]["id"]);
    }
    for origin in [
        "https://todo.example.com.evil.example",
        "http://todo.example.com",
        "https://todo.example.com:444",
        "https://evil.example",
        "null",
    ] {
        assert_eq!(
            call(&state, "list_items", json!({}), Some(origin)).await.0,
            StatusCode::FORBIDDEN
        );
    }
    for kind in [
        "cross-site",
        "same-site",
        "missing-header",
        "multiple-origins",
    ] {
        let mut req = Request::builder()
            .method("POST")
            .uri("/api/tools/list_items")
            .header("origin", origins[1])
            .header("content-type", "application/json");
        if kind != "missing-header" {
            req = req.header("x-gtd-request", "1");
        }
        if kind == "multiple-origins" {
            req = req.header("origin", origins[0]);
        }
        if kind == "cross-site" || kind == "same-site" {
            req = req.header("sec-fetch-site", kind);
        }
        assert_eq!(
            router(state.clone())
                .oneshot(req.body(Body::from("{}")).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN,
            "{kind}"
        );
    }
    // A legacy origin is not implicitly retained when the explicit list is supplied.
    state.origins = AllowedOrigins::from_config(Some(origins[1]), Some(origins[0])).unwrap();
    assert_eq!(
        call(&state, "list_items", json!({}), Some(origins[0]))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn stale_environment_headers_refuse_writes_without_consuming_retry_keys() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    let arguments = json!({"estimated_minutes":30,"effort":"medium","importance":"normal","request_id":"environment-guard","title":"A genuine new action","reason":"Environment header regression"});
    for expected in ["demo", "test", "unknown", "", "production,demo"] {
        let request = Request::builder()
            .method("POST")
            .uri("/api/tools/capture_item")
            .header("origin", "https://todo.home")
            .header("x-gtd-request", "1")
            .header("content-type", "application/json")
            .header("x-gtd-environment", expected)
            .body(Body::from(arguments.to_string()))
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let error: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(error["code"], "environment_changed");
        assert_eq!(error["environment"], "production");
        assert_eq!(error["retryable"], false);
    }
    let (_, history) = call(&state, "list_changes", json!({}), Some("https://todo.home")).await;
    assert_eq!(history["changes"].as_array().unwrap().len(), 0);
    let request = Request::builder()
        .method("POST")
        .uri("/api/tools/capture_item")
        .header("origin", "https://todo.home")
        .header("x-gtd-request", "1")
        .header("content-type", "application/json")
        .header("x-gtd-environment", "production")
        .body(Body::from(arguments.to_string()))
        .unwrap();
    let response = router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let saved: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(saved["replayed"], false);
    let (status, replayed) =
        call(&state, "capture_item", arguments, Some("https://todo.home")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replayed["replayed"], true);
    let logs = state
        .app
        .diagnostics
        .list(Default::default())
        .unwrap()
        .to_string();
    assert!(logs.contains("environment_changed"));
    assert!(!logs.contains("A genuine new action"));
}

#[tokio::test]
async fn ambiguous_environment_headers_fail_closed_on_reads_and_writes() {
    let dir = TempDir::new().unwrap();
    let state = setup(&dir);
    for name in ["list_items", "capture_item"] {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/tools/{name}"))
            .header("origin", "https://todo.home")
            .header("x-gtd-request", "1")
            .header("content-type", "application/json")
            .header("x-gtd-environment", "production")
            .header("x-gtd-environment", "demo")
            .body(Body::from("{}"))
            .unwrap();
        let response = router(state.clone()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let error: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(error["code"], "environment_changed");
    }
}
