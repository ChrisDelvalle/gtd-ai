//! SQLite adapter for the shared mutation journal, retained during the port.
use super::*;
use mutation::{Journal, Mutation, RecordRead};
use std::ops::Deref;

pub(super) struct WriteTransaction<'a> {
    tx: Transaction<'a>,
    policy: content::Policy,
    journal: Journal,
}
impl<'a> Deref for WriteTransaction<'a> {
    type Target = Transaction<'a>;
    fn deref(&self) -> &Self::Target {
        &self.tx
    }
}
impl<'a> WriteTransaction<'a> {
    pub fn with_policy(tx: Transaction<'a>, policy: content::Policy) -> Result<Self> {
        let base = tx.query_row("SELECT COALESCE(MAX(id),0) FROM changes", [], |r| r.get(0))?;
        Ok(Self {
            tx,
            policy,
            journal: Journal::new(base),
        })
    }
    pub fn finish(&self) -> Result<()> {
        mutation::finish_rules(self)?;
        for (change, batch) in self.journal.entries() {
            self.execute("INSERT INTO changes(id,task_id,document,entity_type,batch_id,token) VALUES(?1,?2,?3,?4,?5,?6)",params![change.id,change.task_id,serde_json::to_string(&change)?,entity_name(change.entity_type),batch,Uuid::new_v4().to_string()])?;
            self.execute(
                "INSERT INTO revisions(seq,entity_id,entity_type,document) VALUES(?1,?2,?3,?4)",
                params![
                    change.id,
                    change.task_id,
                    entity_name(change.entity_type),
                    serde_json::to_string(&change.after)?
                ],
            )?;
        }
        for (id, group) in self.journal.groups() {
            self.execute(
                "INSERT INTO action_groups VALUES(?1,?2)",
                params![id, group],
            )?;
        }
        Ok(())
    }
    pub fn receipt<T: Serialize + DeserializeOwned>(&self, result: T) -> Result<T> {
        self.journal.receipt(result)
    }
    pub fn commit(self) -> Result<()> {
        self.tx.commit()?;
        Ok(())
    }
}
impl RecordRead for WriteTransaction<'_> {
    fn load_record(&self, id: &str) -> Result<Task> {
        self.tx.load_record(id)
    }
    fn occurrences(&self, id: &str) -> Result<Vec<Task>> {
        self.tx.occurrences(id)
    }
    fn archive_status(&self, task: &Task) -> Result<Option<Status>> {
        self.tx.archive_status(task)
    }
}
impl Mutation for WriteTransaction<'_> {
    fn policy(&self) -> content::Policy {
        self.policy
    }
    fn journal(&self) -> &Journal {
        &self.journal
    }
    fn write_current(&self, task: &Task) -> Result<()> {
        self.execute("INSERT INTO tasks(id,document) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET document=excluded.document",params![task.id,serde_json::to_string(task)?])?;
        Ok(())
    }
    fn all_records(&self) -> Result<Vec<Task>> {
        self.prepare("SELECT document FROM tasks ORDER BY id")?
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    fn undo_group(&self, id: i64) -> Result<(bool, Vec<Change>)> {
        let group: Option<String> = self
            .query_row(
                "SELECT group_id FROM action_groups WHERE change_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let changes=self.prepare("SELECT document FROM changes WHERE id=?1 OR id IN (SELECT change_id FROM action_groups WHERE group_id=?2) ORDER BY id")?
            .query_map(params![id,group],|r|r.get::<_,String>(0))?.map(|r|Ok(serde_json::from_str(&r?)?)).collect::<Result<_>>()?;
        Ok((group.is_some(), changes))
    }
}
