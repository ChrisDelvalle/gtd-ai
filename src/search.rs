//! Rebuildable search projection; SQLite owns records, snapshots, and frozen results.
//!
//! A personal store is small enough to rebuild an immutable index at each committed
//! checkpoint. Unlike mutating one shared index, a delayed writer cannot overwrite
//! a newer published snapshot after losing its lease. Each worker poll advances one
//! durable async task; the old generation remains available until the new one is ready.
use super::*;
use crate::search_engine::*;
use serde_json::{Value, json};
use std::time::Instant;

fn engine(c: &Connection, deadline: Instant) -> Result<Engine> {
    let identity: String = c.query_row(
        "SELECT value FROM store_meta WHERE key='identity'",
        [],
        |r| r.get(0),
    )?;
    Engine::new(
        &SearchConfig::from_env()?,
        format!("gtd_{}_v1_", identity.replace('-', "")),
        deadline,
    )
}

fn get(c: &Connection, k: &str) -> Result<Option<String>> {
    Ok(
        c.query_row("SELECT value FROM search_state WHERE key=?1", [k], |r| {
            r.get(0)
        })
        .optional()?,
    )
}
fn put(c: &Connection, k: &str, v: &str) -> Result<()> {
    c.execute("INSERT INTO search_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![k, v])?;
    Ok(())
}
// SQLite's normal five-second busy wait must not consume the whole search budget.
struct BusyWait<'a>(&'a Connection, Duration);
impl<'a> BusyWait<'a> {
    fn new(c: &'a Connection) -> Result<Self> {
        let old: u32 = c.pragma_query_value(None, "busy_timeout", |r| r.get(0))?;
        c.busy_timeout(Duration::from_millis(50))?;
        Ok(Self(c, Duration::from_millis(u64::from(old))))
    }
}
impl Drop for BusyWait<'_> {
    fn drop(&mut self) {
        let _ = self.0.busy_timeout(self.1);
    }
}
fn active(c: &Connection) -> Result<Option<Published>> {
    get(c, "active")?
        .map(|s| serde_json::from_str(&s).map_err(StoreError::from))
        .transpose()
}
fn lease(c: &Connection) -> Result<String> {
    let owner = format!(
        "{}:{}",
        Utc::now().timestamp() + LEASE_SECONDS,
        Uuid::new_v4()
    );
    let won = c.execute("INSERT INTO search_state(key,value) VALUES('lease',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(substr(search_state.value,1,instr(search_state.value,':')-1) AS INTEGER)<CAST(strftime('%s','now') AS INTEGER)", [&owner])?;
    if won == 0 {
        return Err(StoreError::SearchUnavailable);
    }
    Ok(owner)
}
// All durable state changes are fenced in the same SQLite transaction. Generation
// names additionally fence HTTP writes that resume after a process stalls.
fn fenced<T>(
    c: &Connection,
    owner: &str,
    deadline: Instant,
    f: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    remaining(deadline)?;
    let tx = c.unchecked_transaction()?;
    let changed = tx.execute("UPDATE search_state SET value=value WHERE key='lease' AND value=?1 AND CAST(substr(value,1,instr(value,':')-1) AS INTEGER)>=CAST(strftime('%s','now') AS INTEGER)", [owner])?;
    if changed != 1 {
        return Err(StoreError::SearchUnavailable);
    }
    remaining(deadline)?;
    let result = f(&tx)?;
    remaining(deadline)?;
    tx.commit()?;
    Ok(result)
}
fn save_job(c: &Connection, owner: &str, engine: &Engine, job: &Job) -> Result<()> {
    fenced(c, owner, engine.deadline, |c| {
        put(c, "inflight", &serde_json::to_string(job)?)
    })
}
fn snapshot_count(c: &Connection, high: i64) -> Result<usize> {
    let count: i64 = c.query_row(
        "SELECT COUNT(DISTINCT entity_id) FROM revisions WHERE seq<=?1",
        [high],
        |r| r.get(0),
    )?;
    usize::try_from(count).map_err(|_| StoreError::SearchUnavailable)
}
fn snapshot_chunk(c: &Connection, high: i64, offset: usize) -> Result<Vec<Value>> {
    let offset = i64::try_from(offset).map_err(|_| StoreError::SearchUnavailable)?;
    let mut statement = c.prepare("WITH latest AS (SELECT entity_id,MAX(seq) seq FROM revisions WHERE seq<=?1 GROUP BY entity_id) SELECT r.document FROM revisions r JOIN latest l ON r.seq=l.seq ORDER BY r.entity_id LIMIT ?2 OFFSET ?3")?;
    let records = statement.query_map(params![high, CHUNK as i64, offset], |r| {
        r.get::<_, String>(0)
    })?;
    let mut documents = Vec::new();
    let mut bytes = 2;
    for document in records {
        let task: Task = serde_json::from_str(&document?)?;
        let document = crate::search_engine::document(&task);
        let size = serde_json::to_vec(&document)?.len() + 1;
        if !documents.is_empty() && bytes + size > CHUNK_BYTES {
            break;
        }
        bytes += size;
        documents.push(document);
    }
    Ok(documents)
}
fn expired_sessions(c: &Connection) -> Result<()> {
    c.execute(
        "DELETE FROM search_sessions WHERE expires<CAST(strftime('%s','now') AS INTEGER)",
        [],
    )?;
    Ok(())
}
fn retire(c: &Connection, index: &str) -> Result<()> {
    put(
        c,
        &format!("generation:{index}"),
        &Utc::now().timestamp().to_string(),
    )
}
fn gc(c: &Connection, owner: &str, engine: &Engine, published: &Published) -> Result<()> {
    if let Some(value) = get(c, "gc_pending")? {
        let garbage: Garbage = serde_json::from_str(&value)?;
        let task = engine.request(
            reqwest::Method::GET,
            &format!("/tasks/{}", garbage.pending),
            None,
        );
        if matches!(&task, Ok(v) if matches!(v["status"].as_str(), Some("enqueued" | "processing")))
        {
            return Ok(());
        }
        match task {
            Ok(_) | Err(RemoteError::Missing) => {
                fenced(c, owner, engine.deadline, |c| {
                    // A failed deletion stays tracked and is retried on a later poll.
                    if matches!(&task, Ok(v) if v["status"] == "succeeded") {
                        c.execute(
                            "DELETE FROM search_state WHERE key=?1",
                            [format!("generation:{}", garbage.index)],
                        )?;
                    }
                    c.execute("DELETE FROM search_state WHERE key='gc_pending'", [])?;
                    Ok(())
                })?;
            }
            Err(error) => return Err(error.into()),
        }
        return Ok(());
    }
    let candidate: Option<String> = c.query_row("SELECT substr(key,12) FROM search_state WHERE key LIKE 'generation:%' AND CAST(value AS INTEGER)<?1 AND substr(key,12)<>?2 ORDER BY CAST(value AS INTEGER) LIMIT 1", params![Utc::now().timestamp() - GC_GRACE_SECONDS, published.index], |r| r.get(0)).optional()?;
    let Some(index) = candidate else {
        return Ok(());
    };
    if !index.starts_with(&engine.prefix) {
        return Ok(());
    }
    match engine.submit(reqwest::Method::DELETE, &format!("/indexes/{index}"), None) {
        Ok(pending) => fenced(c, owner, engine.deadline, |c| {
            put(
                c,
                "gc_pending",
                &serde_json::to_string(&Garbage { index, pending })?,
            )
        }),
        Err(RemoteError::Missing) => fenced(c, owner, engine.deadline, |c| {
            c.execute(
                "DELETE FROM search_state WHERE key=?1",
                [format!("generation:{index}")],
            )?;
            Ok(())
        }),
        Err(error) => Err(error.into()),
    }
}
fn advance(c: &Connection, owner: &str, engine: &Engine, mut job: Job) -> Result<()> {
    let path = format!("/indexes/{}", job.published.index);
    if let Some(pending) = job.pending {
        let task = engine.request(reqwest::Method::GET, &format!("/tasks/{pending}"), None);
        match task {
            Ok(task) if matches!(task["status"].as_str(), Some("enqueued" | "processing")) => {
                return Ok(());
            }
            Ok(task)
                if task["status"] == "succeeded"
                    || (matches!(job.phase, Phase::Create)
                        && task["error"]["code"] == "index_already_exists") =>
            {
                job.phase = match job.phase {
                    Phase::Create => Phase::Settings,
                    Phase::Settings => Phase::Documents,
                    Phase::Documents => {
                        job.offset += job.pending_count;
                        Phase::Documents
                    }
                    Phase::Publish => Phase::Publish,
                };
                job.pending = None;
                job.pending_count = 0;
                save_job(c, owner, engine, &job)?;
                return advance(c, owner, engine, job);
            }
            Ok(_) | Err(RemoteError::Missing) => {
                job.phase = Phase::Create;
                job.pending = None;
                job.offset = 0;
                job.pending_count = 0;
                save_job(c, owner, engine, &job)?;
                return Err(StoreError::SearchUnavailable);
            }
            Err(error) => return Err(error.into()),
        }
    }
    match job.phase {
        Phase::Create => match engine.request(reqwest::Method::GET, &path, None) {
            Ok(_) => job.phase = Phase::Settings,
            Err(RemoteError::Missing) => match engine.submit(
                reqwest::Method::POST,
                "/indexes",
                Some(&json!({"uid":job.published.index,"primaryKey":"id"})),
            ) {
                Ok(id) => job.pending = Some(id),
                Err(RemoteError::Exists) => job.phase = Phase::Settings,
                Err(error) => return Err(error.into()),
            },
            Err(error) => return Err(error.into()),
        },
        Phase::Settings => {
            // The server's search cutoff exceeds our entire client deadline, so a
            // slow search fails instead of freezing a cutoff-truncated result set.
            let settings = settings(job.published.count, false);
            match engine.submit(
                reqwest::Method::PATCH,
                &format!("{path}/settings"),
                Some(&settings),
            ) {
                Ok(id) => job.pending = Some(id),
                Err(RemoteError::Missing) => job.phase = Phase::Create,
                Err(error) => return Err(error.into()),
            }
        }
        Phase::Documents => {
            if job.offset == job.published.count {
                job.phase = Phase::Publish;
            } else {
                let docs = snapshot_chunk(c, job.published.high, job.offset)?;
                if docs.is_empty() || job.offset + docs.len() > job.published.count {
                    return Err(StoreError::SearchUnavailable);
                }
                remaining(engine.deadline)?;
                match engine.submit(
                    reqwest::Method::POST,
                    &format!("{path}/documents"),
                    Some(&json!(docs)),
                ) {
                    Ok(id) => {
                        job.pending = Some(id);
                        job.pending_count = docs.len();
                    }
                    Err(RemoteError::Missing) => {
                        job.phase = Phase::Create;
                        job.offset = 0;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Phase::Publish => {
            match engine.request(reqwest::Method::GET, &format!("{path}/stats"), None) {
                Ok(stats)
                    if stats["numberOfDocuments"].as_u64() == Some(job.published.count as u64) =>
                {
                    return fenced(c, owner, engine.deadline, |c| {
                        if let Some(old) = active(c)? {
                            if old.high > job.published.high {
                                return Err(StoreError::SearchUnavailable);
                            }
                            if old.index != job.published.index {
                                retire(c, &old.index)?;
                            }
                        }
                        put(c, "active", &serde_json::to_string(&job.published)?)?;
                        put(c, "indexed", &job.published.high.to_string())?;
                        put(c, "last_success", &now())?;
                        c.execute(
                            "DELETE FROM search_state WHERE key IN ('inflight','repair')",
                            [],
                        )?;
                        Ok(())
                    });
                }
                Ok(_) | Err(RemoteError::Missing) => {
                    job.phase = Phase::Create;
                    job.offset = 0;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    save_job(c, owner, engine, &job)?;
    if job.pending.is_none() && matches!(job.phase, Phase::Settings | Phase::Publish) {
        advance(c, owner, engine, job)
    } else {
        Ok(())
    }
}
impl Store {
    pub fn search_health(&self) -> Value {
        let c = &self.connection;
        let high = c
            .query_row("SELECT COALESCE(MAX(id),0) FROM changes", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(0);
        let published = active(c).ok().flatten();
        let indexed = published.as_ref().map(|p| p.high);
        let repair = get(c, "repair").ok().flatten();
        let checked = get(c, "last_check").ok().flatten();
        let error = get(c, "last_error")
            .ok()
            .flatten()
            .filter(|v| !v.is_empty());
        let live = checked
            .as_deref()
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .is_some_and(|v| {
                (chrono::Utc::now() - v.with_timezone(&chrono::Utc)).num_seconds() < 15
            });
        json!({"configured":std::env::var_os("TODO_SEARCH_URL").is_some(),"indexed_checkpoint":indexed,"store_checkpoint":high,"ready":live&&error.is_none()&&published.as_ref().is_some_and(|p|p.high==high&&repair.as_deref()!=Some(&p.index)),"last_success":get(c,"last_success").ok().flatten(),"last_check":checked,"error_code":error})
    }
    /// One bounded progress step. The dedicated worker polls until all accepted
    /// async tasks have succeeded; a slow task's UID survives restart and retries.
    pub fn index_once(&mut self) -> Result<()> {
        let deadline = Instant::now() + BUDGET;
        let c = &self.connection;
        let _busy = BusyWait::new(c)?;
        expired_sessions(c)?;
        let engine = engine(c, deadline)?;
        let owner = lease(c)?;
        let result = (|| {
            let high: i64 =
                c.query_row("SELECT COALESCE(MAX(id),0) FROM changes", [], |r| r.get(0))?;
            if let Some(value) = get(c, "inflight")?
                && let Ok(job) = serde_json::from_str::<Job>(&value)
                && job.published.index == engine.index(job.published.high)
                && job.published.high <= high
            {
                return advance(c, &owner, &engine, job);
            }
            if let Some(published) = active(c)?
                && published.high == high
                && published.index == engine.index(high)
                && get(c, "repair")?.as_deref() != Some(&published.index)
            {
                match engine.request(
                    reqwest::Method::GET,
                    &format!("/indexes/{}/stats", published.index),
                    None,
                ) {
                    Ok(stats)
                        if stats["numberOfDocuments"].as_u64() == Some(published.count as u64) =>
                    {
                        return gc(c, &owner, &engine, &published);
                    }
                    Ok(_) | Err(RemoteError::Missing) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            let job = Job {
                published: Published {
                    high,
                    index: engine.index(high),
                    count: snapshot_count(c, high)?,
                },
                phase: Phase::Create,
                pending: None,
                offset: 0,
                pending_count: 0,
            };
            fenced(c, &owner, deadline, |c| {
                put(c, "inflight", &serde_json::to_string(&job)?)?;
                put(c, "repair", &job.published.index)?;
                retire(c, &job.published.index)
            })?;
            advance(c, &owner, &engine, job)
        })();
        let _ = c.execute(
            "DELETE FROM search_state WHERE key='lease' AND value=?1",
            [&owner],
        );
        put(c, "last_check", &now())?;
        put(
            c,
            "last_error",
            result.as_ref().err().map_or("", |e| e.code()),
        )?;
        result
    }
    pub(super) fn prepare_search(&self, q: &str) -> Result<i64> {
        let query = validated_query(q)?;
        let deadline = Instant::now() + BUDGET;
        let c = &self.connection;
        let _busy = BusyWait::new(c)?;
        expired_sessions(c)?;
        let target: i64 =
            c.query_row("SELECT COALESCE(MAX(id),0) FROM changes", [], |r| r.get(0))?;
        let engine = engine(c, deadline)?;
        loop {
            remaining(deadline)?;
            if let Some(published) = active(c)?
                && published.high >= target
                && published.index == engine.index(published.high)
                && get(c, "repair")?.as_deref() != Some(&published.index)
            {
                let mut ids = Vec::new();
                let mut seen = HashSet::new();
                loop {
                    let response = engine.request(reqwest::Method::POST, &format!("/indexes/{}/search", published.index), Some(&json!({"q":query,"matchingStrategy":"all","attributesToRetrieve":["id"],"offset":ids.len(),"limit":SEARCH_PAGE})));
                    let response = match response {
                        Ok(value) => value,
                        Err(RemoteError::Missing) => {
                            put(c, "repair", &published.index)?;
                            return Err(StoreError::SearchUnavailable);
                        }
                        Err(error) => return Err(error.into()),
                    };
                    let hits = response["hits"]
                        .as_array()
                        .ok_or(StoreError::SearchUnavailable)?;
                    if response["degraded"] == true
                        || hits.len() > SEARCH_PAGE
                        || ids.len() + hits.len() > published.count
                    {
                        return Err(StoreError::SearchUnavailable);
                    }
                    for hit in hits {
                        let id = hit["id"].as_str().ok_or(StoreError::SearchUnavailable)?;
                        if !seen.insert(id.to_string()) {
                            return Err(StoreError::SearchUnavailable);
                        }
                        ids.push(id.to_string());
                    }
                    remaining(deadline)?;
                    if hits.len() < SEARCH_PAGE {
                        break;
                    }
                }
                let store: String = c.query_row(
                    "SELECT value FROM store_meta WHERE key='identity'",
                    [],
                    |r| r.get(0),
                )?;
                remaining(deadline)?;
                // Do not rewrite an already frozen ranking for the same query/checkpoint.
                c.execute("INSERT INTO search_sessions VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires", params![key(q,published.high),store,q,published.high,Utc::now().timestamp()+3600,serde_json::to_string(&ids)?])?;
                remaining(deadline)?;
                return Ok(published.high);
            }
            std::thread::sleep(Duration::from_millis(40).min(remaining(deadline)?));
        }
    }
}
pub(super) fn matches(c: &Connection, q: &str, h: i64) -> Result<String> {
    c.query_row("SELECT ids FROM search_sessions WHERE id=?1 AND expires>=CAST(strftime('%s','now') AS INTEGER) AND store=(SELECT value FROM store_meta WHERE key='identity')", [key(q,h)], |r| r.get(0)).optional()?.ok_or(StoreError::ResetRequired)
}
