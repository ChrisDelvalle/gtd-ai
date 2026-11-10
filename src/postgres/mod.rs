//! Account-bound PostgreSQL transaction boundary. Not yet wired to production.
//!
//! Run synchronous operations on the application's blocking executor. The pool
//! never exposes an unbound connection to callers. Migrations use a separate role.
use ::postgres::types::Type;
use ::postgres::{Config, IsolationLevel, NoTls, Transaction};
use r2d2::{HandleError, Pool};
use r2d2_postgres::PostgresConnectionManager;
use std::{fmt, time::Duration};
use uuid::Uuid;

pub const COMPATIBILITY: i32 = 13;
pub const SCHEMA: &str = concat!(
    include_str!("schema.sql"),
    include_str!("administration.sql"),
    include_str!("settings.sql"),
    include_str!("activity.sql"),
    include_str!("timed_holds_index.sql"),
    include_str!("sessions.sql")
);

pub mod administration;
pub(crate) mod sessions;
pub(crate) mod settings;

mod activity;
#[cfg(feature = "postgres-operator")]
pub mod activity_operator;
mod application;
pub mod legacy;
#[cfg(feature = "postgres-operator")]
pub mod operator;
mod priorities;
mod read_snapshot;
mod reads;
mod view_cache;
mod widget_launch;
pub(crate) use widget_launch::{LaunchMode, WidgetPagesRequest};
mod recurrence_reads;
mod search;
mod search_reads;
pub use crate::search_engine::SearchConfig;
mod sync;
mod worker;
mod writes;
pub use crate::store::mutation::Operation as WriteOperation;
pub use worker::{BackgroundStep, BackgroundWorker};
pub use writes::MaintenanceResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    Production,
    Staging,
}
impl Environment {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Staging => "staging",
        }
    }
}

#[derive(thiserror::Error)]
pub enum Error {
    #[error("Database connection unavailable")]
    Unavailable,
    #[error("The GTD account or environment changed. Reopen GTD before continuing.")]
    Binding(&'static str),
    #[error("Database runtime privileges or row-security policies are unsafe")]
    UnsafeRole,
    #[error("Unexpected retained database account context")]
    RetainedContext,
    #[error("Database compatibility, environment or identity mismatch")]
    Compatibility,
    #[error("Account is unavailable")]
    AccountUnavailable,
    #[error("Invalid account timezone")]
    InvalidTimezone,
    #[error("Invalid connection pool size")]
    InvalidPoolSize,
    #[error("Read transactions cannot allocate revisions")]
    ReadOnly,
    #[error("Legacy source could not be read or is not an intact version-11 database")]
    LegacySource,
    #[error("Legacy source identity or environment does not match the approved snapshot")]
    SourceMismatch,
    #[error("Import requires an empty account, or an exact retry of its completed import")]
    ImportConflict,
    #[error("Imported records do not match the source; the transaction was rolled back")]
    Reconciliation,
    #[error(
        "Checkpoint is invalid or belongs to another account, audience or history; start a fresh snapshot"
    )]
    ResetRequired,
    #[error("Page size must be between 1 and 100")]
    PageSize,
    #[error("Stored data could not be decoded")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Business(#[from] crate::store::StoreError),
    #[error("Database operation failed")]
    Database(#[from] ::postgres::Error),
}
// PostgreSQL details may include record content. Keep routine logs safe too.
impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
type Result<T> = std::result::Result<T, Error>;

