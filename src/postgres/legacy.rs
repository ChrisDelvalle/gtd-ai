//! Private SQLite import/recovery support. This is not a second runtime backend.
//!
//! Read a consistent, read-only version-11 snapshot and retain the original text
//! cells. Import all authoritative tables in one account-locked transaction,
//! reconcile them before committing, and record an immutable retry receipt.
//! Deployment tooling must stop writers and pin the source identity/environment;
//! there is deliberately no HTTP/MCP entry point or implicit owner assignment.
use super::{AccountTransaction, Error, Principal, Result, Store};
use postgres::types::ToSql;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub identity: Uuid,
    pub environment: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub source: Source,
    /// Hash of ordered raw cells, table names, source identity and environment.
    /// It is a logical snapshot digest, not a hash of the SQLite file/WAL bytes.
    pub digest: String,
    pub counts: BTreeMap<String, usize>,
    pub high: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
enum Cell {
    Text(String),
    Integer(i64),
    Null,
}
impl Cell {
    fn parameter(&self) -> &(dyn ToSql + Sync) {
        match self {
            Self::Text(value) => value,
            Self::Integer(value) => value,
            Self::Null => &None::<String>,
        }
    }
}

struct Table {
    name: &'static str,
    // A colon marks an integer column; a question mark marks nullable text.
    // All identifiers are constants below, never file or caller input.
    columns: &'static [&'static str],
    order: &'static str,
    filter: &'static str,
}
const TABLES: &[Table] = &[
    Table {
        name: "tasks",
        columns: &["id", "document"],
        order: "id",
        filter: "",
    },
    Table {
        name: "changes",
        columns: &[
            ":id",
            "task_id",
            "document",
            "entity_type",
            "?batch_id",
            "token",
        ],
        order: "id",
        filter: "",
    },
    Table {
        name: "revisions",
        columns: &[":seq", "entity_id", "entity_type", "document"],
        order: "seq",
        filter: "",
    },
    Table {
        name: "requests",
        columns: &["id", "request", "response"],
        order: "id",
        filter: "",
    },
    Table {
        name: "action_groups",
        columns: &[":change_id", "group_id"],
        order: "change_id",
        filter: "",
    },
    // Keep recurrence worker checkpoints. Search indexes/cursors are derived and
    // must be rebuilt; the new account gets a fresh cursor identity.
    Table {
        name: "search_state",
        columns: &["key", "value"],
        order: "key",
        filter: " WHERE key LIKE 'recurrence:%'",
    },
];
impl Table {
    fn column_list(&self) -> String {
        self.columns
            .iter()
            .map(|c| c.trim_start_matches([':', '?']))
            .collect::<Vec<_>>()
            .join(",")
    }
    fn select(&self, postgres: bool) -> String {
        let prefix = if postgres { "gtd." } else { "" };
        let filter = if postgres && self.name == "search_state" {
            " WHERE account_id=$1 AND key LIKE 'recurrence:%'"
        } else if postgres {
            " WHERE account_id=$1"
        } else {
            self.filter
        };
        // SQLite BINARY and PostgreSQL C order UTF-8 bytewise. Never depend on
        // the server's installation locale when reconciling identifiers.
        let collate = if self.columns[0].starts_with(':') {
            ""
        } else if postgres {
            " COLLATE \"C\""
        } else {
            " COLLATE BINARY"
        };
        format!(
            "SELECT {} FROM {prefix}{}{filter} ORDER BY {}{collate}",
            self.column_list(),
            self.name,
            self.order
        )
    }
}

