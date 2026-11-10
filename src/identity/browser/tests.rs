use super::*;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde_json::{Value, json};

fn identity() -> BrowserIdentity {
    let mut identity = BrowserIdentity::new(
        super::super::tests::ISSUER,
        "gtd-web",
        "synthetic-client-secret".into(),
        "https://website.invalid/",
        "https://gtd.invalid/mcp",
    )
    .unwrap();
    identity.verifier = super::super::tests::cached_verifier();
    let metadata:CoreProviderMetadata=serde_json::from_value(json!({
        "issuer":identity.issuer,"authorization_endpoint":format!("{}/protocol/openid-connect/auth",identity.issuer),
        "token_endpoint":format!("{}/protocol/openid-connect/token",identity.issuer),
        "jwks_uri":format!("{}/protocol/openid-connect/certs",identity.issuer),
        "response_types_supported":["code"],"subject_types_supported":["public"],
        "id_token_signing_alg_values_supported":["RS256"]})).unwrap();
    let key: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/identity/a.json")).unwrap();
    *identity.metadata.lock().unwrap() = Some((
        metadata.set_jwks(serde_json::from_value(json!({"keys":[key]})).unwrap()),
        Instant::now(),
    ));
    identity
}
fn id_claims(nonce: &str) -> Value {
    let now = chrono::Utc::now().timestamp();
    json!({"iss":super::super::tests::ISSUER,"sub":"a","aud":"gtd-web","iat":now,"exp":now+60,
        "auth_time":now-30,"nonce":nonce})
}
fn response(access: &Value, id: Option<&Value>) -> CoreTokenResponse {
    let token = super::super::tests::signed(access)
        .strip_prefix("Bearer ")
        .unwrap()
        .to_owned();
    let mut result = json!({"access_token":token,"token_type":"Bearer","refresh_token":"synthetic-refresh","expires_in":120});
    if let Some(id) = id {
        let header = Header {
            kid: Some("a".into()),
            ..Header::new(Algorithm::RS256)
        };
        result["id_token"] = json!(
            encode(
                &header,
                id,
                &EncodingKey::from_rsa_pem(include_bytes!(
                    "../../../tests/fixtures/identity/a.pem"
                ))
                .unwrap()
            )
            .unwrap()
        );
    }
    serde_json::from_value(result).unwrap()
}

#[test]
fn website_authorization_uses_pkce_nonce_and_validated_returns() {
    let identity = identity();
    let authorization = identity
        .authorize(true, "/tasks/fixture?view=next", None, true)
        .unwrap();
    let query: std::collections::HashMap<_, _> = authorization.url.query_pairs().collect();
    assert_eq!(query["client_id"], "gtd-web");
    assert_eq!(query["response_type"], "code");
    assert_eq!(
        query["redirect_uri"],
        "https://website.invalid/api/auth/callback"
    );
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["max_age"], "0");
    assert!(
        query["scope"]
            .split(' ')
            .all(|v| ["openid", "gtd:access", "offline_access"].contains(&v))
    );
    assert!(query["scope"].contains("offline_access"));
    assert!(query["state"].len() >= 32);
    assert_ne!(query["code_challenge"], authorization.pending.verifier);
    let once = identity.authorize(false, "/", None, false).unwrap();
    assert!(
        !once
            .url
            .query_pairs()
            .any(|(k, v)| k == "scope" && v.contains("offline_access"))
    );
    assert_ne!(once.pending.state, authorization.pending.state);
    for invalid in [
        "https://other.invalid/",
        "//other.invalid/",
        "/\\other.invalid/",
        "/api/auth/callback",
        "/../api/secrets",
        "/tasks#fragment",
        "/tasks\n",
    ] {
        assert!(local_return_path(invalid).is_err(), "{invalid}");
    }
    let attempted = axum::http::Request::builder()
        .uri("https://other.invalid/token")
        .method("POST")
        .body(Vec::new())
        .unwrap();
    assert!(matches!(
        identity.request(attempted),
        Err(Error::Configuration)
    ));
    assert!(matches!(
        identity.exchange(&authorization.pending, "https://other.invalid", "code"),
        Err(Error::Invalid)
    ));
}

