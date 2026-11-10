use super::*;
use crate::view::{LoadingPolicy, ViewRequest, task_list};
use serde_json::{Value, json};

impl Store {
    pub fn home_view(&mut self, request: ViewRequest) -> Result<Value> {
        validate_date(Some(&request.review_on))?;
        self.settle_availability()?;
        let tx = self.connection.transaction()?;
        let revision = reads::high(&tx)?;
        let evaluated_at = crate::clock::timestamp();
        let snapshot = reads::TaskSnapshot::new(&tx, revision, &evaluated_at)?;
        let mut sections = serde_json::Map::new();
        let mut empty = true;
        for (name, status, limit) in [
            ("next", Some(Status::Next), 7),
            ("waiting", Some(Status::Waiting), 4),
            ("someday", Some(Status::Someday), 4),
            ("reviewTasks", None, 4),
        ] {
            let mut input = ListItems {
                status,
                group_recurrences: true,
                limit: Some(limit),
                review_on: if name == "reviewTasks" {
                    Some(request.review_on.clone())
                } else {
                    None
                },
                ..Default::default()
            };
            let mut cursor = reads::make(&tx, "tasks", revision, 0, reads::query_key(&input)?)?;
            cursor.evaluated_at = Some(evaluated_at.clone());
            input.cursor = Some(reads::encode(&cursor));
            let result = reads::read_tasks_in(&tx, input.clone(), None, Some(&snapshot))?;
            empty &= result.items.is_empty();
            let mut output = task_list(&result, &input);
            if name == "next" {
                let preload = match request.loading {
                    LoadingPolicy::Featured => 1,
                    LoadingPolicy::TopThree => 3,
                    _ => 0,
                };
                for (i, task) in result.items.iter().take(preload).enumerate() {
                    let mut full = crate::projection::page_record_with_agent_notes(
                        task,
                        Detail::Full,
                        false,
                        false,
                    );
                    full["blocking_count"] = output["items"][i]["blocking_count"].clone();
                    output["items"][i] = full;
                }
            }
            sections.insert(name.into(), output);
        }
        let mut remaining = Value::Null;
        if empty {
            let mut input = ListItems {
                view: Some(TaskView::All),
                archived: Some(false),
                exclude_statuses: Some(vec![Status::Done]),
                limit: Some(1),
                ..Default::default()
            };
            let mut cursor = reads::make(&tx, "tasks", revision, 0, reads::query_key(&input)?)?;
            cursor.evaluated_at = Some(evaluated_at.clone());
            input.cursor = Some(reads::encode(&cursor));
            let result = reads::read_tasks_in(&tx, input, None, Some(&snapshot))?;
            remaining = json!(result.items.first().map(|t| t.status));
        }
        let mut projects = ListProjects {
            review_on: Some(request.review_on),
            limit: Some(4),
            ..Default::default()
        };
        projects.cursor = Some(reads::encode(&reads::make(
            &tx,
            "projects",
            revision,
            0,
            reads::query_key(&projects)?,
        )?));
        tx.commit()?;
        // Project counts use the same immutable revision even if a writer commits
        // between these transactions. No subsequent current-state reads leak in.
        let projects = self.projects(projects)?;
        if projects["projects"]
            .as_array()
            .is_some_and(|p| !p.is_empty())
        {
            remaining = Value::Null;
        }
        sections.insert("reviewProjects".into(), projects);
        sections.insert("remaining".into(), remaining);
        let result = json!({"view":"home","data":sections,"revision":revision,"evaluated_at":evaluated_at,"loading":request.loading,"environment":self.environment(),"response_version":1});
        // Composed screen allowance: six existing bounded pages, never unbounded.
        if serde_json::to_vec(&result)?.len() > 6 * crate::projection::PAGE_BYTES {
            return Err(StoreError::Invalid(
                "Composed view exceeds its response budget".into(),
            ));
        }
        Ok(result)
    }
}
