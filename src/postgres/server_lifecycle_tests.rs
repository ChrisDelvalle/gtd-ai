//! Process-level opt-in/shutdown acceptance. Build gtd-account-server first.
use super::{tests::fixture, write_tests::run, *};
use serde_json::json;
use std::{
    fs,
    io::Write,
    net::TcpListener,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::Instant,
};

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn private(path: &Path, bytes: &[u8]) {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap()
        .write_all(bytes)
        .unwrap();
}
fn stop(child: &mut Running) {
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.0.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "account server did not stop cleanly");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "account server did not stop in time"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "Manual executable lifecycle check; build gtd-account-server, disposable local PostgreSQL, no model calls"]
fn account_server_opts_into_maintenance_and_joins_it_on_termination() {
    let (_pg, mut db, config, a, b) = fixture();
    db.execute("DELETE FROM gtd.tasks", &[]).unwrap();
    db.execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&b])
        .unwrap();
    let store = Store::connect(config.clone(), Environment::Staging, 2).unwrap();
    run(
        &store,
        "a",
        "recurrence",
        json!({"request_id":"backlog","reason":"Fixture",
        "template":{"title":"Process fixture","brief":"Synthetic recurrence.","agent_notes":"Shared synthetic handoff.","importance":"normal","estimated_minutes":5,"effort":"low"},
        "rule":{"start_date":"2000-01-01","frequency":"daily","count":305}}),
    );
    let count = |db: &mut postgres::Client| {
        db.query_one(
            "SELECT count(*) FROM gtd.tasks WHERE account_id=$1 AND series_id IS NOT NULL",
            &[&a],
        )
        .unwrap()
        .get::<_, i64>(0)
    };
    assert_eq!(count(&mut db), 100);
    let dir = tempfile::tempdir().unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let dsn = dir.path().join("database.dsn");
    // These credentials were generated for this disposable loopback fixture.
    private(
        &dsn,
        format!(
            "host=127.0.0.1 port={} user=gtd_runtime dbname=postgres password={}",
            config.get_ports()[0],
            std::str::from_utf8(config.get_password().unwrap()).unwrap()
        )
        .as_bytes(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let database_identity: Uuid = db
        .query_one("SELECT identity FROM gtd.schema_meta", &[])
        .unwrap()
        .get(0);
    let settings = json!({"environment":"staging","listen":address.to_string(),"database_dsn_file":dsn,"database_identity":database_identity,
        "pool_size":4,"issuer":"https://identity.invalid/fixture","resource":"https://gtd.invalid/mcp",
        "protected_resource_metadata":"https://gtd.invalid/.well-known/oauth-protected-resource/mcp",
        "diagnostics_file":dir.path().join("service.db")});
    let disabled = dir.path().join("disabled.json");
    private(&disabled, &serde_json::to_vec(&settings).unwrap());
    let enabled = dir.path().join("enabled.json");
    let mut settings = settings;
    settings["background"] = json!(true);
    private(&enabled, &serde_json::to_vec(&settings).unwrap());
    let binary = std::env::var_os("GTD_TEST_ACCOUNT_SERVER_BINARY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/gtd-account-server")
        });
    assert!(
        binary.is_file(),
        "Build gtd-account-server before this ignored process test"
    );
    let launch = |path: &Path| {
        let log = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(dir.path().join(format!("{}.log", Uuid::new_v4())))
            .unwrap();
        Running(
            Command::new(&binary)
                .arg(path)
                .env_clear()
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::from(log))
                .spawn()
                .unwrap(),
        )
    };
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    let ready = |child: &mut Running| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "account server exited at startup: {}",
                fs::read_dir(dir.path())
                    .unwrap()
                    .flatten()
                    .filter(|e| e.path().extension().is_some_and(|ext| ext == "log"))
                    .map(|e| fs::read_to_string(e.path()).unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            if client
                .get(format!("http://{address}/internal/ready"))
                .send()
                .is_ok_and(|r| r.status().is_success())
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "account server did not become ready"
            );
            thread::sleep(Duration::from_millis(20));
        }
    };
    let mut server = launch(&disabled);
    ready(&mut server);
    assert_eq!(
        count(&mut db),
        100,
        "maintenance must be explicitly enabled"
    );
    let mut collision = launch(&enabled);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = collision.0.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "second server should refuse the occupied listener"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        count(&mut db),
        100,
        "a failed listener must not start a worker"
    );
    stop(&mut server);
    let mut server = launch(&enabled);
    ready(&mut server);
    let deadline = Instant::now() + Duration::from_secs(10);
    while count(&mut db) < 305 {
        assert!(
            Instant::now() < deadline,
            "enabled maintenance did not finish bounded catch-up"
        );
        thread::sleep(Duration::from_millis(20));
    }
    stop(&mut server);
    assert_eq!(count(&mut db), 305);
}