#[test]
fn oidc_tokens_reject_substitution_and_preserve_authentication_time() {
    let identity = identity();
    let authorization = identity.authorize(false, "/", None, false).unwrap();
    let client = identity.client().unwrap();
    let nonce_value = authorization.pending.nonce.clone();
    let nonce = &nonce_value;
    let mut access = super::super::tests::claims("a");
    access["auth_time"] = json!(chrono::Utc::now().timestamp() - 30);
    access["gtd_generation"] = json!(uuid::Uuid::new_v4());
    let mut id = id_claims(nonce);
    id["auth_time"] = access["auth_time"].clone();
    let tokens = identity
        .tokens(
            &client,
            &response(&access, Some(&id)),
            nonce,
            None,
            Some(&authorization.pending),
        )
        .unwrap();
    assert_eq!(
        tokens.authenticated_at(),
        access["auth_time"].as_i64().unwrap()
    );
    assert_eq!(tokens.principal().subject(), "a");
    // The OAuth expires_in value cannot extend the signed access-token lifetime.
    assert_eq!(tokens.expires_at, access["exp"].as_i64().unwrap());
    assert!(tokens.needs_refresh(tokens.expires_at - 10));
    for (key, value) in [
        ("nonce", json!("wrong")),
        ("sub", json!("b")),
        ("aud", json!("other-client")),
        ("iss", json!("https://other.invalid")),
        ("exp", json!(0)),
        ("iat", json!(chrono::Utc::now().timestamp() + 60)),
        ("at_hash", json!("wrong")),
        ("auth_time", json!(chrono::Utc::now().timestamp() - 300)),
    ] {
        let mut bad = id.clone();
        bad[key] = value;
        assert!(
            matches!(
                identity.tokens(
                    &client,
                    &response(&access, Some(&bad)),
                    nonce,
                    None,
                    Some(&authorization.pending)
                ),
                Err(Error::Invalid)
            ),
            "{key}"
        );
    }
    assert!(matches!(
        identity.tokens(
            &client,
            &response(&access, None),
            nonce,
            None,
            Some(&authorization.pending)
        ),
        Err(Error::Invalid)
    ));
    let renewed = identity
        .tokens(
            &client,
            &response(&access, None),
            nonce,
            Some(&tokens),
            None,
        )
        .unwrap();
    assert_eq!(renewed.authenticated_at, tokens.authenticated_at);
    let mut no_nonce = id.clone();
    no_nonce.as_object_mut().unwrap().remove("nonce");
    assert!(
        identity
            .tokens(
                &client,
                &response(&access, Some(&no_nonce)),
                nonce,
                Some(&tokens),
                None
            )
            .is_ok()
    );
    assert!(matches!(
        identity.tokens(
            &client,
            &response(&access, Some(&no_nonce)),
            nonce,
            None,
            Some(&authorization.pending)
        ),
        Err(Error::Invalid)
    ));
    no_nonce["nonce"] = json!("wrong");
    assert!(matches!(
        identity.tokens(
            &client,
            &response(&access, Some(&no_nonce)),
            nonce,
            Some(&tokens),
            None
        ),
        Err(Error::Invalid)
    ));
    for (key, value) in [
        ("sub", json!("b")),
        ("gtd_generation", json!(uuid::Uuid::new_v4())),
        ("auth_time", json!(chrono::Utc::now().timestamp())),
    ] {
        let mut bad = access.clone();
        bad[key] = value;
        assert!(
            matches!(
                identity.tokens(&client, &response(&bad, None), nonce, Some(&tokens), None),
                Err(Error::Invalid)
            ),
            "{key}"
        );
    }
    let mut recent = authorization.pending;
    recent.recent = true;
    assert!(matches!(
        identity.tokens(
            &client,
            &response(&access, Some(&id)),
            nonce,
            None,
            Some(&recent)
        ),
        Err(Error::Invalid)
    ));
}
