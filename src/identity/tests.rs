use super::*;
use jsonwebtoken::{EncodingKey, Header, encode};
use serde_json::{Value, json};
use std::{
    io::Write,
    net::TcpListener,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread,
};

pub(crate) const ISSUER: &str = "https://identity.invalid/storage-fixture";
const RESOURCE: &str = "https://gtd.invalid/mcp";
pub(crate) fn claims(subject: &str) -> Value {
    let now = jsonwebtoken::get_current_timestamp();
    json!({"iss":ISSUER,"sub":subject,"aud":RESOURCE,"iat":now,"exp":now+60,
        "typ":"Bearer","scope":"offline_access gtd:access"})
}
fn jwk(id: &str) -> Value {
    serde_json::from_str(if id == "a" {
        include_str!("../../tests/fixtures/identity/a.json")
    } else {
        include_str!("../../tests/fixtures/identity/b.json")
    })
    .unwrap()
}
fn sign(header: Header, claims: &Value, id: &str) -> String {
    let pem: &[u8] = if id == "a" {
        include_bytes!("../../tests/fixtures/identity/a.pem")
    } else {
        include_bytes!("../../tests/fixtures/identity/b.pem")
    };
    format!(
        "Bearer {}",
        encode(&header, claims, &EncodingKey::from_rsa_pem(pem).unwrap()).unwrap()
    )
}
fn header(id: &str) -> Header {
    Header {
        kid: Some(id.into()),
        ..Header::new(Algorithm::RS256)
    }
}
pub(crate) fn signed(claims: &Value) -> String {
    sign(header("a"), claims, "a")
}
pub(crate) fn cached_verifier() -> Verifier {
    let verifier = Verifier::new(ISSUER, RESOURCE).unwrap();
    *verifier.cache.lock().unwrap() = KeyCache {
        keys: keys::parse(&serde_json::to_vec(&json!({"keys":[jwk("a")]})).unwrap()).unwrap(),
        loaded: Some(Instant::now()),
        attempted: Some(Instant::now()),
        failed: false,
    };
    verifier
}

#[test]
fn access_token_contract_and_untrusted_headers() {
    let verifier = cached_verifier();
    let good = claims("a");
    assert!(verifier.verify(&signed(&good)).is_ok());
    let mut array = good.clone();
    array["aud"] = json!(["account", RESOURCE]);
    assert!(verifier.verify(&signed(&array)).is_ok());
    for (field, value) in [
        ("iss", json!("https://other.invalid")),
        ("aud", json!("wrong")),
        ("sub", json!("")),
        ("sub", json!("a\n")),
        ("typ", json!("ID")),
        ("exp", json!(0)),
        ("iat", json!("wrong type")),
        ("iat", json!(jsonwebtoken::get_current_timestamp() + 60)),
        ("exp", json!(jsonwebtoken::get_current_timestamp() + 3600)),
        ("nbf", json!(jsonwebtoken::get_current_timestamp() + 60)),
        ("auth_time", json!(-1)),
        (
            "auth_time",
            json!(jsonwebtoken::get_current_timestamp() + 60),
        ),
        ("gtd_generation", json!("not-a-uuid")),
    ] {
        let mut changed = good.clone();
        changed[field] = value;
        assert!(
            matches!(verifier.verify(&signed(&changed)), Err(Error::InvalidToken)),
            "{field}"
        );
    }
    for required in ["iss", "aud", "sub", "exp", "iat", "typ"] {
        let mut changed = good.clone();
        changed.as_object_mut().unwrap().remove(required);
        assert!(
            matches!(verifier.verify(&signed(&changed)), Err(Error::InvalidToken)),
            "{required}"
        );
    }
    for scope in [
        Value::Null,
        json!("openid profile"),
        json!("other:gtd:access"),
        json!("gtd:access:admin"),
    ] {
        let mut changed = good.clone();
        changed["scope"] = scope;
        assert!(matches!(
            verifier.verify(&signed(&changed)),
            Err(Error::InsufficientScope)
        ));
    }
    let mut h = header("a");
    h.jku = Some("http://127.0.0.1/private".into());
    assert!(matches!(
        verifier.verify(&sign(h, &good, "a")),
        Err(Error::InvalidToken)
    ));
    let mut h = header("a");
    h.crit = Some(vec!["custom".into()]);
    assert!(matches!(
        verifier.verify(&sign(h, &good, "a")),
        Err(Error::InvalidToken)
    ));
    let mut h = header("a");
    h.alg = Algorithm::RS512;
    assert!(matches!(
        verifier.verify(&sign(h, &good, "a")),
        Err(Error::InvalidToken)
    ));
    assert!(matches!(
        verifier.verify(&sign(header("a"), &good, "b")),
        Err(Error::InvalidToken)
    ));
    let h = Header {
        kid: Some("a".into()),
        ..Header::new(Algorithm::HS256)
    };
    let hmac = format!(
        "Bearer {}",
        encode(&h, &good, &EncodingKey::from_secret(b"not an RSA key")).unwrap()
    );
    assert!(matches!(verifier.verify(&hmac), Err(Error::InvalidToken)));
    for value in [
        "",
        "Bearer",
        "Basic a.b.c",
        "Bearer a.b",
        "Bearer  a.b.c",
        "Bearer a.b.c\n",
    ] {
        assert!(matches!(verifier.verify(value), Err(Error::InvalidToken)));
    }
    assert!(matches!(
        verifier.verify(&format!("Bearer {}", "a".repeat(MAX_TOKEN + 1))),
        Err(Error::InvalidToken)
    ));
}

