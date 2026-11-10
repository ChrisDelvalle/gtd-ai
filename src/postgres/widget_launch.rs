//! Authenticated widget data. The shared HTML and model-facing result never
//! include this projection. Each bundle is built inside one account snapshot.
use super::{
    application::{parse, show_gtd_input, task_input},
    read_snapshot::Snapshot,
    reads::{Cursor, limit},
    *,
};
use crate::{
    activity::{ChartQuery, Metric, ResultsQuery},
    model::*,
    projection,
    recurrence_model::ListOccurrences,
    store::{StoreError, reads::query_key},
    view::{LoadingPolicy, ViewRequest, task_list},
};
use chrono::{Datelike, Days};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const OPTIONAL_BYTES: usize = 512 * 1024;
// Below the private transport's 4 MiB limit even with the model-facing page.
// The actual host envelope still has to be verified in staging.
const REQUIRED_BYTES: usize = 2 * 1024 * 1024;
const PREVIEW: usize = 2;

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LaunchMode {
    #[default]
    Legacy,
    Requested,
    Full,
    Deferred,
    Nearby,
    Summaries,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct WidgetPagesRequest {
    pub target: Option<WidgetPageQuery>,
    pub exclude: Option<WidgetPageQuery>,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(tag = "operation", content = "arguments", rename_all = "snake_case")]
pub(crate) enum WidgetPageQuery {
    Home(ViewRequest),
    ListItems(Box<ListItems>),
    ListProjects(ListProjects),
}
impl WidgetPageQuery {
    fn key(&self) -> Result<(&'static str, Value)> {
        Ok(match self {
            Self::Home(input) => ("home", json!(input)),
            Self::ListItems(input) => ("list_items", json!(input)),
            Self::ListProjects(input) => ("list_projects", json!(input)),
        })
    }
}

struct Page {
    operation: &'static str,
    arguments: Value,
    data: Value,
    required: bool,
    expansions: bool,
}
impl Page {
    fn new(operation: &'static str, arguments: Value, data: Value, required: bool) -> Self {
        Self {
            operation,
            arguments,
            data,
            required,
            expansions: true,
        }
    }
    fn rows(&mut self) -> impl Iterator<Item = &mut Value> {
        fn list<'a>(value: &'a mut Value, field: &str) -> &'a mut [Value] {
            value
                .get_mut(field)
                .and_then(Value::as_array_mut)
                .map(Vec::as_mut_slice)
                .unwrap_or_default()
        }
        let data = &mut self.data;
        match self.operation {
            "home" => data
                .as_object_mut()
                .into_iter()
                .flatten()
                .flat_map(|(key, value)| {
                    list(
                        value,
                        if key == "reviewProjects" {
                            "projects"
                        } else {
                            "items"
                        },
                    )
                    .iter_mut()
                })
                .collect::<Vec<_>>()
                .into_iter(),
            "list_items" | "list_projects" | "request_results" => {
                let field = match self.operation {
                    "list_items" => "items",
                    "list_projects" => "projects",
                    _ => "records",
                };
                list(data, field).iter_mut().collect::<Vec<_>>().into_iter()
            }
            _ => Vec::new().into_iter(),
        }
    }
}
fn strip_agent(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("agent_notes");
            for child in object.values_mut() {
                strip_agent(child);
            }
        }
        Value::Array(rows) => rows.iter_mut().for_each(strip_agent),
        _ => {}
    }
}
fn ui_cursor(data: &mut Value, key: &str, query: Value) -> Result<()> {
    if let Some(token) = data[key].as_str() {
        let mut cursor = Cursor::decode(token)?;
        cursor.audience = false;
        cursor.query = query;
        data[key] = json!(cursor.encode()?);
    }
    Ok(())
}
fn home_args(day: &str) -> Value {
    json!({"view":"home","review_on":day,"loading":"top-three"})
}
fn account_day(base: &Cursor) -> Result<chrono::NaiveDate> {
    let at = chrono::DateTime::parse_from_rfc3339(&base.evaluated_at)
        .map_err(|_| Error::Reconciliation)?;
    let timezone: chrono_tz::Tz = base.timezone.parse().map_err(|_| Error::Reconciliation)?;
    Ok(at.with_timezone(&timezone).date_naive())
}

