//! Account-owned immutable search generations. Network calls never hold the
//! account write lock. Lease checks fence durable state after every remote step.
use super::*;
use crate::{model::Task, search_engine::*, store::StoreError};
use chrono::Utc;
use serde_json::{Value, json};
use std::time::Instant;

impl From<RemoteError> for Error {
    fn from(_: RemoteError) -> Self {
        StoreError::SearchUnavailable.into()
    }
}
fn unavailable<T>() -> Result<T> {
    Err(StoreError::SearchUnavailable.into())
}
pub(super) fn get(tx: &mut AccountTransaction<'_>, key: &str) -> Result<Option<String>> {
    Ok(tx
        .tx
        .query_opt(
            "SELECT value FROM gtd.search_state WHERE account_id=$1 AND key=$2",
            &[&tx.account.id, &key],
        )?
        .map(|r| r.get(0)))
}
pub(super) fn put(tx: &mut AccountTransaction<'_>, key: &str, value: &str) -> Result<()> {
    tx.tx.execute("INSERT INTO gtd.search_state VALUES($1,$2,$3) ON CONFLICT(account_id,key) DO UPDATE SET value=excluded.value", &[&tx.account.id, &key, &value])?;
    Ok(())
}
fn remove(tx: &mut AccountTransaction<'_>, key: &str) -> Result<()> {
    tx.tx.execute(
        "DELETE FROM gtd.search_state WHERE account_id=$1 AND key=$2",
        &[&tx.account.id, &key],
    )?;
    Ok(())
}
pub(super) fn active(tx: &mut AccountTransaction<'_>) -> Result<Option<Published>> {
    get(tx, "active")?
        .map(|s| serde_json::from_str(&s).map_err(Error::from))
        .transpose()
}
pub(super) fn prefix(tx: &AccountTransaction<'_>) -> String {
    format!(
        "gtd_{}_{}_v2_",
        tx.store_identity.simple(),
        tx.identity.simple()
    )
}