/// Constructed only by a trusted authentication boundary after verification.
/// It is deliberately not deserializable and has no account-ID selector.
pub struct Principal {
    issuer: String,
    subject: String,
    credential_generation: Option<Uuid>,
    authenticated_at: Option<i64>,
    background: bool,
    expected_account: Option<String>,
    expected_environment: Option<String>,
}
impl Principal {
    pub(crate) fn subject(&self) -> &str {
        &self.subject
    }
    pub(crate) fn credential_generation(&self) -> Option<Uuid> {
        self.credential_generation
    }
    pub(crate) fn authenticated_at(&self) -> Option<i64> {
        self.authenticated_at
    }
    /// A widget may pin verified identity. These values only reject a mismatch.
    pub(crate) fn with_binding(
        mut self,
        account: Option<String>,
        environment: Option<String>,
    ) -> Self {
        self.expected_account = account;
        self.expected_environment = environment;
        self
    }
    #[allow(dead_code)] // HTTP/OIDC integration is the following checkpoint.
    pub(crate) fn verified(issuer: String, subject: String) -> Self {
        Self::verified_token(issuer, subject, None)
    }
    pub(crate) fn verified_token(
        issuer: String,
        subject: String,
        credential_generation: Option<Uuid>,
    ) -> Self {
        Self::verified_session(issuer, subject, credential_generation, None)
    }
    pub(crate) fn verified_session(
        issuer: String,
        subject: String,
        credential_generation: Option<Uuid>,
        authenticated_at: Option<i64>,
    ) -> Self {
        Self {
            issuer,
            subject,
            credential_generation,
            authenticated_at,
            background: false,
            expected_account: None,
            expected_environment: None,
        }
    }
    /// Internal scheduler only. It has no user token, and its selected identity
    /// comes from the active-account directory, never a request argument.
    pub(super) fn for_background(issuer: String, subject: String) -> Self {
        Self {
            background: true,
            ..Self::verified(issuer, subject)
        }
    }
}

#[derive(Debug, Clone)]
pub struct Account {
    id: Uuid,
    username: String,
    display_name: Option<String>,
    timezone: chrono_tz::Tz,
    administrator: bool,
}
impl Account {
    pub fn id(&self) -> Uuid {
        self.id
    }
    pub fn username(&self) -> &str {
        &self.username
    }
    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }
    pub fn timezone(&self) -> chrono_tz::Tz {
        self.timezone
    }
    pub fn administrator(&self) -> bool {
        self.administrator
    }
}

#[derive(Clone)]
pub struct Store {
    pool: Pool<PostgresConnectionManager<NoTls>>,
    lifecycle_connection: Config,
    environment: Environment,
    identity: Uuid,
    search: Option<SearchConfig>,
    worker_notifications: std::sync::Arc<worker::Notifications>,
    view_tokens: std::sync::Arc<std::sync::Mutex<view_cache::Tokens>>,
}

#[derive(Debug)]
struct SafePoolErrors;
impl HandleError<::postgres::Error> for SafePoolErrors {
    fn handle_error(&self, _: ::postgres::Error) {
        // The caller receives a fixed Unavailable error. Do not log connection
        // configuration, provider error details or SQL values from a pool thread.
    }
}

impl Store {
    /// Startup pin supplied by private operator configuration. A database swap
    /// must be an explicit recovery/cutover decision, including after restart.
    pub fn connect_expected(
        config: Config,
        environment: Environment,
        maximum: u32,
        expected_identity: Uuid,
    ) -> Result<Self> {
        let store = Self::connect(config, environment, maximum)?;
        if store.identity != expected_identity {
            return Err(Error::Compatibility);
        }
        Ok(store)
    }

    /// Operator readiness probe, with no record or account selector. Never
    /// establishes user authority; application requests still resolve identity.
    pub fn health(&self) -> Result<()> {
        let mut connection = self.pool.get().map_err(|_| Error::Unavailable)?;
        validate_runtime(&mut connection)?;
        let mut tx = connection.build_transaction().read_only(true).start()?;
        tx.batch_execute("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'")?;
        metadata(&mut tx, self.environment, Some(self.identity))?;
        tx.commit()?;
        Ok(())
    }
    /// Private-network transport only; no credentials or DSN are accepted from
    /// user-facing API arguments. The runtime does not create or migrate schema.
    pub fn connect(mut config: Config, environment: Environment, maximum: u32) -> Result<Self> {
        if !(1..=32).contains(&maximum) {
            return Err(Error::InvalidPoolSize);
        }
        config.connect_timeout(Duration::from_secs(5));
        config.application_name("gtd-runtime");
        let mut lifecycle_connection = config.clone();
        lifecycle_connection.application_name("gtd-account-lifecycle");
        let pool = Pool::builder()
            .max_size(maximum)
            .min_idle(Some(1))
            .connection_timeout(Duration::from_secs(5))
            .test_on_check_out(true)
            .error_handler(Box::new(SafePoolErrors))
            .build(PostgresConnectionManager::new(config, NoTls))
            .map_err(|_| Error::Unavailable)?;
        let identity = {
            let mut connection = pool.get().map_err(|_| Error::Unavailable)?;
            validate_runtime(&mut connection)?;
            metadata(&mut *connection, environment, None)?
        };
        Ok(Self {
            pool,
            lifecycle_connection,
            environment,
            identity,
            search: None,
            worker_notifications: Default::default(),
            view_tokens: Default::default(),
        })
    }

