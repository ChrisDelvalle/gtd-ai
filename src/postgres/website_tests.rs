//! Full cookie HTTP boundary against disposable PostgreSQL. The stored tokens
//! are synthetic fixture data, never credentials from a browser or provider.
use super::*;
use crate::identity::{
    browser::BrowserIdentity, provisioning::keycloak::Keycloak, website,
    website_session::WebsiteSessions,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

#[test]
#[ignore = "Manual deterministic website test; disposable PostgreSQL, no live models"]
fn website_sessions_enforce_account_csrf_and_administration_boundaries() {
    let (_container, mut db, config, a, b) = tests::fixture();
    // Initial minimal storage fixture records are not full task documents.
    db.execute("DELETE FROM gtd.tasks", &[]).unwrap();
    db.execute(
        "UPDATE gtd.accounts SET administrator=true WHERE id=$1",
        &[&a],
    )
    .unwrap();
    let store = Store::connect(config, Environment::Staging, 4).unwrap();
    let provider = BrowserIdentity::new(
        "https://127.0.0.1:9/disposable-unavailable-provider",
        "web",
        "synthetic-secret".into(),
        "https://website.invalid/",
        "https://gtd.invalid/mcp",
    )
    .unwrap();
    let sessions = WebsiteSessions::new(store.clone(), provider);
    let admin = Keycloak::new(
        "http://127.0.0.1:9/",
        tests::ISSUER,
        "fixture",
        "admin",
        "synthetic-secret".into(),
        vec!["web".into()],
    )
    .unwrap();
    let diagnostic_dir = tempfile::tempdir().unwrap();
    let diagnostics =
        crate::diagnostics::Diagnostics::open(&diagnostic_dir.path().join("service.db"), "account")
            .unwrap();
    let operations = crate::identity::operations::Operations::new(diagnostics, None).unwrap();
    let service = website::Service::new(
        store.clone(),
        sessions,
        admin,
        "https://website.invalid/",
        tests::ISSUER,
    )
    .unwrap()
    .with_operations(operations);
    let vault = sessions::Sessions::new(store.clone());
    let key = sessions::CookieKey::random();
    let csrf = sessions::CookieKey::random();
    let now = chrono::Utc::now().timestamp();
    let document = |subject: &str, auth: i64| {
        json!({"tokens":{
        "access_token":"synthetic-access", "refresh_token":"synthetic-refresh", "nonce":"fixture",
        "issuer":tests::ISSUER,"subject":subject,"generation":null,"authenticated_at":auth,"expires_at":now+120
    },"csrf":csrf.value(),"remember":false})
    };
    vault
        .create(&key, &tests::principal("a"), &document("a", now), false)
        .unwrap();
    let other = sessions::CookieKey::random();
    vault
        .create(&other, &tests::principal("b"), &document("b", now), false)
        .unwrap();
    let stale = sessions::CookieKey::random();
    vault
        .create(
            &stale,
            &tests::principal("a"),
            &document("a", now - 600),
            false,
        )
        .unwrap();
    let request = |method: &str,
                   path: &str,
                   key: &sessions::CookieKey,
                   account: Uuid,
                   csrf_value: &str,
                   body: Value| {
        Request::builder()
            .method(method)
            .uri(path)
            .header("origin", "https://website.invalid")
            .header("content-type", "application/json")
            .header("x-gtd-request", "1")
            .header("x-gtd-csrf", csrf_value)
            .header("x-gtd-account", account.to_string())
            .header("x-gtd-environment", "staging")
            .header("cookie", format!("__Host-gtd_session={}", key.value()))
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let operation_request = Uuid::new_v4();
    let op = store
        .begin_administration(
            &administration::WebsiteIdentity::from_verified_session(&tests::principal("a"), now),
            operation_request,
            administration::Command::Invite {
                username: "lookup-fixture".into(),
                display_name: None,
            },
        )
        .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let router=service.clone().router();
        // The public shell contains no records or identity. Its asset middleware
        // must not overwrite API authentication or turn unknown APIs into HTML.
        for (path, expected) in [
            ("/",StatusCode::OK), ("/users",StatusCode::OK),
            ("/tasks/00000000-0000-4000-8000-000000000001",StatusCode::OK),
            ("/tasks/not-an-id",StatusCode::NOT_FOUND),
            ("/api/nonexistent",StatusCode::NOT_FOUND),
            ("/assets/missing-12345678.js",StatusCode::NOT_FOUND),
        ] {
            let response=router.clone().oneshot(Request::builder().uri(path).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(),expected,"{path}");
            assert_eq!(response.headers()["cache-control"],"no-store");
            assert!(response.headers()["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
            let body=response.into_body().collect().await.unwrap().to_bytes();
            if expected==StatusCode::OK { assert!(String::from_utf8_lossy(&body).contains("<title>GTD</title>")); }
            else { assert!(!String::from_utf8_lossy(&body).contains("<title>GTD</title>")); }
        }
        let manifest:Value=serde_json::from_slice(&std::fs::read(crate::web::assets_dir().join("asset-manifest.json")).expect("build website before delivery acceptance")).unwrap();
        let css=manifest.as_object().unwrap().keys().find(|key|key.ends_with(".css")).unwrap();
        let response=router.clone().oneshot(Request::builder().uri(format!("/assets/{css}"))
            .header("accept-encoding","br, gzip").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(),StatusCode::OK);
        assert_eq!(response.headers()["content-encoding"],"br");
        assert_eq!(response.headers()["cache-control"],"public, max-age=31536000, immutable");
        let denied=router.clone().oneshot(Request::builder().method("POST").uri("/api/view")
            .header("origin","https://website.invalid").header("x-gtd-request","1").header("content-type","application/json")
            .body(Body::from("{\"view\":\"home\",\"review_on\":\"2026-10-16\"}")).unwrap()).await.unwrap();
        assert_eq!(denied.status(),StatusCode::UNAUTHORIZED);
        assert_eq!(denied.headers()["cache-control"],"no-store");
        assert_eq!(denied.headers()["content-security-policy"],"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        let anonymous=router.clone().oneshot(Request::builder().uri("/api/auth/session")
            .header("cookie","__Host-gtd_session=malformed").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(anonymous.status(),StatusCode::OK);
        assert!(!anonymous.headers().contains_key("set-cookie"));
        let anonymous:Value=serde_json::from_slice(&anonymous.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(anonymous["authenticated"],false);
        let response=router.clone().oneshot(request("GET","/api/auth/session",&key,a,csrf.value(),json!({}))).await.unwrap();
        assert_eq!(response.status(),StatusCode::OK);
        assert_eq!(response.headers()["cache-control"],"no-store");
        let status:Value=serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(status["account"]["id"],a.to_string());
        assert_eq!(status["account"]["administrator"],true);
        assert_eq!(status["csrf"],csrf.value());
        assert!(!status.to_string().contains("synthetic-access"));
        let timezone=json!({"expected_timezone":"America/New_York","timezone":"Europe/Paris"});
        for (account,anti,status) in [(a,csrf.value(),StatusCode::CONFLICT),(b,"wrong",StatusCode::FORBIDDEN)] {
            let response=router.clone().oneshot(request("POST","/api/account/timezone",&other,account,anti,timezone.clone())).await.unwrap();
            assert_eq!(response.status(),status);
        }
        // Ordinary accounts can change only their own default, with explicit
        // conflict detection and a harmless same-value response-lost retry.
        for _ in 0..2 {
            let response=router.clone().oneshot(request("POST","/api/account/timezone",&other,b,csrf.value(),timezone.clone())).await.unwrap();
            let status=response.status();
            let body=response.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(status,StatusCode::OK,"{}",String::from_utf8_lossy(&body));
            assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["timezone"],"Europe/Paris");
        }
        for (input,status) in [
            (json!({"expected_timezone":"America/New_York","timezone":"Asia/Tokyo"}),StatusCode::CONFLICT),
            (json!({"expected_timezone":"Europe/Paris","timezone":"Not/AZone"}),StatusCode::BAD_REQUEST),
            (json!({"expected_timezone":"Europe/Paris","timezone":"Asia/Tokyo","account_id":a}),StatusCode::UNPROCESSABLE_ENTITY),
        ] {
            let response=router.clone().oneshot(request("POST","/api/account/timezone",&other,b,csrf.value(),input)).await.unwrap();
            assert_eq!(response.status(),status);
        }
        for (cookie,account,zone) in [(&key,a,"America/New_York"),(&other,b,"Europe/Paris")] {
            let response=router.clone().oneshot(request("GET","/api/auth/session",cookie,account,csrf.value(),json!({}))).await.unwrap();
            let status:Value=serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
            assert_eq!(status["account"]["timezone"],zone);
        }
        let capture=json!({"title":"Human Inbox fixture","request_id":Uuid::new_v4().to_string(),"importance":"normal","reason":"Deterministic website fixture"});
        for (account,anti,status) in [(b,csrf.value(),StatusCode::CONFLICT),(a,"wrong",StatusCode::FORBIDDEN)] {
            let response=router.clone().oneshot(request("POST","/api/tools/capture_item",&key,account,anti,capture.clone())).await.unwrap();
            assert_eq!(response.status(),status);
        }
        let response=router.clone().oneshot(request("POST","/api/tools/capture_item",&key,a,csrf.value(),capture.clone())).await.unwrap();
        let status=response.status();
        let body=response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(status,StatusCode::OK,"{}",String::from_utf8_lossy(&body));
        // Historical retry returns the same result; website human capture does
        // not require fabricated briefs or agent handoffs.
        let retry=router.clone().oneshot(request("POST","/api/tools/capture_item",&key,a,csrf.value(),capture)).await.unwrap();
        let mut first:Value=serde_json::from_slice(&body).unwrap();
        assert_eq!(first["change"]["origin"],"website");
        first["replayed"]=json!(true);
        let repeated:Value=serde_json::from_slice(&retry.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(first,repeated);
        for path in ["/api/health","/api/logs"] {
            let denied=router.clone().oneshot(request("GET",path,&other,b,csrf.value(),json!({}))).await.unwrap();
            assert_eq!(denied.status(),StatusCode::FORBIDDEN);
            let response=router.clone().oneshot(request("GET",path,&key,a,csrf.value(),json!({}))).await.unwrap();
            assert_eq!(response.status(),StatusCode::OK);
            assert_eq!(response.headers()["cache-control"],"no-store");
            let body=response.into_body().collect().await.unwrap().to_bytes();
            let text=String::from_utf8_lossy(&body);
            for private in ["Human Inbox fixture","synthetic-access","synthetic-refresh",csrf.value(),first["task"]["id"].as_str().unwrap()] {
                assert!(!text.contains(private),"service diagnostics leaked private content");
            }
            let value:Value=serde_json::from_slice(&body).unwrap();
            if path=="/api/health" {
                assert_eq!(value["database"],true);
                assert_eq!(value["diagnostics"]["available"],true);
                assert_eq!(value["search"]["store_checkpoint"],1);
                assert_eq!(value["tunnel"]["configured"],false);
            } else {
                let events=value["events"].as_array().unwrap();
                assert!(events.iter().any(|e|e["operation"]=="capture_item" && e["source"]=="web"));
                assert!(events.iter().all(|e|e["task_id"].is_null() && e["change_id"].is_null()));
                assert!(events.iter().all(|e|e["message"].as_str().unwrap().starts_with("Request ")));
            }
        }
        let users=router.clone().oneshot(request("GET","/api/users",&key,a,csrf.value(),json!({}))).await.unwrap();
        assert_eq!(users.status(),StatusCode::OK);
        for path in [format!("/api/users/requests/{operation_request}"),format!("/api/users/operations/{}",op.id)] {
            let inspection=router.clone().oneshot(request("GET",&path,&stale,a,csrf.value(),json!({}))).await.unwrap();
            assert_eq!(inspection.status(),StatusCode::OK);
            let inspected:Value=serde_json::from_slice(&inspection.into_body().collect().await.unwrap().to_bytes()).unwrap();
            assert_eq!(inspected["operation"]["id"],op.id.to_string());
            assert!(!inspected.to_string().contains("password"));
            let denied=router.clone().oneshot(request("GET",&path,&other,b,csrf.value(),json!({}))).await.unwrap();
            assert_eq!(denied.status(),StatusCode::FORBIDDEN);
        }
        let denied=router.clone().oneshot(request("GET","/api/users",&other,b,csrf.value(),json!({}))).await.unwrap();
        assert_eq!(denied.status(),StatusCode::FORBIDDEN);
        let input=json!({"request_id":Uuid::new_v4(),"command":{"action":"invite","username":"fixture-new"}});
        let reauth=router.clone().oneshot(request("POST","/api/users/operations",&stale,a,csrf.value(),input)).await.unwrap();
        assert_eq!(reauth.status(),StatusCode::FORBIDDEN);
        let value:Value=serde_json::from_slice(&reauth.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(value["code"],"reauthentication_required");
        let response=router.oneshot(request("POST","/api/tools/unknown",&key,a,csrf.value(),json!({}))).await.unwrap();
        assert_eq!(response.status(),StatusCode::NOT_FOUND);
    });
    assert_eq!(
        db.query_one("SELECT count(*) FROM gtd.tasks WHERE account_id=$1", &[&a])
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    assert_eq!(
        db.query_one("SELECT count(*) FROM gtd.tasks WHERE account_id=$1", &[&b])
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    // Disablement is enforced despite a still-valid cached provider token.
    db.execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&b])
        .unwrap();
    runtime.block_on(async {
        let response = service
            .clone()
            .router()
            .oneshot(request(
                "POST",
                "/api/account/timezone",
                &other,
                b,
                csrf.value(),
                json!({"expected_timezone":"Europe/Paris","timezone":"Asia/Tokyo"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = service
            .clone()
            .router()
            .oneshot(request(
                "POST",
                "/api/tools/list_items",
                &other,
                b,
                csrf.value(),
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let refused = service
            .clone()
            .router()
            .oneshot(request(
                "POST",
                "/api/auth/logout",
                &other,
                b,
                "invalid",
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        let logged_out = service
            .clone()
            .router()
            .oneshot(request(
                "POST",
                "/api/auth/logout",
                &other,
                b,
                csrf.value(),
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(logged_out.status(), StatusCode::OK);
        assert!(
            logged_out
                .headers()
                .get_all("set-cookie")
                .iter()
                .all(|v| v.to_str().unwrap().ends_with("Max-Age=0"))
        );
    });
    assert_eq!(
        db.query_one(
            "SELECT count(*) FROM gtd.web_sessions WHERE account_id=$1",
            &[&b]
        )
        .unwrap()
        .get::<_, i64>(0),
        0
    );
    drop(runtime);
    drop(service);
    drop(store);
}
