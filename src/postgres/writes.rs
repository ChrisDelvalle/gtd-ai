//! Native PostgreSQL persistence for the shared business rules and undo journal.
use super::*;
use crate::{
    model::{Change, Status, Task},
    store::{
        StoreError,
        content::Policy,
        mutation::{Journal, Mutation, Operation, RecordRead},
    },
};
use serde_json::Value;
use std::cell::RefCell;

type DomainResult<T> = std::result::Result<T, StoreError>;
fn storage(_: ::postgres::Error) -> StoreError {
    StoreError::BackendStorage
}

impl Store {
    /// The ordinary current read checks timed availability within its own
    /// snapshot. Only an expired hold needs a separate write and a fresh read.
    /// Never use this for continuation pages, which retain their original high.
    pub(super) fn read_current<T>(
        &self,
        principal: &Principal,
        operation: impl FnOnce(&mut AccountTransaction<'_>) -> Result<T>,
    ) -> Result<T> {
        use std::ops::ControlFlow;
        let outcome = self.read(principal, |tx| {
            if availability_due(tx)? {
                Ok(ControlFlow::Break(operation))
            } else {
                operation(tx).map(ControlFlow::Continue)
            }
        })?;
        match outcome {
            ControlFlow::Continue(value) => Ok(value),
            ControlFlow::Break(operation) => {
                self.settle_availability(principal)?;
                self.read(principal, operation)
            }
        }
    }

    /// Only a verified application entry point can choose the authoring policy.
    /// No tools expose either this choice or an account selector.
    pub fn execute(
        &self,
        principal: &Principal,
        policy: Policy,
        origin: &str,
        operation: Operation,
    ) -> Result<Value> {
        self.write(principal, |bound| {
            bound.execute_in(policy, origin, operation)
        })
    }
}

impl AccountTransaction<'_> {
    pub(super) fn execute_in(
        &mut self,
        policy: Policy,
        origin: &str,
        operation: Operation,
    ) -> Result<Value> {
        let fingerprint = operation.fingerprint()?;
        let key = operation.key().to_owned();
        let bound = self;
        if let Some(row) = bound.tx.query_opt(
            "SELECT request,response FROM gtd.requests WHERE account_id=$1 AND id=$2",
            &[&bound.account.id, &key],
        )? {
            if row.get::<_, String>("request") != fingerprint {
                return Err(StoreError::RetryKeyConflict.into());
            }
            // Preserve unknown fields in historical receipts. Parsing as a
            // current typed result would silently discard legacy content.
            let mut receipt: Value = serde_json::from_str(&row.get::<_, String>("response"))?;
            receipt["replayed"] = true.into();
            if let Some(items) = receipt.get_mut("results").and_then(Value::as_array_mut) {
                for item in items {
                    item["replayed"] = true.into();
                }
            }
            return Ok(receipt);
        }
        let journal = Journal::new(bound.high);
        let context = PgMutation {
            bound: RefCell::new(bound),
            journal,
            policy,
        };
        let result = operation.apply(&context, origin)?;
        crate::store::mutation::finish_rules(&context)?;
        let result = context.journal.receipt(result)?;
        context.persist(Some((&key, &fingerprint, &result)))?;
        Ok(result)
    }
}

