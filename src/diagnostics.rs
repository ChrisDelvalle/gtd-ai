//! Bounded diagnostics, deliberately separate from the authoritative audit database.
use chrono::Utc;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_ROWS: i64 = 60_000;
// Reserve room for a rollback journal and vacuum work below the 256 MiB total budget.
const MAX_PAGES: i64 = 30_000; // 117.2 MiB at 4096 bytes/page.

#[derive(Clone)]
pub struct Diagnostics {
    connection: Arc<Mutex<Connection>>,
    failed: Arc<AtomicBool>,
    failure_path: PathBuf,
    directory: PathBuf,
    source: &'static str,
}

pub struct Call {
    pub id: String,
    started: Instant,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogQuery {
    pub before_id: Option<i64>,
    pub source: Option<String>,
    pub operation: Option<String>,
    pub outcome: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct Event {
    pub id: i64,
    pub call_id: String,
    pub created_at: String,
    pub source: String,
    pub operation: String,
    pub outcome: String,
    pub duration_ms: Option<i64>,
    pub code: Option<String>,
    pub task_id: Option<String>,
    pub change_id: Option<i64>,
    pub replayed: bool,
    pub message: Option<String>,
}

impl Diagnostics {
    /// Share the bounded operational log while identifying the entry point.
    pub fn with_source(&self, source: &'static str) -> Self {
        Self {
            source,
            ..self.clone()
        }
    }
    pub fn open(path: &Path, source: &'static str) -> rusqlite::Result<Self> {
        let directory = path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let _ = std::fs::create_dir_all(&directory);
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(3))?;
        connection.pragma_update(None, "page_size", 4096)?;
        connection.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
        connection.pragma_update(None, "journal_mode", "TRUNCATE")?;
        connection.pragma_update(None, "journal_size_limit", 0)?;
        connection.pragma_update(None, "max_page_count", MAX_PAGES)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL, source TEXT NOT NULL, operation TEXT NOT NULL,
          outcome TEXT NOT NULL, duration_ms INTEGER, code TEXT, task_id TEXT,
          change_id INTEGER, replayed INTEGER NOT NULL DEFAULT 0, message TEXT);
          CREATE INDEX IF NOT EXISTS event_time ON events(created_at);
          CREATE TABLE IF NOT EXISTS retention (id INTEGER PRIMARY KEY CHECK(id=1), removed INTEGER NOT NULL DEFAULT 0);
          INSERT OR IGNORE INTO retention(id) VALUES (1);")?;
        let this = Self {
            connection: Arc::new(Mutex::new(connection)),
            failed: Arc::new(AtomicBool::new(false)),
            failure_path: directory.join(format!("{source}.logging-failed")),
            directory,
            source,
        };
        this.prune()?;
        Ok(this)
    }

    fn record_status<T>(&self, result: &rusqlite::Result<T>) {
        let failed = result.is_err();
        let previous = self.failed.swap(failed, Ordering::Relaxed);
        if failed {
            // No errors/payloads/credentials are interpolated into fallback output.
            eprintln!("Diagnostic logging failed; task state remains authoritative.");
            let _ = std::fs::write(&self.failure_path, b"Diagnostic logging failed\n");
        } else if previous || self.failure_path.exists() {
            let _ = std::fs::remove_file(&self.failure_path);
        }
    }