impl Store {
    pub(crate) fn widget_display(
        &self,
        principal: &Principal,
        name: &str,
        arguments: Value,
        mode: LaunchMode,
    ) -> Result<(Value, Option<Value>)> {
        if matches!(mode, LaunchMode::Legacy) {
            return self
                .execute_tool(principal, name, arguments)
                .map(|value| (value, None));
        }
        let (mut value, bundle) = match name {
            "show_tasks" => {
                let input = task_input(name, arguments, true)?;
                self.list_with(
                    principal,
                    input.clone(),
                    true,
                    |tx, base, snapshot, page| {
                        let value = task_list(&page, &input);
                        let mut ui = input;
                        ui.include_agent_notes = false;
                        ui.agent_context = false;
                        ui.cursor = None;
                        let mut data = value.clone();
                        strip_agent(&mut data);
                        ui_cursor(&mut data, "next_cursor", query_key(&ui)?)?;
                        let known = page
                            .items
                            .into_iter()
                            .map(|row| (row.id.clone(), row))
                            .collect();
                        let pages = vec![Page::new("list_items", json!(ui), data, true)];
                        let bundle = tx.finish_widget(base, snapshot, pages, known, mode, false)?;
                        Ok((value, bundle))
                    },
                )?
            }
            "show_projects" => {
                let mut input: ListProjects = parse(arguments)?;
                input.agent_context = true;
                input.include_agent_notes = true;
                input.detail = Some(Detail::Full);
                self.projects_with(principal, input.clone(), |tx, base, snapshot, value| {
                    let mut ui = input;
                    ui.agent_context = false;
                    ui.include_agent_notes = false;
                    ui.detail = Some(Detail::Summary);
                    ui.cursor = None;
                    let mut data = value.clone();
                    strip_agent(&mut data);
                    ui_cursor(&mut data, "next_cursor", query_key(&ui)?)?;
                    let mut pages = vec![Page::new("list_projects", json!(ui), data, true)];
                    if let Some(id) = ui.project_id {
                        for (status, archived) in [
                            (Some("next"), false),
                            (Some("waiting"), false),
                            (Some("blocked"), false),
                            (Some("inbox"), false),
                            (Some("someday"), false),
                            (Some("done"), false),
                            (None, true),
                        ] {
                            let args = if let Some(status) = status {
                                json!({"project_id":id,"status":status,"archived":archived})
                            } else {
                                json!({"project_id":id,"archived":archived})
                            };
                            pages.push(tx.widget_task_page(base, snapshot, args, true)?);
                        }
                    }
                    let bundle =
                        tx.finish_widget(base, snapshot, pages, HashMap::new(), mode, false)?;
                    Ok((value, bundle))
                })?
            }
            "show_gtd" => {
                let input = show_gtd_input(arguments)?;
                self.read(principal, |tx| {
                    let mut base = tx.list_cursor(None, "home", Value::Null, false, 0)?;
                    let value = if input.view == GtdView::Results {
                        let query = ResultsQuery {
                            from_request_ids: input.from_request_ids.clone().ok_or_else(|| StoreError::Invalid("Results requires from_request_ids".into()))?,
                            cursor: input.cursor,
                            limit: input.limit,
                            agent_context: true,
                        };
                        let result = tx.results(query)?;
                        base = Cursor::decode(result["snapshot"].as_str().ok_or(Error::Reconciliation)?)?;
                        result
                    } else {
                        json!({"view":input.view,"series_id":input.series_id,"app":"gtd","response_version":2})
                    };
                    let snapshot = Snapshot::load(tx, base.high, base.evaluated_at.clone())?;
                    let pages = if input.view == GtdView::Results {
                        let query = ResultsQuery {
                            from_request_ids: input.from_request_ids.unwrap_or_default(),
                            limit: input.limit,
                            ..Default::default()
                        };
                        let mut data = value.clone();
                        strip_agent(&mut data);
                        let key = query_key(&query)?;
                        ui_cursor(&mut data, "next_cursor", key.clone())?;
                        ui_cursor(&mut data, "snapshot", key)?;
                        vec![Page::new("request_results", json!(query), data, true)]
                    } else {
                        tx.widget_view(&base, &snapshot, input.view, input.series_id, true)?
                    };
                    // Activity, Help and Charts don't depend on persisted readiness.
                    let revalidate = matches!(input.view, GtdView::Home | GtdView::Review)
                        && super::writes::availability_due(tx)?;
                    let bundle = tx.finish_widget(&base, &snapshot, pages, HashMap::new(), mode, revalidate)?;
                    Ok((value, bundle))
                })?
            }
            _ => return Err(Error::Reconciliation),
        };
        value["environment"] = json!(self.environment.as_str());
        Ok((value, Some(bundle)))
    }

