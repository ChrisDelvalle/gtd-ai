//! Website-only authentication. Session IDs/passwords never enter the task store.
use async_trait::async_trait;
use axum::{
    Json,
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_login::{
    AuthUser, AuthnBackend, UserId,
    tower_sessions::{
        Expiry, Session,
        session::{Id, Record},
        session_store::{self, SessionStore},
    },
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use time::{Duration, OffsetDateTime};

pub type AuthSession = axum_login::AuthSession<Backend>;

#[derive(Debug, thiserror::Error)]
#[error("Website authentication unavailable")]
pub struct AuthError;

#[derive(Clone)]
pub struct User {
    name: String,
    fingerprint: Vec<u8>,
}
impl fmt::Debug for User {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WebsiteUser")
    }
}
impl AuthUser for User {
    type Id = String;
    fn id(&self) -> String {
        self.name.clone()
    }
    fn session_auth_hash(&self) -> &[u8] {
        &self.fingerprint
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    username: String,
    password: String,
    #[serde(default)]
    remember: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialFile {
    username: String,
    password_hash: String,
}

fn read_credentials(path: &Path) -> Result<CredentialFile, AuthError> {
    let value = std::fs::read(path).map_err(|_| AuthError)?;
    if value.len() > 4096 {
        return Err(AuthError);
    }
    let value: CredentialFile = serde_json::from_slice(&value).map_err(|_| AuthError)?;
    if value.username.is_empty() || value.username.len() > 128 {
        return Err(AuthError);
    }
    let hash = bcrypt::HashParts::from_str(&value.password_hash).map_err(|_| AuthError)?;
    if !(4..=16).contains(&hash.get_cost()) {
        return Err(AuthError);
    }
    Ok(value)
}
use std::str::FromStr;

#[derive(Clone, Debug)]
pub struct Backend {
    credential_file: PathBuf,
    pub store: SqliteSessions,
    pub secure: bool,
}
impl Backend {
    pub fn open(credentials: PathBuf, database: PathBuf, secure: bool) -> Result<Self, AuthError> {
        read_credentials(&credentials)?;
        Ok(Self {
            credential_file: credentials,
            store: SqliteSessions::open(&database)?,
            secure,
        })
    }
}

impl AuthnBackend for Backend {
    type User = User;
    type Credentials = Credentials;
    type Error = AuthError;
    async fn authenticate(&self, credentials: Credentials) -> Result<Option<User>, AuthError> {
        let path = self.credential_file.clone();
        tokio::task::spawn_blocking(move || {
            let stored = read_credentials(&path)?;
            // Verify even a wrong username; never log credentials or verifier errors.
            let valid = bcrypt::verify(&credentials.password, &stored.password_hash)
                .map_err(|_| AuthError)?;
            Ok(
                (valid && credentials.username == stored.username).then(|| User {
                    name: stored.username,
                    fingerprint: Sha256::digest(stored.password_hash.as_bytes()).to_vec(),
                }),
            )
        })
        .await
        .map_err(|_| AuthError)?
    }
    async fn get_user(&self, user_id: &UserId<Self>) -> Result<Option<User>, AuthError> {
        let path = self.credential_file.clone();
        let id = user_id.clone();
        tokio::task::spawn_blocking(move || {
            let stored = read_credentials(&path)?;
            Ok((id == stored.username).then(|| User {
                name: stored.username,
                fingerprint: Sha256::digest(stored.password_hash.as_bytes()).to_vec(),
            }))
        })
        .await
        .map_err(|_| AuthError)?
    }
}

#[derive(Clone)]
pub struct SqliteSessions(Arc<Mutex<Connection>>);
impl fmt::Debug for SqliteSessions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SqliteSessions")
    }
}
impl SqliteSessions {
    fn open(path: &Path) -> Result<Self, AuthError> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .map_err(|_| AuthError)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| AuthError)?;
        let db = Connection::open(path).map_err(|_| AuthError)?;
        let unrelated: i64 = db.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT IN ('sessions','login_attempts') AND name NOT LIKE 'sqlite_%'",
            [], |row| row.get(0),
        ).map_err(|_| AuthError)?;
        if unrelated != 0 {
            return Err(AuthError);
        }
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| AuthError)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
            CREATE TABLE IF NOT EXISTS login_attempts (at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS login_attempts_at ON login_attempts(at);").map_err(|_| AuthError)?;
        db.execute(
            "DELETE FROM sessions WHERE expires <= ?",
            [OffsetDateTime::now_utc().unix_timestamp()],
        )
        .map_err(|_| AuthError)?;
        Ok(Self(Arc::new(Mutex::new(db))))
    }
    async fn with_db<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, AuthError> + Send + 'static,
    ) -> Result<T, AuthError> {
        let db = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = db.lock().map_err(|_| AuthError)?;
            f(&mut guard)
        })
        .await
        .map_err(|_| AuthError)?
    }
    // A bounded, persistent account-wide limiter; forwarded IPs cannot bypass it.
    async fn reserve_login(&self) -> Result<Option<i64>, AuthError> {
        self.with_db(|db| {
            let now = OffsetDateTime::now_utc().unix_timestamp();
            let tx = db.transaction().map_err(|_| AuthError)?;
            tx.execute("DELETE FROM login_attempts WHERE at <= ?", [now - 900])
                .map_err(|_| AuthError)?;
            tx.execute("DELETE FROM sessions WHERE expires <= ?", [now])
                .map_err(|_| AuthError)?;
            let (minute, quarter): (i64, i64) = tx
                .query_row(
                    "SELECT COALESCE(SUM(at > ?), 0), COUNT(*) FROM login_attempts",
                    [now - 60],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| AuthError)?;
            if minute >= 5 || quarter >= 20 {
                let (shortest, longest): (i64, i64) = tx.query_row(
                    "SELECT COALESCE(MIN(CASE WHEN at > ? THEN at END), ?), MIN(at) FROM login_attempts",
                    params![now - 60, now], |r| Ok((r.get(0)?, r.get(1)?)),
                ).map_err(|_| AuthError)?;
                let retry = (if minute >= 5 { shortest + 60 - now } else { 0 })
                    .max(if quarter >= 20 { longest + 900 - now } else { 0 }).max(1);
                tx.commit().map_err(|_| AuthError)?;
                return Ok(Some(retry));
            }
            tx.execute("INSERT INTO login_attempts(at) VALUES (?)", [now])
                .map_err(|_| AuthError)?;
            tx.commit().map_err(|_| AuthError)?;
            Ok(None)
        })
        .await
    }
}
fn key(id: &Id) -> String {
    format!("{:x}", Sha256::digest(id.to_string().as_bytes()))
}
fn store_error(_: AuthError) -> session_store::Error {
    session_store::Error::Backend("Session storage unavailable".into())
}
fn expiry(record: &Record) -> i64 {
    record.expiry_date.unix_timestamp().min(
        record
            .data
            .get("gtd_expires_at")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
    )
}
#[async_trait]
impl SessionStore for SqliteSessions {
    async fn create(&self, record: &mut Record) -> session_store::Result<()> {
        loop {
            let id = key(&record.id);
            let data = serde_json::to_string(&record.data).map_err(|_| store_error(AuthError))?;
            let expires = expiry(record);
            let inserted = self
                .with_db(move |db| {
                    db.execute(
                        "INSERT OR IGNORE INTO sessions(key, data, expires) VALUES (?, ?, ?)",
                        params![id, data, expires],
                    )
                    .map_err(|_| AuthError)
                })
                .await
                .map_err(store_error)?;
            if inserted == 1 {
                return Ok(());
            }
            record.id = Id::default();
        }
    }
    async fn save(&self, record: &Record) -> session_store::Result<()> {
        let id = key(&record.id);
        let data = serde_json::to_string(&record.data).map_err(|_| store_error(AuthError))?;
        let expires = expiry(record);
        // Never upsert: an in-flight request cannot resurrect a logged-out session.
        self.with_db(move |db| {
            db.execute(
                "UPDATE sessions SET data=?, expires=MIN(expires, ?) WHERE key=? AND expires>?",
                params![
                    data,
                    expires,
                    id,
                    OffsetDateTime::now_utc().unix_timestamp()
                ],
            )
            .map_err(|_| AuthError)?;
            Ok(())
        })
        .await
        .map_err(store_error)
    }
    async fn load(&self, id: &Id) -> session_store::Result<Option<Record>> {
        let id = *id;
        self.with_db(move |db| {
            let row: Option<(String, i64)> = db
                .query_row(
                    "SELECT data, expires FROM sessions WHERE key=? AND expires>?",
                    params![key(&id), OffsetDateTime::now_utc().unix_timestamp()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|_| AuthError)?;
            row.map(|(data, expires)| {
                Ok(Record {
                    id,
                    data: serde_json::from_str(&data).map_err(|_| AuthError)?,
                    expiry_date: OffsetDateTime::from_unix_timestamp(expires)
                        .map_err(|_| AuthError)?,
                })
            })
            .transpose()
        })
        .await
        .map_err(store_error)
    }
    async fn delete(&self, id: &Id) -> session_store::Result<()> {
        let id = key(id);
        self.with_db(move |db| {
            db.execute("DELETE FROM sessions WHERE key=?", [id])
                .map_err(|_| AuthError)?;
            Ok(())
        })
        .await
        .map_err(store_error)
    }
}

fn failure(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({"code":code,"message":message}))).into_response()
}
fn unavailable() -> Response {
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "auth_unavailable",
        "Sign-in is temporarily unavailable. Try again.",
    )
}
pub async fn require_auth(auth: AuthSession, request: Request, next: Next) -> Response {
    if auth.user.is_none() {
        return failure(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
            "Sign in to continue. Your draft is still here.",
        );
    }
    next.run(request).await
}
pub async fn status(
    State(state): State<crate::web::WebState>,
    auth: AuthSession,
) -> Json<serde_json::Value> {
    let environment = state
        .app
        .store
        .lock()
        .map(|store| store.environment())
        .unwrap_or("unknown".into());
    Json(json!({"authenticated":auth.user.is_some(),"enabled":true,"environment":environment}))
}
pub async fn login(
    State(state): State<crate::web::WebState>,
    mut auth: AuthSession,
    session: Session,
    Json(credentials): Json<Credentials>,
) -> Response {
    let Some(backend) = state.auth else {
        return unavailable();
    };
    match backend.store.reserve_login().await {
        Ok(None) => {}
        Ok(Some(seconds)) => {
            let mut response = failure(
                StatusCode::TOO_MANY_REQUESTS,
                "login_throttled",
                &format!(
                    "Too many attempts. Try again in {} minute{}.",
                    (seconds + 59) / 60,
                    if seconds > 60 { "s" } else { "" }
                ),
            );
            response
                .headers_mut()
                .insert("retry-after", seconds.to_string().parse().unwrap());
            return response;
        }
        Err(_) => return unavailable(),
    }
    if credentials.username.len() > 128
        || credentials.password.len() > 1024
        || credentials.password.is_empty()
    {
        return failure(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Incorrect username or password.",
        );
    }
    let remember = credentials.remember;
    let user = match auth.authenticate(credentials).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return failure(
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "Incorrect username or password.",
            );
        }
        Err(_) => return unavailable(),
    };
    // Always rotate, including when signing in again from an authenticated page.
    if auth.logout().await.is_err()
        || session.cycle_id().await.is_err()
        || auth.login(&user).await.is_err()
    {
        return unavailable();
    }
    let deadline = OffsetDateTime::now_utc()
        + if remember {
            Duration::days(30)
        } else {
            Duration::hours(12)
        };
    if session
        .insert("gtd_expires_at", deadline.unix_timestamp())
        .await
        .is_err()
    {
        return unavailable();
    }
    session.set_expiry(Some(if remember {
        Expiry::AtDateTime(deadline)
    } else {
        Expiry::OnSessionEnd
    }));
    Json(json!({"authenticated":true})).into_response()
}
pub async fn logout(mut auth: AuthSession) -> Response {
    match auth.logout().await {
        Ok(_) => Json(json!({"authenticated":false})).into_response(),
        Err(_) => unavailable(),
    }
}

