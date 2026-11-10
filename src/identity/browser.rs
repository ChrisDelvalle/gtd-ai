//! Website OIDC protocol client. Cookies, CSRF and persistent sessions belong to
//! the website boundary; this module never receives passwords or browser tokens.
use super::{Principal, Verifier};
use openidconnect::{
    AccessTokenHash, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointMaybeSet,
    EndpointNotSet, EndpointSet, HttpRequest, HttpResponse, IssuerUrl, Nonce, NonceVerifier,
    OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, RefreshToken,
    RevocationUrl, Scope, TokenResponse,
    core::{
        CoreAuthenticationFlow, CoreClient, CoreJwsSigningAlgorithm, CoreProviderMetadata,
        CoreRevocableToken, CoreTokenResponse,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;

type Client = CoreClient<
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointSet,
    EndpointMaybeSet,
    EndpointMaybeSet,
>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Invalid website identity configuration")]
    Configuration,
    #[error("Sign-in is temporarily unavailable")]
    Unavailable,
    #[error("Sign in again to continue")]
    Invalid,
}

/// Serializable only to private session storage. Never log or return to the UI.
#[derive(Serialize, Deserialize)]
pub struct PendingLogin {
    pub(crate) state: String,
    nonce: String,
    verifier: String,
    pub(crate) remember: bool,
    pub(crate) return_to: String,
    pub(crate) expected_account: Option<uuid::Uuid>,
    started_at: i64,
    recent: bool,
}
pub struct Authorization {
    pub url: Url,
    pub pending: PendingLogin,
}
#[derive(Serialize, Deserialize)]
pub struct Tokens {
    access_token: String,
    refresh_token: String,
    nonce: String,
    issuer: String,
    subject: String,
    generation: Option<uuid::Uuid>,
    authenticated_at: i64,
    expires_at: i64,
}
impl Tokens {
    pub(crate) fn principal(&self) -> Principal {
        Principal::verified_session(
            self.issuer.clone(),
            self.subject.clone(),
            self.generation,
            Some(self.authenticated_at),
        )
    }
    pub(crate) fn authenticated_at(&self) -> i64 {
        self.authenticated_at
    }
    pub(crate) fn needs_refresh(&self, now: i64) -> bool {
        self.expires_at <= now + 20
    }
}

#[derive(Clone)]
pub struct BrowserIdentity {
    issuer: String,
    client_id: String,
    client_secret: String,
    redirect: String,
    resource: String,
    http: reqwest::blocking::Client,
    metadata: Arc<Mutex<Option<(CoreProviderMetadata, Instant)>>>,
    verifier: Verifier,
}
impl BrowserIdentity {
    pub fn new(
        issuer: &str,
        client_id: &str,
        client_secret: String,
        website_origin: &str,
        resource: &str,
    ) -> Result<Self, Error> {
        super::configured_url(issuer).map_err(|_| Error::Configuration)?;
        let website = super::configured_url(website_origin).map_err(|_| Error::Configuration)?;
        if website.path() != "/"
            || client_id.is_empty()
            || client_id.len() > 100
            || client_secret.is_empty()
            || client_secret.len() > 4096
            || client_id.chars().any(char::is_control)
        {
            return Err(Error::Configuration);
        }
        let redirect = website
            .join("api/auth/callback")
            .map_err(|_| Error::Configuration)?
            .to_string();
        let http =
            super::http_client("GTD-Website-OIDC/1", None).map_err(|_| Error::Configuration)?;
        Ok(Self {
            issuer: issuer.into(),
            client_id: client_id.into(),
            client_secret,
            redirect,
            resource: resource.into(),
            http,
            metadata: Arc::new(Mutex::new(None)),
            verifier: Verifier::new(issuer, resource).map_err(|_| Error::Configuration)?,
        })
    }
    /// Applies the same explicitly configured staging root to discovery,
    /// token exchange and independent access-token verification.
    pub fn with_root_certificate(mut self, root: reqwest::Certificate) -> Result<Self, Error> {
        self.http = super::http_client("GTD-Website-OIDC/1", Some(root.clone()))
            .map_err(|_| Error::Configuration)?;
        self.verifier = self
            .verifier
            .with_root_certificate(root)
            .map_err(|_| Error::Configuration)?;
        Ok(self)
    }
    fn request(&self, request: HttpRequest) -> Result<HttpResponse, Error> {
        // Discovery may not redirect credentials or key reads to another host.
        // This product deliberately supports the selected Keycloak endpoints.
        let address = request.uri().to_string();
        let allowed = match request.method().as_str() {
            "GET" => [
                format!("{}/.well-known/openid-configuration", self.issuer),
                format!("{}/protocol/openid-connect/certs", self.issuer),
            ]
            .contains(&address),
            "POST" => [
                format!("{}/protocol/openid-connect/token", self.issuer),
                format!("{}/protocol/openid-connect/revoke", self.issuer),
            ]
            .contains(&address),
            _ => false,
        };
        if !allowed || request.body().len() > 32 * 1024 {
            return Err(Error::Configuration);
        }
        let response = self
            .http
            .request(request.method().clone(), address)
            .headers(request.headers().clone())
            .body(request.body().clone())
            .send()
            .map_err(|_| Error::Unavailable)?;
        if response.content_length().is_some_and(|n| n > 256 * 1024) {
            return Err(Error::Unavailable);
        }
        let mut result = axum::http::Response::builder().status(response.status());
        *result.headers_mut().ok_or(Error::Unavailable)? = response.headers().clone();
        let mut bytes = Vec::new();
        response
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Unavailable)?;
        if bytes.len() > 256 * 1024 {
            return Err(Error::Unavailable);
        }
        result.body(bytes).map_err(|_| Error::Unavailable)
    }
    fn client(&self) -> Result<Client, Error> {
        let mut cached = self.metadata.lock().map_err(|_| Error::Unavailable)?;
        if cached
            .as_ref()
            .is_none_or(|(_, at)| at.elapsed() > Duration::from_secs(300))
        {
            let metadata = CoreProviderMetadata::discover(
                &IssuerUrl::new(self.issuer.clone()).map_err(|_| Error::Configuration)?,
                &|request| self.request(request),
            )
            .map_err(|_| Error::Unavailable)?;
            if metadata.authorization_endpoint().as_str()
                != format!("{}/protocol/openid-connect/auth", self.issuer)
                || metadata.token_endpoint().map(|v| v.as_str())
                    != Some(format!("{}/protocol/openid-connect/token", self.issuer).as_str())
            {
                return Err(Error::Configuration);
            }
            *cached = Some((metadata, Instant::now()));
        }
        Ok(CoreClient::from_provider_metadata(
            cached.as_ref().unwrap().0.clone(),
            ClientId::new(self.client_id.clone()),
            Some(ClientSecret::new(self.client_secret.clone())),
        )
        .set_redirect_uri(
            RedirectUrl::new(self.redirect.clone()).map_err(|_| Error::Configuration)?,
        )
        .set_revocation_url(
            RevocationUrl::new(format!("{}/protocol/openid-connect/revoke", self.issuer))
                .map_err(|_| Error::Configuration)?,
        ))
    }
    pub fn authorize(
        &self,
        remember: bool,
        return_to: &str,
        expected_account: Option<uuid::Uuid>,
        recent: bool,
    ) -> Result<Authorization, Error> {
        let return_to = local_return_path(return_to)?;
        let client = self.client()?;
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let mut request = client
            .authorize_url(
                CoreAuthenticationFlow::AuthorizationCode,
                || CsrfToken::new_random_len(32),
                || Nonce::new_random_len(32),
            )
            .add_scope(Scope::new("gtd:access".into()))
            .add_extra_param("resource", self.resource.clone())
            .set_pkce_challenge(challenge);
        if remember {
            request = request.add_scope(Scope::new("offline_access".into()));
        }
        if recent {
            request = request.set_max_age(Duration::ZERO);
        }
        let (url, state, nonce) = request.url();
        Ok(Authorization {
            url,
            pending: PendingLogin {
                state: state.secret().clone(),
                nonce: nonce.secret().clone(),
                verifier: verifier.secret().clone(),
                remember,
                return_to,
                expected_account,
                recent,
                started_at: chrono::Utc::now().timestamp(),
            },
        })
    }
    /// The website must atomically consume a matching state + HttpOnly browser
    /// cookie before calling this method. Issuer response and nonce are checked
    /// again here; a code is exchanged only once and never automatically retried.
    pub fn exchange(
        &self,
        pending: &PendingLogin,
        callback_issuer: &str,
        code: &str,
    ) -> Result<Tokens, Error> {
        let now = chrono::Utc::now().timestamp();
        if callback_issuer != self.issuer
            || code.is_empty()
            || code.len() > 8192
            || pending.started_at > now + 5
            || pending.started_at < now - 600
        {
            return Err(Error::Invalid);
        }
        let client = self.client()?;
        let response = client
            .exchange_code(AuthorizationCode::new(code.into()))
            .map_err(|_| Error::Configuration)?
            .set_pkce_verifier(PkceCodeVerifier::new(pending.verifier.clone()))
            .add_extra_param("resource", self.resource.clone())
            .request(&|request| self.request(request))
            .map_err(token_error)?;
        self.tokens(&client, &response, &pending.nonce, None, Some(pending))
    }
    pub fn refresh(&self, existing: &Tokens) -> Result<Tokens, Error> {
        if existing.issuer != self.issuer {
            return Err(Error::Invalid);
        }
        let client = self.client()?;
        let response = client
            .exchange_refresh_token(&RefreshToken::new(existing.refresh_token.clone()))
            .map_err(|_| Error::Configuration)?
            .add_extra_param("resource", self.resource.clone())
            .request(&|request| self.request(request))
            .map_err(token_error)?;
        self.tokens(&client, &response, &existing.nonce, Some(existing), None)
    }
    fn tokens(
        &self,
        client: &Client,
        response: &CoreTokenResponse,
        nonce: &str,
        existing: Option<&Tokens>,
        pending: Option<&PendingLogin>,
    ) -> Result<Tokens, Error> {
        let access = response.access_token().secret();
        let (principal, token_expires) = self
            .verifier
            .verify_with_expiry(&format!("Bearer {access}"))
            .map_err(|error| match error {
                super::Error::Unavailable => Error::Unavailable,
                _ => Error::Invalid,
            })?;
        let authenticated_at = principal.authenticated_at().ok_or(Error::Invalid)?;
        if let Some(existing) = existing
            && (principal.subject() != existing.subject
                || principal.credential_generation() != existing.generation
                || authenticated_at != existing.authenticated_at)
        {
            return Err(Error::Invalid);
        }
        if let Some(pending) = pending
            && pending.recent
            && authenticated_at < pending.started_at - 5
        {
            return Err(Error::Invalid);
        }
        if let Some(id) = response.id_token() {
            let verifier = client
                .id_token_verifier()
                .set_allowed_algs([CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256])
                .set_issue_time_verifier_fn(|issued| {
                    let age = chrono::Utc::now().timestamp() - issued.timestamp();
                    if (-5..=300).contains(&age) {
                        Ok(())
                    } else {
                        Err("Invalid issue time".into())
                    }
                });
            // OIDC Core 12.2 permits omission on refresh; an included nonce must
            // still match the original login. Initial exchanges require it.
            let expected_nonce = Nonce::new(nonce.into());
            let claims = id
                .claims(&verifier, |supplied: Option<&Nonce>| {
                    if existing.is_some() && supplied.is_none() {
                        Ok(())
                    } else {
                        (&expected_nonce).verify(supplied)
                    }
                })
                .map_err(|_| Error::Invalid)?;
            if claims.subject().as_str() != principal.subject()
                || claims.auth_time().map(|v| v.timestamp()) != Some(authenticated_at)
            {
                return Err(Error::Invalid);
            }
            if let Some(expected) = claims.access_token_hash() {
                let actual = AccessTokenHash::from_token(
                    response.access_token(),
                    id.signing_alg().map_err(|_| Error::Invalid)?,
                    id.signing_key(&verifier).map_err(|_| Error::Invalid)?,
                )
                .map_err(|_| Error::Invalid)?;
                if &actual != expected {
                    return Err(Error::Invalid);
                }
            }
        } else if pending.is_some() {
            return Err(Error::Invalid);
        }
        let refresh = response
            .refresh_token()
            .map(|v| v.secret().clone())
            .or_else(|| existing.map(|v| v.refresh_token.clone()))
            .ok_or(Error::Invalid)?;
        if refresh.is_empty() || refresh.len() > 16_384 {
            return Err(Error::Invalid);
        }
        let expires = response
            .expires_in()
            .filter(|v| v.as_secs() > 0 && v.as_secs() <= 300)
            .ok_or(Error::Invalid)?
            .as_secs() as i64;
        Ok(Tokens {
            access_token: access.clone(),
            refresh_token: refresh,
            nonce: nonce.into(),
            issuer: self.issuer.clone(),
            subject: principal.subject().to_owned(),
            generation: principal.credential_generation(),
            authenticated_at,
            expires_at: (chrono::Utc::now().timestamp() + expires).min(token_expires as i64),
        })
    }
    pub fn revoke(&self, tokens: Tokens) -> Result<(), Error> {
        self.client()?
            .revoke_token(CoreRevocableToken::RefreshToken(RefreshToken::new(
                tokens.refresh_token,
            )))
            .map_err(|_| Error::Configuration)?
            .request(&|request| self.request(request))
            .map_err(|_| Error::Unavailable)
    }
}
fn token_error(
    error: openidconnect::RequestTokenError<
        Error,
        openidconnect::StandardErrorResponse<openidconnect::core::CoreErrorResponseType>,
    >,
) -> Error {
    match error {
        openidconnect::RequestTokenError::ServerResponse(response)
            if response.error().to_string() == "invalid_grant" =>
        {
            Error::Invalid
        }
        _ => Error::Unavailable,
    }
}
pub(crate) fn local_return_path(value: &str) -> Result<String, Error> {
    if value.len() > 2048
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(Error::Configuration);
    }
    let base = Url::parse("https://website.invalid/").unwrap();
    let target = base.join(value).map_err(|_| Error::Configuration)?;
    if target.origin() != base.origin() || target.fragment().is_some() {
        return Err(Error::Configuration);
    }
    let first = target.path().split('/').nth(1).unwrap_or("");
    if ![
        "",
        "tasks",
        "projects",
        "repeating",
        "review",
        "activity",
        "help",
        "logs",
        "health",
        "users",
    ]
    .contains(&first)
    {
        return Err(Error::Configuration);
    }
    Ok(format!(
        "{}{}",
        target.path(),
        target.query().map(|v| format!("?{v}")).unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests;
