//! Account-bound snapshot/delta storage primitive. The application must settle
//! availability before beginning an initial read, as it does on the old backend.
//! No live endpoint uses this module until the business-operation port is ready.
use super::*;
use crate::{
    model::{Change, Detail, SyncState, Task},
    projection,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    compatibility: i32,
    account: Uuid,
    identity: Uuid,
    store: Uuid,
    environment: String,
    agent_context: bool,
    phase: Phase,
    high: i64,
    position: i64,
    anchor: String,
    evaluated_at: String,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Snapshot,
    Changes,
    Checkpoint,
}

impl Cursor {
    fn encode(&self) -> Result<String> {
        Ok(serde_json::to_vec(self)?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    }
    fn decode(value: &str) -> Result<Self> {
        if value.len() > 20_000
            || !value.len().is_multiple_of(2)
            || !value.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(Error::ResetRequired);
        }
        let bytes = (0..value.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| Error::ResetRequired))
            .collect::<Result<Vec<_>>>()?;
        serde_json::from_slice(&bytes).map_err(|_| Error::ResetRequired)
    }
}

impl AccountTransaction<'_> {
    fn sync_anchor(&mut self, high: i64) -> Result<String> {
        if high == 0 {
            return Ok(self.identity().to_string());
        }
        self.tx
            .query_opt(
                "SELECT token FROM gtd.changes WHERE account_id=$1 AND id=$2",
                &[&self.account().id(), &high],
            )?
            .map(|r| r.get(0))
            .ok_or(Error::ResetRequired)
    }
    fn sync_cursor(&mut self, agent_context: bool) -> Result<Cursor> {
        Ok(Cursor {
            version: 2,
            compatibility: COMPATIBILITY,
            account: self.account().id(),
            identity: self.identity(),
            store: self.store_identity,
            environment: self.environment.as_str().into(),
            agent_context,
            phase: Phase::Snapshot,
            high: self.high(),
            position: 0,
            anchor: self.sync_anchor(self.high())?,
            evaluated_at: crate::clock::timestamp(),
        })
    }

    /// Read a complete-context agent page or a separate lightweight UI page.
    /// `agent_context` comes from trusted transport routing, never a tool argument.
    /// Cursors bind the audience, account, environment, database and history.
    pub fn read_sync_page(&mut self, input: &SyncState) -> Result<Value> {
        let limit = i64::from(input.limit.unwrap_or(20));
        if !(1..=100).contains(&limit) {
            return Err(Error::PageSize);
        }
        let mut cursor = match input.cursor.as_deref() {
            None => self.sync_cursor(input.agent_context)?,
            Some(value) => {
                let cursor = Cursor::decode(value)?;
                if cursor.version != 2
                    || cursor.compatibility != COMPATIBILITY
                    || cursor.account != self.account().id()
                    || cursor.identity != self.identity()
                    || cursor.store != self.store_identity
                    || cursor.environment != self.environment.as_str()
                    || cursor.agent_context != input.agent_context
                    || cursor.high < 0
                    || cursor.high > self.high()
                    || cursor.position < 0
                    || cursor.anchor != self.sync_anchor(cursor.high)?
                    || chrono::DateTime::parse_from_rfc3339(&cursor.evaluated_at).is_err()
                {
                    return Err(Error::ResetRequired);
                }
                cursor
            }
        };
        if cursor.phase == Phase::Checkpoint {
            if cursor.position != cursor.high {
                return Err(Error::ResetRequired);
            }
            let position = cursor.high;
            cursor = self.sync_cursor(input.agent_context)?;
            cursor.phase = Phase::Changes;
            cursor.position = position;
        }
        let account = self.account().id();
        let mut records = Vec::new();
        let mut changes = Vec::new();
        let mut bytes = 2048;
        let mut more = false;
        match cursor.phase {
            Phase::Snapshot => {
                let rows = self.tx.query("WITH latest AS (
                    SELECT DISTINCT ON (entity_id) entity_id,entity_type,document
                    FROM gtd.revisions WHERE account_id=$1 AND seq<=$2 ORDER BY entity_id,seq DESC)
                    SELECT document FROM latest WHERE COALESCE((document::jsonb->>'deleted')::boolean,false)=false
                    ORDER BY entity_type COLLATE \"C\",entity_id COLLATE \"C\" LIMIT $3 OFFSET $4",
                    &[&account, &cursor.high, &(limit+1), &cursor.position])?;
                for row in rows {
                    let task: Task = serde_json::from_str(&row.get::<_, String>(0))?;
                    let value = if input.agent_context {
                        projection::agent_record_at(&task, &cursor.evaluated_at)
                    } else {
                        projection::record(&task, Detail::Summary)
                    };
                    let size = serde_json::to_vec(&value)?.len();
                    if records.len() >= limit as usize
                        || (!records.is_empty() && bytes + size > projection::PAGE_BYTES)
                    {
                        more = true;
                        break;
                    }
                    bytes += size;
                    records.push(value);
                    cursor.position += 1;
                }
            }
            Phase::Changes => {
                if cursor.position > cursor.high {
                    return Err(Error::ResetRequired);
                }
                let rows = self.tx.query("SELECT c.document,c.batch_id,
                    NOT EXISTS (SELECT 1 FROM gtd.changes n WHERE n.account_id=$1 AND n.id>c.id AND n.id<=$3 AND n.batch_id=c.batch_id) AS transaction_end
                    FROM gtd.changes c WHERE c.account_id=$1 AND c.id>$2 AND c.id<=$3 ORDER BY c.id LIMIT $4",
                    &[&account, &cursor.position, &cursor.high, &(limit+1)])?;
                for row in rows {
                    let change: Change = serde_json::from_str(&row.get::<_, String>(0))?;
                    let mut value = projection::change(&change, Detail::Summary);
                    if input.agent_context {
                        value["after"] =
                            projection::agent_record_at(&change.after, &cursor.evaluated_at);
                    }
                    value["transaction_id"] = json!(row.get::<_, Option<String>>(1));
                    value["transaction_end"] = json!(row.get::<_, bool>(2));
                    let size = serde_json::to_vec(&value)?.len();
                    if changes.len() >= limit as usize
                        || (!changes.is_empty() && bytes + size > projection::PAGE_BYTES)
                    {
                        more = true;
                        break;
                    }
                    bytes += size;
                    cursor.position = change.id;
                    changes.push(value);
                }
            }
            Phase::Checkpoint => unreachable!("checkpoint becomes changes above"),
        }
        let phase = json!(cursor.phase);
        let evaluated_at = cursor.evaluated_at.clone();
        let (next, checkpoint) = if more {
            (Some(cursor.encode()?), None)
        } else {
            cursor.phase = Phase::Checkpoint;
            cursor.position = cursor.high;
            (None, Some(cursor.encode()?))
        };
        Ok(
            json!({"phase":phase,"records":records,"changes":changes,"next_cursor":next,
            "checkpoint":checkpoint,"complete":!more,"response_version":2,"evaluated_at":evaluated_at}),
        )
    }
}
