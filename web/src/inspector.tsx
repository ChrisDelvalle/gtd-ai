import { BriefField } from "./brief-field";
import { DependencyFields } from "./dependencies";
import {
  PlanningFields,
  planningDraft,
  planningArgs,
  type PlanningDraft,
} from "./planning-fields";
import { AgentNotes } from "./agent-notes";
import { RepeatControls } from "./lazy-recurrence";
import { useState, useEffect, useRef } from "react";
import {
  type Api,
  type Args,
  type Task,
  type Change,
  type Changes,
  type Status,
  statuses,
  isArchived,
  errorText,
  time,
  day,
} from "./api";
import { ContextFields, TaskContext, type ContextDraft } from "./task-context";
import { WorkflowFields, type WorkflowDraft } from "./workflow-fields";
import { useActions } from "./actions";
import { useRecordDraft } from "./use-record-draft";
import { Badge, QuickActions, ChangeCard } from "./shared";

type Draft = PlanningDraft &
  ContextDraft &
  WorkflowDraft & {
    title: string;
    brief: string;
    notes: string;
    status: Status;
    blocked_by: string[];
    manual_block: boolean;
    due_date: string;
  };
function draft(task: Task): Draft {
  return {
    ...planningDraft(task),
    blocked_by: task.blocked_by || [],
    manual_block: task.manual_block || false,
    project_id: task.project_id || "",
    review_date: task.review_date || "",
    work_sessions: task.work_sessions || [],
    completion_result: task.completion_result || "",
    title: task.title,
    brief: task.brief || "",
    notes: task.notes || "",
    links: (task.links || []).map((l) => ({
      url: l.url,
      label: l.label || "",
    })),
    location: task.location || "",
    status: task.status,
    due_date: task.due_date || "",
  };
}
function delta(base: Draft, form: Draft) {
  return Object.fromEntries(
    Object.entries(form).filter(
      ([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(base[key as keyof Draft]),
    ),
  );
}
export type InspectorProps = {
  task: Task;
  api: Api;
  compact?: boolean;
  onTask?: (task: Task) => void;
  embeddedView?: "edit" | "history" | "agent-notes";
  onDirtyChange?: (dirty: boolean) => void;
  onSubmitted?: () => void;
  onClose?: () => void;
  active?: boolean;
};
export function Inspector(props: InspectorProps) {
  return props.embeddedView === "agent-notes" ? (
    <AgentNotes
      task={props.task}
      api={props.api}
      onTask={props.onTask}
      onDirtyChange={props.onDirtyChange}
      onClose={props.onClose}
      active={props.active}
    />
  ) : (
    <DescriptionInspector {...props} />
  );
}
function DescriptionInspector({
  task,
  api,
  compact = false,
  onTask,
  embeddedView,
  onDirtyChange,
  onSubmitted,
}: InspectorProps) {
  const isProject = task.entity_type === "project";
  const [repeatDirty, setRepeatDirty] = useState(false);
  const [{base, form, reason}, setDraft] = useRecordDraft(
    `description:${task.id}`,
    () => ({base: task, form: draft(task), reason: ""}),
    value => Object.keys(delta(draft(value.base), value.form)).length > 0 || !!value.reason,
  );
  const setBase = (base: Task) => setDraft(previous => ({...previous, base}));
  const setForm = (form: Draft | ((previous: Draft) => Draft)) => setDraft(previous => ({...previous, form: typeof form === "function" ? form(previous.form) : form}));
  const setReason = (reason: string | ((previous: string) => string)) => setDraft(previous => ({...previous, reason: typeof reason === "function" ? reason(previous.reason) : reason}));
  const [history, setHistory] = useState<Change[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [historyError, setHistoryError] = useState("");
  const { run, controller } = useActions();
  const intent = controller.state.intents.get(task.id);
  const busy = !!intent,
    uncertain = !!intent?.error?.uncertain;
  const patch = delta(draft(base), form),
    dirty = Object.keys(patch).length > 0;
  const stale = dirty && base.version !== task.version;
  useEffect(() => {
    onDirtyChange?.(dirty || repeatDirty);
  }, [dirty, repeatDirty, onDirtyChange]);
  useEffect(() => {
    if (
      (!dirty || JSON.stringify(form) === JSON.stringify(draft(task))) &&
      task.version !== base.version
    ) {
      setBase(task);
      setForm(draft(task));
    }
  }, [task, dirty, base.version, form]);
  const historyGeneration = useRef(0);
  useEffect(() => {
    if (embeddedView === "edit") return;
    const generation = ++historyGeneration.current;
    setHistoryError("");
    api
      .call<Changes>("list_changes", {
        [isProject ? "project_id" : "task_id"]: task.id,
        limit: 20,
      })
      .then((r) => {
        if (generation === historyGeneration.current) {
          setHistory(r.changes);
          setCursor(r.next_before_id);
        }
      })
      .catch((e) => {
        if (generation === historyGeneration.current)
          setHistoryError(errorText(e));
      });
    return () => {
      historyGeneration.current++;
    };
  }, [api, task.id, task.version, embeddedView]);
  async function save() {
    if (stale || !dirty) return;
    const args: Args = {
      [isProject ? "project_id" : "task_id"]: task.id,
      expected_version: base.version,
      ...patch,
      reason:
        reason.trim() ||
        `Edited ${Object.keys(patch).join(", ")} using the task interface.`,
    };
    if ("manual_block" in patch) {
      args.status = form.manual_block
        ? "blocked"
        : form.status === "blocked"
          ? "next"
          : form.status;
      delete args.manual_block;
    }
    planningArgs(args);
    if ("due_date" in patch && !form.due_date) {
      delete args.due_date;
      args.clear_due_date = true;
    }
    if ("review_date" in patch && !form.review_date) {
      delete args.review_date;
      args.clear_review_date = true;
    }
    if (!isProject && "project_id" in patch && !form.project_id) {
      delete args.project_id;
      args.clear_project = true;
    }
    if (isProject) {
      delete args.project_id;
      args.project_id = task.id;
      delete args.work_sessions;
      delete args.location;
    }
    if (form.status !== "done") delete args.completion_result;
    const sending = run(
      isProject ? "update_project" : "update_item",
      args,
      base,
      {
        ...base,
        ...form,
        due_date: form.due_date || null,
        review_date: form.review_date || null,
        project_id: form.project_id || null,
      },
    );
    onSubmitted?.();
    const result = await sending;
    if (result) {
      setBase(result.task);
      // A user may continue typing while the acknowledgement is in flight.
      // Rebase only fields changed since submission onto the confirmed task.
      setForm(
        (current) =>
          ({ ...draft(result.task), ...delta(form, current) }) as Draft,
      );
      setReason((current) => (current === reason ? "" : current));
      onTask?.(result.task);
    }
  }
  return (
    <section className="inspector" aria-label="Task details">
      {!embeddedView && (
        <>
          <div className="eyebrow">
            TASK DETAILS{" "}
            <span>
              v{task.version} · #{task.last_change_id}
            </span>
          </div>
          <h2>{task.title}</h2>
          <div className="detail-meta">
            <Badge status={task.status} />
            {isArchived(task) && <span className="badge">Archived</span>}
            <span>{day(task.due_date)}</span>
            {task.deleted && <span className="badge">Hidden capture</span>}
          </div>
          <QuickActions task={task} onTask={onTask} />
        </>
      )}
      <div hidden={embeddedView === "history"}>
        {stale && (
          <div className="banner error" role="alert">
            This task changed on the server. Your draft is preserved.
            <details>
              <summary>Compare with current server values</summary>
              <p>
                <strong>{task.title}</strong>
              </p>
              <TaskContext task={task} api={api} />
              <p>
                {task.status} · {day(task.due_date)}
              </p>
            </details>
            <button
              onClick={() => {
                setForm({ ...draft(task), ...patch } as Draft);
                setBase(task);
              }}
            >
              Apply my edited fields to latest version
            </button>
            <button
              onClick={() => {
                setForm(draft(task));
                setBase(task);
                setReason("");
              }}
            >
              Discard draft
            </button>
          </div>
        )}
        {task.deleted ? (
          <p className="muted">This capture was undone. Restore it to edit.</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {compact ? (
              <>
                <TaskContext task={task} api={api} />
                <label>
                  Deadline
                  <input
                    type="date"
                    value={form.due_date}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        due_date: e.target.value,
                        deadline_time: e.target.value
                          ? form.deadline_time
                          : null,
                      })
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Title
                  <input
                    required
                    maxLength={500}
                    value={form.title}
                    onChange={(e) =>
                      setForm({ ...form, title: e.target.value })
                    }
                  />
                </label>
                <BriefField value={form.brief} onChange={brief => setForm({...form, brief})}
                  required={isProject || form.status !== "inbox"} />
                <label>
                  Notes
                  <textarea
                    rows={5}
                    maxLength={10000}
                    value={form.notes}
                    onChange={(e) =>
                      setForm({ ...form, notes: e.target.value })
                    }
                  />
                </label>
                <ContextFields
                  value={form}
                  onChange={(context) => setForm({ ...form, ...context })}
                  allowLocation={!isProject}
                />
                <div className="field-row">
                  {!isProject && (
                    <label>
                      Status
                      <select
                        value={form.status}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            status: e.target.value as Status,
                            manual_block: e.target.value === "blocked",
                          })
                        }
                      >
                        {statuses.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Deadline
                    <input
                      type="date"
                      value={form.due_date}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          due_date: e.target.value,
                          deadline_time: e.target.value
                            ? form.deadline_time
                            : null,
                        })
                      }
                    />
                  </label>
                </div>
                {!isProject && (
                  <PlanningFields
                    required={
                      !task.archived &&
                      ["next", "blocked", "waiting"].includes(form.status)
                    }
                    value={form}
                    dueDate={form.due_date}
                    onChange={(v) => setForm({ ...form, ...v })}
                    api={api}
                    taskId={task.id}
                  />
                )}
                {!isProject && (
                  <DependencyFields
                    api={api}
                    task={task}
                    ids={form.blocked_by}
                    manual={form.manual_block}
                    status={form.status}
                    onChange={(blocked_by) => setForm({ ...form, blocked_by })}
                    onManual={(manual_block) =>
                      setForm({
                        ...form,
                        manual_block,
                        status: manual_block
                          ? "blocked"
                          : form.status === "blocked"
                            ? "next"
                            : form.status,
                      })
                    }
                  />
                )}
                <WorkflowFields
                  value={form}
                  onChange={(workflow) => setForm({ ...form, ...workflow })}
                  api={api}
                  task={{ ...task, status: form.status }}
                />
                <label>
                  Reason <span className="muted">(optional)</span>
                  <input
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="What prompted this change?"
                  />
                </label>
              </>
            )}
            <div className="form-footer">
              <span className="sr-only" role="status">
                {dirty ? "Unsaved changes" : "All changes saved"}
              </span>
              <button
                className="primary"
                type="submit"
                disabled={!dirty || stale || busy || uncertain}
              >
                Save changes
              </button>
            </div>
          </form>
        )}
        {!isProject && !task.deleted && task.status !== "done" && (
          <RepeatControls
            task={task}
            api={api}
            disabled={dirty || busy}
            onDirtyChange={setRepeatDirty}
            onTask={onTask}
          />
        )}
      </div>
      <details
        className="history"
        hidden={embeddedView === "edit"}
        open={embeddedView === "history" || !compact}
      >
        <summary>
          Change history <span className="muted">{history.length} loaded</span>
        </summary>
        {historyError && <p role="alert">{historyError}</p>}
        {history.map((c) => (
          <ChangeCard key={c.id} change={c} api={api} />
        ))}
        {cursor && (
          <button
            onClick={async () => {
              try {
                const r = await api.call<Changes>("list_changes", {
                  [isProject ? "project_id" : "task_id"]: task.id,
                  before_id: cursor,
                  limit: 20,
                });
                setHistory((h) => [...h, ...r.changes]);
                setCursor(r.next_before_id);
              } catch (e) {
                setHistoryError(errorText(e));
              }
            }}
          >
            Older changes
          </button>
        )}
      </details>
      <p className="record-id">
        {task.id}
        <br />
        Updated {time(task.updated_at || new Date().toISOString())} · Eastern
        time
      </p>
    </section>
  );
}
