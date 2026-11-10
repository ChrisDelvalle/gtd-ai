//! Website session coordinator. The HTTP layer owns cookie attributes, exact
//! Origin checks and response headers; this layer owns identity and rotation.
use super::browser::{self, BrowserIdentity, Tokens};
use crate::postgres::{
    Account, Principal, Store,
    administration::WebsiteIdentity,
    sessions::{self, CookieKey, Sessions},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Sign in to continue")]
    SignIn,
    #[error("Sign-in is temporarily unavailable")]
    Unavailable,
    #[error("The signed-in account changed. Reopen GTD before continuing")]
    AccountChanged,
    #[error("The request could not be verified. Reload GTD and try again")]
    InvalidRequest,
}
impl From<sessions::Error> for Error {
    fn from(e: sessions::Error) -> Self {
        match e {
            sessions::Error::Missing => Self::SignIn,
            _ => Self::Unavailable,
        }
    }
}
impl From<browser::Error> for Error {
    fn from(e: browser::Error) -> Self {
        match e {
            browser::Error::Invalid => Self::SignIn,
            _ => Self::Unavailable,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Saved {
    tokens: Tokens,
    csrf: String,
    remember: bool,
}
pub struct Grant {
    pub(crate) principal: Principal,
    pub account: Account,
    pub csrf: String,
    pub remember: bool,
    pub expires_at: i64,
    authenticated_at: i64,
}
impl Grant {
    pub fn verify_csrf(&self, supplied: &str) -> Result<(), Error> {
        // Constant-time secret comparison is enabled on the pinned OIDC crate.
        if supplied.len() != 64
            || openidconnect::CsrfToken::new(supplied.into())
                != openidconnect::CsrfToken::new(self.csrf.clone())
        {
            return Err(Error::InvalidRequest);
        }
        Ok(())
    }
    pub(crate) fn administrator_identity(&self) -> WebsiteIdentity<'_> {
        WebsiteIdentity::from_verified_session(&self.principal, self.authenticated_at)
    }
}
pub struct Started {
    pub url: url::Url,
    pub login_cookie: CookieKey,
}
pub struct SignedIn {
    pub cookie: CookieKey,
    pub expires_at: i64,
    pub remember: bool,
    pub return_to: String,
}

#[derive(Clone)]
pub struct WebsiteSessions {
    store: Store,
    sessions: Sessions,
    provider: BrowserIdentity,
}
impl WebsiteSessions {
    pub fn new(store: Store, provider: BrowserIdentity) -> Self {
        Self {
            sessions: Sessions::new(store.clone()),
            store,
            provider,
        }
    }
    pub fn start(
        &self,
        current: Option<&CookieKey>,
        remember: bool,
        return_to: &str,
        reauthenticate: bool,
    ) -> Result<Started, Error> {
        let (expected, remember) = if reauthenticate {
            let grant = self.authenticate(current.ok_or(Error::SignIn)?)?;
            (Some(grant.account.id()), grant.remember)
        } else {
            (None, remember)
        };
        let authorization =
            self.provider
                .authorize(remember, return_to, expected, reauthenticate)?;
        let cookie = CookieKey::random();
        self.sessions.save_login(
            &authorization.pending.state,
            &cookie,
            &authorization.pending,
        )?;
        Ok(Started {
            url: authorization.url,
            login_cookie: cookie,
        })
    }
    pub fn finish(
        &self,
        login: &CookieKey,
        state: &str,
        issuer: &str,
        code: &str,
        previous: Option<&CookieKey>,
    ) -> Result<SignedIn, Error> {
        // Consume before network traffic: duplicate callbacks cannot exchange a
        // code twice. Failure requires a fresh login, not an automatic retry.
        let pending: browser::PendingLogin = self.sessions.consume_login(state, login)?;
        let tokens = self.provider.exchange(&pending, issuer, code)?;
        let principal = tokens.principal();
        let account = self
            .store
            .read(&principal, |tx| Ok(tx.account().clone()))
            .map_err(store_error)?;
        if pending
            .expected_account
            .is_some_and(|id| id != account.id())
        {
            return Err(Error::AccountChanged);
        }
        let saved = Saved {
            tokens,
            csrf: CookieKey::random().value().into(),
            remember: pending.remember,
        };
        let cookie = CookieKey::random();
        let expires_at = self
            .sessions
            .create(&cookie, &principal, &saved, pending.remember)?;
        if let Some(previous) = previous {
            // Rotate local identity, but do not revoke the provider SSO session:
            // Keycloak may attach the new grant to that same session.
            let _ = self.sessions.delete::<Saved>(previous)?;
        }
        Ok(SignedIn {
            cookie,
            expires_at,
            remember: pending.remember,
            return_to: pending.return_to,
        })
    }
    pub fn authenticate(&self, cookie: &CookieKey) -> Result<Grant, Error> {
        let result = self
            .sessions
            .with_session::<Saved, _>(cookie, |mut saved, bound| {
                let changed = saved.tokens.needs_refresh(chrono::Utc::now().timestamp());
                if changed {
                    saved.tokens =
                        self.provider
                            .refresh(&saved.tokens)
                            .map_err(|error| match error {
                                browser::Error::Invalid => sessions::Error::Missing,
                                _ => sessions::Error::Unavailable,
                            })?;
                }
                let snapshot = (
                    saved.tokens.principal(),
                    saved.csrf.clone(),
                    saved.remember,
                    saved.tokens.authenticated_at(),
                    bound.account_id,
                    bound.expires_at,
                );
                Ok((snapshot, changed.then_some(saved)))
            });
        let (principal, csrf, remember, authenticated_at, expected, expires_at) = match result {
            Ok(value) => value,
            Err(sessions::Error::Missing) => {
                let _ = self.sessions.delete::<Saved>(cookie);
                return Err(Error::SignIn);
            }
            Err(error) => return Err(error.into()),
        };
        // Do not take a second pooled connection while holding the session lock.
        // Account disablement and credential changes are rechecked on every use.
        let account = self
            .store
            .read(&principal, |tx| Ok(tx.account().clone()))
            .map_err(store_error)?;
        if account.id() != expected {
            return Err(Error::AccountChanged);
        }
        Ok(Grant {
            principal,
            account,
            csrf,
            remember,
            expires_at,
            authenticated_at,
        })
    }
    pub fn logout(
        &self,
        cookie: &CookieKey,
        expected_account: uuid::Uuid,
        csrf: &str,
    ) -> Result<(), Error> {
        if csrf.len() != 64 {
            return Err(Error::InvalidRequest);
        }
        let saved = self
            .sessions
            .delete_checked::<Saved>(cookie, |saved, account| {
                account == expected_account
                    && openidconnect::CsrfToken::new(csrf.into())
                        == openidconnect::CsrfToken::new(saved.csrf.clone())
            })
            .map_err(|error| match error {
                sessions::Error::Missing => Error::InvalidRequest,
                _ => Error::Unavailable,
            })?;
        if let Some(saved) = saved {
            // Local sign-out is durable even if the provider is unavailable.
            // A short-lived provider token cannot recover a deleted cookie.
            let _ = self.provider.revoke(saved.tokens);
        }
        Ok(())
    }
    pub fn cleanup(&self) -> Result<i64, Error> {
        self.sessions.cleanup().map_err(Into::into)
    }
}
fn store_error(error: crate::postgres::Error) -> Error {
    match error {
        crate::postgres::Error::AccountUnavailable => Error::SignIn,
        _ => Error::Unavailable,
    }
}