struct PgMutation<'a, 'db> {
    bound: RefCell<&'a mut AccountTransaction<'db>>,
    journal: Journal,
    policy: Policy,
}
impl RecordRead for PgMutation<'_, '_> {
    fn calendar_timezone(&self) -> chrono_tz::Tz {
        self.bound.borrow().account.timezone
    }
    fn load_record(&self, id: &str) -> DomainResult<Task> {
        let mut bound = self.bound.borrow_mut();
        let account = bound.account.id;
        let row = bound
            .tx
            .query_opt(
                "SELECT document FROM gtd.tasks WHERE account_id=$1 AND id=$2",
                &[&account, &id],
            )
            .map_err(storage)?
            .ok_or_else(|| StoreError::NotFound("task not found".into()))?;
        Ok(serde_json::from_str(&row.get::<_, String>(0))?)
    }
    fn occurrences(&self, id: &str) -> DomainResult<Vec<Task>> {
        let mut bound = self.bound.borrow_mut();
        let account = bound.account.id;
        bound.tx.query("SELECT document FROM gtd.tasks WHERE account_id=$1 AND series_id=$2 ORDER BY occurrence_date",&[&account,&id])
            .map_err(storage)?.iter().map(|r|Ok(serde_json::from_str(&r.get::<_,String>(0))?)).collect()
    }
    fn archive_status(&self, task: &Task) -> DomainResult<Option<Status>> {
        let mut bound = self.bound.borrow_mut();
        let account = bound.account.id;
        let row=bound.tx.query_opt(
            "SELECT document::jsonb #>> '{before,status}' FROM gtd.changes WHERE account_id=$1 AND task_id=$2 AND id<=$3
            AND document::jsonb #>> '{before,status}' IN ('inbox','next','waiting','someday','done') ORDER BY id DESC LIMIT 1",
            &[&account,&task.id,&task.last_change_id]).map_err(storage)?;
        row.map(|r| Ok(serde_json::from_value(r.get::<_, String>(0).into())?))
            .transpose()
    }
}
impl Mutation for PgMutation<'_, '_> {
    fn policy(&self) -> Policy {
        self.policy
    }
    fn journal(&self) -> &Journal {
        &self.journal
    }
    fn write_current(&self, task: &Task) -> DomainResult<()> {
        let mut bound = self.bound.borrow_mut();
        let account = bound.account.id;
        bound
            .tx
            .execute(
                "INSERT INTO gtd.tasks(account_id,id,document) VALUES($1,$2,$3)
            ON CONFLICT(account_id,id) DO UPDATE SET document=excluded.document",
                &[&account, &task.id, &serde_json::to_string(task)?],
            )
            .map_err(storage)?;
        Ok(())
    }
    fn all_records(&self) -> DomainResult<Vec<Task>> {
        let mut bound = self.bound.borrow_mut();
        let account = bound.account.id;
        bound
            .tx
            .query(
                "SELECT document FROM gtd.tasks WHERE account_id=$1 ORDER BY id",
                &[&account],
            )
            .map_err(storage)?
            .iter()
            .map(|r| Ok(serde_json::from_str(&r.get::<_, String>(0))?))
            .collect()
    }
    fn undo_group(&self, id: i64) -> DomainResult<(bool, Vec<Change>)> {
        let mut bound = self.bound.borrow_mut();
        let account = bound.account.id;
        let group: Option<String> = bound
            .tx
            .query_opt(
                "SELECT group_id FROM gtd.action_groups WHERE account_id=$1 AND change_id=$2",
                &[&account, &id],
            )
            .map_err(storage)?
            .map(|r| r.get(0));
        let rows=bound.tx.query("SELECT document FROM gtd.changes WHERE account_id=$1 AND
            (id=$2 OR id IN (SELECT change_id FROM gtd.action_groups WHERE account_id=$1 AND group_id=$3)) ORDER BY id",
            &[&account,&id,&group]).map_err(storage)?;
        Ok((
            group.is_some(),
            rows.iter()
                .map(|r| Ok(serde_json::from_str(&r.get::<_, String>(0))?))
                .collect::<DomainResult<_>>()?,
        ))
    }
}
impl PgMutation<'_, '_> {
    fn persist(&self, receipt: Option<(&str, &str, &Value)>) -> Result<()> {
        let mut bound = self.bound.borrow_mut();
        let account = bound.account.id;
        let base = bound.high;
        let high = self.journal.high();
        // Allocate the final journal range inside the already locked account.
        // Rollback restores this counter along with current records and receipts.
        let row=bound.tx.query_opt("UPDATE gtd.account_state SET high=$2 WHERE account_id=$1 AND high=$3 RETURNING high",
            &[&account,&high,&base])?.ok_or(Error::Reconciliation)?;
        bound.high = row.get(0);
        for (change, batch) in self.journal.entries() {
            let kind = match change.entity_type {
                crate::model::EntityType::Task => "task",
                crate::model::EntityType::Project => "project",
                crate::model::EntityType::Recurrence => "recurrence",
            };
            bound.tx.execute("INSERT INTO gtd.changes(account_id,id,task_id,document,entity_type,batch_id,token) VALUES($1,$2,$3,$4,$5,$6,$7)",
                &[&account,&change.id,&change.task_id,&serde_json::to_string(&change)?,&kind,&batch,&Uuid::new_v4().to_string()])?;
            super::activity::insert_event(&mut bound.tx, account, &change)?;
            bound.tx.execute("INSERT INTO gtd.revisions(account_id,seq,entity_id,entity_type,document) VALUES($1,$2,$3,$4,$5)",
                &[&account,&change.id,&change.task_id,&kind,&serde_json::to_string(&change.after)?])?;
            bound.tx.execute(
                "DELETE FROM gtd.dependencies WHERE account_id=$1 AND task_id=$2",
                &[&account, &change.task_id],
            )?;
            if !change.after.deleted {
                for prerequisite in &change.after.blocked_by {
                    bound.tx.execute("INSERT INTO gtd.dependencies(account_id,task_id,prerequisite_id) VALUES($1,$2,$3)",&[&account,&change.task_id,prerequisite])?;
                }
            }
        }
        for (id, group) in self.journal.groups() {
            bound.tx.execute(
                "INSERT INTO gtd.action_groups(account_id,change_id,group_id) VALUES($1,$2,$3)",
                &[&account, &id, &group],
            )?;
        }
        if let Some((key, fingerprint, result)) = receipt {
            bound.tx.execute(
                "INSERT INTO gtd.requests(account_id,id,request,response) VALUES($1,$2,$3,$4)",
                &[
                    &account,
                    &key,
                    &fingerprint,
                    &serde_json::to_string(result)?,
                ],
            )?;
        }
        // Check final-state references before the outer transaction can commit.
        bound.tx.batch_execute("SET CONSTRAINTS ALL IMMEDIATE")?;
        Ok(())
    }
}