    pub(crate) fn widget_pages(
        &self,
        principal: &Principal,
        request: WidgetPagesRequest,
    ) -> Result<Value> {
        // A refresh has the same readiness semantics as the ordinary UI read.
        let read = |tx: &mut AccountTransaction<'_>| {
            let base = tx.list_cursor(None, "home", Value::Null, false, 0)?;
            let snapshot = Snapshot::load(tx, base.high, base.evaluated_at.clone())?;
            let mut pages = Vec::new();
            if let Some(target) = request.target {
                let (operation, args) = target.key()?;
                pages.push(match operation {
                    "home" => tx.widget_home(&base, &snapshot, args, true)?,
                    "list_items" => tx.widget_task_page(&base, &snapshot, args, true)?,
                    _ => tx.widget_project_page(&base, &snapshot, args, true)?,
                });
                tx.finish_widget(
                    &base,
                    &snapshot,
                    pages,
                    HashMap::new(),
                    LaunchMode::Requested,
                    false,
                )
            } else {
                let exclude = request.exclude.map(|value| value.key()).transpose()?;
                pages = tx.widget_defaults(&base, &snapshot, &[], LaunchMode::Full)?;
                if let Some((op, args)) = exclude {
                    pages.retain(|page| page.operation != op || page.arguments != args);
                }
                tx.pack_widget(&base, &snapshot, pages, HashMap::new(), false, false)
            }
        };
        self.read_current(principal, read)
    }
}