    pub fn begin(&self, operation: &str) -> Call {
        let call = Call {
            id: Uuid::new_v4().to_string(),
            started: Instant::now(),
        };
        let result = (|| {
            let conn = self
                .connection
                .lock()
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            // Prune before insertion, bounding even a noisy tunnel and diagnostic self-polling.
            prune(&conn, MAX_ROWS)?;
            conn.execute("INSERT INTO events(call_id, created_at, source, operation, outcome) VALUES (?1, ?2, ?3, ?4, 'incomplete')",
                params![call.id, Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), self.source, operation])?;
            Ok(())
        })();
        self.record_status(&result);
        call
    }

    pub fn finish(&self, call: &Call, outcome: &str, code: Option<&str>, value: Option<&Value>) {
        let task_id = value
            .and_then(|v| {
                v.pointer("/task/id")
                    .or_else(|| v.pointer("/project/id"))
                    .or_else(|| v.pointer("/series/id"))
            })
            .and_then(Value::as_str)
            .filter(|s| Uuid::parse_str(s).is_ok());
        let change_id = value
            .and_then(|v| v.pointer("/change/id"))
            .and_then(Value::as_i64);
        let replayed = value
            .and_then(|v| v.get("replayed"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let result = self.connection.lock().map_err(|_| rusqlite::Error::InvalidQuery).and_then(|conn|
            conn.execute("UPDATE events SET outcome=?2, duration_ms=?3, code=?4, task_id=?5, change_id=?6, replayed=?7 WHERE call_id=?1",
                params![call.id, outcome, call.started.elapsed().as_millis().min(i64::MAX as u128) as i64, code, task_id, change_id, replayed]))
            .and_then(require_recorded);
        self.record_status(&result);
        if result.is_ok()
            && let Some(changes) = value
                .and_then(|v| v.get("results"))
                .and_then(Value::as_array)
        {
            // Bounded audit identifiers only; no titles, notes, reasons, or raw request IDs.
            let ids: Vec<String> = changes
                .iter()
                .take(50)
                .filter_map(|v| {
                    v.get("change_id")
                        .or_else(|| v.pointer("/change/id"))
                        .and_then(Value::as_i64)
                })
                .map(|id| id.to_string())
                .collect();
            self.annotate(call, &format!("Batch change IDs: {}", ids.join(", ")));
        }
    }

    pub fn event(&self, operation: &str, outcome: &str, message: &str) {
        let call = self.begin(operation);
        self.finish(&call, outcome, None, None);
        self.annotate(&call, message);
    }

    /// Callers must supply only sanitized operational metadata, never raw inputs.
    pub fn annotate(&self, call: &Call, message: &str) {
        let message: String = message.chars().take(1500).collect();
        let result = self
            .connection
            .lock()
            .map_err(|_| rusqlite::Error::InvalidQuery)
            .and_then(|conn| {
                conn.execute(
                    "UPDATE events SET message=?2 WHERE call_id=?1",
                    params![call.id, message],
                )
            })
            .and_then(require_recorded);
        self.record_status(&result);
    }

    pub fn prune(&self) -> rusqlite::Result<()> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        prune(&conn, MAX_ROWS)
    }

    pub fn list(&self, input: LogQuery) -> Result<Value, String> {
        let limit = input.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) || input.before_id.is_some_and(|v| v <= 0) {
            return Err("Invalid log page limit or cursor".into());
        }
        for bound in [&input.since, &input.until].into_iter().flatten() {
            if chrono::DateTime::parse_from_rfc3339(bound).is_err() {
                return Err("Log time bounds must be RFC3339 timestamps".into());
            }
        }
        for filter in [&input.source, &input.operation, &input.outcome]
            .into_iter()
            .flatten()
        {
            if filter.len() > 100 {
                return Err("Log filter is too long".into());
            }
        }
        let result = (|| -> rusqlite::Result<Value> {
            let conn = self
                .connection
                .lock()
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            let mut statement = conn.prepare(
                "SELECT id, call_id, created_at, source, operation, outcome,
              duration_ms, code, task_id, change_id, replayed, message FROM events
              WHERE (?1 IS NULL OR id < ?1) AND (?2 IS NULL OR source=?2)
              AND (?3 IS NULL OR operation=?3) AND (?4 IS NULL OR outcome=?4)
              AND (?5 IS NULL OR julianday(created_at)>=julianday(?5))
              AND (?6 IS NULL OR julianday(created_at)<=julianday(?6))
              ORDER BY id DESC LIMIT ?7",
            )?;
            let mut events = statement
                .query_map(
                    params![
                        input.before_id,
                        input.source,
                        input.operation,
                        input.outcome,
                        input.since,
                        input.until,
                        limit + 1
                    ],
                    |r| {
                        Ok(Event {
                            id: r.get(0)?,
                            call_id: r.get(1)?,
                            created_at: r.get(2)?,
                            source: r.get(3)?,
                            operation: r.get(4)?,
                            outcome: r.get(5)?,
                            duration_ms: r.get(6)?,
                            code: r.get(7)?,
                            task_id: r.get(8)?,
                            change_id: r.get(9)?,
                            replayed: r.get(10)?,
                            message: r.get(11)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let next = if events.len() > limit as usize {
                events.pop();
                events.last().map(|e| e.id)
            } else {
                None
            };
            let removed: i64 =
                conn.query_row("SELECT removed FROM retention WHERE id=1", [], |r| r.get(0))?;
            Ok(
                json!({"events":events, "next_before_id":next, "retention_days":30, "cap_bytes":268435456, "expired_events":removed}),
            )
        })();
        // A readable DB does not establish that failed writes have recovered.
        if result.is_err() {
            self.record_status(&result);
        }
        result.map_err(|_| "Diagnostic database unavailable".into())
    }

    pub fn health(&self) -> Value {
        let last_successful_call = self.connection.lock().ok().and_then(|conn| conn.query_row(
            "SELECT MAX(created_at) FROM events WHERE outcome='success' AND operation IN ('capture_item','list_items','update_item','undo_change','apply_changes','show_tasks','list_changes','create_project','update_project','list_projects','show_projects','show_gtd','sync_state','create_recurrence','update_recurrence','list_occurrences')",
            [], |r| r.get::<_, Option<String>>(0)).ok()).flatten();
        let failures: Vec<_> = std::fs::read_dir(&self.directory)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .filter(|name| name.ends_with(".logging-failed"))
            .collect();
        json!({"available":!self.failed.load(Ordering::Relaxed), "failure_markers":failures,
            "retention_days":30, "cap_bytes":268435456, "last_successful_call":last_successful_call})
    }
}

fn prune(conn: &Connection, max_rows: i64) -> rusqlite::Result<()> {
    // Never touches the task/audit database. Small bounded batches keep journals small.
    loop {
        let removed = conn.execute(
            "DELETE FROM events WHERE id IN (
      SELECT id FROM events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
      OR id <= (SELECT COALESCE(MAX(id),0)-?1 FROM events) LIMIT 1000)",
            [max_rows],
        )?;
        if removed == 0 {
            break;
        }
        conn.execute(
            "UPDATE retention SET removed=removed+?1 WHERE id=1",
            [removed as i64],
        )?;
        conn.execute_batch("PRAGMA incremental_vacuum(256);")?;
    }
    Ok(())
}

fn require_recorded(rows: usize) -> rusqlite::Result<usize> {
    if rows == 1 {
        Ok(rows)
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn health_counts_successful_tools_but_not_failed_or_operational_events() {
        for operation in [
            "capture_item",
            "list_items",
            "update_item",
            "undo_change",
            "apply_changes",
            "show_tasks",
            "list_changes",
            "create_project",
            "update_project",
            "list_projects",
            "show_projects",
            "show_gtd",
            "sync_state",
            "create_recurrence",
            "update_recurrence",
            "list_occurrences",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let log = Diagnostics::open(&temp.path().join("log.db"), "mcp").unwrap();
            let failed = log.begin(operation);
            assert!(
                log.health()["last_successful_call"].is_null(),
                "{operation}"
            );
            log.finish(&failed, "error", Some("storage_error"), None);
            log.event("mcp.start", "success", "MCP service started");
            assert!(
                log.health()["last_successful_call"].is_null(),
                "{operation}"
            );

            let successful = log.begin(operation);
            log.finish(&successful, "success", None, None);
            let records = log.list(LogQuery::default()).unwrap();
            assert_eq!(
                log.health()["last_successful_call"],
                records["events"][0]["created_at"],
                "{operation}"
            );
        }
    }

    #[test]
    fn missing_start_and_successful_reads_do_not_hide_logging_failure() {
        let temp = tempfile::tempdir().unwrap();
        let log = Diagnostics::open(&temp.path().join("log.db"), "web").unwrap();
        log.connection.lock().unwrap().execute_batch("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL,'test'); END;").unwrap();
        let call = log.begin("capture_item");
        log.finish(&call, "success", None, None);
        log.list(LogQuery::default()).unwrap();
        assert_eq!(log.health()["available"], false);
        assert!(log.failure_path.exists());
        log.connection
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_event;")
            .unwrap();
        let call = log.begin("list_items");
        log.finish(&call, "success", None, None);
        assert_eq!(log.health()["available"], true);
        assert!(!log.failure_path.exists());
    }
    #[test]
    fn incomplete_failed_replayed_and_retention_are_visible() {
        let temp = tempfile::tempdir().unwrap();
        let log = Diagnostics::open(&temp.path().join("log.db"), "mcp").unwrap();
        log.begin("interrupted");
        let failed = log.begin("update_item");
        log.finish(&failed, "error", Some("conflict"), None);
        let retry = log.begin("capture_item");
        log.finish(&retry, "success", None, Some(&json!({"replayed":true,"task":{"id":Uuid::new_v4().to_string(),"notes":"do not log this"},"change":{"id":42}})));
        let records = log.list(LogQuery::default()).unwrap();
        assert_eq!(records["events"][0]["replayed"], true);
        assert_eq!(records["events"][1]["code"], "conflict");
        assert_eq!(records["events"][2]["outcome"], "incomplete");
        assert!(!records.to_string().contains("do not log this"));
        let conn = log.connection.lock().unwrap();
        conn.execute(
            "UPDATE events SET created_at='2000-01-01T00:00:00.000Z' WHERE operation='interrupted'",
            [],
        )
        .unwrap();
        prune(&conn, 1).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let pages: i64 = conn
            .pragma_query_value(None, "max_page_count", |r| r.get(0))
            .unwrap();
        assert_eq!(pages, MAX_PAGES);
    }
}
