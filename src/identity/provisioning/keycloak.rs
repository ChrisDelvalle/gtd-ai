//! Bounded Keycloak Admin REST client for one operator-configured realm. It has
//! no realm configuration, role promotion, impersonation or account-delete API.
use super::{Error, Provider, TemporaryPassword};
use crate::postgres::administration::Work;
use reqwest::{Method, StatusCode, blocking::Response};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::Read,
    sync::Mutex,
    time::{Duration, Instant},
};
use url::Url;

const MAX_RESPONSE: u64 = 256 * 1024;

pub struct Keycloak {
    client: reqwest::blocking::Client,
    base: Url,
    issuer: String,
    realm: String,
    client_id: String,
    client_secret: String,
    oauth_clients: Vec<String>,
    token: Mutex<Option<(String, Instant)>>,
}
impl Keycloak {
    pub fn new(
        base: &str,
        issuer: &str,
        realm: &str,
        client_id: &str,
        client_secret: String,
        oauth_clients: Vec<String>,
    ) -> Result<Self, Error> {
        let base = Url::parse(base).map_err(|_| Error::Configuration)?;
        super::super::configured_url(issuer).map_err(|_| Error::Configuration)?;
        let private_http = base.scheme() == "http"
            && base.host().is_some_and(|host| match host {
                url::Host::Ipv4(ip) => ip.is_loopback(),
                url::Host::Ipv6(ip) => ip.is_loopback(),
                url::Host::Domain(host) => {
                    !host.is_empty() && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                }
            });
        if !(base.scheme() == "https" || private_http)
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
            || !identifier(realm)
            || !identifier(client_id)
            || client_secret.is_empty()
            || client_secret.len() > 4096
            || oauth_clients.is_empty()
            || oauth_clients.len() > 8
            || oauth_clients.iter().any(|v| !identifier(v))
        {
            return Err(Error::Configuration);
        }
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .user_agent("GTD-Account-Administration/1")
            .build()
            .map_err(|_| Error::Configuration)?;
        Ok(Self {
            client,
            base,
            issuer: issuer.into(),
            realm: realm.into(),
            client_id: client_id.into(),
            client_secret,
            oauth_clients,
            token: Mutex::new(None),
        })
    }
    fn endpoint(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .expect("validated base")
            .clear()
            .extend(segments);
        url
    }
    fn users(&self) -> Url {
        self.endpoint(&["admin", "realms", &self.realm, "users"])
    }
    fn user(&self, subject: &str, suffix: Option<&str>) -> Result<Url, Error> {
        if subject.is_empty() || subject.len() > 255 || subject.chars().any(char::is_control) {
            return Err(Error::Verification);
        }
        let mut url = self.users();
        url.path_segments_mut().unwrap().push(subject);
        if let Some(suffix) = suffix {
            url.path_segments_mut().unwrap().push(suffix);
        }
        Ok(url)
    }
    fn access_token(&self) -> Result<String, Error> {
        let mut cached = self.token.lock().map_err(|_| Error::ProviderUnavailable)?;
        if let Some((value, expires)) = cached.as_ref()
            && *expires > Instant::now()
        {
            return Ok(value.clone());
        }
        let response = self
            .client
            .post(self.endpoint(&["realms", &self.realm, "protocol", "openid-connect", "token"]))
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
            ])
            .send()
            .map_err(|_| Error::ProviderUnavailable)?;
        status(&response)?;
        #[derive(Deserialize)]
        struct Token {
            access_token: String,
            expires_in: u64,
            token_type: String,
        }
        let token: Token = decode(response)?;
        if token.access_token.is_empty()
            || token.access_token.len() > 16_384
            || token.token_type != "Bearer"
            || token.expires_in < 20
        {
            return Err(Error::Verification);
        }
        *cached = Some((
            token.access_token.clone(),
            Instant::now() + Duration::from_secs(token.expires_in.min(300) - 15),
        ));
        Ok(token.access_token)
    }
    fn request(&self, method: Method, url: Url, body: Option<&Value>) -> Result<Response, Error> {
        let token = self.access_token()?;
        let mut request = self.client.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().map_err(|_| Error::ProviderUnavailable)?;
        if response.status() == StatusCode::UNAUTHORIZED {
            *self.token.lock().map_err(|_| Error::ProviderUnavailable)? = None;
        }
        Ok(response)
    }
    fn read(&self, subject: &str) -> Result<Value, Error> {
        let response = self.request(Method::GET, self.user(subject, None)?, None)?;
        status(&response)?;
        decode(response)
    }
    fn confirm(&self, work: &Work, value: &Value) -> Result<String, Error> {
        if work.issuer.as_deref() != Some(&self.issuer) {
            return Err(Error::Configuration);
        }
        let subject = value["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 255)
            .ok_or(Error::Verification)?;
        if work.subject.as_deref().is_some_and(|s| s != subject)
            || value["attributes"]["gtd_account_id"]
                != json!([work.operation.target_id.to_string()])
        {
            return Err(Error::IdentityConflict);
        }
        Ok(subject.into())
    }
    fn lookup(&self, work: &Work) -> Result<Option<Value>, Error> {
        let username = work.username.as_deref().ok_or(Error::Verification)?;
        let mut url = self.users();
        url.query_pairs_mut()
            .append_pair("username", username)
            .append_pair("exact", "true")
            .append_pair("briefRepresentation", "false")
            .append_pair("max", "2");
        let response = self.request(Method::GET, url, None)?;
        status(&response)?;
        let mut users: Vec<Value> = decode(response)?;
        if users.len() > 1 {
            return Err(Error::IdentityConflict);
        }
        let Some(user) = users.pop() else {
            return Ok(None);
        };
        if user["username"].as_str() != Some(username) {
            return Err(Error::IdentityConflict);
        }
        self.confirm(work, &user)?;
        Ok(Some(user))
    }
}
impl Provider for Keycloak {
    fn ensure_identity(&self, work: &Work) -> Result<String, Error> {
        if work.issuer.as_deref() != Some(&self.issuer) {
            return Err(Error::Configuration);
        }
        if let Some(subject) = &work.subject {
            return self.confirm(work, &self.read(subject)?);
        }
        if let Some(user) = self.lookup(work)? {
            return self.confirm(work, &user);
        }
        // A revoked invitation may never have reached Keycloak. Creating a
        // disabled tombstone reserves its username and lets a late create fail.
        let payload = json!({"username":work.username,"enabled":false,
            "attributes":{"gtd_account_id":[work.operation.target_id.to_string()]}});
        let response = self.request(Method::POST, self.users(), Some(&payload))?;
        if response.status() != StatusCode::CONFLICT {
            status(&response)?;
        }
        let user = self.lookup(work)?.ok_or(Error::Verification)?;
        self.confirm(work, &user)
    }
    fn replace_credentials(
        &self,
        work: &Work,
        subject: &str,
        password: &TemporaryPassword,
    ) -> Result<(), Error> {
        let user = self.read(subject)?;
        self.confirm(work, &user)?;
        let mut attributes = user["attributes"].as_object().cloned().unwrap_or_default();
        attributes.insert(
            "gtd_generation".into(),
            json!([work
                .operation
                .attempt
                .ok_or(Error::Verification)?
                .to_string()]),
        );
        let mut actions: Vec<String> =
            serde_json::from_value(user.get("requiredActions").cloned().unwrap_or(json!([])))
                .map_err(|_| Error::Verification)?;
        if !actions.iter().any(|a| a == "UPDATE_PASSWORD") {
            actions.push("UPDATE_PASSWORD".into());
        }
        // Keycloak 26.8.1 applies attributes, credentials and required actions in
        // the same user-update transaction. Never use a separate reset endpoint
        // that could leave a new password associated with an old generation.
        let payload = json!({"enabled":true,"attributes":attributes,"requiredActions":actions,
            "credentials":[{"type":"password","temporary":true,"value":password.value()}]});
        let response = self.request(Method::PUT, self.user(subject, None)?, Some(&payload))?;
        status(&response)
    }
    fn disable(&self, work: &Work, subject: &str) -> Result<(), Error> {
        let user = self.read(subject)?;
        self.confirm(work, &user)?;
        let response = self.request(
            Method::PUT,
            self.user(subject, None)?,
            Some(&json!({"enabled":false})),
        )?;
        status(&response)
    }
    fn revoke_grants(&self, work: &Work, subject: &str) -> Result<(), Error> {
        self.confirm(work, &self.read(subject)?)?;
        let response = self.request(Method::POST, self.user(subject, Some("logout"))?, None)?;
        status(&response)?;
        // Keycloak's session logout and offline-consent revocation are distinct.
        // A missing consent is already revoked; no other error is ignored.
        for client in &self.oauth_clients {
            let mut url = self.user(subject, Some("consents"))?;
            url.path_segments_mut().unwrap().push(client);
            let response = self.request(Method::DELETE, url, None)?;
            if response.status() != StatusCode::NOT_FOUND {
                status(&response)?;
            }
        }
        Ok(())
    }
    fn verify(&self, work: &Work, subject: &str, credentials: bool) -> Result<(), Error> {
        let user = self.read(subject)?;
        self.confirm(work, &user)?;
        if user["enabled"].as_bool() != Some(credentials) {
            return Err(Error::Verification);
        }
        if credentials
            && (user["attributes"]["gtd_generation"]
                != json!([work
                    .operation
                    .attempt
                    .ok_or(Error::Verification)?
                    .to_string()])
                || !user["requiredActions"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == "UPDATE_PASSWORD")))
        {
            return Err(Error::Verification);
        }
        Ok(())
    }
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn status(response: &Response) -> Result<(), Error> {
    match response.status() {
        status if status.is_success() => Ok(()),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(Error::ProviderPermission),
        _ => Err(Error::ProviderUnavailable),
    }
}
fn decode<T: serde::de::DeserializeOwned>(response: Response) -> Result<T, Error> {
    if response.content_length().is_some_and(|n| n > MAX_RESPONSE) {
        return Err(Error::Verification);
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::ProviderUnavailable)?;
    if bytes.len() > MAX_RESPONSE as usize {
        return Err(Error::Verification);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Verification)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_configuration_never_allows_public_plaintext_or_caller_urls() {
        let construct = |base: &str| {
            Keycloak::new(
                base,
                "https://identity.invalid/realms/gtd",
                "gtd",
                "gtd-admin",
                "synthetic-fixture-secret".into(),
                vec!["gtd-web".into()],
            )
        };
        for base in [
            "http://example.com/",
            "http://203.0.113.1/",
            "http://[2001:db8::1]/",
            "https://operator:secret@example.com/",
            "https://example.com/path",
            "https://example.com/?redirect=1",
        ] {
            assert!(
                matches!(construct(base), Err(Error::Configuration)),
                "{base}"
            );
        }
        for base in [
            "http://127.0.0.1:18443/",
            "http://[::1]:18443/",
            "http://keycloak:8080/",
            "https://identity.invalid/",
        ] {
            assert!(construct(base).is_ok(), "{base}");
        }
    }
}