impl AccountTransaction<'_> {
    pub(super) fn attach_priority_chart(
        &mut self,
        base: &Cursor,
        snapshot: &Snapshot,
        data: &mut Value,
    ) -> Result<()> {
        data["priorities"] = snapshot.widget_priorities(base)?;
        let projects = self.widget_project_page(
            base,
            snapshot,
            json!({"view":"all","archived":false,"limit":20}),
            false,
        )?;
        data["priority_projects"] = projects.data;
        Ok(())
    }
    fn widget_home(
        &mut self,
        base: &Cursor,
        snapshot: &Snapshot,
        args: Value,
        required: bool,
    ) -> Result<Page> {
        let mut input: ViewRequest = parse(args.clone())?;
        input.loading = LoadingPolicy::OnDemand;
        let mut data = self.home_from_snapshot(input, 0, base.clone(), snapshot)?;
        Ok(Page::new("home", args, data["data"].take(), required))
    }
    fn widget_task_page(
        &mut self,
        base: &Cursor,
        snapshot: &Snapshot,
        args: Value,
        required: bool,
    ) -> Result<Page> {
        let input: ListItems = parse(args.clone())?;
        crate::store::reads::validate_query(&input)?;
        if input.cursor.is_some() || input.query.as_deref().is_some_and(|q| !q.trim().is_empty()) {
            return Err(StoreError::Invalid(
                "Widget page requires a first-page query without search".into(),
            )
            .into());
        }
        let cursor = Cursor {
            phase: "tasks".into(),
            query: query_key(&input)?,
            position: u64::from(input.offset),
            audience: false,
            ..base.clone()
        };
        let page = self.task_page(
            input.clone(),
            limit(input.limit, 20)?,
            limit(input.history_limit, 50)?,
            cursor,
            snapshot,
        )?;
        Ok(Page::new(
            "list_items",
            args,
            task_list(&page, &input),
            required,
        ))
    }
    fn widget_project_page(
        &mut self,
        base: &Cursor,
        snapshot: &Snapshot,
        args: Value,
        required: bool,
    ) -> Result<Page> {
        let input: ListProjects = parse(args.clone())?;
        if input.cursor.is_some() || input.query.as_deref().is_some_and(|q| !q.trim().is_empty()) {
            return Err(StoreError::Invalid(
                "Widget page requires a first-page query without search".into(),
            )
            .into());
        }
        let cursor = Cursor {
            phase: "projects".into(),
            query: query_key(&input)?,
            position: 0,
            audience: false,
            ..base.clone()
        };
        let detail = input.detail.unwrap_or(Detail::Summary);
        let count = limit(input.limit, 20)?;
        let data = self.project_page(input, detail, count, cursor, snapshot)?;
        Ok(Page::new("list_projects", args, data, required))
    }
    fn widget_view(
        &mut self,
        base: &Cursor,
        snapshot: &Snapshot,
        view: GtdView,
        series: Option<String>,
        required: bool,
    ) -> Result<Vec<Page>> {
        let today = account_day(base)?;
        let day = today.to_string();
        Ok(match view {
            GtdView::Home => vec![self.widget_home(base, snapshot, home_args(&day), required)?],
            GtdView::Review => {
                let args = json!({"review_on":day,"detail":"summary"});
                let compact = json!({"review_on":day,"detail":"summary","limit":30});
                vec![
                    self.widget_task_page(base, snapshot, compact.clone(), required)?,
                    self.widget_project_page(base, snapshot, compact, required)?,
                    self.widget_task_page(base, snapshot, args.clone(), required)?,
                    self.widget_project_page(base, snapshot, args, required)?,
                ]
            }
            GtdView::Repeating => {
                let mut pages = vec![Page::new(
                    "list_occurrences",
                    json!({}),
                    self.read_occurrences(ListOccurrences::default())?,
                    required,
                )];
                if let Some(id) = series {
                    let args = json!({"series_id":id,"limit":1});
                    pages.push(Page::new(
                        "list_occurrences",
                        args.clone(),
                        self.read_occurrences(parse(args)?)?,
                        required,
                    ));
                }
                pages
            }
            GtdView::Activity => {
                let changes = self.read_changes(ListChanges {
                    limit: Some(30),
                    ..Default::default()
                })?;
                vec![Page::new(
                    "list_changes",
                    json!({"limit":30}),
                    projection::changes(&changes, Detail::Summary),
                    required,
                )]
            }
            GtdView::Charts => {
                let through =
                    today + Days::new(6 - u64::from(today.weekday().num_days_from_sunday()));
                let from = through - Days::new(52 * 7 - 1);
                let args = json!({"from":from,"through":through,"metric":"changes"});
                let mut data = self.chart(
                    ChartQuery {
                        from: from.to_string(),
                        through: through.to_string(),
                        metric: Metric::Changes,
                        ..Default::default()
                    },
                    false,
                )?;
                let mut completions = self.chart(
                    ChartQuery {
                        from: from.to_string(),
                        through: through.to_string(),
                        metric: Metric::Completed,
                        ..Default::default()
                    },
                    false,
                )?;
                super::view_cache::omit_empty_chart_days(&mut data, self.account.timezone);
                super::view_cache::omit_empty_chart_days(&mut completions, self.account.timezone);
                data["chart_today"] = json!(day);
                data["completions"] = completions;
                self.attach_priority_chart(base, snapshot, &mut data)?;
                vec![Page::new("activity_summary", args, data, required)]
            }
            GtdView::Help | GtdView::Results => vec![],
        })
    }
    fn widget_defaults(
        &mut self,
        base: &Cursor,
        snapshot: &Snapshot,
        existing: &[Page],
        mode: LaunchMode,
    ) -> Result<Vec<Page>> {
        let mut pages = Vec::new();
        for args in [
            json!({"status":"next","group_recurrences":true}),
            json!({"status":"blocked","group_recurrences":true}),
            json!({"status":"inbox","group_recurrences":true}),
            json!({"status":"waiting","group_recurrences":true}),
            json!({"status":"someday","group_recurrences":true}),
            json!({"status":"done","group_recurrences":true}),
            json!({"view":"all","archived":false,"group_recurrences":true}),
            json!({"archived":true,"group_recurrences":true}),
        ] {
            if matches!(mode, LaunchMode::Nearby)
                && !matches!(args["status"].as_str(), Some("next" | "blocked"))
            {
                continue;
            }
            if !existing
                .iter()
                .any(|page| page.operation == "list_items" && page.arguments == args)
            {
                pages.push(self.widget_task_page(base, snapshot, args, false)?);
            }
        }
        if !matches!(mode, LaunchMode::Nearby) {
            pages.push(self.widget_project_page(
                base,
                snapshot,
                json!({"status":"active","archived":false,"detail":"summary"}),
                false,
            )?);
        }
        for view in [
            GtdView::Charts,
            GtdView::Home,
            GtdView::Review,
            GtdView::Repeating,
            GtdView::Activity,
        ] {
            if matches!(mode, LaunchMode::Nearby) && view != GtdView::Charts {
                continue;
            }
            if view == GtdView::Home && existing.iter().any(|page| page.operation == "home") {
                continue;
            }
            for page in self.widget_view(base, snapshot, view, None, false)? {
                if !existing.iter().any(|existing| {
                    existing.operation == page.operation && existing.arguments == page.arguments
                }) {
                    pages.push(page);
                }
            }
        }
        if matches!(mode, LaunchMode::Summaries) {
            for page in &mut pages {
                page.expansions = false;
            }
        }
        Ok(pages)
    }
    fn finish_widget(
        &mut self,
        base: &Cursor,
        snapshot: &Snapshot,
        mut pages: Vec<Page>,
        known: HashMap<String, Task>,
        mode: LaunchMode,
        revalidate: bool,
    ) -> Result<Value> {
        if matches!(
            mode,
            LaunchMode::Full | LaunchMode::Nearby | LaunchMode::Summaries
        ) && base.high == self.high()
        {
            pages.extend(self.widget_defaults(base, snapshot, &pages, mode)?);
        }
        self.pack_widget(
            base,
            snapshot,
            pages,
            known,
            matches!(
                mode,
                LaunchMode::Deferred | LaunchMode::Nearby | LaunchMode::Summaries
            ),
            revalidate,
        )
    }
    fn pack_widget(
        &mut self,
        base: &Cursor,
        snapshot: &Snapshot,
        mut pages: Vec<Page>,
        mut known: HashMap<String, Task>,
        deferred: bool,
        revalidate: bool,
    ) -> Result<Value> {
        let mut ids = HashSet::new();
        for page in pages.iter_mut().filter(|page| page.expansions) {
            for row in page.rows() {
                if let Some(id) = row["id"].as_str() {
                    ids.insert(id.to_owned());
                }
            }
        }
        let mut missing = ids
            .iter()
            .filter(|id| !known.contains_key(*id))
            .cloned()
            .collect::<HashSet<_>>();
        for id in &ids {
            if let Some(occurrence) = snapshot
                .graph
                .tasks
                .get(id)
                .and_then(|task| task.occurrence.as_ref())
            {
                missing.insert(occurrence.series_id.clone());
            }
        }
        known.extend(snapshot.full(self, &missing.into_iter().collect::<Vec<_>>())?);
        let previews = dependency_previews(snapshot, &ids);
        let mut records = Vec::new();
        let mut index = HashMap::<String, usize>::new();
        let mut output = Vec::new();
        let mut bytes = 1024;
        for mut page in pages {
            let mut additional = Vec::new();
            let mut proposed = HashMap::new();
            let expansions = page.expansions;
            for row in page.rows().filter(|_| expansions) {
                let id = row["id"].as_str().ok_or(Error::Reconciliation)?;
                let task = known.get(id).ok_or(Error::Reconciliation)?;
                if row["version"].as_i64() != Some(task.version) {
                    return Err(Error::Reconciliation);
                }
                let position = if let Some(&position) = index.get(id).or_else(|| proposed.get(id)) {
                    position
                } else {
                    let position = records.len() + additional.len();
                    let mut task = task.clone();
                    if task.entity_type == EntityType::Task {
                        snapshot.decorate(&mut task, None, &snapshot.availability);
                    }
                    let mut projected = projection::record(&task, Detail::Full);
                    if task.entity_type == EntityType::Task {
                        projected["widget_preview"] = previews.get(id).cloned().unwrap_or_else(|| json!({"prerequisites":[],"dependents":[],"more":false,"project_title":null}));
                        if let Some(occurrence) = &task.occurrence {
                            let rule = known
                                .get(&occurrence.series_id)
                                .and_then(|series| series.recurrence.as_ref())
                                .and_then(|data| data.segments.last())
                                .map(|segment| &segment.rule);
                            projected["widget_preview"]["repeat_rule"] = json!(rule);
                        }
                    }
                    let size = serde_json::to_vec(&projected)?.len();
                    proposed.insert(id.to_owned(), position);
                    additional.push((size + 1, projected));
                    position
                };
                let record = if position < records.len() {
                    &records[position]
                } else {
                    &additional[position - records.len()].1
                };
                // Ranking/group decorations are contextual to a list, even
                // when several lists share the same version of the task body.
                let context = [
                    "recommendation",
                    "pending_occurrence_count",
                    "blocking_count",
                    "needs_next_action",
                    "task_counts",
                ]
                .into_iter()
                .filter_map(|key| {
                    row.get(key)
                        .filter(|value| Some(*value) != record.get(key))
                        .map(|value| (key.to_owned(), value.clone()))
                })
                .collect::<serde_json::Map<_, _>>();
                *row = if context.is_empty() {
                    json!(position)
                } else {
                    json!({"ref":position,"context":context})
                };
            }
            let value = json!({"operation":page.operation,"arguments":page.arguments,"data":page.data,"summaries":!page.expansions});
            let added = serde_json::to_vec(&value)?.len()
                + 1
                + additional.iter().map(|(n, _)| n).sum::<usize>();
            if bytes + added
                > if page.required {
                    REQUIRED_BYTES
                } else {
                    OPTIONAL_BYTES
                }
            {
                if page.required {
                    return Err(StoreError::Invalid(
                        "The requested widget view exceeds the launch envelope".into(),
                    )
                    .into());
                }
                continue;
            }
            bytes += added;
            records.extend(additional.into_iter().map(|(_, record)| record));
            index.extend(proposed);
            output.push(value);
        }
        Ok(
            json!({"version":1,"account":self.account.id,"environment":self.environment.as_str(),
            "timezone":base.timezone,"revision":base.high,"evaluated_at":base.evaluated_at,
            "deferred":deferred,"revalidate":revalidate,"pages":output,"records":records}),
        )
    }
}

