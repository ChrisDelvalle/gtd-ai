//! Opt-in private backend. Does not create schema, migrate data, provision users,
//! or replace the existing supervisor. Configuration is operator-owned.
use serde::Deserialize;
use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};
use todo_mcp::{
    diagnostics::Diagnostics,
    identity::{
        Verifier, browser::BrowserIdentity, http::Service, operations::Operations,
        provisioning::keycloak::Keycloak, website, website_session::WebsiteSessions,
    },
    postgres::{BackgroundWorker, Environment, SearchConfig, Store},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    environment: String,
    listen: SocketAddr,
    database_dsn_file: PathBuf,
    database_identity: uuid::Uuid,
    pool_size: u32,
    issuer: String,
    identity_ca_file: Option<PathBuf>,
    resource: String,
    protected_resource_metadata: String,
    search_url: Option<String>,
    search_key_file: Option<PathBuf>,
    website: Option<WebsiteConfig>,
    #[serde(default)]
    background: bool,
    diagnostics_file: Option<PathBuf>,
    openai_health_origin: Option<String>,
    chatgpt_resource: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WebsiteConfig {
    origin: String,
    client_id: String,
    client_secret_file: PathBuf,
    provider_private_url: String,
    realm: String,
    administration_client_id: String,
    administration_secret_file: PathBuf,
    oauth_clients: Vec<String>,
}
fn private_file(path: &Path) -> Result<String, ()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_file()
        || metadata.len() > 32 * 1024
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(());
    }
    fs::read_to_string(path).map_err(|_| ())
}
fn operational_log(path: &Path) -> Result<Diagnostics, ()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if !path.is_absolute() {
        return Err(());
    }
    let parent = fs::symlink_metadata(path.parent().ok_or(())?).map_err(|_| ())?;
    if !parent.is_dir() || parent.permissions().mode() & 0o077 != 0 {
        return Err(());
    }
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
            if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
                return Err(());
            }
        }
        Err(_) => return Err(()),
    }
    Diagnostics::open(path, "account").map_err(|_| ())
}
type Prepared = (
    SocketAddr,
    Service,
    Option<website::Service>,
    Option<BackgroundWorker>,
);
fn prepare(config: Config) -> Result<Prepared, &'static str> {
    if !config.listen.ip().is_loopback() || config.listen.port() == 0 {
        return Err("listen_configuration");
    }
    let environment = match config.environment.as_str() {
        "staging" => Environment::Staging,
        "production" => Environment::Production,
        _ => return Err("environment_configuration"),
    };
    let identity_ca = match config.identity_ca_file {
        Some(path) if environment == Environment::Staging => Some(
            reqwest::Certificate::from_pem(
                private_file(&path)
                    .map_err(|_| "identity_ca_file")?
                    .as_bytes(),
            )
            .map_err(|_| "identity_ca_configuration")?,
        ),
        Some(_) => return Err("identity_ca_requires_staging"),
        None => None,
    };
    let dsn = private_file(&config.database_dsn_file).map_err(|_| "database_file")?;
    let mut store = Store::connect_expected(
        dsn.trim().parse().map_err(|_| "database_configuration")?,
        environment,
        config.pool_size,
        config.database_identity,
    )
    .map_err(|_| "database_connect")?;
    match (config.search_url, config.search_key_file) {
        (Some(url), Some(path)) => {
            store = store.with_search(
                SearchConfig::new(url, private_file(&path).map_err(|_| "search_file")?)
                    .map_err(|_| "search_configuration")?,
            )
        }
        (None, None) => {}
        _ => return Err("search_configuration"),
    }
    let mut verifier =
        Verifier::new(&config.issuer, &config.resource).map_err(|_| "identity_configuration")?;
    if let Some(root) = &identity_ca {
        verifier = verifier
            .with_root_certificate(root.clone())
            .map_err(|_| "identity_ca_configuration")?;
    }
    let operations = match config.diagnostics_file {
        Some(path) => Some(
            Operations::new(
                operational_log(&path).map_err(|_| "diagnostic_file")?,
                config.openai_health_origin.as_deref(),
            )
            .map_err(|_| "diagnostic_configuration")?,
        ),
        None if config.openai_health_origin.is_none() => None,
        None => return Err("diagnostic_configuration"),
    };
    let website = config
        .website
        .map(|web| -> Result<_, &'static str> {
            let mut identity = BrowserIdentity::new(
                &config.issuer,
                &web.client_id,
                private_file(&web.client_secret_file)
                    .map_err(|_| "website_secret_file")?
                    .trim()
                    .to_owned(),
                &web.origin,
                &config.resource,
            )
            .map_err(|_| "website_identity_configuration")?;
            if let Some(root) = identity_ca {
                identity = identity
                    .with_root_certificate(root)
                    .map_err(|_| "identity_ca_configuration")?;
            }
            let sessions = WebsiteSessions::new(store.clone(), identity);
            let provider = Keycloak::new(
                &web.provider_private_url,
                &config.issuer,
                &web.realm,
                &web.administration_client_id,
                private_file(&web.administration_secret_file)
                    .map_err(|_| "administration_secret_file")?
                    .trim()
                    .to_owned(),
                web.oauth_clients,
            )
            .map_err(|_| "administration_configuration")?;
            let service = website::Service::new(
                store.clone(),
                sessions,
                provider,
                &web.origin,
                &config.issuer,
            )
            .map_err(|_| "website_configuration")?;
            Ok(if let Some(operations) = &operations {
                service.with_operations(operations.clone())
            } else {
                service
            })
        })
        .transpose()?;
    let background = config.background.then(|| store.background_worker());
    let mut service = Service::new(store, verifier, &config.protected_resource_metadata)
        .map_err(|_| "metadata_configuration")?;
    if let Some(operations) = operations {
        service = service.with_operations(operations);
    }
    if let Some(resource) = config.chatgpt_resource {
        service = service
            .with_chatgpt_resource(&resource)
            .map_err(|_| "chatgpt_resource")?;
    }
    Ok((config.listen, service, website, background))
}
async fn shutdown() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("signal handler");
    tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
}
fn run() -> Result<(), &'static str> {
    let mut args = std::env::args_os().skip(1);
    let path = args.next().ok_or("arguments")?;
    if args.next().is_some() {
        return Err("arguments");
    }
    let config: Config =
        serde_json::from_str(&private_file(Path::new(&path)).map_err(|_| "configuration_file")?)
            .map_err(|_| "configuration_format")?;
    // Synchronous postgres/reqwest clients must also be destroyed outside Tokio.
    // Retain the owning Service until the runtime and all server tasks stop.
    let (address, service, website, background) = prepare(config)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| "runtime")?;
    let result = runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .map_err(|_| "listener")?;
        let mut router = service.clone().router();
        if let Some(website) = website.clone() {
            router = router.merge(website.router());
        }
        // Start maintenance only after the listener binds. A failed second
        // instance must not start writing in the background.
        let (stop, stopped) = std::sync::mpsc::channel();
        let mut worker =
            background.map(|worker| tokio::task::spawn_blocking(move || worker.run(stopped)));
        let has_worker = worker.is_some();
        let worker_exit = async {
            match worker.as_mut() {
                Some(task) => {
                    let _ = task.await;
                }
                None => std::future::pending::<()>().await,
            }
        };
        let (drain, draining) = tokio::sync::oneshot::channel::<()>();
        let server = async {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = draining.await;
                })
                .await
                .map_err(|_| "http_server")
        };
        tokio::pin!(server, worker_exit);
        eprintln!("{{\"component\":\"account-http\",\"operation\":\"ready\"}}");
        let mut worker_failed = false;
        let result = tokio::select! {
            value = &mut server => Some(value),
            _ = shutdown() => None,
            _ = &mut worker_exit => { worker_failed = true; None },
        };
        // No detached worker can outlive HTTP shutdown or the maintenance lock.
        let _ = stop.send(());
        let _ = drain.send(());
        let result = match result {
            Some(value) => value,
            None => server.await,
        };
        if has_worker && !worker_failed {
            worker_exit.await;
        }
        if worker_failed {
            Err("background_worker")
        } else {
            result
        }
    });
    runtime.shutdown_timeout(Duration::from_secs(20));
    drop(service);
    drop(website);
    result
}
fn main() {
    if let Err(stage) = run() {
        // Fixed stage identifiers only; no configuration values or raw errors.
        eprintln!(
            "{{\"component\":\"account-http\",\"operation\":\"service_failed\",\"stage\":\"{stage}\"}}"
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn production_cannot_enable_a_private_identity_root() {
        let config: Config = serde_json::from_value(serde_json::json!({
            "environment":"production", "listen":"127.0.0.1:19541",
            "database_dsn_file":"/nonexistent", "database_identity":uuid::Uuid::new_v4(),
            "pool_size":1, "issuer":"https://identity.invalid/realms/gtd",
            "identity_ca_file":"/nonexistent-ca", "resource":"https://mcp.invalid/mcp",
            "protected_resource_metadata":"https://mcp.invalid/.well-known/oauth-protected-resource/mcp"
        })).unwrap();
        assert_eq!(prepare(config).err(), Some("identity_ca_requires_staging"));
    }
    #[test]
    fn operator_files_must_be_small_private_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        fs::write(&path, "synthetic fixture").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(private_file(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(private_file(&path).unwrap(), "synthetic fixture");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(private_file(&link).is_err());
        fs::write(&path, vec![b'x'; 32 * 1024 + 1]).unwrap();
        assert!(private_file(&path).is_err());
    }
    #[test]
    fn diagnostic_storage_stays_in_a_private_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().join("service.db");
        let log = operational_log(&path).unwrap();
        log.event("fixture", "info", "Only operational metadata");
        drop(log);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(operational_log(&path).is_ok());
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(operational_log(&path).is_err());
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(operational_log(&link).is_err());
    }
}
