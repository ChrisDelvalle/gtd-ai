//! Resource-server access-token verification. This is deliberately independent
//! of browser sessions and the Node MCP adapter. Call on a blocking executor.
//!
//! Only operator configuration selects the issuer/resource/key endpoint. Neither
//! token claims nor tool arguments can choose a key URL or an account ID.
use crate::postgres::Principal;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::Read,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;

pub mod browser;
mod contract;
pub mod http;
mod keys;
pub mod operations;
pub mod provisioning;
#[cfg(test)]
pub(crate) mod tests;
pub mod website;
pub mod website_session;

const MAX_TOKEN: usize = 16_384;
const KEY_TTL: Duration = Duration::from_secs(300);
const REFRESH_COOLDOWN: Duration = Duration::from_secs(30);
const CLOCK_SKEW: u64 = 5;
const MAX_ACCESS_LIFETIME: u64 = 300;

fn http_client(
    agent: &'static str,
    root: Option<reqwest::Certificate>,
) -> Result<reqwest::blocking::Client, Error> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .user_agent(agent);
    if let Some(root) = root {
        builder = builder.add_root_certificate(root);
    }
    builder.build().map_err(|_| Error::Configuration)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Invalid identity configuration")]
    Configuration,
    #[error("A valid access token is required")]
    InvalidToken,
    #[error("The access token lacks the required scope")]
    InsufficientScope,
    #[error("Identity verification is temporarily unavailable")]
    Unavailable,
}

/// No Debug/Serialize implementation: accidentally logging configuration or a
/// verifier must not reveal operator transport configuration.
#[derive(Clone)]
pub struct Verifier {
    issuer: String,
    resource: String,
    jwks: Url,
    client: reqwest::blocking::Client,
    cache: Arc<Mutex<KeyCache>>,
}
#[derive(Default)]
struct KeyCache {
    keys: HashMap<String, DecodingKey>,
    loaded: Option<Instant>,
    attempted: Option<Instant>,
    failed: bool,
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
    iat: u64,
    exp: u64,
    typ: String,
    scope: Option<String>,
    gtd_generation: Option<uuid::Uuid>,
    auth_time: Option<i64>,
}

impl Verifier {
    pub(super) fn for_resource(mut self, resource: &str) -> Result<Self, Error> {
        if configured_url(resource)?.path() != "/mcp" {
            return Err(Error::Configuration);
        }
        self.resource = resource.into();
        Ok(self)
    }
    pub fn new(issuer: &str, resource: &str) -> Result<Self, Error> {
        let issuer_url = configured_url(issuer)?;
        configured_url(resource)?;
        if issuer_url.path().ends_with('/') {
            return Err(Error::Configuration);
        }
        let jwks = Url::parse(&format!("{issuer}/protocol/openid-connect/certs"))
            .map_err(|_| Error::Configuration)?;
        let client = http_client("GTD-Identity/1", None)?;
        Ok(Self {
            issuer: issuer.into(),
            resource: resource.into(),
            jwks,
            client,
            cache: Arc::new(Mutex::new(KeyCache::default())),
        })
    }

    /// Operator-provided private CA for isolated staging. Certificate, hostname
    /// and issuer validation remain enabled; no host or token selects this root.
    pub fn with_root_certificate(mut self, root: reqwest::Certificate) -> Result<Self, Error> {
        self.client = http_client("GTD-Identity/1", Some(root))?;
        Ok(self)
    }