/// A bounded recurrence slice, not a claim that all accounts have caught up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaintenanceResult {
    pub materialized: usize,
    pub changes: usize,
    pub budget_reached: bool,
}
impl Store {
    /// The scheduler must rotate accounts between slices. Authentication and
    /// disablement are rechecked on each slice, just as for user requests.
    pub fn maintain_account(&self, principal: &Principal) -> Result<MaintenanceResult> {
        self.write(principal, |bound| bound.maintain_in())
    }

    /// Fresh reads settle elapsed availability without taking the account writer
    /// lock on the usual path where no timed hold has expired. Continuation pages
    /// must keep their frozen snapshot and must not invoke this method.
    pub fn settle_availability(&self, principal: &Principal) -> Result<()> {
        let due = self.read(principal, availability_due)?;
        if due {
            self.write(principal, |bound| {
                let journal = Journal::new(bound.high);
                let context = PgMutation {
                    bound: RefCell::new(bound),
                    journal,
                    policy: Policy::Human,
                };
                crate::store::mutation::finish_rules(&context)?;
                context.persist(None)
            })?;
        }
        Ok(())
    }

    pub fn sync_state(
        &self,
        principal: &Principal,
        input: &crate::model::SyncState,
    ) -> Result<Value> {
        if input.cursor.is_none() {
            return self.read_current(principal, |bound| bound.read_sync_page(input));
        }
        self.read(principal, |bound| bound.read_sync_page(input))
    }
}

impl AccountTransaction<'_> {
    pub(super) fn maintain_in(&mut self) -> Result<MaintenanceResult> {
        let bound = self;
        let journal = Journal::new(bound.high);
        let context = PgMutation {
            bound: RefCell::new(bound),
            journal,
            policy: Policy::Human,
        };
        let mut total = 0;
        for series in context
            .all_records()?
            .into_iter()
            .filter(|t| !t.deleted && t.entity_type == crate::model::EntityType::Recurrence)
        {
            let data = series
                .recurrence
                .as_ref()
                .ok_or_else(|| StoreError::Invalid("Missing recurring defaults".into()))?;
            let through = data
                .date_at(crate::clock::now())
                .map_err(StoreError::Invalid)?;
            let key = format!("recurrence:{}", series.id);
            let checkpoint = format!("{}:{through}:{}", series.version, data.timezone);
            let saved = {
                let mut bound = context.bound.borrow_mut();
                let account = bound.account.id;
                bound
                    .tx
                    .query_opt(
                        "SELECT value FROM gtd.search_state WHERE account_id=$1 AND key=$2",
                        &[&account, &key],
                    )?
                    .map(|r| r.get::<_, String>(0))
            };
            if saved.as_deref() == Some(checkpoint.as_str()) {
                continue;
            }
            let remaining = 100 - total;
            let count =
                crate::store::mutation::materialize_series(&context, &series, &through, remaining)?;
            total += count;
            if count < remaining {
                let mut bound = context.bound.borrow_mut();
                let account = bound.account.id;
                bound.tx.execute("INSERT INTO gtd.search_state(account_id,key,value) VALUES($1,$2,$3) ON CONFLICT(account_id,key) DO UPDATE SET value=excluded.value",&[&account,&key,&checkpoint])?;
            }
            if total >= 100 {
                break;
            }
        }
        crate::store::mutation::finish_rules(&context)?;
        let result = MaintenanceResult {
            materialized: total,
            changes: context.journal.changes().len(),
            budget_reached: total == 100,
        };
        context.persist(None)?;
        Ok(result)
    }
}

pub(super) fn availability_due(bound: &mut AccountTransaction<'_>) -> Result<bool> {
    let now = crate::clock::now();
    let rows = bound.tx.query_typed(
        "SELECT document::jsonb->>'not_before' FROM gtd.tasks WHERE account_id=$1
        AND entity_type='task' AND document::jsonb->>'status'='blocked'
        AND COALESCE((document::jsonb->>'manual_block')::boolean,false)=false
        AND COALESCE((document::jsonb->>'deleted')::boolean,false)=false
        AND COALESCE((document::jsonb->>'archived')::boolean,false)=false
        AND COALESCE((document::jsonb #>> '{occurrence,skipped}')::boolean,false)=false
        AND document::jsonb->>'not_before' IS NOT NULL",
        &[(&bound.account.id, Type::UUID)],
    )?;
    for row in rows {
        let moment: crate::planning::Moment = serde_json::from_str(&row.get::<_, String>(0))?;
        if moment.bound(false).map_err(StoreError::Invalid)? <= now {
            return Ok(true);
        }
    }
    Ok(false)
}