fn dependency_previews(snapshot: &Snapshot, ids: &HashSet<String>) -> HashMap<String, Value> {
    if ids.is_empty() {
        return HashMap::new();
    }
    fn label(task: &Task) -> Value {
        json!({"id":task.id,"title":task.title,"status":task.status,"version":task.version,
            "occurrence":task.occurrence.as_ref().map(|o| json!({"scheduled_date":o.scheduled_date,"skipped":o.skipped}))})
    }
    let mut reverse = HashMap::<&str, Vec<Value>>::new();
    let input = ListItems {
        view: Some(TaskView::All),
        ..Default::default()
    };
    for (node, _) in snapshot.select(&input, EntityType::Task) {
        for blocker in &node.task.blocked_by {
            if ids.contains(blocker) {
                let rows = reverse.entry(blocker).or_default();
                if rows.len() < PREVIEW + 2 {
                    rows.push(label(&node.task));
                }
            }
        }
    }
    ids.iter().filter_map(|id| {
        let task = snapshot.graph.tasks.get(id)?;
        let project = task.project_id.as_ref().and_then(|id| snapshot.graph.tasks.get(id))
            .filter(|record| !record.deleted && record.entity_type == EntityType::Project);
        let prerequisites = task.blocked_by.iter().take(PREVIEW)
            .filter_map(|id| snapshot.graph.tasks.get(id)).map(label).collect::<Vec<_>>();
        let mut dependents = reverse.remove(id.as_str()).unwrap_or_default();
        let more = dependents.len() > PREVIEW + 1;
        dependents.truncate(PREVIEW + 1);
        Some((id.clone(), json!({"prerequisites":prerequisites,"dependents":dependents,"more":more,"project_title":project.map(|record| &record.title),"project_version":project.map(|record| record.version)})))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postgres::{
        tests::{fixture, principal},
        write_tests::{capture, run},
    };
    use std::time::Instant;

    fn record<'a>(bundle: &'a Value, reference: &Value) -> &'a Value {
        &bundle["records"][reference
            .as_u64()
            .or_else(|| reference["ref"].as_u64())
            .unwrap() as usize]
    }

    #[test]
    #[ignore = "Disposable PostgreSQL runtime fixture; no live models"]
    fn widget_launch_snapshot_and_capacity() {
        let (_container, mut admin, runtime, a, b) = fixture();
        admin
            .execute("DELETE FROM gtd.tasks WHERE id='shared'", &[])
            .unwrap();
        let store = Store::connect(runtime, Environment::Staging, 3).unwrap();
        let p = principal("a");
        let project = run(&store, "a", "project", json!({"request_id":"project","title":"Launch project","brief":"Support the fixture.","agent_notes":"Private fixture note","reason":"Deterministic fixture"})).task;
        let base = run(&store, "a", "capture", capture("first")).task;
        let mut blocked = capture("blocked-fixture");
        blocked["blocked_by"] = json!([base.id]);
        blocked["notes"] = json!("Visible task body");
        blocked["project_id"] = json!(project.id);
        let blocked = run(&store, "a", "capture", blocked).task;
        run(&store, "b", "capture", capture("separate-account-fixture"));

        let (output, bundle) = store
            .widget_display(
                &p,
                "show_tasks",
                json!({"task_id":blocked.id}),
                LaunchMode::Requested,
            )
            .unwrap();
        assert!(output["items"][0]["agent_notes"].is_string());
        let bundle = bundle.unwrap();
        assert_eq!(bundle["account"], json!(a));
        let row = record(&bundle, &bundle["pages"][0]["data"]["items"][0]);
        assert_eq!(row["notes"], "Visible task body");
        assert_eq!(row["widget_preview"]["project_title"], "Launch project");
        assert_eq!(row["widget_preview"]["prerequisites"][0]["id"], base.id);
        assert!(row.get("agent_notes").is_none());
        assert!(!bundle.to_string().contains("separate-account-fixture"));

        let (_, selected_project) = store
            .widget_display(
                &p,
                "show_projects",
                json!({"project_id":project.id}),
                LaunchMode::Requested,
            )
            .unwrap();
        let selected_project = selected_project.unwrap();
        assert_eq!(selected_project["pages"][0]["operation"], "list_projects");
        assert!(
            selected_project["pages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|page| page["arguments"]["status"] == "blocked"
                    && !page["data"]["items"].as_array().unwrap().is_empty())
        );

        let (_, selected_list) = store
            .widget_display(
                &p,
                "show_tasks",
                json!({"view":"all","limit":1}),
                LaunchMode::Requested,
            )
            .unwrap();
        let selected_list = selected_list.unwrap();
        let page = &selected_list["pages"][0];
        let mut args = page["arguments"].clone();
        args["cursor"] = page["data"]["next_cursor"].clone();
        let next = store
            .execute_tool(
                &p,
                "gtd_ui_read",
                json!({"operation":"list_items","arguments":args}),
            )
            .unwrap();
        assert_eq!(next["items"].as_array().unwrap().len(), 1);

        let home = |mode| {
            store
                .widget_display(&p, "show_gtd", json!({}), mode)
                .unwrap()
                .1
                .unwrap()
        };
        let full = home(LaunchMode::Full);
        let home_row = record(&full, &full["pages"][0]["data"]["next"]["items"][0]);
        assert_eq!(
            home_row["widget_preview"]["dependents"][0]["id"],
            blocked.id
        );
        assert_eq!(full["deferred"], false);
        assert!(full["pages"].as_array().unwrap().iter().any(|page| {
            page["data"]["completions"]["snapshot"].is_string()
                && page["data"]["priorities"]["previews"][21][0]["id"] == base.id
                && page["data"]["priority_projects"]["projects"][0]["id"] == project.id
        }));
        let deferred = home(LaunchMode::Deferred);
        assert_eq!(deferred["deferred"], true);
        assert_eq!(deferred["pages"].as_array().unwrap().len(), 1);
        let background = store.widget_pages(&p, parse(json!({"exclude":{"operation":"home","arguments":deferred["pages"][0]["arguments"]}})).unwrap()).unwrap();
        assert!(
            background["pages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|page| page["operation"] != "home")
        );
        for args in [
            json!({"view":"review"}),
            json!({"view":"repeating"}),
            json!({"view":"activity"}),
            json!({"view":"charts"}),
            json!({"view":"results","from_request_ids":["blocked-fixture"]}),
        ] {
            let (_, bundle) = store
                .widget_display(&p, "show_gtd", args, LaunchMode::Requested)
                .unwrap();
            assert!(!bundle.unwrap()["pages"].as_array().unwrap().is_empty());
        }
        let other = store
            .widget_display(&principal("b"), "show_gtd", json!({}), LaunchMode::Full)
            .unwrap()
            .1
            .unwrap();
        assert_eq!(other["account"], json!(b));
        assert!(!other.to_string().contains("Launch project"));

        for n in 0..8 {
            let operations = (0..22)
                .map(|i| {
                    let mut task = capture(&format!("synthetic-page-{n}-{i}"));
                    task.as_object_mut().unwrap().remove("request_id");
                    task["operation"] = json!("capture");
                    task["status"] = json!(["next", "inbox", "waiting", "someday"][n % 4]);
                    task["notes"] = json!(format!("Fixture {n}-{i}. ").repeat(160));
                    task
                })
                .collect::<Vec<_>>();
            store
                .execute_tool(
                    &p,
                    "apply_changes",
                    json!({"request_id":format!("widget-seed-{n}"),"operations":operations}),
                )
                .unwrap();
        }
        store.read(&p, |tx| {
            let ids = vec![base.id.clone(), blocked.id.clone()];
            let plan = tx.tx.query_typed(
                "EXPLAIN (ANALYZE, BUFFERS) SELECT document FROM gtd.tasks WHERE account_id=$1 AND id=ANY($2)",
                &[(&tx.account.id, Type::UUID), (&ids, Type::TEXT_ARRAY)],
            )?;
            for row in plan {
                println!("WIDGET_TASK_PLAN {}", row.get::<_, String>(0));
            }
            let plan = tx.tx.query_typed(
                "EXPLAIN (ANALYZE, BUFFERS) SELECT category, count(*) FROM gtd.activity_events
                 WHERE account_id=$1 AND occurred_at >= now() - interval '1 year'
                 AND occurred_at <= now() GROUP BY category",
                &[(&tx.account.id, Type::UUID)],
            )?;
            for row in plan {
                println!("WIDGET_CHART_PLAN {}", row.get::<_, String>(0));
            }
            Ok(())
        }).unwrap();
        let mut requested = Vec::new();
        let mut bundled = Vec::new();
        let mut legacy = Vec::new();
        let mut background_times = Vec::new();
        let mut sizes = [0; 4];
        for i in 0..30 {
            for mode in if i % 2 == 0 {
                [LaunchMode::Requested, LaunchMode::Full]
            } else {
                [LaunchMode::Full, LaunchMode::Requested]
            } {
                let start = Instant::now();
                let data = home(mode);
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                let bytes = data.to_string().len();
                if matches!(mode, LaunchMode::Full) {
                    bundled.push(elapsed);
                    sizes[1] = bytes;
                } else {
                    requested.push(elapsed);
                    sizes[0] = bytes;
                }
            }
            let start = Instant::now();
            let data = store.widget_home_seed(&p).unwrap().unwrap();
            legacy.push(start.elapsed().as_secs_f64() * 1000.0);
            sizes[2] = data.to_string().len();
            let start = Instant::now();
            let data = store
                .widget_pages(
                    &p,
                    WidgetPagesRequest {
                        target: None,
                        exclude: None,
                    },
                )
                .unwrap();
            background_times.push(start.elapsed().as_secs_f64() * 1000.0);
            sizes[3] = data.to_string().len();
        }
        fn stats(mut times: Vec<f64>) -> Value {
            times.sort_by(f64::total_cmp);
            json!({"n":times.len(),"p50":times[14],"p95":times[28]})
        }
        println!(
            "WIDGET_LAUNCH_PROFILE={}",
            json!({"requested_ms":stats(requested),"full_ms":stats(bundled),
            "legacy_ms":stats(legacy),"background_ms":stats(background_times),"bytes":sizes})
        );
    }
}
