//! Native PostgreSQL list/history reads. All selectors are subordinate to the
//! trusted account transaction; no account IDs are accepted in API arguments.
use super::{read_snapshot::Snapshot, *};
use crate::{
    model::*,
    projection,
    store::{
        StoreError,
        reads::{query_key, validate_query},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Cursor {
    pub(super) version: u8,
    pub(super) compatibility: i32,
    pub(super) account: Uuid,
    pub(super) identity: Uuid,
    pub(super) store: Uuid,
    pub(super) environment: String,
    pub(super) audience: bool,
    pub(super) phase: String,
    pub(super) query: Value,
    pub high: i64,
    pub(super) anchor: String,
    pub position: u64,
    pub evaluated_at: String,
    pub timezone: String,
}
impl Cursor {
    pub fn encode(&self) -> Result<String> {
        Ok(serde_json::to_vec(self)?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    }
    pub(super) fn decode(value: &str) -> Result<Self> {
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

pub(super) fn limit(value: Option<u32>, default: u32) -> Result<usize> {
    let value = value.unwrap_or(default);
    if !(1..=100).contains(&value) {
        return Err(Error::PageSize);
    }
    Ok(value as usize)
}
impl Store {
    pub fn home_view(
        &self,
        principal: &Principal,
        request: crate::view::ViewRequest,
    ) -> Result<Value> {
        self.read_current(principal, |tx| tx.read_home(request))
    }
    pub fn list(&self, principal: &Principal, input: ListItems) -> Result<ListResult> {
        self.list_with(principal, input, false, |_, _, _, page| Ok(page))
    }
    pub(super) fn list_with<T>(
        &self,
        principal: &Principal,
        input: ListItems,
        composed: bool,
        finish: impl FnOnce(&mut AccountTransaction<'_>, &Cursor, &Snapshot, ListResult) -> Result<T>,
    ) -> Result<T> {
        if input.cursor.is_none() && input.query.as_deref().is_none_or(|q| q.trim().is_empty()) {
            return self.read_current(principal, |tx| {
                tx.read_tasks_with(input, None, composed, finish)
            });
        }
        if input.cursor.is_none() {
            self.settle_availability(principal)?;
        }
        let search_high = if input.cursor.is_none() {
            input
                .query
                .as_deref()
                .filter(|q| !q.trim().is_empty())
                .map(|q| self.prepare_search(principal, q))
                .transpose()?
        } else {
            None
        };
        self.read(principal, |tx| {
            tx.read_tasks_with(input, search_high, composed, finish)
        })
    }
    pub fn projects(&self, principal: &Principal, input: ListProjects) -> Result<Value> {
        self.projects_with(principal, input, |_, _, _, page| Ok(page))
    }
    pub(super) fn projects_with<T>(
        &self,
        principal: &Principal,
        input: ListProjects,
        finish: impl FnOnce(&mut AccountTransaction<'_>, &Cursor, &Snapshot, Value) -> Result<T>,
    ) -> Result<T> {
        if input.cursor.is_none() && input.query.as_deref().is_none_or(|q| q.trim().is_empty()) {
            return self.read_current(principal, |tx| tx.read_projects_with(input, None, finish));
        }
        if input.cursor.is_none() {
            self.settle_availability(principal)?;
        }
        let search_high = if input.cursor.is_none() {
            input
                .query
                .as_deref()
                .filter(|q| !q.trim().is_empty())
                .map(|q| self.prepare_search(principal, q))
                .transpose()?
        } else {
            None
        };
        self.read(principal, |tx| {
            tx.read_projects_with(input, search_high, finish)
        })
    }
    pub fn changes(&self, principal: &Principal, input: ListChanges) -> Result<ChangesResult> {
        self.read(principal, |tx| tx.read_changes(input))
    }
}
impl AccountTransaction<'_> {
    pub(super) fn read_home(&mut self, request: crate::view::ViewRequest) -> Result<Value> {
        self.read_home_with_budget(request, usize::MAX)
    }

    pub(super) fn read_home_with_budget(
        &mut self,
        request: crate::view::ViewRequest,
        budget: usize,
    ) -> Result<Value> {
        let base = self.list_cursor(None, "home", Value::Null, false, 0)?;
        let snapshot = Snapshot::load(self, base.high, base.evaluated_at.clone())?;
        self.home_from_snapshot(request, budget, base, &snapshot)
    }

    pub(super) fn home_from_snapshot(
        &mut self,
        request: crate::view::ViewRequest,
        mut budget: usize,
        base: Cursor,
        snapshot: &Snapshot,
    ) -> Result<Value> {
        use crate::view::{LoadingPolicy, task_list};
        crate::planning::date(&request.review_on).map_err(StoreError::Invalid)?;
        let mut sections = serde_json::Map::new();
        let mut empty = true;
        for (name, status, max) in [
            ("next", Some(Status::Next), 7),
            ("waiting", Some(Status::Waiting), 4),
            ("someday", Some(Status::Someday), 4),
            ("reviewTasks", None, 4),
        ] {
            let input = ListItems {
                status,
                group_recurrences: true,
                limit: Some(max),
                review_on: if name == "reviewTasks" {
                    Some(request.review_on.clone())
                } else {
                    None
                },
                ..Default::default()
            };
            let cursor = Cursor {
                phase: "tasks".into(),
                query: query_key(&input)?,
                ..base.clone()
            };
            let page = self.task_page(input.clone(), max as usize, 50, cursor, snapshot)?;
            empty &= page.items.is_empty();
            let mut output = task_list(&page, &input);
            if name == "next" {
                let preload = match request.loading {
                    LoadingPolicy::Featured => 1,
                    LoadingPolicy::TopThree => 3,
                    _ => 0,
                };
                for (i, task) in page.items.iter().take(preload).enumerate() {
                    let mut full = projection::page_record(task, Detail::Full, false);
                    full["blocking_count"] = output["items"][i]["blocking_count"].clone();
                    let added = serde_json::to_vec(&full)?
                        .len()
                        .saturating_sub(serde_json::to_vec(&output["items"][i])?.len());
                    if added > budget {
                        break;
                    }
                    output["items"][i] = full;
                    budget -= added;
                }
            }
            sections.insert(name.into(), output);
        }
        let mut remaining = Value::Null;
        if empty {
            let input = ListItems {
                view: Some(TaskView::All),
                archived: Some(false),
                exclude_statuses: Some(vec![Status::Done]),
                limit: Some(1),
                ..Default::default()
            };
            remaining = json!(
                snapshot
                    .select(&input, EntityType::Task)
                    .first()
                    .map(|(n, _)| n.task.status)
            );
        }
        let input = ListProjects {
            review_on: Some(request.review_on),
            limit: Some(4),
            ..Default::default()
        };
        let cursor = Cursor {
            phase: "projects".into(),
            query: query_key(&input)?,
            ..base
        };
        let projects = self.project_page(input, Detail::Summary, 4, cursor, snapshot)?;
        if projects["projects"]
            .as_array()
            .is_some_and(|p| !p.is_empty())
        {
            remaining = Value::Null;
        }
        sections.insert("reviewProjects".into(), projects);
        sections.insert("remaining".into(), remaining);
        let value = json!({"view":"home","data":sections,"revision":snapshot.high,"evaluated_at":snapshot.evaluated_at,"loading":request.loading,"environment":self.environment.as_str(),"response_version":1});
        if serde_json::to_vec(&value)?.len() > 6 * projection::PAGE_BYTES {
            return Err(
                StoreError::Invalid("Composed view exceeds its response budget".into()).into(),
            );
        }
        Ok(value)
    }

    fn list_anchor(&mut self, high: i64) -> Result<String> {
        if high == 0 {
            return Ok(self.identity.to_string());
        }
        self.tx
            .query_typed_opt(
                "SELECT token FROM gtd.changes WHERE account_id=$1 AND id=$2",
                &[(&self.account.id, Type::UUID), (&high, Type::INT8)],
            )?
            .map(|r| r.get(0))
            .ok_or(Error::ResetRequired)
    }
    pub(super) fn list_cursor(
        &mut self,
        encoded: Option<&str>,
        phase: &str,
        query: Value,
        audience: bool,
        offset: u32,
    ) -> Result<Cursor> {
        if let Some(encoded) = encoded {
            let c = Cursor::decode(encoded)?;
            if c.version != 3
                || c.compatibility != COMPATIBILITY
                || c.account != self.account.id
                || c.identity != self.identity
                || c.store != self.store_identity
                || c.environment != self.environment.as_str()
                || c.audience != audience
                || c.phase != phase
                || c.query != query
                || offset != 0
                || c.high < 0
                || c.high > self.high
                || c.position > i64::MAX as u64
                || c.anchor != self.list_anchor(c.high)?
                || chrono::DateTime::parse_from_rfc3339(&c.evaluated_at).is_err()
            {
                return Err(Error::ResetRequired);
            }
            Ok(c)
        } else {
            Ok(Cursor {
                version: 3,
                compatibility: COMPATIBILITY,
                account: self.account.id,
                identity: self.identity,
                store: self.store_identity,
                environment: self.environment.as_str().into(),
                audience,
                phase: phase.into(),
                query,
                high: self.high,
                anchor: self.list_anchor(self.high)?,
                position: u64::from(offset),
                evaluated_at: crate::clock::timestamp(),
                timezone: self.account.timezone.name().into(),
            })
        }
    }
    pub fn read_tasks(&mut self, input: ListItems) -> Result<ListResult> {
        self.read_tasks_with(input, None, false, |_, _, _, page| Ok(page))
    }
    fn read_tasks_with<T>(
        &mut self,
        mut input: ListItems,
        search_high: Option<i64>,
        composed: bool,
        finish: impl FnOnce(&mut Self, &Cursor, &Snapshot, ListResult) -> Result<T>,
    ) -> Result<T> {
        // The audience is supplied by trusted routing, not the legacy inclusion
        // fields. Agent records always carry complete context, even at summary.
        if input.agent_context {
            input.include_agent_notes = true;
            input.detail = Some(Detail::Full)
        }
        validate_query(&input)?;
        let max = limit(input.limit, 20)?;
        let history_max = if input.include_history {
            limit(input.history_limit, 50)?
        } else {
            50
        };
        let mut cursor = self.list_cursor(
            input.cursor.as_deref(),
            "tasks",
            query_key(&input)?,
            input.agent_context,
            input.offset,
        )?;
        if let Some(high) = search_high {
            if high < 0 || high > self.high || input.cursor.is_some() {
                return Err(Error::ResetRequired);
            }
            cursor.high = high;
            cursor.anchor = self.list_anchor(high)?;
        }
        let exact = input.task_id.as_deref().filter(|_| {
            !composed
                && input.cursor.is_none()
                && input.query.as_deref().is_none_or(|q| q.trim().is_empty())
        });
        let snapshot = Snapshot::load_for(self, cursor.high, cursor.evaluated_at.clone(), exact)?;
        let page = self.task_page(input, max, history_max, cursor.clone(), &snapshot)?;
        finish(self, &cursor, &snapshot, page)
    }
    pub(super) fn task_page(
        &mut self,
        input: ListItems,
        max: usize,
        history_max: usize,
        mut cursor: Cursor,
        snapshot: &Snapshot,
    ) -> Result<ListResult> {
        let search = self.search_matches(input.query.as_deref(), snapshot.high)?;
        let candidates = snapshot.select_search(&input, EntityType::Task, search.as_ref());
        let next_change = snapshot.next_change(&input);
        let selected: Vec<_> = candidates
            .into_iter()
            .skip(cursor.position as usize)
            .take(max + 1)
            .collect();
        let ids: Vec<_> = selected.iter().map(|(n, _)| n.task.id.clone()).collect();
        let mut full = snapshot.full(self, &ids)?;
        let mut items = Vec::new();
        let mut bytes = 2048;
        let budget = if input.include_history {
            projection::PAGE_BYTES / 2
        } else {
            projection::PAGE_BYTES
        };
        let mut more = false;
        for (node, count) in selected {
            let mut task = full.remove(&node.task.id).ok_or(Error::Reconciliation)?;
            snapshot.decorate(&mut task, count, &next_change);
            let size = serde_json::to_vec(&projection::page_record_with_agent_notes(
                &task,
                input.effective_detail(),
                input.task_id.is_some(),
                input.include_agent_notes,
            ))?
            .len()
                + 1;
            if items.len() == max || (!items.is_empty() && bytes + size > budget) {
                more = true;
                break;
            }
            bytes += size;
            items.push(task);
        }
        cursor.position += items.len() as u64;
        let next_cursor = more.then(|| cursor.encode()).transpose()?;
        let next_offset = more
            .then(|| u32::try_from(cursor.position).map_err(|_| Error::ResetRequired))
            .transpose()?;
        let mut history = Vec::new();
        let mut next_history_after = None;
        if input.include_history && !items.is_empty() {
            let ids: Vec<_> = items.iter().map(|t| t.id.clone()).collect();
            let rows=self.tx.query("SELECT document FROM gtd.changes WHERE account_id=$1 AND id>$2 AND id<=$3 AND task_id=ANY($4) ORDER BY id LIMIT $5",&[&self.account.id,&input.history_after,&snapshot.high,&ids,&((history_max+1)as i64)])?;
            let mut bytes = 1024;
            for r in rows {
                let change: Change = serde_json::from_str(&r.get::<_, String>(0))?;
                let size = serde_json::to_vec(&projection::change(&change, Detail::Summary))?.len();
                if history.len() == history_max
                    || (!history.is_empty() && bytes + size > projection::PAGE_BYTES / 2)
                {
                    next_history_after = Some(
                        history
                            .last()
                            .map_or(input.history_after, |c: &Change| c.id),
                    );
                    break;
                }
                bytes += size;
                history.push(change);
            }
        }
        Ok(ListResult {
            effective_sort: input.effective_sort().into(),
            blocking_counts: if input.agent_context {
                Default::default()
            } else {
                items
                    .iter()
                    .map(|task| {
                        (
                            task.id.clone(),
                            snapshot.blocking_counts.get(&task.id).copied().unwrap_or(0),
                        )
                    })
                    .collect()
            },
            evaluated_at: snapshot.evaluated_at.clone(),
            next_change_at: next_change,
            items,
            next_cursor,
            next_offset,
            history,
            next_history_after,
        })
    }
    pub fn read_projects(&mut self, input: ListProjects) -> Result<Value> {
        self.read_projects_with(input, None, |_, _, _, page| Ok(page))
    }
    fn read_projects_with<T>(
        &mut self,
        mut input: ListProjects,
        search_high: Option<i64>,
        finish: impl FnOnce(&mut Self, &Cursor, &Snapshot, Value) -> Result<T>,
    ) -> Result<T> {
        if input.agent_context {
            input.include_agent_notes = true;
            input.detail = Some(Detail::Full)
        }
        if input.view.is_some() && input.status.is_some() {
            return Err(StoreError::Invalid("Choose view OR status, not both".into()).into());
        }
        let detail = input.detail.unwrap_or(if input.project_id.is_some() {
            Detail::Full
        } else {
            Detail::Summary
        });
        let max = limit(input.limit, 20)?;
        let mut cursor = self.list_cursor(
            input.cursor.as_deref(),
            "projects",
            query_key(&input)?,
            input.agent_context,
            0,
        )?;
        if let Some(high) = search_high {
            if high < 0 || high > self.high || input.cursor.is_some() {
                return Err(Error::ResetRequired);
            }
            cursor.high = high;
            cursor.anchor = self.list_anchor(high)?;
        }
        let snapshot = Snapshot::load(self, cursor.high, cursor.evaluated_at.clone())?;
        let page = self.project_page(input, detail, max, cursor.clone(), &snapshot)?;
        finish(self, &cursor, &snapshot, page)
    }
    pub(super) fn project_page(
        &mut self,
        input: ListProjects,
        detail: Detail,
        max: usize,
        mut cursor: Cursor,
        snapshot: &Snapshot,
    ) -> Result<Value> {
        let exact = input.project_id.is_some();
        let filter = ListItems {
            sort: input.sort,
            query: input.query,
            task_id: input.project_id,
            status: input.status.map(Into::into).or(
                if input.view == Some(TaskView::Active)
                    || (!exact
                        && input.view != Some(TaskView::All)
                        && input.archived != Some(true)
                        && input.review_on.is_none())
                {
                    Some(Status::Active)
                } else {
                    None
                },
            ),
            view: if input.view == Some(TaskView::All) {
                input.view
            } else {
                None
            },
            archived: input.archived,
            include_deleted: input.include_deleted,
            review_on: input.review_on,
            review_from: input.review_from,
            review_through: input.review_through,
            detail: Some(detail),
            ..Default::default()
        };
        validate_query(&filter)?;
        let search = self.search_matches(filter.query.as_deref(), snapshot.high)?;
        let selected: Vec<_> = snapshot
            .select_search(&filter, EntityType::Project, search.as_ref())
            .into_iter()
            .skip(cursor.position as usize)
            .take(max + 1)
            .collect();
        let ids: Vec<_> = selected.iter().map(|(n, _)| n.task.id.clone()).collect();
        let mut full = snapshot.full(self, &ids)?;
        let mut counts = BTreeMap::<String, BTreeMap<String, i64>>::new();
        for n in &snapshot.nodes {
            let task = &n.task;
            if task.entity_type != EntityType::Task || task.deleted {
                continue;
            }
            if let Some(project) = &task.project_id {
                let bucket = if task.archived {
                    "archived".to_string()
                } else {
                    serde_json::to_value(task.status)?
                        .as_str()
                        .unwrap()
                        .to_string()
                };
                *counts
                    .entry(project.clone())
                    .or_default()
                    .entry(bucket)
                    .or_default() += 1;
            }
        }
        let mut projects = Vec::new();
        let mut bytes = 2048;
        let mut more = false;
        for (n, _) in selected {
            let task = full.remove(&n.task.id).ok_or(Error::Reconciliation)?;
            let mut v = projection::page_record_with_agent_notes(
                &task,
                detail,
                exact,
                input.include_agent_notes,
            );
            let counts = counts.remove(&task.id).unwrap_or_default();
            v["needs_next_action"] = json!(
                task.status == Status::Active
                    && !task.archived
                    && counts.get("next").copied().unwrap_or(0) == 0
                    && counts.get("waiting").copied().unwrap_or(0) == 0
            );
            v["task_counts"] = json!(counts);
            let size = serde_json::to_vec(&v)?.len() + 1;
            if projects.len() == max
                || (!projects.is_empty() && bytes + size > projection::PAGE_BYTES)
            {
                more = true;
                break;
            }
            bytes += size;
            projects.push(v);
        }
        cursor.position += projects.len() as u64;
        let next = more.then(|| cursor.encode()).transpose()?;
        Ok(
            json!({"projects":projects,"next_cursor":next,"detail":detail,"complete":!more,"response_version":2}),
        )
    }
    pub fn read_changes(&mut self, input: ListChanges) -> Result<ChangesResult> {
        self.activity_changes(input)
    }
}
