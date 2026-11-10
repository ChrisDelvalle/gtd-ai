//! Private website administration, deliberately absent from MCP dispatch.
//!
//! A verified OIDC browser session supplies identity and original authentication
//! time. Request bodies cannot construct this context. Provider work uses a
//! durable, leased operation; no credentials enter the journal or its audit.
use super::{Principal, Store, metadata, validate_runtime};
use postgres::types::ToSql;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

/// One private connection owns the lifecycle lock across provider calls and
/// separately committed journal steps. It is independent of the pool: dropping
/// it closes the session instead of returning a session-level lock to the pool.
/// Backups acquire the same lock before capturing the two databases.
pub(crate) struct ProvisioningSession {
    connection: postgres::Client,
    environment: super::Environment,
    identity: Uuid,
}
impl ProvisioningSession {
    pub(crate) fn claim(
        &mut self,
        identity: &WebsiteIdentity<'_>,
        id: Uuid,
    ) -> Result<Work, Error> {
        admin_query(
            &mut self.connection,
            self.environment,
            self.identity,
            "SELECT gtd.admin_claim($1::text::jsonb,$2)::text",
            &[&identity.context(), &id],
        )
    }
    pub(crate) fn bind(
        &mut self,
        identity: &WebsiteIdentity<'_>,
        id: Uuid,
        attempt: Uuid,
        subject: &str,
    ) -> Result<Operation, Error> {
        admin_query(
            &mut self.connection,
            self.environment,
            self.identity,
            "SELECT gtd.admin_bind($1::text::jsonb,$2,$3,$4)::text",
            &[&identity.context(), &id, &attempt, &subject],
        )
    }
    pub(crate) fn complete(
        &mut self,
        identity: &WebsiteIdentity<'_>,
        id: Uuid,
        attempt: Uuid,
    ) -> Result<Operation, Error> {
        admin_query(
            &mut self.connection,
            self.environment,
            self.identity,
            "SELECT gtd.admin_complete($1::text::jsonb,$2,$3)::text",
            &[&identity.context(), &id, &attempt],
        )
    }
}

fn admin_query<T: serde::de::DeserializeOwned>(
    connection: &mut postgres::Client,
    environment: super::Environment,
    identity: Uuid,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<T, Error> {
    validate_runtime(connection).map_err(|_| Error::Unavailable)?;
    let mut tx = connection.transaction()?;
    tx.batch_execute("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='15s'")?;
    metadata(&mut tx, environment, Some(identity)).map_err(|_| Error::Unavailable)?;
    let value: String = tx.query_one(sql, params)?.get(0);
    let decoded = serde_json::from_str(&value).map_err(|_| Error::Unavailable)?;
    tx.commit()?;
    Ok(decoded)
}

pub struct WebsiteIdentity<'a> {
    principal: &'a Principal,
    authenticated_at: i64,
}
impl<'a> WebsiteIdentity<'a> {
    // Only the forthcoming trusted OIDC session boundary may call this. Do not
    // derive Deserialize or accept auth_time from an HTTP body/header.
    #[allow(dead_code)]
    pub(crate) fn from_verified_session(principal: &'a Principal, authenticated_at: i64) -> Self {
        Self {
            principal,
            authenticated_at,
        }
    }
    fn context(&self) -> String {
        json!({"issuer":self.principal.issuer,"subject":self.principal.subject,
            "generation":self.principal.credential_generation,"authenticated_at":self.authenticated_at}).to_string()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Invite {
        username: String,
        display_name: Option<String>,
    },
    Regenerate {
        target_id: Uuid,
    },
    ResetPassword {
        target_id: Uuid,
    },
    Revoke {
        target_id: Uuid,
    },
    Disable {
        target_id: Uuid,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Pending,
    Complete,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operation {
    pub id: Uuid,
    pub target_id: Uuid,
    pub kind: String,
    pub state: OperationState,
    pub attempt: Option<Uuid>,
    pub lease_until: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}
/// Internal provider work, never returned to ordinary task callers. It contains
/// only public account attributes; passwords exist solely in provider memory.
#[derive(Deserialize)]
pub struct Work {
    #[serde(flatten)]
    pub operation: Operation,
    pub issuer: Option<String>,
    pub subject: Option<String>,
    pub username: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Administrator access is required")]
    Forbidden,
    #[error("Sign in again to manage accounts")]
    Reauthentication,
    #[error(
        "Use a lowercase username of 1–64 letters, numbers, dots, underscores or hyphens; display names allow 1–100 characters"
    )]
    InvalidRequest,
    #[error("That username is unavailable")]
    UsernameUnavailable,
    #[error("The account or invitation is unavailable")]
    TargetUnavailable,
    #[error("This request ID was already used for a different account operation")]
    RequestConflict,
    #[error("Resolve the pending account operation before starting another")]
    Pending,
    #[error("Account administration is busy; try again shortly")]
    Busy,
    #[error("This operation attempt is no longer current; reload its status")]
    StaleAttempt,
    #[error("The invitation has expired or was revoked")]
    Expired,
    #[error(
        "The last administrator cannot be disabled or reset here; use account security to change its password"
    )]
    LastAdministrator,
    #[error(
        "Use account security to change your password; another administrator must disable your account"
    )]
    OwnAccount,
    #[error("The provider identity does not match the reserved account")]
    IdentityConflict,
    #[error("Account administration is temporarily unavailable")]
    Unavailable,
}
impl From<postgres::Error> for Error {
    fn from(error: postgres::Error) -> Self {
        match error.as_db_error().map(|e| e.message()) {
            Some("admin_forbidden") => Self::Forbidden,
            Some("reauthentication_required") => Self::Reauthentication,
            Some("invalid_admin_request") => Self::InvalidRequest,
            Some("username_unavailable") => Self::UsernameUnavailable,
            Some("admin_target_unavailable") => Self::TargetUnavailable,
            Some("admin_request_conflict") => Self::RequestConflict,
            Some("admin_operation_pending") => Self::Pending,
            Some("admin_operation_busy") => Self::Busy,
            Some("stale_admin_attempt") => Self::StaleAttempt,
            Some("invitation_expired") => Self::Expired,
            Some("last_administrator") => Self::LastAdministrator,
            Some("self_account_change") => Self::OwnAccount,
            Some("identity_binding_conflict") => Self::IdentityConflict,
            _ => Self::Unavailable,
        }
    }
}