#[test]
fn key_selection_and_configuration_fail_closed() {
    for url in [
        "http://identity.invalid/realm",
        "https://name:secret@identity.invalid/realm",
        "https://identity.invalid/realm?key=x",
        "https://identity.invalid/realm#fragment",
        "https://identity.invalid/realm/",
    ] {
        assert!(matches!(
            Verifier::new(url, RESOURCE),
            Err(Error::Configuration)
        ));
    }
    assert!(matches!(
        Verifier::new(ISSUER, "http://gtd.invalid/mcp"),
        Err(Error::Configuration)
    ));
    let a = jwk("a");
    for set in [
        json!({"keys":[]}),
        json!({"keys":[a.clone(),a.clone()]}),
        json!({"keys":vec![a.clone();65]}),
        json!({"keys":[{"kid":"secret","kty":"oct","k":"abc"}]}),
    ] {
        assert!(matches!(
            keys::parse(&serde_json::to_vec(&set).unwrap()),
            Err(Error::Unavailable)
        ));
    }
    for (field, value) in [
        ("use", json!("enc")),
        ("alg", json!("RS512")),
        ("key_ops", json!(["sign"])),
    ] {
        let mut wrong = a.clone();
        wrong[field] = value;
        assert!(matches!(
            keys::parse(&serde_json::to_vec(&json!({"keys":[wrong]})).unwrap()),
            Err(Error::Unavailable)
        ));
    }
}

struct KeyServer {
    url: Url,
    body: Arc<Mutex<(u16, Vec<u8>)>>,
    requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl KeyServer {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!("http://{}/certs", listener.local_addr().unwrap())).unwrap();
        let body = Arc::new(Mutex::new((
            200,
            serde_json::to_vec(&json!({"keys":[jwk("a")]})).unwrap(),
        )));
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (b, r, s) = (body.clone(), requests.clone(), stop.clone());
        let worker = thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = [0; 4096];
                        let n = stream.read(&mut request).unwrap();
                        assert!(
                            String::from_utf8_lossy(&request[..n])
                                .starts_with("GET /certs HTTP/1.1")
                        );
                        r.fetch_add(1, Ordering::SeqCst);
                        let (status, bytes) = b.lock().unwrap().clone();
                        let _ = write!(
                            stream,
                            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/never\r\nConnection: close\r\n\r\n",
                            bytes.len()
                        );
                        let _ = stream.write_all(&bytes);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("{e}"),
                }
            }
        });
        Self {
            url,
            body,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn verifier(&self) -> Verifier {
        // Only unit tests can override the operator-derived HTTPS key endpoint.
        let mut v = Verifier::new(ISSUER, RESOURCE).unwrap();
        v.jwks = self.url.clone();
        v
    }
}
impl Drop for KeyServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}
fn expire_cooldown(v: &Verifier) {
    v.cache.lock().unwrap().attempted =
        Some(Instant::now() - REFRESH_COOLDOWN - Duration::from_secs(1));
}
fn expire_cache(v: &Verifier) {
    v.cache.lock().unwrap().loaded = Some(Instant::now() - KEY_TTL - Duration::from_secs(1));
    expire_cooldown(v);
}

#[test]
fn bounded_key_fetch_rotation_concurrency_and_provider_outage() {
    let server = KeyServer::new();
    let verifier = server.verifier();
    let token = signed(&claims("a"));
    thread::scope(|scope| {
        for _ in 0..12 {
            let v = &verifier;
            let t = &token;
            scope.spawn(move || assert!(v.verify(t).is_ok()));
        }
    });
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
    let b = sign(header("b"), &claims("a"), "b");
    for _ in 0..20 {
        assert!(matches!(verifier.verify(&b), Err(Error::InvalidToken)));
    }
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
    *server.body.lock().unwrap() = (
        200,
        serde_json::to_vec(&json!({"keys":[jwk("a"),jwk("b")]})).unwrap(),
    );
    expire_cooldown(&verifier);
    assert!(verifier.verify(&b).is_ok());
    assert_eq!(server.requests.load(Ordering::SeqCst), 2);
    *server.body.lock().unwrap() = (503, b"private provider diagnostic must not escape".to_vec());
    expire_cache(&verifier);
    assert!(matches!(verifier.verify(&token), Err(Error::Unavailable)));
    assert!(matches!(verifier.verify(&token), Err(Error::Unavailable)));
    assert_eq!(server.requests.load(Ordering::SeqCst), 3);
    *server.body.lock().unwrap() = (
        200,
        serde_json::to_vec(&json!({"keys":[jwk("b")]})).unwrap(),
    );
    expire_cooldown(&verifier);
    assert!(verifier.verify(&b).is_ok());
    assert!(matches!(verifier.verify(&token), Err(Error::InvalidToken)));
    assert_eq!(server.requests.load(Ordering::SeqCst), 4);
}

#[test]
fn key_fetch_rejects_redirects_malformed_and_oversized_documents() {
    let server = KeyServer::new();
    let token = signed(&claims("a"));
    for (status, body) in [
        (302, b"redirect".to_vec()),
        (200, b"not json".to_vec()),
        (200, vec![b' '; 128 * 1024 + 1]),
    ] {
        *server.body.lock().unwrap() = (status, body);
        assert!(matches!(
            server.verifier().verify(&token),
            Err(Error::Unavailable)
        ));
    }
    assert_eq!(server.requests.load(Ordering::SeqCst), 3);
}