struct Worker<'a> {
    store: &'a Store,
    principal: &'a Principal,
    owner: String,
    engine: Engine,
}
impl Worker<'_> {
    fn fenced<T>(&self, f: impl FnOnce(&mut AccountTransaction<'_>) -> Result<T>) -> Result<T> {
        remaining(self.engine.deadline)?;
        self.store.write(self.principal, |tx| {
            let valid = tx.tx.query_opt("SELECT 1 FROM gtd.search_state WHERE account_id=$1 AND key='lease' AND value=$2 AND split_part(value,':',1)::bigint>=extract(epoch FROM clock_timestamp())::bigint", &[&tx.account.id, &self.owner])?.is_some();
            if !valid { return unavailable(); }
            remaining(self.engine.deadline)?;
            let result = f(tx)?;
            remaining(self.engine.deadline)?;
            Ok(result)
        })
    }
    fn save_job(&self, job: &Job) -> Result<()> {
        self.fenced(|tx| put(tx, "inflight", &serde_json::to_string(job)?))
    }
    fn snapshot_chunk(&self, high: i64, offset: usize) -> Result<Vec<Value>> {
        self.store.read(self.principal, |tx| {
            let sql = format!(
                "{} SELECT document FROM records ORDER BY entity_id LIMIT $3 OFFSET $4",
                super::read_snapshot::source(high == tx.high)
            );
            let rows = tx.tx.query(
                &sql,
                &[&tx.account.id, &high, &(CHUNK as i64), &(offset as i64)],
            )?;
            let mut documents = Vec::new();
            let mut bytes = 2;
            for row in rows {
                let task: Task = serde_json::from_str(&row.get::<_, String>(0))?;
                let mut doc = document(&task);
                doc["account_id"] = json!(tx.account.id.to_string());
                let size = serde_json::to_vec(&doc)?.len() + 1;
                if !documents.is_empty() && bytes + size > CHUNK_BYTES {
                    break;
                }
                bytes += size;
                documents.push(doc);
            }
            Ok(documents)
        })
    }
    fn collect(&self, published: &Published) -> Result<()> {
        let pending = self
            .store
            .read(self.principal, |tx| get(tx, "gc_pending"))?;
        if let Some(pending) = pending {
            let garbage: Garbage = serde_json::from_str(&pending)?;
            if !garbage.index.starts_with(&self.engine.prefix) || garbage.index == published.index {
                return unavailable();
            }
            let result = self.engine.request(
                reqwest::Method::GET,
                &format!("/tasks/{}", garbage.pending),
                None,
            );
            if matches!(&result, Ok(v) if matches!(v["status"].as_str(), Some("enqueued" | "processing")))
            {
                return Ok(());
            }
            return match result {
                Ok(value) => self.fenced(|tx| {
                    if value["status"] == "succeeded" {
                        remove(tx, &format!("generation:{}", garbage.index))?;
                    }
                    remove(tx, "gc_pending")
                }),
                Err(RemoteError::Missing) => self.fenced(|tx| remove(tx, "gc_pending")),
                Err(error) => Err(error.into()),
            };
        }
        let candidate = self.store.read(self.principal, |tx| {
            Ok(tx.tx.query_opt("SELECT substring(key FROM 12) FROM gtd.search_state WHERE account_id=$1 AND key LIKE 'generation:%' AND value::bigint<$2 AND substring(key FROM 12)<>$3 ORDER BY value::bigint LIMIT 1", &[&tx.account.id,&(Utc::now().timestamp()-GC_GRACE_SECONDS),&published.index])?.map(|r|r.get::<_,String>(0)))
        })?;
        let Some(index) = candidate else {
            return Ok(());
        };
        if !index.starts_with(&self.engine.prefix) {
            return unavailable();
        }
        match self
            .engine
            .submit(reqwest::Method::DELETE, &format!("/indexes/{index}"), None)
        {
            Ok(pending) => self.fenced(|tx| {
                put(
                    tx,
                    "gc_pending",
                    &serde_json::to_string(&Garbage { index, pending })?,
                )
            }),
            Err(RemoteError::Missing) => {
                self.fenced(|tx| remove(tx, &format!("generation:{index}")))
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl Store {
    /// Startup configuration only; caller arguments cannot select a search server.
    pub fn with_search(mut self, config: SearchConfig) -> Self {
        self.search = Some(config);
        self
    }

    pub fn index_once(&self, principal: &Principal) -> Result<()> {
        let deadline = Instant::now() + BUDGET;
        let config = self.search.as_ref().ok_or(StoreError::SearchUnavailable)?;
        let owner = format!(
            "{}:{}",
            Utc::now().timestamp() + LEASE_SECONDS,
            Uuid::new_v4()
        );
        let (prefix,high,published,inflight,repair) = self.write(principal,|tx| {
            let won = tx.tx.execute("INSERT INTO gtd.search_state VALUES($1,'lease',$2) ON CONFLICT(account_id,key) DO UPDATE SET value=excluded.value WHERE split_part(search_state.value,':',1)::bigint<extract(epoch FROM clock_timestamp())::bigint", &[&tx.account.id,&owner])?;
            if won == 0 { return unavailable(); }
            tx.tx.execute("DELETE FROM gtd.search_sessions WHERE account_id=$1 AND id IN (SELECT id FROM gtd.search_sessions WHERE account_id=$1 AND expires<extract(epoch FROM now())::bigint LIMIT 1000)", &[&tx.account.id])?;
            Ok((prefix(tx),tx.high,active(tx)?,get(tx,"inflight")?,get(tx,"repair")?))
        })?;
        let worker = Worker {
            store: self,
            principal,
            owner,
            engine: Engine::new(config, prefix, deadline)?,
        };
        let result = (|| {
            if let Some(value) = inflight
                && let Ok(job) = serde_json::from_str::<Job>(&value)
                && valid_index(&worker.engine, &job.published)
                && job.published.high <= high
            {
                return advance(&worker, job);
            }
            if let Some(published) = published
                && published.high == high
                && valid_index(&worker.engine, &published)
                && repair.as_deref() != Some(&published.index)
            {
                match worker.engine.request(
                    reqwest::Method::GET,
                    &format!("/indexes/{}/stats", published.index),
                    None,
                ) {
                    Ok(stats)
                        if stats["numberOfDocuments"].as_u64() == Some(published.count as u64) =>
                    {
                        return worker.collect(&published);
                    }
                    Ok(_) | Err(RemoteError::Missing) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            let count = self.read(principal, |tx| {
                let count: i64 = tx.tx.query_one("SELECT count(DISTINCT entity_id) FROM gtd.revisions WHERE account_id=$1 AND seq<=$2", &[&tx.account.id,&high])?.get(0);
                usize::try_from(count).map_err(|_|StoreError::SearchUnavailable.into())
            })?;
            let job = Job {
                published: Published {
                    high,
                    index: format!("{}_{}", worker.engine.index(high), Uuid::new_v4().simple()),
                    count,
                },
                phase: Phase::Create,
                pending: None,
                offset: 0,
                pending_count: 0,
            };
            worker.fenced(|tx| {
                put(tx, "inflight", &serde_json::to_string(&job)?)?;
                // Keep the active generation unhealthy until its replacement is
                // published, including repairs at the same record revision.
                if let Some(old) = active(tx)? {
                    put(tx, "repair", &old.index)?;
                }
                put(
                    tx,
                    &format!("generation:{}", job.published.index),
                    &Utc::now().timestamp().to_string(),
                )
            })?;
            advance(&worker, job)
        })();
        // Only the same lease owner can publish health or release the lease.
        self.write(principal, |tx| {
            if get(tx, "lease")?.as_deref() == Some(&worker.owner) {
                put(tx, "last_check", &crate::clock::timestamp())?;
                put(
                    tx,
                    "last_error",
                    if result.is_ok() {
                        ""
                    } else {
                        "search_unavailable"
                    },
                )?;
                remove(tx, "lease")?;
            }
            Ok(())
        })?;
        result
    }
}
fn advance(w: &Worker<'_>, mut job: Job) -> Result<()> {
    let engine = &w.engine;
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
                w.save_job(&job)?;
                return advance(w, job);
            }
            Ok(_) | Err(RemoteError::Missing) => {
                job.phase = Phase::Create;
                job.pending = None;
                job.offset = 0;
                job.pending_count = 0;
                w.save_job(&job)?;
                return Err(StoreError::SearchUnavailable.into());
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
            let settings = settings(job.published.count, true);
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
                let docs = w.snapshot_chunk(job.published.high, job.offset)?;
                if docs.is_empty() || job.offset + docs.len() > job.published.count {
                    return Err(StoreError::SearchUnavailable.into());
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
                    return w.fenced(|c| {
                        if let Some(old) = active(c)? {
                            if old.high > job.published.high {
                                return Err(StoreError::SearchUnavailable.into());
                            }
                            if old.index != job.published.index {
                                put(
                                    c,
                                    &format!("generation:{}", old.index),
                                    &Utc::now().timestamp().to_string(),
                                )?;
                            }
                        }
                        put(c, "active", &serde_json::to_string(&job.published)?)?;
                        put(c, "indexed", &job.published.high.to_string())?;
                        put(c, "last_success", &crate::clock::timestamp())?;
                        remove(c, "inflight")?;
                        remove(c, "repair")?;
                        Ok(())
                    });
                }
                Ok(_) | Err(RemoteError::Missing) => {
                    // A bad completed generation must not be repaired in place:
                    // stale/foreign extra documents could survive every upsert.
                    // Keep it tracked for GC and build a fresh immutable name.
                    w.fenced(|tx| remove(tx, "inflight"))?;
                    return unavailable();
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    w.save_job(&job)?;
    if job.pending.is_none() && matches!(job.phase, Phase::Settings | Phase::Publish) {
        advance(w, job)
    } else {
        Ok(())
    }
}

pub(super) fn valid_index(engine: &Engine, published: &Published) -> bool {
    published.high >= 0
        && published
            .index
            .strip_prefix(&format!("{}_", engine.index(published.high)))
            .is_some_and(|suffix| suffix.len() == 32 && Uuid::parse_str(suffix).is_ok())
}
