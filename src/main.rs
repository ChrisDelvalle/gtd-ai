use rmcp::{ServiceExt, transport::stdio};
use std::{env, error::Error, path::PathBuf};
use todo_mcp::{
    application::Application, diagnostics::Diagnostics, server::TodoServer, store::Store,
    supervisor, web,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    todo_mcp::clock::initialize()?;
    let mut args = env::args().skip(1);
    let mut path =
        PathBuf::from(env::var_os("TODO_DB_PATH").unwrap_or_else(|| "data/todo.sqlite3".into()));
    let mut backup = None;
    let mut mode = "mcp";
    let mut listen = "0.0.0.0:8081".to_string();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => path = args.next().ok_or("--db needs a path")?.into(),
            "--backup" => {
                backup = Some(PathBuf::from(
                    args.next().ok_or("--backup needs a new destination path")?,
                ))
            }
            "--web" => mode = "web",
            "--worker" => mode = "worker",
            "--supervise-tunnel" => mode = "tunnel",
            "--listen" => listen = args.next().ok_or("--listen needs an address")?,
            "--help" | "-h" => {
                println!(
                    "todo-mcp [--db PATH] [--backup NEW_PATH] [--web [--listen ADDRESS] | --worker | --supervise-tunnel]\nDefault: MCP stdio. TODO_DB_PATH, TODO_LOG_DB_PATH, TODO_WEB_DIR, TODO_WEB_ORIGINS (or legacy TODO_WEB_ORIGIN), TODO_HEALTH_SOCKET configure deployment.\n--backup creates a consistent snapshot and never overwrites."
                );
                return Ok(());
            }
            "--version" | "-V" => {
                println!("todo-mcp {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            _ => return Err(format!("unknown argument {arg}").into()),
        }
    }
    if backup.is_some() && !path.is_file() {
        return Err("backup source database does not exist".into());
    }
    if let Some(destination) = backup {
        Store::open(path)?.backup(destination)?;
        eprintln!("Backup completed.");
        return Ok(());
    }
    let logs = env::var_os("TODO_LOG_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| path.with_extension("diagnostics.sqlite3"));
    let diagnostics = Diagnostics::open(&logs, mode)?;
    let socket = env::var_os("TODO_HEALTH_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/run/todo-health/tunnel.sock".into());
    let cleanup = diagnostics.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            let cleanup = cleanup.clone();
            let _ = tokio::task::spawn_blocking(move || cleanup.prune()).await;
        }
    });
    if mode == "tunnel" {
        return supervisor::run(diagnostics, &socket).await;
    }
    if mode == "worker" {
        diagnostics.event(
            "worker.start",
            "success",
            "Indexing and recurrence worker started",
        );
        let shutdown = supervisor::shutdown_signal();
        tokio::pin!(shutdown);
        let mut previous = String::new();
        loop {
            let path = path.clone();
            let job = tokio::task::spawn_blocking(
                move || -> Result<bool, todo_mcp::store::StoreError> {
                    let mut store = Store::open(path)?.with_origin("worker");
                    let day = todo_mcp::clock::now()
                        .with_timezone(&chrono_tz::America::New_York)
                        .date_naive()
                        .to_string();
                    store.materialize_recurrences(&day)?;
                    store.settle_availability()?;
                    if env::var_os("TODO_SEARCH_URL").is_some() {
                        store.index_once()?;
                        return Ok(store.search_health()["ready"].as_bool().unwrap_or(false));
                    }
                    Ok(true)
                },
            );
            tokio::pin!(job);
            let outcome =
                tokio::select! {result=&mut job=>result, _=&mut shutdown=>{let _=job.await;break}};
            let status = match outcome {
                Ok(Ok(_)) => "success",
                Ok(Err(ref e)) => e.code(),
                Err(_) => "interrupted",
            }
            .to_string();
            if status != previous {
                diagnostics.event(
                    "worker.cycle",
                    if status == "success" {
                        "success"
                    } else {
                        "error"
                    },
                    &status,
                );
                previous = status;
            }
            let delay = if matches!(outcome, Ok(Ok(false))) {
                100
            } else {
                1000
            };
            tokio::select! {_=tokio::time::sleep(std::time::Duration::from_millis(delay))=>{},_=&mut shutdown=>break}
        }
        diagnostics.event("worker.stop", "success", "Worker stopped");
        return Ok(());
    }
    let app = Application::new(
        Store::open(&path)?.with_origin(if mode == "web" { "website" } else { "mcp" }),
        diagnostics.clone(),
    );
    if mode == "web" {
        let read = |name| {
            env::var_os(name)
                .map(|v| {
                    v.into_string()
                        .map_err(|_| "Website origin configuration must be UTF-8")
                })
                .transpose()
        };
        let multiple = read("TODO_WEB_ORIGINS")?;
        let legacy = read("TODO_WEB_ORIGIN")?;
        let origins = web::AllowedOrigins::from_config(multiple.as_deref(), legacy.as_deref())?;
        return web::serve(app, &listen, origins, socket).await;
    }
    diagnostics.event("mcp.start", "success", "MCP service started");
    let service = TodoServer { app }.serve(stdio()).await?;
    let cancellation = service.cancellation_token();
    tokio::spawn(async move {
        supervisor::shutdown_signal().await;
        cancellation.cancel();
    });
    service.waiting().await?;
    diagnostics.event("mcp.stop", "success", "MCP service stopped");
    Ok(())
}