    /// Verifies a single Authorization value. HTTP callers must also reject
    /// duplicate Authorization headers. The returned principal is not an access
    /// grant on its own: PostgreSQL resolves current account state on every use.
    pub fn verify(&self, authorization: &str) -> Result<Principal, Error> {
        self.verify_with_expiry(authorization)
            .map(|(principal, _)| principal)
    }
    pub(crate) fn verify_with_expiry(
        &self,
        authorization: &str,
    ) -> Result<(Principal, u64), Error> {
        let token = bearer(authorization)?;
        let header = decode_header(token).map_err(|_| Error::InvalidToken)?;
        if header.alg != Algorithm::RS256
            || !matches!(header.typ.as_deref(), Some("JWT" | "at+jwt"))
            || header.crit.as_ref().is_some_and(|v| !v.is_empty())
            || header.jku.is_some()
            || header.jwk.is_some()
            || header.x5u.is_some()
            || header.enc.is_some()
            || header.zip.is_some()
        {
            return Err(Error::InvalidToken);
        }
        let kid = header
            .kid
            .filter(|s| valid_key_id(s))
            .ok_or(Error::InvalidToken)?;
        let key = self.key(&kid)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.resource]);
        validation.set_required_spec_claims(&["iss", "sub", "aud", "iat", "exp"]);
        validation.leeway = CLOCK_SKEW;
        validation.validate_nbf = true;
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| Error::InvalidToken)?
            .claims;
        let now = jsonwebtoken::get_current_timestamp();
        if claims.typ != "Bearer"
            || claims.sub.trim().is_empty()
            || claims.sub.len() > 255
            || claims.sub.chars().any(char::is_control)
            || claims.iat > now.saturating_add(CLOCK_SKEW)
            || claims.exp <= claims.iat
            || claims.exp - claims.iat > MAX_ACCESS_LIFETIME
            || claims
                .auth_time
                .is_some_and(|v| v < 0 || v as u64 > claims.iat.saturating_add(CLOCK_SKEW))
        {
            return Err(Error::InvalidToken);
        }
        if !claims
            .scope
            .as_deref()
            .is_some_and(|s| s.split(' ').any(|v| v == "gtd:access"))
        {
            return Err(Error::InsufficientScope);
        }
        Ok((
            Principal::verified_session(
                self.issuer.clone(),
                claims.sub,
                claims.gtd_generation,
                claims.auth_time,
            ),
            claims.exp,
        ))
    }

    fn key(&self, kid: &str) -> Result<DecodingKey, Error> {
        // One bounded fetch at a time; arbitrary unknown kids cannot trigger a
        // request each. No database/account lock is held during discovery.
        let mut cache = self.cache.lock().map_err(|_| Error::Unavailable)?;
        let fresh = cache.loaded.is_some_and(|t| t.elapsed() < KEY_TTL);
        if fresh && let Some(key) = cache.keys.get(kid) {
            return Ok(key.clone());
        }
        if cache
            .attempted
            .is_some_and(|t| t.elapsed() < REFRESH_COOLDOWN)
        {
            return Err(if !fresh || cache.failed {
                Error::Unavailable
            } else {
                Error::InvalidToken
            });
        }
        cache.attempted = Some(Instant::now());
        match self.fetch_keys() {
            Ok(keys) => {
                cache.keys = keys;
                cache.loaded = Some(Instant::now());
                cache.failed = false;
            }
            Err(error) => {
                cache.failed = true;
                return Err(error);
            }
        }
        cache.keys.get(kid).cloned().ok_or(Error::InvalidToken)
    }

    fn fetch_keys(&self) -> Result<HashMap<String, DecodingKey>, Error> {
        const MAX_JWKS: u64 = 128 * 1024;
        let response = self
            .client
            .get(self.jwks.clone())
            .send()
            .map_err(|_| Error::Unavailable)?;
        if !response.status().is_success()
            || response.content_length().is_some_and(|n| n > MAX_JWKS)
        {
            return Err(Error::Unavailable);
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_JWKS + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Unavailable)?;
        if bytes.len() > MAX_JWKS as usize {
            return Err(Error::Unavailable);
        }
        keys::parse(&bytes)
    }
}

fn configured_url(value: &str) -> Result<Url, Error> {
    let url = Url::parse(value).map_err(|_| Error::Configuration)?;
    if value.len() > 2048
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != value
    {
        return Err(Error::Configuration);
    }
    Ok(url)
}
fn valid_key_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn bearer(value: &str) -> Result<&str, Error> {
    let (scheme, token) = value.split_once(' ').ok_or(Error::InvalidToken)?;
    if !scheme.eq_ignore_ascii_case("Bearer")
        || token.len() > MAX_TOKEN
        || token.is_empty()
        || token.split('.').count() != 3
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
    {
        return Err(Error::InvalidToken);
    }
    Ok(token)
}
