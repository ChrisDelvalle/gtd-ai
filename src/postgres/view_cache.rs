//! Opaque refresh hints. Keep only view identity and validity, never record bodies.
use super::*;
use crate::{
    store::StoreError,
    view::{LoadingPolicy, SnapshotQuery, SnapshotRequest, View, ViewRequest},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, time::Instant};

const TOKEN_LIMIT: usize = 128;
const TOKEN_LIFETIME: Duration = Duration::from_secs(300);
const HOME_DETAIL_BYTES: usize = 32 * 1024;
const HOME_SEED_BYTES: usize = 64 * 1024;
const MIN_REUSABLE_NOTE_BYTES: usize = 256;
type NoteDigests = Vec<(String, [u8; 32])>;

#[derive(PartialEq, Eq)]
struct Scope {
    account: Uuid,
    history: Uuid,
    database: Uuid,
    environment: Environment,
    timezone: chrono_tz::Tz,
    query: [u8; 32],
}

struct Token {
    scope: Scope,
    revision: i64,
    evaluated_at: DateTime<Utc>,
    day: NaiveDate,
    next_change: Option<DateTime<Utc>>,
    created: Instant,
    home_notes: NoteDigests,
}

#[derive(Default)]
pub(super) struct Tokens(VecDeque<(Uuid, Token)>);

impl Token {
    fn matches(&self, scope: &Scope, revision: i64, now: DateTime<Utc>) -> bool {
        self.scope == *scope
            && self.revision == revision
            && self.created.elapsed() < TOKEN_LIFETIME
            && self.evaluated_at <= now
            && self.day == now.with_timezone(&scope.timezone).date_naive()
            && self.next_change.is_none_or(|at| now < at)
    }
}

impl Store {
    pub(super) fn view_snapshot(
        &self,
        principal: &Principal,
        request: SnapshotRequest,
    ) -> Result<Value> {
        validate(&request.query)?;
        if matches!(request.query, SnapshotQuery::Charts(_)) {
            self.read(principal, |tx| self.snapshot(tx, request))
        } else {
            self.read_current(principal, |tx| self.snapshot(tx, request))
        }
    }

    /// A display tool is read-only. If a timed hold needs settling, leave that
    /// to the existing authenticated Home read instead of doing it at launch.
    pub(crate) fn widget_home_seed(&self, principal: &Principal) -> Result<Option<Value>> {
        self.read(principal, |tx| {
            if writes::availability_due(tx)? {
                return Ok(None);
            }
            let review_on = crate::clock::now()
                .with_timezone(&tx.account.timezone)
                .date_naive()
                .to_string();
            let mut response = self.snapshot(
                tx,
                SnapshotRequest {
                    query: SnapshotQuery::Home(ViewRequest {
                        view: View::Home,
                        review_on: review_on.clone(),
                        loading: LoadingPolicy::TopThree,
                    }),
                    token: None,
                    reuse_home_notes: false,
                    sparse_chart: false,
                },
            )?;
            response["review_on"] = json!(review_on);
            Ok((serde_json::to_vec(&response)?.len() <= HOME_SEED_BYTES).then_some(response))
        })
    }

    fn snapshot(&self, tx: &mut AccountTransaction<'_>, request: SnapshotRequest) -> Result<Value> {
        let scope = Scope {
            account: tx.account.id,
            history: tx.identity,
            database: tx.store_identity,
            environment: tx.environment,
            timezone: tx.account.timezone,
            query: Sha256::digest(serde_json::to_vec(&request.query)?).into(),
        };
        let now = crate::clock::now();
        let prior_id = request
            .token
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok());
        let mut prior_notes = Vec::new();
        if let Some(id) = prior_id
            && let Ok(tokens) = self.view_tokens.lock()
            && let Some((_, entry)) = tokens.0.iter().find(|(key, _)| *key == id)
        {
            if entry.matches(&scope, tx.high, now) {
                return Ok(json!({"kind":"unchanged","token":id}));
            }
            if request.reuse_home_notes
                && entry.scope == scope
                && entry.created.elapsed() < TOKEN_LIFETIME
            {
                prior_notes = entry.home_notes.clone();
            }
        }