/// No implicit unauthenticated fallback, including if credentials are unreadable.
pub fn configuration(
    environment: &str,
    listen: &str,
) -> Result<Option<Backend>, Box<dyn std::error::Error>> {
    if std::env::var("TODO_WEB_AUTH_TEST_BYPASS").as_deref() == Ok("1") {
        let address: std::net::SocketAddr = listen.parse()?;
        if environment != "test" || !address.ip().is_loopback() {
            return Err(
                "Authentication bypass requires a loopback-only disposable test server".into(),
            );
        }
        return Ok(None);
    }
    let file = PathBuf::from(
        std::env::var_os("TODO_WEB_AUTH_FILE")
            .ok_or("TODO_WEB_AUTH_FILE is required for website login")?,
    );
    let db = PathBuf::from(
        std::env::var_os("TODO_WEB_SESSION_DB")
            .ok_or("TODO_WEB_SESSION_DB must name a separate persistent session database")?,
    );
    let insecure = std::env::var("TODO_WEB_AUTH_TEST_HTTP").as_deref() == Ok("1");
    if insecure
        && (environment != "test" || !listen.parse::<std::net::SocketAddr>()?.ip().is_loopback())
    {
        return Err(
            "HTTP authentication fixtures require a loopback-only disposable test server".into(),
        );
    }
    Ok(Some(Backend::open(file, db, !insecure)?))
}
