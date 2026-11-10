use super::*;
#[test]
fn browser_boundary_rejects_ambient_authority_and_ambiguous_cookies() {
    let mut headers = HeaderMap::new();
    for (key, value) in [
        ("origin", "https://website.invalid"),
        ("content-type", "application/json"),
        ("x-gtd-request", "1"),
        ("sec-fetch-site", "same-origin"),
    ] {
        headers.insert(key, value.parse().unwrap());
    }
    assert!(valid_post(&headers, "https://website.invalid"));
    assert!(!valid_post(&headers, "https://other.invalid"));
    headers.append("origin", "https://website.invalid".parse().unwrap());
    assert!(!valid_post(&headers, "https://website.invalid"));
    headers.insert("origin", "https://website.invalid".parse().unwrap());
    headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
    assert!(!valid_post(&headers, "https://website.invalid"));
    let key = CookieKey::random();
    headers.insert(
        header::COOKIE,
        format!("unrelated=x; {SESSION}={}", key.value())
            .parse()
            .unwrap(),
    );
    assert_eq!(
        cookie(&headers, SESSION).ok().flatten().unwrap().value(),
        key.value()
    );
    headers.append(
        header::COOKIE,
        format!("{SESSION}={}", key.value()).parse().unwrap(),
    );
    assert!(cookie(&headers, SESSION).is_err());
    headers.insert(
        header::COOKIE,
        format!("{SESSION}=malformed").parse().unwrap(),
    );
    assert!(cookie(&headers, SESSION).is_err());
    let mut response = StatusCode::OK.into_response();
    set_cookie(&mut response, SESSION, key.value(), None);
    let value = response.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(value.contains("; Path=/; Secure; HttpOnly; SameSite=Lax"));
    assert!(!value.contains("Max-Age") && !value.contains("Domain"));
    let mut response = StatusCode::OK.into_response();
    set_cookie(&mut response, SESSION, key.value(), Some(30 * 24 * 3600));
    assert!(
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .ends_with("Max-Age=2592000")
    );
}