        let home = matches!(request.query, SnapshotQuery::Home(_));
        let sparse_chart =
            request.sparse_chart && matches!(request.query, SnapshotQuery::Charts(_));
        let mut data = match request.query {
            SnapshotQuery::Home(query) => {
                tx.read_home_with_budget(query, HOME_DETAIL_BYTES)?["data"].take()
            }
            SnapshotQuery::Tasks(query) => {
                crate::view::task_list(&tx.read_tasks((*query).clone())?, &query)
            }
            SnapshotQuery::Charts(query) => {
                let mut chart = tx.chart(query, false)?;
                let cursor = super::reads::Cursor::decode(
                    chart["snapshot"].as_str().ok_or(Error::Reconciliation)?,
                )?;
                let snapshot = super::read_snapshot::Snapshot::load(
                    tx,
                    cursor.high,
                    cursor.evaluated_at.clone(),
                )?;
                tx.attach_priority_chart(&cursor, &snapshot, &mut chart)?;
                chart
            }
        };
        let mut home_notes = Vec::new();
        let mut reused_notes = Vec::new();
        if home && let Some(items) = data["next"]["items"].as_array_mut() {
            for row in items.iter_mut().take(3) {
                let (Some(id), Some(notes)) = (row["id"].as_str(), row["notes"].as_str()) else {
                    continue;
                };
                if notes.len() < MIN_REUSABLE_NOTE_BYTES {
                    continue;
                }
                let digest = (id.to_owned(), Sha256::digest(notes).into());
                if prior_notes.contains(&digest) {
                    row.as_object_mut().unwrap().remove("notes");
                    reused_notes.push(digest.0.clone());
                }
                home_notes.push(digest);
            }
        }
        let next_change = std::iter::once(&data["next_change_at"])
            .chain(std::iter::once(&data["priorities"]["next_change_at"]))
            .chain(
                ["next", "waiting", "someday", "reviewTasks"]
                    .map(|key| &data[key]["next_change_at"]),
            )
            .filter_map(Value::as_str)
            .map(DateTime::parse_from_rfc3339)
            .collect::<std::result::Result<Vec<_>, _>>();
        let mut id = None;
        if let (Ok(boundaries), Ok(mut tokens)) = (next_change, self.view_tokens.lock()) {
            let key = Uuid::new_v4();
            tokens
                .0
                .retain(|(_, value)| value.created.elapsed() < TOKEN_LIFETIME);
            if tokens.0.len() >= TOKEN_LIMIT {
                tokens.0.pop_front();
            }
            tokens.0.push_back((
                key,
                Token {
                    revision: tx.high,
                    evaluated_at: now,
                    day: now.with_timezone(&scope.timezone).date_naive(),
                    scope,
                    next_change: boundaries
                        .into_iter()
                        .min()
                        .map(|at| at.with_timezone(&Utc)),
                    created: Instant::now(),
                    home_notes,
                },
            ));
            id = Some(key);
        }
        let sparse_today = sparse_chart
            .then(|| omit_empty_chart_days(&mut data, tx.account.timezone))
            .flatten();
        let mut result = json!({"kind":"full","token":id,"data":data});
        if home {
            result["home_notes_reusable"] = json!(true);
            if !reused_notes.is_empty() {
                result["reused_home_notes"] = json!(reused_notes);
            }
        }
        if let Some(day) = sparse_today {
            result["chart_today"] = json!(day);
        }
        Ok(result)
    }
}

pub(super) fn omit_empty_chart_days(
    data: &mut Value,
    timezone: chrono_tz::Tz,
) -> Option<NaiveDate> {
    let today = DateTime::parse_from_rfc3339(data["window"]["evaluated_at"].as_str()?)
        .ok()?
        .with_timezone(&timezone)
        .date_naive();
    let days = data["days"].as_array_mut()?;
    let kept = |day: &Value| {
        day["partial"] == true
            || day["count"].as_u64().unwrap_or_default() > 0
            || day["categories"]
                .as_object()
                .is_some_and(|counts| !counts.is_empty())
    };
    if days.iter().filter(|day| !kept(day)).take(32).count() < 32 {
        return None;
    }
    days.retain(kept);
    Some(today)
}

fn validate(query: &SnapshotQuery) -> Result<()> {
    match query {
        SnapshotQuery::Tasks(q)
            if q.cursor.is_some()
                || q.offset != 0
                || q.query.is_some()
                || q.include_history
                || q.include_agent_notes
                || q.task_id.is_some()
                || q.task_ids.is_some() =>
        {
            Err(
                StoreError::Invalid("View snapshots require an unsearched first task page".into())
                    .into(),
            )
        }
        SnapshotQuery::Charts(q) if q.snapshot.is_some() || q.limit.is_some() => {
            Err(StoreError::Invalid("View snapshots require a new chart window".into()).into())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postgres::{
        tests::{fixture, principal},
        write_tests::{capture, patch, run},
    };

    #[test]
    #[ignore = "Requires the isolated PostgreSQL fixture"]
    fn snapshot_refresh_validates_scope_revision_and_expiration() {
        let (_container, mut admin, config, _, _) = fixture();
        admin
            .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
            .unwrap();
        let store = Store::connect(config.clone(), Environment::Staging, 2).unwrap();
        let initial = run(&store, "a", "capture", capture("snapshot-first"));
        let request = |token: Option<String>, status: &str| SnapshotRequest {
            query: SnapshotQuery::Tasks(Box::new(
                serde_json::from_value(json!({"status":status})).unwrap(),
            )),
            token,
            reuse_home_notes: false,
            sparse_chart: false,
        };
        let a = principal("a");
        let b = principal("b");
        let full = store.view_snapshot(&a, request(None, "next")).unwrap();
        assert_eq!(full["kind"], "full");
        let token = full["token"].as_str().unwrap().to_owned();
        let refresh = |who, status| {
            store
                .view_snapshot(who, request(Some(token.clone()), status))
                .unwrap()
        };
        assert_eq!(refresh(&a, "next")["kind"], "unchanged");
        let restarted = Store::connect(config, Environment::Staging, 2).unwrap();
        assert_eq!(
            restarted
                .view_snapshot(&a, request(Some(token.clone()), "next"))
                .unwrap()["kind"],
            "full"
        );
        assert_eq!(refresh(&a, "waiting")["kind"], "full");
        let other = refresh(&b, "next");
        assert_eq!(other["kind"], "full");
        assert_eq!(other["data"]["items"], json!([]));
        {
            let mut entries = store.view_tokens.lock().unwrap();
            entries.0.front_mut().unwrap().1.next_change = Some(crate::clock::now());
        }
        assert_eq!(refresh(&a, "next")["kind"], "full");
        let replacement = store.view_snapshot(&a, request(None, "next")).unwrap();
        let replacement = replacement["token"].as_str().unwrap().to_owned();
        run(
            &store,
            "a",
            "update",
            patch(&initial.task, "snapshot-edit", json!({"status":"waiting"})),
        );
        assert_eq!(
            store
                .view_snapshot(&a, request(Some(replacement), "next"))
                .unwrap()["data"]["items"],
            json!([])
        );
        assert!(store.execute_tool(&a, "view_snapshot", json!({})).is_err());
    }
}
