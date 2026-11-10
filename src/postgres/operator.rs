//! Private offline migration entry point. This module is not compiled into the
//! HTTP service and cannot be selected by a tool, cookie or request parameter.
use super::{
    legacy::{Report, Snapshot, Source},
    *,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    source_path: PathBuf,
    source: Source,
    /// Logical digest from an earlier inspect, not an automatically accepted one.
    source_digest: Option<String>,
    destination: Option<Destination>,
    maintenance_state: Option<PathBuf>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Destination {
    database_dsn_file: PathBuf,
    environment: String,
    database_identity: Uuid,
    account_id: Uuid,
    issuer: String,
    subject: String,
    username: String,
    administrator: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Maintenance {
    operation: String,
    phase: String,
    environment: String,
    database_identity: Uuid,
    account_id: Uuid,
    source_digest: String,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Inspect,
    Import,
    Verify,
}
#[derive(Serialize)]
pub struct Outcome {
    operation: &'static str,
    source: Report,
    destination: Option<DestinationReport>,
    replayed: bool,
    current_verified: bool,
}
#[derive(Serialize)]
struct DestinationReport {
    environment: String,
    database_identity: Uuid,
    account_id: Uuid,
    history_identity: Uuid,
}
#[derive(Debug, thiserror::Error)]
pub enum OperatorError {
    #[error("Invalid private configuration or file permissions")]
    Configuration,
    #[error(
        "Source snapshot is invalid or does not match its expected identity, environment or digest"
    )]
    Source,
    #[error("Destination database or immutable account mapping does not match")]
    Destination,
    #[error("Maintenance lock unavailable or writers-stopped marker does not match this import")]
    Maintenance,
    #[error(
        "Import not confirmed; retain the source and retry with the same configuration. Never reset the destination"
    )]
    ImportUnconfirmed,
    #[error(
        "Current destination does not exactly match the source; keep writers stopped and investigate"
    )]
    Reconciliation,
}
type OperatorResult<T> = std::result::Result<T, OperatorError>;

