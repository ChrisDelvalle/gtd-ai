//! Bounded round-robin work, with identity resolved again for every transaction.
//! The supervisor owns one worker; callers cannot supply an account selector.
use super::*;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::Instant;

pub struct BackgroundWorker {
    store: Store,
    after: Option<Uuid>,
    schedule: HashMap<Uuid, Schedule>,
    priority: VecDeque<(Uuid, Principal)>,
    queued: HashSet<Uuid>,
    burst: usize,
}
// Only successful authoritative commits notify. This is an in-process latency
// hint, not durable state or caller-selected authority. Periodic scans recover
// after restarts, missed hints or writes from a separate operator process.
const NOTIFICATION_LIMIT: usize = 1024;
#[derive(Default)]
pub(super) struct Notifications(Mutex<BTreeMap<Uuid, Principal>>);
impl Notifications {
    pub(super) fn notify(&self, id: Uuid, principal: &Principal) {
        if let Ok(mut pending) = self.0.lock()
            && (pending.len() < NOTIFICATION_LIMIT || pending.contains_key(&id))
        {
            pending.insert(
                id,
                Principal::for_background(principal.issuer.clone(), principal.subject.clone()),
            );
        }
    }
    fn take(&self) -> BTreeMap<Uuid, Principal> {
        self.0
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default()
    }
    fn pending(&self) -> bool {
        self.0.lock().is_ok_and(|pending| !pending.is_empty())
    }
}
pub struct BackgroundStep {
    pub account_id: Uuid,
    pub maintenance: Result<MaintenanceResult>,
    pub search: Option<Result<()>>,
    pending: bool,
}
#[derive(Default)]
struct Schedule {
    maintenance: Option<(i64, Instant)>,
    search: Option<(i64, Instant, bool, bool)>, // revision, time, pending, failed
    seen: Option<Instant>,
}
impl Store {
    pub fn background_worker(&self) -> BackgroundWorker {
        BackgroundWorker {
            store: self.clone(),
            after: None,
            schedule: HashMap::new(),
            priority: VecDeque::new(),
            queued: HashSet::new(),
            burst: 0,
        }
    }
}
impl BackgroundWorker {
    /// At most 100 materialized occurrences and one bounded index step. Returns
    /// None at the end of a sweep (or when empty). The next call starts a new
    /// sweep. Failed/backlogged accounts still rotate behind other accounts.
    /// This is internal supervisor work, not a user-facing authentication path.
    pub fn step(&mut self) -> Result<Option<BackgroundStep>> {
        self.visit(false)
    }
    fn visit(&mut self, scheduled: bool) -> Result<Option<BackgroundStep>> {
        if scheduled {
            for (id, principal) in self.store.worker_notifications.take() {
                self.queue(id, principal);
            }
            // A busy account cannot starve periodic discovery/maintenance.
            if self.burst < 4
                && let Some((id, principal)) = self.priority.pop_front()
            {
                self.queued.remove(&id);
                self.burst += 1;
                return self.visit_account(id, principal, true).map(Some);
            }
            self.burst = 0;
        }
        let selected = {
            let mut c = self.store.pool.get().map_err(|_| Error::Unavailable)?;
            validate_runtime(&mut c)?;
            let mut tx = c.build_transaction().read_only(true).start()?;
            tx.batch_execute("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'")?;
            metadata(&mut tx, self.store.environment, Some(self.store.identity))?;
            let row = tx.query_opt("SELECT * FROM gtd.next_worker_account($1)", &[&self.after])?;
            tx.commit()?;
            row
        };
        let Some(row) = selected else {
            self.after = None;
            self.schedule.clear();
            return Ok(None);
        };
        let id: Uuid = row.get("id");
        if self.after.is_some_and(|previous| id <= previous) {
            self.after = None;
            self.schedule.retain(|_, state| {
                state
                    .seen
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(60))
            });
            return Ok(None);
        }
        self.after = Some(id);
        let principal = Principal::for_background(row.get("issuer"), row.get("subject"));
        self.visit_account(id, principal, scheduled).map(Some)
    }
    fn queue(&mut self, id: Uuid, principal: Principal) {
        if self.priority.len() < NOTIFICATION_LIMIT && self.queued.insert(id) {
            self.priority.push_back((id, principal));
        }
    }
    fn visit_account(
        &mut self,
        id: Uuid,
        principal: Principal,
        scheduled: bool,
    ) -> Result<BackgroundStep> {
        let started = Instant::now();
        let high = match self.store.read(&principal, |tx| Ok(tx.high)) {
            Ok(high) => high,
            Err(error) => {
                return Ok(BackgroundStep {
                    account_id: id,
                    maintenance: Err(error),
                    search: None,
                    pending: false,
                });
            }
        };
        let read_ms = started.elapsed().as_secs_f64() * 1000.0;
        let state = self.schedule.entry(id).or_default();
        state.seen = Some(Instant::now());
        let maintenance_due = !scheduled
            || state
                .maintenance
                .is_none_or(|(saved, at)| saved != high || at.elapsed() >= Duration::from_secs(30));
        let maintenance = if maintenance_due {
            let result = self.store.maintain_account(&principal);
            if let Ok(result) = &result {
                state.maintenance = if result.budget_reached {
                    None
                } else {
                    Some((high + result.changes as i64, Instant::now()))
                };
            }
            result
        } else {
            Ok(MaintenanceResult {
                materialized: 0,
                changes: 0,
                budget_reached: false,
            })
        };
        let maintenance_ms = started.elapsed().as_secs_f64() * 1000.0 - read_ms;
        let search_due = !scheduled
            || state.search.is_none_or(|(saved, at, pending, failed)| {
                if failed {
                    at.elapsed() >= Duration::from_secs(5)
                } else {
                    pending || saved != high || at.elapsed() >= Duration::from_secs(5)
                }
            });
        let mut pending = maintenance.as_ref().is_ok_and(|v| v.budget_reached);
        let search = if self.store.search.is_some() && search_due {
            let result = self.store.index_once(&principal).and_then(|_| {
                let health = self.store.search_health(&principal)?;
                let pending_search = health["ready"] != true;
                state.search = Some((high, Instant::now(), pending_search, false));
                pending |= pending_search;
                Ok(())
            });
            if result.is_err() {
                state.search = Some((high, Instant::now(), false, true));
            }
            Some(result)
        } else {
            None
        };
        if self.store.environment == Environment::Staging
            && std::env::var("GTD_STAGING_WORKER_TIMINGS").as_deref() == Ok("1")
        {
            eprintln!(
                "{}",
                serde_json::json!({
                    "component":"staging-worker-timing", "at_ms":chrono::Utc::now().timestamp_millis(),
                    "read_ms":read_ms, "maintenance_ms":maintenance_ms,
                    "search_ms":started.elapsed().as_secs_f64()*1000.0-read_ms-maintenance_ms,
                    "maintenance_due":maintenance_due, "search_due":search_due,
                    "pending":pending,
                })
            );
        }
        if scheduled && pending {
            self.queue(id, principal);
        }
        Ok(BackgroundStep {
            account_id: id,
            maintenance,
            search,
            pending,
        })
    }

    /// One process-owned loop, no overlapping jobs or detached timeout retries.
    /// Check cancellation between bounded slices; idle waits are interruptible.
    pub fn run(mut self, stop: Receiver<()>) {
        let sessions = super::sessions::Sessions::new(self.store.clone());
        let mut cleaned = None::<Instant>;
        let mut pending = false;
        loop {
            if !matches!(stop.try_recv(), Err(TryRecvError::Empty)) {
                return;
            }
            let started = Instant::now();
            let delay = match self.visit(true) {
                Ok(Some(step)) => {
                    pending |= step.pending;
                    let failed = step.maintenance.is_err()
                        || step.search.as_ref().is_some_and(Result::is_err);
                    let changes = step.maintenance.as_ref().map(|v| v.changes).unwrap_or(0);
                    if failed || changes > 0 {
                        eprintln!(
                            "{}",
                            serde_json::json!({"component":"account-worker","operation":"slice",
                            "account_id":step.account_id,"changes":changes,"failed":failed,"duration_ms":started.elapsed().as_millis()})
                        );
                    }
                    // Bound visits to 50 per second without adding a fixed idle
                    // penalty after an already slower indexing/maintenance slice.
                    Duration::from_millis(20).saturating_sub(started.elapsed())
                }
                Ok(None) => {
                    let delay = if pending {
                        Duration::from_millis(100)
                    } else {
                        Duration::from_secs(1)
                    };
                    pending = false;
                    delay
                }
                Err(_) => {
                    eprintln!(
                        "{{\"component\":\"account-worker\",\"operation\":\"directory_failed\"}}"
                    );
                    Duration::from_secs(30)
                }
            };
            if cleaned.is_none_or(|at| at.elapsed() >= Duration::from_secs(300)) {
                if sessions.cleanup().is_err() {
                    eprintln!(
                        "{{\"component\":\"account-worker\",\"operation\":\"session_cleanup_failed\"}}"
                    );
                }
                cleaned = Some(Instant::now());
            }
            let until = Instant::now() + delay;
            loop {
                let remaining = until.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                if !matches!(
                    stop.recv_timeout(remaining.min(Duration::from_millis(100))),
                    Err(RecvTimeoutError::Timeout)
                ) {
                    return;
                }
                if self.store.worker_notifications.pending() {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postgres::{
        tests::{fixture, principal},
        write_tests::{capture, run},
    };
    use serde_json::json;
    use std::{sync::mpsc, thread};

    #[test]
    fn notifications_coalesce_accounts_and_remain_bounded() {
        let notifications = Notifications::default();
        let principal =
            Principal::for_background("https://fixture.invalid".into(), "fixture".into());
        let id = Uuid::new_v4();
        for _ in 0..100 {
            notifications.notify(id, &principal);
        }
        assert_eq!(notifications.take().len(), 1);
        for _ in 0..(NOTIFICATION_LIMIT + 100) {
            notifications.notify(Uuid::new_v4(), &principal);
        }
        assert_eq!(notifications.take().len(), NOTIFICATION_LIMIT);
        assert!(!notifications.pending());
    }

    #[test]
    #[ignore = "Manual worker lifecycle checks; disposable PostgreSQL only, no model or production data"]
    fn shutdown_finishes_one_slice_and_interrupts_idle_waits() {
        let (_container, mut admin, runtime, a, b) = fixture();
        admin
            .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
            .unwrap();
        admin
            .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&b])
            .unwrap();
        let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
        assert!(store.worker_notifications.take().is_empty());
        let rolled_back = store.write(&principal("a"), |tx| {
            tx.next_revision()?;
            Err::<(), _>(Error::ReadOnly)
        });
        assert!(rolled_back.is_err());
        assert!(
            store.worker_notifications.take().is_empty(),
            "rolled-back changes cannot wake work"
        );
        run(
            &store,
            "a",
            "recurrence",
            json!({"request_id":"backlog","reason":"Fixture",
            "template":{"title":"Daily fixture","brief":"Synthetic recurrence.","agent_notes":"Shared synthetic handoff.","importance":"normal","estimated_minutes":5,"effort":"low"},
            "rule":{"start_date":"2000-01-01","frequency":"daily","count":305}}),
        );
        let count = |admin: &mut postgres::Client| {
            admin
                .query_one(
                    "SELECT count(*) FROM gtd.tasks WHERE account_id=$1 AND series_id IS NOT NULL",
                    &[&a],
                )
                .unwrap()
                .get::<_, i64>(0)
        };
        assert_eq!(count(&mut admin), 100);

        // Synchronize on a real contended write lock, not a guessed delay. Stop
        // while the first slice is running; it must commit once and then exit.
        let mut holder = store.pool.get().unwrap();
        let mut lock = holder.transaction().unwrap();
        lock.execute(
            "SELECT set_config('gtd.account_id', $1, true)",
            &[&a.to_string()],
        )
        .unwrap();
        lock.query_one(
            "SELECT account_id FROM gtd.account_state WHERE account_id=$1 FOR UPDATE",
            &[&a],
        )
        .unwrap();
        let (stop, stopped) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        let worker = store.background_worker();
        let thread = thread::spawn(move || {
            worker.run(stopped);
            done.send(()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let waiting: bool = admin.query_one("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='gtd_runtime' AND wait_event_type='Lock')", &[]).unwrap().get(0);
            if waiting {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "worker did not reach the account lock"
            );
            thread::sleep(Duration::from_millis(20));
        }
        stop.send(()).unwrap();
        lock.commit().unwrap();
        drop(holder);
        finished
            .recv_timeout(Duration::from_secs(5))
            .expect("worker must join after its current slice");
        thread.join().unwrap();
        assert_eq!(
            count(&mut admin),
            200,
            "shutdown must not process the next slice"
        );
        let (stop, stopped) = mpsc::channel();
        stop.send(()).unwrap();
        store.background_worker().run(stopped);
        assert_eq!(
            count(&mut admin),
            200,
            "a pre-cancelled worker cannot write"
        );

        // Cleanup provides an observable signal that the empty-directory worker
        // reached its idle wait; cancellation must interrupt that wait.
        admin
            .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&a])
            .unwrap();
        admin.batch_execute("INSERT INTO gtd.web_logins(state_hash,browser_hash,document,expires_at) VALUES(repeat('a',64),repeat('b',64),'{}',clock_timestamp()-interval '1 second')").unwrap();
        let (stop, stopped) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        let worker = store.background_worker();
        let thread = thread::spawn(move || {
            worker.run(stopped);
            done.send(()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while admin
            .query_one("SELECT count(*) FROM gtd.web_logins", &[])
            .unwrap()
            .get::<_, i64>(0)
            != 0
        {
            assert!(
                Instant::now() < deadline,
                "worker did not perform session cleanup"
            );
            thread::sleep(Duration::from_millis(20));
        }
        drop(stop);
        finished
            .recv_timeout(Duration::from_millis(500))
            .expect("disconnection must interrupt idle wait");
        thread.join().unwrap();
        assert_eq!(count(&mut admin), 200);
    }
    #[test]
    #[ignore = "Manual scheduler checks; disposable PostgreSQL only, no model or production data"]
    fn rotates_backlog_failures_and_disabled_accounts() {
        let (_container, mut admin, runtime, a, b) = fixture();
        admin
            .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
            .unwrap();
        let store = Store::connect(runtime, Environment::Staging, 2).unwrap();
        let series = run(
            &store,
            "a",
            "recurrence",
            json!({"request_id":"backlog","reason":"Fixture","template":{"title":"Daily fixture","brief":"Synthetic recurrence.","agent_notes":"Shared synthetic handoff.","importance":"normal","estimated_minutes":5,"effort":"low"},"rule":{"start_date":"2000-01-01","frequency":"daily","count":205}}),
        );
        run(&store, "b", "capture", capture("other-account"));
        let mut worker = store.background_worker();
        let first = worker.step().unwrap().unwrap();
        let second = worker.step().unwrap().unwrap();
        assert_ne!(first.account_id, second.account_id);
        for step in [first, second] {
            let result = step.maintenance.unwrap();
            assert_eq!(
                result.materialized,
                if step.account_id == a { 100 } else { 0 }
            );
            assert!(step.search.is_none());
        }
        assert!(worker.step().unwrap().is_none());
        let third = worker.step().unwrap().unwrap();
        let fourth = worker.step().unwrap().unwrap();
        assert_ne!(third.account_id, fourth.account_id);
        assert!(third.maintenance.is_ok() && fourth.maintenance.is_ok());
        assert!(worker.step().unwrap().is_none());
        // A malformed per-account record cannot keep the scheduler on that user.
        let mut doc: serde_json::Value = serde_json::to_value(series.task).unwrap();
        doc["recurrence"]["timezone"] = json!("Not/AZone");
        admin
            .execute(
                "UPDATE gtd.tasks SET document=$1 WHERE account_id=$2 AND id=$3",
                &[
                    &serde_json::to_string(&doc).unwrap(),
                    &a,
                    &doc["id"].as_str().unwrap(),
                ],
            )
            .unwrap();
        let first = worker.step().unwrap().unwrap();
        let second = worker.step().unwrap().unwrap();
        assert_ne!(first.account_id, second.account_id);
        for step in [first, second] {
            assert_eq!(step.maintenance.is_err(), step.account_id == a);
        }
        assert!(worker.step().unwrap().is_none());
        admin
            .execute("UPDATE gtd.accounts SET enabled=false WHERE id=$1", &[&a])
            .unwrap();
        for _ in 0..2 {
            assert_eq!(worker.step().unwrap().unwrap().account_id, b);
            assert!(worker.step().unwrap().is_none());
        }
        assert!(matches!(
            store.maintain_account(&principal("a")),
            Err(Error::AccountUnavailable)
        ));
        admin
            .execute(
                "UPDATE gtd.accounts SET enrollment='pending' WHERE id=$1",
                &[&b],
            )
            .unwrap();
        assert!(worker.step().unwrap().is_none());
    }
}