pub struct Snapshot {
    report: Report,
    rows: Vec<Vec<Vec<Cell>>>,
    dependencies: Vec<(String, String)>,
}
impl Snapshot {
    /// Does not create, upgrade, checkpoint, or write the source database.
    /// The caller must supply an independently confirmed source identity.
    pub fn open(path: &Path, expected: &Source) -> Result<Self> {
        let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| Error::LegacySource)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| Error::LegacySource)?;
        let tx = db.transaction().map_err(|_| Error::LegacySource)?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|_| Error::LegacySource)?;
        if version != 11 {
            return Err(Error::LegacySource);
        }
        let integrity: String = tx
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|_| Error::LegacySource)?;
        if integrity != "ok"
            || tx
                .prepare("PRAGMA foreign_key_check")
                .map_err(|_| Error::LegacySource)?
                .exists([])
                .map_err(|_| Error::LegacySource)?
        {
            return Err(Error::LegacySource);
        }
        let identity: String = tx
            .query_row(
                "SELECT value FROM store_meta WHERE key='identity'",
                [],
                |r| r.get(0),
            )
            .map_err(|_| Error::LegacySource)?;
        let environment: String = tx
            .query_row(
                "SELECT value FROM store_meta WHERE key='environment'",
                [],
                |r| r.get(0),
            )
            .map_err(|_| Error::LegacySource)?;
        let source = Source {
            identity: identity.parse().map_err(|_| Error::LegacySource)?,
            environment,
        };
        if &source != expected
            || !["production", "test", "demo"].contains(&source.environment.as_str())
        {
            return Err(Error::SourceMismatch);
        }
        // Refuse unrecognized state instead of silently losing a newly added
        // authoritative table or metadata key under an unchanged schema number.
        let names = tx
            .prepare(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .map_err(|_| Error::LegacySource)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|_| Error::LegacySource)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| Error::LegacySource)?;
        if names.iter().any(|name| {
            !TABLES.iter().any(|t| t.name == name)
                && !["store_meta", "search_sessions"].contains(&name.as_str())
        }) {
            return Err(Error::LegacySource);
        }
        let extra_meta: i64 = tx
            .query_row(
                "SELECT count(*) FROM store_meta WHERE key NOT IN ('identity','environment')",
                [],
                |r| r.get(0),
            )
            .map_err(|_| Error::LegacySource)?;
        if extra_meta != 0 {
            return Err(Error::LegacySource);
        }
        let mut rows = Vec::new();
        let mut counts = BTreeMap::new();
        for table in TABLES {
            let mut stmt = tx
                .prepare(&table.select(false))
                .map_err(|_| Error::LegacySource)?;
            let values = stmt
                .query_map([], |row| {
                    table
                        .columns
                        .iter()
                        .enumerate()
                        .map(|(index, column)| {
                            if column.starts_with(':') {
                                row.get(index).map(Cell::Integer)
                            } else if column.starts_with('?') {
                                row.get::<_, Option<String>>(index)
                                    .map(|v| v.map(Cell::Text).unwrap_or(Cell::Null))
                            } else {
                                row.get(index).map(Cell::Text)
                            }
                        })
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .map_err(|_| Error::LegacySource)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|_| Error::LegacySource)?;
            counts.insert(table.name.into(), values.len());
            rows.push(values);
        }
        let high: i64 = tx
            .query_row("SELECT COALESCE(MAX(id),0) FROM changes", [], |r| r.get(0))
            .map_err(|_| Error::LegacySource)?;
        // Retain every revision, including deleted and historical records. Check
        // correspondence without deserializing/re-serializing historical JSON.
        let mismatch: i64 = tx.query_row("SELECT count(*) FROM changes c LEFT JOIN revisions r ON r.seq=c.id WHERE r.seq IS NULL OR r.entity_id<>c.task_id OR r.entity_type<>c.entity_type", [], |r| r.get(0))
            .map_err(|_| Error::LegacySource)?;
        if mismatch != 0 {
            return Err(Error::LegacySource);
        }
        let dependencies = dependencies(&rows[0])?;
        let bytes = serde_json::to_vec(&(
            1,
            &source,
            TABLES.iter().map(|t| t.name).collect::<Vec<_>>(),
            &rows,
        ))
        .map_err(|_| Error::LegacySource)?;
        let digest = format!("{:x}", Sha256::digest(bytes));
        tx.commit().map_err(|_| Error::LegacySource)?;
        Ok(Self {
            report: Report {
                source,
                digest,
                counts,
                high,
            },
            rows,
            dependencies,
        })
    }
    pub fn report(&self) -> &Report {
        &self.report
    }

    /// Only private migration tooling may call this. The authenticated principal
    /// pins the destination; no username lookup or implicit owner fallback occurs.
    /// Returns true on an exact retry, false on a newly committed import.
    pub fn import(&self, store: &Store, principal: &Principal) -> Result<bool> {
        store.write(principal, |tx| self.import_in(tx))
    }

    pub(super) fn import_in(&self, tx: &mut AccountTransaction<'_>) -> Result<bool> {
        let account = tx.account().id();
        if let Some(row) = tx.tx.query_opt(
            "SELECT report FROM gtd.legacy_imports WHERE account_id=$1",
            &[&account],
        )? {
            let previous: Report = serde_json::from_str(&row.get::<_, String>(0))
                .map_err(|_| Error::ImportConflict)?;
            return if previous == self.report {
                Ok(true)
            } else {
                Err(Error::ImportConflict)
            };
        }
        if tx.high() != 0 || tx.identity() == self.report.source.identity {
            return Err(Error::ImportConflict);
        }
        for name in TABLES
            .iter()
            .map(|t| t.name)
            .chain(["dependencies", "search_sessions"])
        {
            let count: i64 = tx
                .tx
                .query_one(
                    &format!("SELECT count(*) FROM gtd.{name} WHERE account_id=$1"),
                    &[&account],
                )?
                .get(0);
            if count != 0 {
                return Err(Error::ImportConflict);
            }
        }
        for (table, values) in TABLES.iter().zip(&self.rows) {
            let placeholders = (1..=table.columns.len() + 1)
                .map(|n| format!("${n}"))
                .collect::<Vec<_>>()
                .join(",");
            let insert = tx.tx.prepare(&format!(
                "INSERT INTO gtd.{}(account_id,{}) VALUES({placeholders})",
                table.name,
                table.column_list()
            ))?;
            for row in values {
                let parameters = std::iter::once(&account as &(dyn ToSql + Sync))
                    .chain(row.iter().map(Cell::parameter))
                    .collect::<Vec<_>>();
                tx.tx.execute(&insert, &parameters)?;
            }
        }
        let insert = tx.tx.prepare(
            "INSERT INTO gtd.dependencies(account_id,task_id,prerequisite_id) VALUES($1,$2,$3)",
        )?;
        for (task, prerequisite) in &self.dependencies {
            tx.tx.execute(&insert, &[&account, task, prerequisite])?;
        }
        tx.tx.execute(
            "UPDATE gtd.account_state SET high=$2 WHERE account_id=$1",
            &[&account, &self.report.high],
        )?;
        tx.high = self.report.high;
        tx.rebuild_activity()?;
        // Run deferred references before reconciliation, while any failure can
        // still roll back every table and the import receipt together.
        tx.tx.batch_execute("SET CONSTRAINTS ALL IMMEDIATE")?;
        self.reconcile(tx)?;
        let report = serde_json::to_string(&self.report).map_err(|_| Error::Reconciliation)?;
        tx.tx.execute("INSERT INTO gtd.legacy_imports(account_id,source_identity,source_environment,digest,report) VALUES($1,$2,$3,$4,$5)",
            &[&account, &self.report.source.identity, &self.report.source.environment, &self.report.digest, &report])?;
        Ok(false)
    }

    /// Explicit read-only reconciliation, separate from receipt replay. A retry
    /// must not overwrite later writes; verification instead detects divergence.
    #[cfg(any(feature = "postgres-operator", test))]
    pub(super) fn verify_in(&self, tx: &mut AccountTransaction<'_>) -> Result<()> {
        let receipt = tx
            .tx
            .query_opt(
                "SELECT report FROM gtd.legacy_imports WHERE account_id=$1",
                &[&tx.account.id],
            )?
            .ok_or(Error::ImportConflict)?;
        let previous: Report = serde_json::from_str(&receipt.get::<_, String>(0))
            .map_err(|_| Error::ImportConflict)?;
        if previous != self.report {
            return Err(Error::ImportConflict);
        }
        self.reconcile(tx)
    }

    fn reconcile(&self, tx: &mut AccountTransaction<'_>) -> Result<()> {
        let account = tx.account().id();
        for (table, expected) in TABLES.iter().zip(&self.rows) {
            let actual = tx
                .tx
                .query(&table.select(true), &[&account])?
                .iter()
                .map(|row| {
                    table
                        .columns
                        .iter()
                        .enumerate()
                        .map(|(index, column)| {
                            if column.starts_with(':') {
                                row.try_get(index).map(Cell::Integer)
                            } else if column.starts_with('?') {
                                row.try_get::<_, Option<String>>(index)
                                    .map(|v| v.map(Cell::Text).unwrap_or(Cell::Null))
                            } else {
                                row.try_get(index).map(Cell::Text)
                            }
                        })
                        .collect::<std::result::Result<Vec<_>, _>>()
                })
                .collect::<std::result::Result<Vec<_>, _>>()?;
            if &actual != expected {
                return Err(Error::Reconciliation);
            }
        }
        let actual = tx.tx.query("SELECT task_id,prerequisite_id FROM gtd.dependencies WHERE account_id=$1 ORDER BY task_id COLLATE \"C\",prerequisite_id COLLATE \"C\"", &[&account])?
            .iter().map(|r| (r.get(0), r.get(1))).collect::<Vec<(String, String)>>();
        let high: i64 = tx
            .tx
            .query_one(
                "SELECT high FROM gtd.account_state WHERE account_id=$1",
                &[&account],
            )?
            .get(0);
        if actual != self.dependencies || high != self.report.high {
            return Err(Error::Reconciliation);
        }
        Ok(())
    }
}

fn dependencies(tasks: &[Vec<Cell>]) -> Result<Vec<(String, String)>> {
    let mut result = Vec::new();
    for row in tasks {
        let (Cell::Text(id), Cell::Text(document)) = (&row[0], &row[1]) else {
            return Err(Error::LegacySource);
        };
        let value: serde_json::Value =
            serde_json::from_str(document).map_err(|_| Error::LegacySource)?;
        if value.get("id").and_then(|v| v.as_str()) != Some(id) {
            return Err(Error::LegacySource);
        }
        // Deleted records keep their original JSON for historical fidelity but
        // do not take part in the current dependency graph.
        if value.get("deleted").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        if let Some(ids) = value.get("blocked_by") {
            for target in ids.as_array().ok_or(Error::LegacySource)? {
                result.push((
                    id.clone(),
                    target.as_str().ok_or(Error::LegacySource)?.into(),
                ));
            }
        }
    }
    result.sort();
    Ok(result)
}
