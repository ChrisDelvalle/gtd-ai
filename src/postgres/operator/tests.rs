use super::*;
use crate::postgres::tests::{ISSUER, fixture};
use serde_json::{Value, json};
use std::{io::Write, process::Command as Process};

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
#[test]
fn private_configuration_refuses_public_files_symlinks_and_unknown_fields() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.json");
    let value = json!({"source_path":"/fixture/db","source":{"identity":Uuid::new_v4(),"environment":"test"}});
    private(&path, &serde_json::to_vec(&value).unwrap());
    assert!(read_config(&path).is_ok());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        read_config(&path),
        Err(OperatorError::Configuration)
    ));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let link = directory.path().join("symlink");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(read_config(&link).is_err());
    let mut wrong = value;
    wrong["arbitrary_account"] = json!("not allowed");
    fs::write(&path, serde_json::to_vec(&wrong).unwrap()).unwrap();
    assert!(read_config(&path).is_err());
}

#[test]
#[ignore = "Private migration executable; build gtd-migrate, disposable Docker PostgreSQL only, no model calls"]
fn private_import_command_pins_identity_replays_and_reconciles_without_overwriting() {
    let (_pg, mut database, runtime, a, b) = fixture();
    database
        .execute("DELETE FROM gtd.tasks WHERE account_id=$1", &[&a])
        .unwrap();
    let database_id: Uuid = database
        .query_one("SELECT identity FROM gtd.schema_meta", &[])
        .unwrap()
        .get(0);
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let source_path = directory.path().join("source.sqlite3");
    let mut source_store = crate::store::Store::open(&source_path).unwrap();
    let captured = source_store
        .capture(
            serde_json::from_value(json!({"request_id":"import-fixture",
        "title":"Private migration fixture","importance":"normal","reason":"Fixture"}))
            .unwrap(),
        )
        .unwrap();
    let sqlite = rusqlite::Connection::open(&source_path).unwrap();
    let source_id: String = sqlite
        .query_row(
            "SELECT value FROM store_meta WHERE key='identity'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let dsn_path = directory.path().join("database.dsn");
    private(
        &dsn_path,
        format!(
            "host=127.0.0.1 port={} user=gtd_runtime dbname=postgres password={}",
            runtime.get_ports()[0],
            std::str::from_utf8(runtime.get_password().unwrap()).unwrap()
        )
        .as_bytes(),
    );
    let config_path = directory.path().join("config.json");
    let mut config = json!({"source_path":source_path,"source":{"identity":source_id,"environment":source_store.environment()},
        "destination":{"database_dsn_file":dsn_path,"environment":"staging","database_identity":database_id,
            "account_id":a,"issuer":ISSUER,"subject":"a","username":"a","administrator":false},
        "maintenance_state":directory.path()});
    private(&config_path, &serde_json::to_vec(&config).unwrap());
    let binary = std::env::var_os("GTD_TEST_MIGRATE_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/gtd-migrate"));
    assert!(
        binary.is_file(),
        "Build gtd-migrate before this ignored executable test"
    );
    let call = |command: &str, value: &Value| {
        fs::write(&config_path, serde_json::to_vec(value).unwrap()).unwrap();
        let output = Process::new(&binary)
            .args([command])
            .arg(&config_path)
            .env_clear()
            .output()
            .unwrap();
        for bytes in [&output.stdout, &output.stderr] {
            let text = String::from_utf8_lossy(bytes);
            assert!(!text.contains(std::str::from_utf8(runtime.get_password().unwrap()).unwrap()));
            assert!(!text.contains("Private migration fixture"));
            assert!(!text.contains(&captured.task.id));
        }
        output
    };
    let inspect = call("inspect", &config);
    assert!(inspect.status.success());
    let report: Value = serde_json::from_slice(&inspect.stdout).unwrap();
    config["source_digest"] = report["source"]["digest"].clone();
    assert!(
        !call("import", &config).status.success(),
        "must require maintenance"
    );
    let lock_path = directory.path().join("operation.lock");
    private(&lock_path, b"");
    let marker_path = directory.path().join("promotion.json");
    let marker = json!({"operation":"multi-user-import","phase":"writers-stopped","environment":"staging",
        "database_identity":database_id,"account_id":a,"source_digest":config["source_digest"]});
    private(&marker_path, &serde_json::to_vec(&marker).unwrap());
    let locked = private_open(&lock_path, true).unwrap();
    locked.try_lock().unwrap();
    assert!(
        !call("import", &config).status.success(),
        "must not overlap an operator"
    );
    // Existing Python deployment jobs and this Rust CLI must contend on the same lock.
    let status = Process::new("python3").args(["-c", "import fcntl,sys\nf=open(sys.argv[1],'r+')\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(7)\nsys.exit(9)"])
        .arg(&lock_path).status().unwrap();
    assert_eq!(status.code(), Some(7));
    drop(locked);
    for key in [
        "account_id",
        "database_identity",
        "subject",
        "username",
        "administrator",
    ] {
        let mut wrong = config.clone();
        wrong["destination"][key] = match key {
            "account_id" | "database_identity" => json!(Uuid::new_v4()),
            "administrator" => json!(true),
            _ => json!("wrong"),
        };
        assert!(!call("import", &wrong).status.success());
    }
    let mut wrong = config.clone();
    wrong["source_digest"] = json!("0".repeat(64));
    assert!(!call("import", &wrong).status.success());
    wrong = config.clone();
    wrong["source"]["identity"] = json!(Uuid::new_v4());
    assert!(!call("import", &wrong).status.success());
    wrong = config.clone();
    wrong["destination"]["environment"] = json!("production");
    assert!(!call("import", &wrong).status.success());
    database.batch_execute("CREATE FUNCTION gtd.reject_private_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER reject_private_import BEFORE INSERT ON gtd.legacy_imports FOR EACH ROW EXECUTE FUNCTION gtd.reject_private_import()").unwrap();
    assert!(!call("import", &config).status.success());
    assert_eq!(
        database
            .query_one("SELECT count(*) FROM gtd.tasks WHERE account_id=$1", &[&a])
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    database.batch_execute("DROP TRIGGER reject_private_import ON gtd.legacy_imports; DROP FUNCTION gtd.reject_private_import()").unwrap();
    let imported = call("import", &config);
    assert!(
        imported.status.success(),
        "{}",
        String::from_utf8_lossy(&imported.stderr)
    );
    let imported: Value = serde_json::from_slice(&imported.stdout).unwrap();
    assert_eq!(imported["replayed"], false);
    assert_eq!(imported["current_verified"], true);
    let repeated = call("import", &config);
    assert!(repeated.status.success());
    let repeated: Value = serde_json::from_slice(&repeated.stdout).unwrap();
    assert_eq!(repeated["replayed"], true);
    assert_eq!(repeated["current_verified"], false);
    // Derived search publication is outside source reconciliation.
    database.execute("INSERT INTO gtd.search_state(account_id,key,value) VALUES($1,'derived-fixture','not-authoritative')", &[&a]).unwrap();
    assert!(call("verify", &config).status.success());
    database
        .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&a])
        .unwrap();
    assert!(!call("import", &config).status.success());
    database
        .execute("UPDATE gtd.accounts SET enabled=true WHERE id=$1", &[&a])
        .unwrap();
    // Emulate a later edit. Exact receipt retry must preserve it, while explicit
    // reconciliation must stop a cutover that expects the unmodified snapshot.
    database.execute("UPDATE gtd.tasks SET document=jsonb_set(document::jsonb,'{title}',to_jsonb('Later edit'::text))::text WHERE account_id=$1 AND id=$2", &[&a,&captured.task.id]).unwrap();
    assert!(call("import", &config).status.success());
    assert!(!call("verify", &config).status.success());
    assert_eq!(
        database
            .query_one(
                "SELECT document::jsonb->>'title' FROM gtd.tasks WHERE account_id=$1 AND id=$2",
                &[&a, &captured.task.id]
            )
            .unwrap()
            .get::<_, String>(0),
        "Later edit"
    );
    assert_eq!(
        database
            .query_one("SELECT count(*) FROM gtd.tasks WHERE account_id=$1", &[&b])
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    assert_eq!(
        database
            .query_one(
                "SELECT count(*) FROM gtd.legacy_imports WHERE account_id=$1",
                &[&b]
            )
            .unwrap()
            .get::<_, i64>(0),
        0
    );
}