// Open without following a final symlink; read a bounded amount from that same
// descriptor. A separate stat-then-open would race a replaced credential file.
pub(super) fn private_open(path: &Path, write: bool) -> OperatorResult<fs::File> {
    if !path.is_absolute() {
        return Err(OperatorError::Configuration);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(write)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| OperatorError::Configuration)?;
    let meta = file.metadata().map_err(|_| OperatorError::Configuration)?;
    if !meta.is_file() || meta.permissions().mode() & 0o077 != 0 || meta.len() > 32 * 1024 {
        return Err(OperatorError::Configuration);
    }
    Ok(file)
}
pub(super) fn private_text(path: &Path) -> OperatorResult<String> {
    let mut text = String::new();
    private_open(path, false)?
        .take(32 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| OperatorError::Configuration)?;
    if text.len() > 32 * 1024 {
        return Err(OperatorError::Configuration);
    }
    Ok(text)
}
pub fn read_config(path: &Path) -> OperatorResult<Config> {
    serde_json::from_str(&private_text(path)?).map_err(|_| OperatorError::Configuration)
}
fn maintenance(
    config: &Config,
    destination: &Destination,
    digest: &str,
) -> OperatorResult<fs::File> {
    let state = config
        .maintenance_state
        .as_ref()
        .ok_or(OperatorError::Maintenance)?;
    let meta = fs::symlink_metadata(state).map_err(|_| OperatorError::Maintenance)?;
    if !state.is_absolute() || !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
        return Err(OperatorError::Maintenance);
    }
    // Same flock-compatible lock used by existing deployment/backup operations.
    // The caller creates it; never replace its inode while another process holds it.
    let lock = private_open(&state.join("operation.lock"), true)
        .map_err(|_| OperatorError::Maintenance)?;
    lock.try_lock().map_err(|_| OperatorError::Maintenance)?;
    let marker: Maintenance = serde_json::from_str(
        &private_text(&state.join("promotion.json")).map_err(|_| OperatorError::Maintenance)?,
    )
    .map_err(|_| OperatorError::Maintenance)?;
    if marker.operation != "multi-user-import"
        || marker.phase != "writers-stopped"
        || marker.environment != destination.environment
        || marker.database_identity != destination.database_identity
        || marker.account_id != destination.account_id
        || marker.source_digest != digest
    {
        return Err(OperatorError::Maintenance);
    }
    Ok(lock)
}
fn check_destination(tx: &AccountTransaction<'_>, destination: &Destination) -> Result<Uuid> {
    if tx.store_identity != destination.database_identity
        || tx.account.id != destination.account_id
        || tx.account.username != destination.username
        || tx.account.administrator != destination.administrator
    {
        return Err(Error::Compatibility);
    }
    Ok(tx.identity())
}
pub fn execute(config: Config, command: Command) -> OperatorResult<Outcome> {
    if !config.source_path.is_absolute() {
        return Err(OperatorError::Configuration);
    }
    let snapshot =
        Snapshot::open(&config.source_path, &config.source).map_err(|_| OperatorError::Source)?;
    if command == Command::Inspect {
        return Ok(Outcome {
            operation: "inspect",
            source: snapshot.report().clone(),
            destination: None,
            replayed: false,
            current_verified: false,
        });
    }
    if config.source_digest.as_deref() != Some(snapshot.report().digest.as_str()) {
        return Err(OperatorError::Source);
    }
    let destination = config
        .destination
        .as_ref()
        .ok_or(OperatorError::Configuration)?;
    let environment = match destination.environment.as_str() {
        "production"
            if config.source.environment == "production"
                && destination.username == "owner"
                && destination.administrator =>
        {
            Environment::Production
        }
        "staging" => Environment::Staging,
        _ => return Err(OperatorError::Configuration),
    };
    let issuer = url::Url::parse(&destination.issuer).map_err(|_| OperatorError::Configuration)?;
    if issuer.scheme() != "https"
        || issuer.host_str().is_none()
        || !issuer.username().is_empty()
        || issuer.password().is_some()
        || issuer.query().is_some()
        || issuer.fragment().is_some()
        || destination.subject.trim().is_empty()
        || destination.username.trim().is_empty()
    {
        return Err(OperatorError::Configuration);
    }
    // Holding this operator-owned lock does not stop application processes. The
    // cutover procedure must first stop them and persist the matching marker.
    let _lock = maintenance(&config, destination, &snapshot.report().digest)?;
    let dsn = private_text(&destination.database_dsn_file)?;
    let store = Store::connect(
        dsn.trim()
            .parse()
            .map_err(|_| OperatorError::Configuration)?,
        environment,
        1,
    )
    .map_err(|_| OperatorError::Destination)?;
    // Explicit trusted offline mapping. No username lookup or runtime fallback;
    // this principal is inaccessible to the HTTP/MCP build. Disablement still
    // prevents import, and both DB and account IDs are equality assertions.
    let principal =
        Principal::for_background(destination.issuer.clone(), destination.subject.clone());
    let identity = store
        .read(&principal, |tx| check_destination(tx, destination))
        .map_err(|_| OperatorError::Destination)?;
    let replayed = match command {
        Command::Import => store
            .write(&principal, |tx| {
                check_destination(tx, destination)?;
                snapshot.import_in(tx)
            })
            .map_err(|_| OperatorError::ImportUnconfirmed)?,
        Command::Verify => {
            store
                .read(&principal, |tx| {
                    check_destination(tx, destination)?;
                    snapshot.verify_in(tx)
                })
                .map_err(|_| OperatorError::Reconciliation)?;
            false
        }
        Command::Inspect => unreachable!(),
    };
    Ok(Outcome {
        operation: if command == Command::Import {
            "import"
        } else {
            "verify"
        },
        source: snapshot.report().clone(),
        destination: Some(DestinationReport {
            environment: destination.environment.clone(),
            database_identity: destination.database_identity,
            account_id: destination.account_id,
            history_identity: identity,
        }),
        replayed,
        current_verified: !replayed,
    })
}

#[cfg(test)]
mod tests;
