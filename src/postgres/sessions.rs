//! Server-only browser state. The opaque key is a credential: accept it only
//! from the secure cookie boundary and never derive it from account selectors.
use super::{Principal, Store, metadata, validate_runtime};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Sign in again to continue")]
    Missing,
    #[error("Sign-in is temporarily unavailable")]
    Unavailable,
}
impl From<postgres::Error> for Error {
    fn from(_: postgres::Error) -> Self {
        Self::Unavailable
    }
}

/// Generated from two UUID v4 values (244 random bits), never Debug/Serialize.
pub struct CookieKey(String);
impl CookieKey {
    pub fn random() -> Self {
        Self(format!(
            "{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        ))
    }
    pub fn parse(value: &str) -> Result<Self, Error> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Missing);
        }
        Ok(Self(value.into()))
    }
    pub fn value(&self) -> &str {
        &self.0
    }
    fn hash(&self) -> String {
        hash(&self.0)
    }
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[derive(Clone)]
pub struct Sessions(Store);
pub struct BoundSession {
    pub account_id: Uuid,
    pub expires_at: i64,
}
impl Sessions {
    pub fn new(store: Store) -> Self {
        Self(store)
    }
    fn transact<T>(
        &self,
        f: impl FnOnce(&mut postgres::Transaction<'_>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut connection = self.0.pool.get().map_err(|_| Error::Unavailable)?;
        validate_runtime(&mut connection).map_err(|_| Error::Unavailable)?;
        let mut tx = connection.transaction()?;
        tx.batch_execute("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='6s'; SET LOCAL idle_in_transaction_session_timeout='35s'")?;
        metadata(&mut tx, self.0.environment, Some(self.0.identity))
            .map_err(|_| Error::Unavailable)?;
        let value = f(&mut tx)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn save_login(
        &self,
        state: &str,
        browser: &CookieKey,
        pending: &impl Serialize,
    ) -> Result<(), Error> {
        if state.len() < 32 || state.len() > 256 {
            return Err(Error::Missing);
        }
        let document = serde_json::to_string(pending).map_err(|_| Error::Unavailable)?;
        self.transact(|tx| {
            tx.query_one(
                "SELECT gtd.web_login_create($1,$2,$3)",
                &[&hash(state), &browser.hash(), &document],
            )?;
            Ok(())
        })
    }
    pub fn consume_login<T: DeserializeOwned>(
        &self,
        state: &str,
        browser: &CookieKey,
    ) -> Result<T, Error> {
        if state.len() < 32 || state.len() > 256 {
            return Err(Error::Missing);
        }
        self.transact(|tx| {
            let document: Option<String> = tx
                .query_one(
                    "SELECT gtd.web_login_consume($1,$2)",
                    &[&hash(state), &browser.hash()],
                )?
                .get(0);
            serde_json::from_str(&document.ok_or(Error::Missing)?).map_err(|_| Error::Unavailable)
        })
    }
    pub fn create(
        &self,
        key: &CookieKey,
        principal: &Principal,
        document: &impl Serialize,
        remember: bool,
    ) -> Result<i64, Error> {
        // Resolving may activate a provisioned invitation. The SQL insert then
        // rechecks current account state rather than trusting a prior lookup.
        self.0.read(principal, |_| Ok(())).map_err(|e| match e {
            super::Error::AccountUnavailable => Error::Missing,
            _ => Error::Unavailable,
        })?;
        let identity=json!({"issuer":principal.issuer,"subject":principal.subject,
            "generation":principal.credential_generation,"authenticated_at":principal.authenticated_at}).to_string();
        let document = serde_json::to_string(document).map_err(|_| Error::Unavailable)?;
        self.transact(|tx| {
            Ok(tx
                .query_one(
                    "SELECT gtd.web_session_create($1,$2::text::jsonb,$3,$4)",
                    &[&key.hash(), &identity, &document, &remember],
                )?
                .get(0))
        })
    }
    /// Serializes refresh on this session row. The callback supplies a replacement
    /// only when tokens changed; expiry never extends and deletion never upserts.
    pub fn with_session<D: DeserializeOwned + Serialize, T>(
        &self,
        key: &CookieKey,
        operation: impl FnOnce(D, &BoundSession) -> Result<(T, Option<D>), Error>,
    ) -> Result<T, Error> {
        self.transact(|tx| {
            let row = tx
                .query_opt("SELECT * FROM gtd.web_session_lock($1)", &[&key.hash()])?
                .ok_or(Error::Missing)?;
            let saved = BoundSession {
                account_id: row.get("account_id"),
                expires_at: row.get("expires_at"),
            };
            let document: D = serde_json::from_str(&row.get::<_, String>("document"))
                .map_err(|_| Error::Unavailable)?;
            let (result, replacement) = operation(document, &saved)?;
            if let Some(replacement) = replacement {
                let document =
                    serde_json::to_string(&replacement).map_err(|_| Error::Unavailable)?;
                if !tx
                    .query_one(
                        "SELECT gtd.web_session_replace($1,$2)",
                        &[&key.hash(), &document],
                    )?
                    .get::<_, bool>(0)
                {
                    return Err(Error::Missing);
                }
            }
            Ok(result)
        })
    }
    pub fn delete<T: DeserializeOwned>(&self, key: &CookieKey) -> Result<Option<T>, Error> {
        self.transact(|tx| {
            let document: Option<String> = tx
                .query_one("SELECT gtd.web_session_delete($1)", &[&key.hash()])?
                .get(0);
            document
                .map(|v| serde_json::from_str(&v).map_err(|_| Error::Unavailable))
                .transpose()
        })
    }
    pub fn delete_checked<T: DeserializeOwned>(
        &self,
        key: &CookieKey,
        validate: impl FnOnce(&T, Uuid) -> bool,
    ) -> Result<Option<T>, Error> {
        self.transact(|tx| {
            let Some(row) = tx.query_opt(
                "SELECT * FROM gtd.web_session_lock_for_logout($1)",
                &[&key.hash()],
            )?
            else {
                return Ok(None);
            };
            let saved: T = serde_json::from_str(&row.get::<_, String>("document"))
                .map_err(|_| Error::Unavailable)?;
            if !validate(&saved, row.get("account_id")) {
                return Err(Error::Missing);
            }
            tx.query_one("SELECT gtd.web_session_delete($1)", &[&key.hash()])?;
            Ok(Some(saved))
        })
    }
    pub fn cleanup(&self) -> Result<i64, Error> {
        self.transact(|tx| {
            Ok(tx
                .query_one("SELECT gtd.web_session_cleanup()", &[])?
                .get(0))
        })
    }
}

#[cfg(test)]
mod tests;