impl Store {
    pub(crate) fn provisioning_session(&self) -> Result<ProvisioningSession, Error> {
        let mut connection = self
            .lifecycle_connection
            .connect(postgres::NoTls)
            .map_err(|_| Error::Unavailable)?;
        connection.batch_execute("SET statement_timeout='5s'; SET lock_timeout='2s'")?;
        validate_runtime(&mut connection).map_err(|_| Error::Unavailable)?;
        // Try rather than queue: a backup or another lifecycle operation must
        // never leave provider requests waiting indefinitely on a scarce pool.
        let acquired: bool = connection
            .query_one("SELECT pg_try_advisory_lock(214716023,1)", &[])?
            .get(0);
        if !acquired {
            return Err(Error::Busy);
        }
        Ok(ProvisioningSession {
            connection,
            environment: self.environment,
            identity: self.identity,
        })
    }
    pub fn administration_operation(
        &self,
        identity: &WebsiteIdentity<'_>,
        id: Uuid,
    ) -> Result<Option<Operation>, Error> {
        self.admin_query(
            "SELECT gtd.admin_operation($1::text::jsonb,$2)::text",
            &[&identity.context(), &id],
        )
    }
    pub fn administration_request(
        &self,
        identity: &WebsiteIdentity<'_>,
        request_id: Uuid,
    ) -> Result<Option<Operation>, Error> {
        self.admin_query(
            "SELECT gtd.admin_request($1::text::jsonb,$2)::text",
            &[&identity.context(), &request_id],
        )
    }
    pub fn begin_administration(
        &self,
        identity: &WebsiteIdentity<'_>,
        request_id: Uuid,
        command: Command,
    ) -> Result<Operation, Error> {
        let command = serde_json::to_string(&command).map_err(|_| Error::InvalidRequest)?;
        self.admin_query(
            "SELECT gtd.admin_begin($1::text::jsonb,$2,$3::text::jsonb)::text",
            &[&identity.context(), &request_id, &command],
        )
    }
    pub fn claim_administration(
        &self,
        identity: &WebsiteIdentity<'_>,
        operation: Uuid,
    ) -> Result<Work, Error> {
        self.admin_query(
            "SELECT gtd.admin_claim($1::text::jsonb,$2)::text",
            &[&identity.context(), &operation],
        )
    }
    pub fn bind_invitation(
        &self,
        identity: &WebsiteIdentity<'_>,
        operation: Uuid,
        attempt: Uuid,
        verified_subject: &str,
    ) -> Result<Operation, Error> {
        self.admin_query(
            "SELECT gtd.admin_bind($1::text::jsonb,$2,$3,$4)::text",
            &[&identity.context(), &operation, &attempt, &verified_subject],
        )
    }
    pub fn complete_administration(
        &self,
        identity: &WebsiteIdentity<'_>,
        operation: Uuid,
        attempt: Uuid,
    ) -> Result<Operation, Error> {
        self.admin_query(
            "SELECT gtd.admin_complete($1::text::jsonb,$2,$3)::text",
            &[&identity.context(), &operation, &attempt],
        )
    }
    pub fn list_accounts(
        &self,
        identity: &WebsiteIdentity<'_>,
        after: Option<Uuid>,
        limit: i32,
    ) -> Result<Value, Error> {
        self.admin_query(
            "SELECT gtd.admin_list($1::text::jsonb,$2,$3)::text",
            &[&identity.context(), &after, &limit],
        )
    }

    fn admin_query<T: serde::de::DeserializeOwned>(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<T, Error> {
        let mut connection = self.pool.get().map_err(|_| Error::Unavailable)?;
        admin_query(
            &mut connection,
            self.environment,
            self.identity,
            sql,
            params,
        )
    }

    /// Only reached when normal account resolution failed. Active requests add
    /// no extra query. The caller re-resolves after this transaction, including
    /// when concurrent first requests activated the same invitation.
    pub(super) fn activate_invitation(&self, principal: &Principal) -> super::Result<()> {
        let Some(generation) = principal.credential_generation else {
            return Err(super::Error::AccountUnavailable);
        };
        let mut connection = self.pool.get().map_err(|_| super::Error::Unavailable)?;
        validate_runtime(&mut connection)?;
        let mut tx = connection.transaction()?;
        tx.batch_execute("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='15s'")?;
        metadata(&mut tx, self.environment, Some(self.identity))?;
        let _: bool = tx
            .query_one(
                "SELECT gtd.activate_invitation($1,$2,$3,$4)",
                &[
                    &principal.issuer,
                    &principal.subject,
                    &generation,
                    &principal.authenticated_at,
                ],
            )?
            .get(0);
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod backup_tests;
#[cfg(test)]
mod provider_tests;
#[cfg(test)]
mod tests;
