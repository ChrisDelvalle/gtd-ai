use super::*;
use std::{process::Command, sync::mpsc, thread};

const IMAGE: &str = "postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c";
pub(super) const ISSUER: &str = "https://identity.invalid/storage-fixture";

pub(super) struct Container(String);
impl Container {
    pub(super) fn name(&self) -> &str {
        &self.0
    }
}
impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", &self.0])
            .output();
    }
}
fn docker(args: &[&str]) -> String {
    let output = Command::new("docker")
        .args(args)
        .output()
        .expect("Docker is required");
    assert!(
        output.status.success(),
        "Docker command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
pub(super) fn fixture() -> (Container, ::postgres::Client, Config, Uuid, Uuid) {
    fixture_with_budget("512m", "256m")
}
// Explicit budgets for manual capacity measurements; ordinary checks retain
// their smaller defaults. Neither helper accepts an existing database address.
pub(super) fn fixture_with_budget(
    memory: &str,
    storage: &str,
) -> (Container, ::postgres::Client, Config, Uuid, Uuid) {
    let name = format!("gtd-rust-storage-{}", Uuid::new_v4().simple());
    let admin_password = Uuid::new_v4().simple().to_string();
    let output = Command::new("docker")
        .args([
            "run",
            "--detach",
            "--rm",
            "--pull",
            "never",
            "--name",
            &name,
            "--label",
            "gtd.environment=disposable-storage-checkpoint",
            "--publish",
            "127.0.0.1::5432",
            "--user",
            "999:999",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--memory",
            memory,
            "--cpus",
            "1",
            "--pids-limit",
            "128",
            "--tmpfs",
            &format!("/var/lib/postgresql:rw,size={storage},uid=999,gid=999"),
            "--tmpfs",
            "/var/run/postgresql:rw,size=16m,uid=999,gid=999",
            "--tmpfs",
            "/tmp:rw,size=16m,uid=999,gid=999",
            "--env",
            "POSTGRES_PASSWORD",
            IMAGE,
        ])
        .env("POSTGRES_PASSWORD", &admin_password)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Failed to start disposable PostgreSQL"
    );
    let container = Container(name);
    // Docker Desktop can return success before its dynamic port mapping has
    // appeared. Wait only for an empty result; never accept a non-loopback bind.
    let binding = (0..50)
        .find_map(|_| {
            let value = docker(&["port", &container.0, "5432/tcp"]);
            if value.is_empty() {
                thread::sleep(Duration::from_millis(100));
                None
            } else {
                Some(value)
            }
        })
        .expect("Docker did not publish the disposable loopback port");
    let port: u16 = binding
        .strip_prefix("127.0.0.1:")
        .expect("must bind only loopback")
        .parse()
        .unwrap();
    let mut admin_config = Config::new();
    admin_config
        .host("127.0.0.1")
        .port(port)
        .dbname("postgres")
        .user("postgres")
        .password(admin_password)
        .connect_timeout(Duration::from_secs(1));
    let mut admin = (0..60)
        .find_map(|_| {
            let result = admin_config.connect(NoTls).ok();
            if result.is_none() {
                thread::sleep(Duration::from_millis(250));
            }
            result
        })
        .expect("PostgreSQL did not start");
    let runtime_password = Uuid::new_v4().simple().to_string();
    // Only generated hex is interpolated into role DDL; never arbitrary input.
    admin.batch_execute(&format!("CREATE ROLE gtd_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
        CREATE ROLE gtd_runtime LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '{runtime_password}';
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CREATE ON DATABASE postgres TO gtd_owner;")).unwrap();
    admin.batch_execute(SCHEMA).unwrap();
    admin
        .execute(
            "INSERT INTO gtd.schema_meta VALUES(true,13,'staging',$1)",
            &[&Uuid::new_v4()],
        )
        .unwrap();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    for (id, subject) in [(a, "a"), (b, "b")] {
        admin
            .execute(
                "INSERT INTO gtd.accounts(id,issuer,subject,username,enabled,enrollment)
            VALUES($1,$2,$3,$3,true,'active')",
                &[&id, &ISSUER, &subject],
            )
            .unwrap();
        admin
            .execute(
                "INSERT INTO gtd.account_state(account_id,identity) VALUES($1,$2)",
                &[&id, &Uuid::new_v4()],
            )
            .unwrap();
        let document = format!(r#"{{"id":"shared","entity_type":"task","notes":"{subject}"}}"#);
        admin
            .execute(
                "INSERT INTO gtd.tasks(account_id,id,document) VALUES($1,'shared',$2)",
                &[&id, &document],
            )
            .unwrap();
    }
    let mut runtime = Config::new();
    runtime
        .host("127.0.0.1")
        .port(port)
        .dbname("postgres")
        .user("gtd_runtime")
        .password(runtime_password);
    (container, admin, runtime, a, b)
}
pub(super) fn principal(subject: &str) -> Principal {
    Principal::verified(ISSUER.into(), subject.into())
}

#[test]
#[ignore = "Manual deterministic PostgreSQL test; requires Docker and the pinned image, no live models"]
fn isolated_pool_and_account_transactions() {
    let (_container, mut admin, runtime, a, b) = fixture();
    let store = Store::connect(runtime.clone(), Environment::Staging, 1).unwrap();
    let pinned = Store::connect_expected(runtime.clone(), Environment::Staging, 1, store.identity)
        .expect("configured database identity");
    pinned.health().unwrap();
    assert!(matches!(
        Store::connect_expected(runtime.clone(), Environment::Staging, 1, Uuid::new_v4()),
        Err(Error::Compatibility)
    ));
    assert!(matches!(
        Store::connect(runtime.clone(), Environment::Production, 1),
        Err(Error::Compatibility)
    ));
    assert!(matches!(
        Store::connect(runtime.clone(), Environment::Staging, 0),
        Err(Error::InvalidPoolSize)
    ));
    assert!(matches!(
        store.read(&principal("unknown"), |_| Ok(())),
        Err(Error::AccountUnavailable)
    ));
    assert!(matches!(
        store.read(
            &Principal::verified("https://other.invalid".into(), "a".into()),
            |_| Ok(())
        ),
        Err(Error::AccountUnavailable)
    ));

    for subject in ["a", "b", "a", "b"] {
        let actual = store
            .read(&principal(subject), |tx| {
                let value: String = tx
                    .tx
                    .query_one(
                        "SELECT document::jsonb->>'notes' FROM gtd.tasks WHERE id='shared'",
                        &[],
                    )?
                    .get(0);
                assert_eq!(tx.account().id(), if subject == "a" { a } else { b });
                assert_eq!(tx.account().timezone(), chrono_tz::America::New_York);
                Ok(value)
            })
            .unwrap();
        assert_eq!(actual, subject);
    }
    // With max_size=1 every operation above used the same physical connection.
    {
        let mut raw = store.pool.get().unwrap();
        assert!(
            raw.query_one("SELECT gtd.current_account() IS NULL", &[])
                .unwrap()
                .get::<_, bool>(0)
        );
        assert_eq!(
            raw.query_one("SELECT count(*) FROM gtd.tasks", &[])
                .unwrap()
                .get::<_, i64>(0),
            0
        );
    }
    assert!(matches!(
        store.read(&principal("a"), |tx| tx.next_revision()),
        Err(Error::ReadOnly)
    ));
    let failure: Result<()> = store.write(&principal("a"), |tx| {
        tx.next_revision()?;
        Err(Error::AccountUnavailable)
    });
    assert!(failure.is_err());
    assert_eq!(store.read(&principal("a"), |tx| Ok(tx.high())).unwrap(), 0);
    assert_eq!(
        store
            .write(&principal("a"), |tx| tx.next_revision())
            .unwrap(),
        1
    );
    assert_eq!(store.read(&principal("b"), |tx| Ok(tx.high())).unwrap(), 0);

    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<()> = store.write(&principal("a"), |tx| {
            tx.next_revision()?;
            panic!("synthetic rollback checkpoint")
        });
    }));
    assert!(panic.is_err());
    assert_eq!(store.read(&principal("a"), |tx| Ok(tx.high())).unwrap(), 1);
    assert_eq!(
        store
            .read(&principal("b"), |tx| Ok(tx.account().id()))
            .unwrap(),
        b
    );

    let cross: Result<()> = store.write(&principal("a"), |tx| {
        tx.tx.execute(
            "INSERT INTO gtd.search_state VALUES($1,'cross','bad')",
            &[&b],
        )?;
        Ok(())
    });
    assert!(cross.is_err());
    assert_eq!(
        store
            .read(&principal("b"), |tx| Ok(tx
                .tx
                .query_one("SELECT count(*) FROM gtd.search_state", &[])?
                .get::<_, i64>(0)))
            .unwrap(),
        0
    );
    admin
        .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&a])
        .unwrap();
    assert!(matches!(
        store.read(&principal("a"), |_| Ok(())),
        Err(Error::AccountUnavailable)
    ));
    assert!(store.read(&principal("b"), |_| Ok(())).is_ok());
    admin
        .execute("UPDATE gtd.accounts SET enabled=true WHERE id=$1", &[&a])
        .unwrap();

    let concurrent = Store::connect(runtime.clone(), Environment::Staging, 4).unwrap();
    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = concurrent.clone();
    let first = thread::spawn(move || {
        first
            .write(&principal("a"), |tx| {
                let revision = tx.next_revision()?;
                locked_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(4)).unwrap();
                Ok(revision)
            })
            .unwrap()
    });
    locked_rx.recv_timeout(Duration::from_secs(4)).unwrap();
    let next = concurrent.clone();
    let next = thread::spawn(move || {
        next.write(&principal("a"), |tx| tx.next_revision())
            .unwrap()
    });
    // Account B can commit while A has a held transaction and a queued writer.
    assert_eq!(
        concurrent
            .write(&principal("b"), |tx| tx.next_revision())
            .unwrap(),
        1
    );
    release_tx.send(()).unwrap();
    assert_eq!(first.join().unwrap(), 2);
    assert_eq!(next.join().unwrap(), 3);
    assert_eq!(
        concurrent
            .read(&principal("a"), |tx| Ok(tx.high()))
            .unwrap(),
        3
    );

    // Guard against an accidentally weakened schema and a polluted pooled
    // connection. Neither condition may be healed by guessing an account.
    admin
        .batch_execute("ALTER TABLE gtd.tasks DISABLE ROW LEVEL SECURITY")
        .unwrap();
    assert!(matches!(
        store.read(&principal("a"), |_| Ok(())),
        Err(Error::UnsafeRole)
    ));
    admin
        .batch_execute("ALTER TABLE gtd.tasks ENABLE ROW LEVEL SECURITY")
        .unwrap();
    {
        let mut raw = store.pool.get().unwrap();
        raw.query_one(
            "SELECT set_config('gtd.account_id',$1,false)",
            &[&a.to_string()],
        )
        .unwrap();
    }
    assert!(matches!(
        store.read(&principal("b"), |_| Ok(())),
        Err(Error::RetainedContext)
    ));
    store
        .pool
        .get()
        .unwrap()
        .batch_execute("RESET gtd.account_id")
        .unwrap();
    assert_eq!(
        store
            .read(&principal("b"), |tx| Ok(tx.account().id()))
            .unwrap(),
        b
    );

    // A replaced database cannot silently reuse the same pool/cursor namespace.
    admin
        .execute("UPDATE gtd.schema_meta SET identity=$1", &[&Uuid::new_v4()])
        .unwrap();
    assert!(matches!(
        store.read(&principal("a"), |_| Ok(())),
        Err(Error::Compatibility)
    ));
    // Ownership through membership is forbidden even with NOINHERIT.
    admin
        .batch_execute("GRANT gtd_owner TO gtd_runtime")
        .unwrap();
    assert!(matches!(
        Store::connect(runtime, Environment::Staging, 1),
        Err(Error::UnsafeRole)
    ));
}
