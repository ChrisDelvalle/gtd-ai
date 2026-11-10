import { DependencyContext } from "./dependencies";
import { PlanningContext, RecordedTimeValue } from "./planning-fields";
import { MetadataRow } from "./metadata";
import { useEffect, useState } from "react";
import { ChevronDown, CalendarDays, Folder } from "lucide-react";
import {
  type Api,
  type Task,
  type TaskLink,
  type Projects,
  type Project,
  day,
  errorText,
} from "./api";
import { ContextFields, ExternalLink, NoteText } from "./task-context";
import { TaskExpansion } from "./task-expansion";
import { useActions } from "./actions";
import { useEnvironment } from "./app-context";

export type WorkflowDraft = {
  project_id: string;
  review_date: string;
  work_sessions: TaskLink[];
  completion_result: string;
};
export function WorkflowFields({
  value,
  onChange,
  api,
  task,
}: {
  value: WorkflowDraft;
  onChange: (value: WorkflowDraft) => void;
  api: Api;
  task: Task;
}) {
  const project = task.entity_type === "project";
  const [open, setOpen] = useState(
    !!(
      value.project_id ||
      value.review_date ||
      value.work_sessions.length ||
      value.completion_result
    ),
  );
  const [projects, setProjects] = useState<Project[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || project) return;
    let active = true;
    api
      .call<Projects>("list_projects", {})
      .then(async (r) => {
        const rows = r.projects;
        if (value.project_id && !rows.some((p) => p.id === value.project_id)) {
          const exact = await api.call<Projects>("list_projects", {
            project_id: value.project_id,
          });
          rows.push(...exact.projects);
        }
        if (active) {
          setProjects(rows);
          setCursor(r.next_cursor);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [open, project, api]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const r = await api.call<Projects>("list_projects", { cursor });
      setProjects((p) => [
        ...p,
        ...r.projects.filter((x) => !p.some((y) => y.id === x.id)),
      ]);
      setCursor(r.next_cursor);
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workflow-fields">
      <button
        type="button"
        className="text-action"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        More details <ChevronDown className={open ? "turned" : ""} />
      </button>
      <TaskExpansion open={open}>
        <div className="workflow-fields-inner">
          {!project && (
            <label>
              Project
              <select
                value={value.project_id}
                onChange={(e) =>
                  onChange({ ...value, project_id: e.target.value })
                }
              >
                <option value="">Standalone task</option>
                {value.project_id &&
                  !projects.some((p) => p.id === value.project_id) && (
                    <option value={value.project_id}>Current project</option>
                  )}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {cursor && (
            <button
              type="button"
              className="text-action"
              disabled={busy}
              onClick={() => void more()}
            >
              Load more projects
            </button>
          )}
          {error && <p role="alert">{error}</p>}
          <label>
            Review on
            <input
              type="date"
              value={value.review_date}
              onChange={(e) =>
                onChange({ ...value, review_date: e.target.value })
              }
            />
          </label>
          {!project && (
            <div className="session-fields">
              <span className="field-label">Work sessions</span>
              <ContextFields
                value={{ links: value.work_sessions, location: "" }}
                allowLocation={false}
                addLabel="Add calendar link"
                onChange={(context) =>
                  onChange({ ...value, work_sessions: context.links })
                }
              />
            </div>
          )}
          {task.status === "done" && (
            <label>
              Completion result <span className="muted">(optional)</span>
              <textarea
                rows={3}
                maxLength={2000}
                placeholder="What was resolved?"
                value={value.completion_result}
                onChange={(e) =>
                  onChange({ ...value, completion_result: e.target.value })
                }
              />
            </label>
          )}
        </div>
      </TaskExpansion>
    </div>
  );
}
export function ProjectContext({ task, api }: { task: Task; api: Api }) {
  const { controller, state } = useActions();
  const { revision } = useEnvironment();
  const [missing, setMissing] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const known = task.project_id ? state.current.get(task.project_id) : undefined;
  // Reuse the session's versioned records, including confirmed project renames.
  // A disclosure remount must not replace a known name with a loading label.
  const project = known?.entity_type === "project" && !known.deleted && missing !== task.project_id
    ? controller.project(known, state) : null;
  const preview = task.widget_preview;
  const title = preview && (!known || known.version <= (preview.project_version ?? Infinity))
    ? preview.project_title
    : project?.title;
  useEffect(() => {
    if (preview) return;
    let active = true;
    setMissing(null);
    setFailed(false);
    if (task.project_id)
      api
        .call<Projects>("list_projects", {
          project_id: task.project_id,
          detail: "summary",
        })
        .then((r) => {
          if (active) {
            controller.observe(r.projects);
            setMissing(r.projects.length ? null : task.project_id || null);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    return () => {
      active = false;
    };
  }, [task.project_id, preview, api, revision, controller]);
  return task.project_id ? (
      <button
        type="button"
        className="text-action project-link"
        title={title || undefined}
        disabled={!title}
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("gtd:project", { detail: task.project_id }),
          )
        }
      >
        <Folder aria-hidden="true" />
        <span className="project-name">{title ||
          (preview || failed || missing === task.project_id ? "Project unavailable" : "Loading project…")}
        </span>
      </button>
  ) : null;
}
export function WorkflowContext({ task, api }: { task: Task; api: Api }) {
  return (
    <div className="workflow-context">
      <PlanningContext task={task}/>
      {(!task.entity_type || task.entity_type === "task") && <DependencyContext task={task} api={api}/>}
      {task.review_date && (
        <MetadataRow label="Review">{day(task.review_date)}</MetadataRow>
      )}
      {(task.work_sessions || []).map((link, i) => (
        <div className="task-resource" key={`${i}:${link.url}`}>
          <CalendarDays aria-hidden="true" />
          <ExternalLink api={api} url={link.url}>
            {link.label || "Work session"}
          </ExternalLink>
        </div>
      ))}
      {task.status === "done" &&
        (task.completion_result || task.completed_at) && (
          <div className="completion-context">
            {task.completed_at ? (
              <MetadataRow label="Completed"><RecordedTimeValue value={task.completed_at} /></MetadataRow>
            ) : <span className="muted">Completed</span>}
            {task.completion_result && (
              <p className="task-reading-notes">
                <NoteText text={task.completion_result} api={api} />
              </p>
            )}
          </div>
        )}
    </div>
  );
}