    pub fn read<T>(
        &self,
        principal: &Principal,
        operation: impl FnOnce(&mut AccountTransaction<'_>) -> Result<T>,
    ) -> Result<T> {
        self.transact(principal, false, operation)
    }
    pub fn write<T>(
        &self,
        principal: &Principal,
        operation: impl FnOnce(&mut AccountTransaction<'_>) -> Result<T>,
    ) -> Result<T> {
        self.transact(principal, true, operation)
    }

    fn transact<T>(
        &self,
        principal: &Principal,
        writing: bool,
        operation: impl FnOnce(&mut AccountTransaction<'_>) -> Result<T>,
    ) -> Result<T> {
        self.transact_attempt(principal, writing, true, operation)
    }

    fn transact_attempt<T>(
        &self,
        principal: &Principal,
        writing: bool,
        allow_activation: bool,
        operation: impl FnOnce(&mut AccountTransaction<'_>) -> Result<T>,
    ) -> Result<T> {
        let mut connection = self.pool.get().map_err(|_| Error::Unavailable)?;
        validate_runtime(&mut connection)?;
        let mut tx = connection
            .build_transaction()
            .isolation_level(if writing {
                IsolationLevel::ReadCommitted
            } else {
                IsolationLevel::RepeatableRead
            })
            .read_only(!writing)
            .start()?;
        tx.batch_execute("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='15s'")?;
        metadata(&mut tx, self.environment, Some(self.identity))?;
        let row = tx.query_typed_opt(
            "SELECT * FROM gtd.resolve_account($1,$2,$3,$4,$5)",
            &[
                (&principal.issuer, Type::TEXT),
                (&principal.subject, Type::TEXT),
                (&principal.credential_generation, Type::UUID),
                (&principal.authenticated_at, Type::INT8),
                (&principal.background, Type::BOOL),
            ],
        )?;
        let Some(row) = row else {
            drop(tx);
            drop(connection);
            if allow_activation && principal.credential_generation.is_some() {
                self.activate_invitation(principal)?;
                return self.transact_attempt(principal, writing, false, operation);
            }
            return Err(Error::AccountUnavailable);
        };
        let account = Account {
            id: row.get("id"),
            username: row.get("username"),
            display_name: row.get("display_name"),
            timezone: row
                .get::<_, String>("timezone")
                .parse()
                .map_err(|_| Error::InvalidTimezone)?,
            administrator: row.get("administrator"),
        };
        if principal
            .expected_environment
            .as_deref()
            .is_some_and(|v| v != self.environment.as_str())
        {
            return Err(Error::Binding("environment_changed"));
        }
        if principal
            .expected_account
            .as_deref()
            .is_some_and(|v| v != account.id.to_string())
        {
            return Err(Error::Binding("account_changed"));
        }
        tx.query_typed_one(
            "SELECT set_config('gtd.account_id',$1,true)",
            &[(&account.id.to_string(), Type::TEXT)],
        )?;
        // Acquire only this account's row, before any mutation reads. Under READ
        // COMMITTED, a waiting writer sees its predecessor's committed revision.
        let query = if writing {
            "SELECT high,identity FROM gtd.account_state WHERE account_id=$1 FOR UPDATE"
        } else {
            "SELECT high,identity FROM gtd.account_state WHERE account_id=$1"
        };
        let state = tx
            .query_typed_opt(query, &[(&account.id, Type::UUID)])?
            .ok_or(Error::AccountUnavailable)?;
        let mut bound = AccountTransaction {
            tx,
            account,
            writing,
            high: state.get("high"),
            identity: state.get("identity"),
            environment: self.environment,
            store_identity: self.identity,
        };
        let before = bound.high;
        let value = operation(&mut bound)?;
        let changed = bound.high != before;
        let account_id = bound.account.id;
        bound.tx.commit()?;
        if changed {
            self.worker_notifications.notify(account_id, principal);
        }
        Ok(value)
    }
}

pub struct AccountTransaction<'a> {
    pub(crate) tx: Transaction<'a>,
    account: Account,
    writing: bool,
    high: i64,
    identity: Uuid,
    environment: Environment,
    store_identity: Uuid,
}
impl AccountTransaction<'_> {
    pub fn account(&self) -> &Account {
        &self.account
    }
    pub fn high(&self) -> i64 {
        self.high
    }
    pub fn identity(&self) -> Uuid {
        self.identity
    }
    pub fn next_revision(&mut self) -> Result<i64> {
        if !self.writing {
            return Err(Error::ReadOnly);
        }
        self.high = self
            .tx
            .query_one(
                "UPDATE gtd.account_state SET high=high+1 WHERE account_id=$1 RETURNING high",
                &[&self.account.id],
            )?
            .get(0);
        Ok(self.high)
    }
}

fn validate_runtime(client: &mut ::postgres::Client) -> Result<()> {
    // Keep every privilege/RLS/context check on every checkout. One typed
    // statement avoids repeated prepare/execute/close round trips; no tenant or
    // security state is cached across requests or pooled connections.
    let row = client.query_typed_one(
        "SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb
        OR pg_has_role(current_user,'gtd_owner','MEMBER') AS privileged,
        nullif(current_setting('gtd.account_id',true),'') IS NOT NULL AS retained,
        (SELECT count(*) FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gtd' AND c.relkind='r'
         AND (pg_has_role(current_user,c.relowner,'MEMBER')
              OR has_table_privilege(current_user,c.oid,'TRUNCATE'))) AS unsafe_tables,
        (SELECT count(*) FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gtd'
         AND c.relname IN ('account_state','tasks','dependencies','changes','revisions',
             'requests','action_groups','search_state','search_sessions','legacy_imports','activity_events')
         AND c.relrowsecurity AND c.relforcerowsecurity) AS policies
        FROM pg_roles WHERE rolname=current_user",
        &[],
    )?;
    if row.get::<_, bool>("privileged") {
        return Err(Error::UnsafeRole);
    }
    if row.get::<_, bool>("retained") {
        return Err(Error::RetainedContext);
    }
    if row.get::<_, i64>("unsafe_tables") != 0 {
        return Err(Error::UnsafeRole);
    }
    if row.get::<_, i64>("policies") != 11 {
        return Err(Error::UnsafeRole);
    }
    Ok(())
}

fn metadata(
    client: &mut impl ::postgres::GenericClient,
    environment: Environment,
    identity: Option<Uuid>,
) -> Result<Uuid> {
    let row = client
        .query_typed_opt(
            "SELECT compatibility,environment,identity FROM gtd.schema_meta WHERE singleton",
            &[],
        )?
        .ok_or(Error::Compatibility)?;
    let actual: Uuid = row.get("identity");
    if row.get::<_, i32>("compatibility") != COMPATIBILITY
        || row.get::<_, String>("environment") != environment.as_str()
        || identity.is_some_and(|expected| expected != actual)
    {
        return Err(Error::Compatibility);
    }
    Ok(actual)
}

#[cfg(test)]
mod identity_tests;
#[cfg(test)]
mod legacy_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod website_tests;

#[cfg(test)]
mod write_tests;

#[cfg(test)]
mod maintenance_tests;

#[cfg(test)]
mod read_tests;

#[cfg(test)]
mod search_tests;

#[cfg(test)]
mod search_real_tests;

#[cfg(test)]
mod server_lifecycle_tests;

#[cfg(test)]
mod container_tests;

#[cfg(all(test, feature = "workflow-benchmarks"))]
mod workflow_bench;

#[cfg(all(test, feature = "postgres-operator"))]
mod activity_tests;

#[cfg(all(test, feature = "postgres-operator"))]
mod activity_bench;

#[cfg(all(test, feature = "workflow-benchmarks"))]
mod read_performance;
