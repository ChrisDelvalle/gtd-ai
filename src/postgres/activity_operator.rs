//! Offline, derived-only compatibility migration. Never compiled into the service.
use super::*;
use crate::model::Change;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Migration {
    database_dsn_file: PathBuf,
    environment: String,
    database_identity: Uuid,
    maintenance_state: PathBuf,
}
fn private(path: &Path) -> std::result::Result<fs::File, String> {
    if !path.is_absolute() {
        return Err("Use an absolute private file".into());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "Private file unavailable")?;
    let m = file.metadata().map_err(|_| "Private file unavailable")?;
    if !m.is_file() || m.permissions().mode() & 0o077 != 0 || m.len() > 32768 {
        return Err("Private file permissions or size invalid".into());
    }
    Ok(file)
}
fn text(path: &Path) -> std::result::Result<String, String> {
    let mut s = String::new();
    private(path)?
        .take(32769)
        .read_to_string(&mut s)
        .map_err(|_| "Private file unreadable")?;
    Ok(s)
}
pub fn execute(path: &Path, action: &str) -> std::result::Result<Value, String> {
    if !["upgrade", "verify", "rollback"].contains(&action) {
        return Err("Choose upgrade, verify or rollback".into());
    }
    let config: Migration =
        serde_json::from_str(&text(path)?).map_err(|_| "Invalid migration configuration")?;
    if !["production", "staging"].contains(&config.environment.as_str()) {
        return Err("Invalid environment".into());
    }
    let lock = private(&config.maintenance_state.join("operation.lock"))?;
    lock.try_lock().map_err(|_| "Maintenance lock is held")?;
    let marker: Value =
        serde_json::from_str(&text(&config.maintenance_state.join("promotion.json"))?)
            .map_err(|_| "Invalid maintenance marker")?;
    if marker["operation"] != "activity-13"
        || marker["phase"] != "writers-stopped"
        || marker["environment"] != config.environment
        || marker["database_identity"] != config.database_identity.to_string()
    {
        return Err("Writers-stopped marker does not match".into());
    }
    let mut client = text(&config.database_dsn_file)?
        .trim()
        .parse::<Config>()
        .map_err(|_| "Invalid private database configuration")?
        .connect(NoTls)
        .map_err(|_| "Database unavailable")?;
    // Database errors are intentionally not printed: they can contain record data.
    migrate(&mut client,config.database_identity,&config.environment,action).map_err(|_|"Migration not confirmed. Keep writers stopped and inspect the isolated rehearsal; no credentials or record content were logged.".into())
}
fn fingerprint(tx: &mut Transaction<'_>) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for table in [
        "accounts",
        "account_state",
        "tasks",
        "dependencies",
        "changes",
        "revisions",
        "requests",
        "action_groups",
        "legacy_imports",
    ] {
        let row=tx.query_one(&format!("SELECT count(*),md5(coalesce(string_agg(md5(row_to_json(t)::text),',' ORDER BY md5(row_to_json(t)::text)),'')) FROM gtd.{table} t"),&[])?;
        out.insert(
            table.into(),
            json!({"count":row.get::<_,i64>(0),"digest":row.get::<_,String>(1)}),
        );
    }
    Ok(Value::Object(out))
}
pub(super) fn migrate(
    client: &mut ::postgres::Client,
    identity: Uuid,
    environment: &str,
    action: &str,
) -> Result<Value> {
    let mut tx = client.transaction()?;
    tx.batch_execute("SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='5s'; LOCK TABLE gtd.schema_meta IN ACCESS EXCLUSIVE MODE")?;
    let row = tx.query_one(
        "SELECT compatibility,identity,environment FROM gtd.schema_meta WHERE singleton",
        &[],
    )?;
    let version: i32 = row.get(0);
    if row.get::<_, Uuid>(1) != identity
        || row.get::<_, String>(2) != environment
        || ![12, 13].contains(&version)
    {
        return Err(Error::Compatibility);
    }
    if tx.query_one("SELECT count(*) FROM pg_stat_activity WHERE usename='gtd_runtime' AND pid<>pg_backend_pid()",&[])?.get::<_,i64>(0)>0{return Err(Error::Compatibility);}
    // A private PostgreSQL operator role is required; runtime never owns migrations.
    if !tx
        .query_one(
            "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
            &[],
        )?
        .get::<_, bool>(0)
    {
        return Err(Error::UnsafeRole);
    }
    let before = fingerprint(&mut tx)?;
    if action == "upgrade" {
        if version == 12 {
            tx.batch_execute("SET LOCAL ROLE gtd_owner")?;
            tx.batch_execute(include_str!("activity.sql"))?;
            tx.batch_execute("RESET ROLE")?;
        } else {
            tx.batch_execute("TRUNCATE gtd.activity_events")?;
        }
        let accounts = tx.query("SELECT id FROM gtd.accounts ORDER BY id", &[])?;
        for account in accounts {
            let id: Uuid = account.get(0);
            let mut after = 0i64;
            loop {
                let rows=tx.query("SELECT id,document FROM gtd.changes WHERE account_id=$1 AND id>$2 ORDER BY id LIMIT 200",&[&id,&after])?;
                if rows.is_empty() {
                    break;
                }
                for row in rows {
                    after = row.get(0);
                    let change: Change = serde_json::from_str(&row.get::<_, String>(1))?;
                    super::activity::insert_event(&mut tx, id, &change)?;
                }
            }
        }
        tx.batch_execute("ALTER TABLE gtd.schema_meta DROP CONSTRAINT schema_meta_compatibility_check; UPDATE gtd.schema_meta SET compatibility=13; ALTER TABLE gtd.schema_meta ADD CONSTRAINT schema_meta_compatibility_check CHECK(compatibility=13)")?;
    } else if action == "rollback" {
        if version == 13 {
            // Only derived rows/indexes are removed. Every post-release write survives.
            tx.batch_execute("DROP TABLE gtd.activity_events; DROP INDEX gtd.changes_request; ALTER TABLE gtd.schema_meta DROP CONSTRAINT schema_meta_compatibility_check; UPDATE gtd.schema_meta SET compatibility=12; ALTER TABLE gtd.schema_meta ADD CONSTRAINT schema_meta_compatibility_check CHECK(compatibility=12)")?;
        }
    } else if version != 13 {
        return Err(Error::Compatibility);
    }
    let projected = if action != "rollback" {
        let n = tx
            .query_one("SELECT count(*) FROM gtd.activity_events", &[])?
            .get::<_, i64>(0);
        if n != tx
            .query_one("SELECT count(*) FROM gtd.changes", &[])?
            .get::<_, i64>(0)
        {
            return Err(Error::Compatibility);
        }
        // Verify every compact document with the same classifier, including undo origins.
        let mut after = (Uuid::nil(), 0i64);
        let mut known = std::collections::BTreeMap::new();
        loop {
            let rows=tx.query("SELECT c.account_id,c.id,c.document,e.document FROM gtd.changes c JOIN gtd.activity_events e ON e.account_id=c.account_id AND e.change_id=c.id WHERE (c.account_id,c.id)>($1,$2) ORDER BY c.account_id,c.id LIMIT 200",&[&after.0,&after.1])?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                let id: Uuid = row.get(0);
                let seq: i64 = row.get(1);
                if id != after.0 {
                    known.clear();
                }
                let change: Change = serde_json::from_str(&row.get::<_, String>(2))?;
                let mut event = crate::activity::Event::from_change(&change);
                if let Some(target) = event.undoes {
                    event.automatic |= known.get(&target).copied().unwrap_or(false);
                }
                known.insert(seq, event.automatic);
                if serde_json::to_value(&event)?
                    != serde_json::from_str::<Value>(&row.get::<_, String>(3))?
                {
                    return Err(Error::Compatibility);
                }
                after = (id, seq);
            }
        }
        Some(n)
    } else {
        None
    };
    let after = fingerprint(&mut tx)?;
    if before != after {
        return Err(Error::Compatibility);
    }
    tx.commit()?;
    Ok(
        json!({"operation":action,"environment":environment,"database_identity":identity,"compatibility":if action=="rollback"{12}else{13},"authoritative_unchanged":true,"source":after,"activity_rows":projected}),
    )
}
