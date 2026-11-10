import { categoryNames } from "./activity-labels";
import { ImportanceField } from "./planning-fields";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  type Api,
  type Args,
  type Task,
  type Change,
  type Changes,
  type Status,
  isArchived,
  errorText,
  time,
  day,
} from "./api";
import { useActions, Recovery } from "./actions";
export {
  Mutations,
  useActions,
  useTaskState,
  SaveIcon,
  Recovery,
  UndoButton,
} from "./actions";
export { Inspector } from "./lazy-inspector";

export function Badge({ status }: { status: Status }) {
  return (
    <span className={`badge ${status}`}>
      {status === "someday" ? "Someday / maybe" : status}
    </span>
  );
}
export function TaskLine({
  task,
  selected,
  onSelect,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`task-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className={`status-dot ${task.status}`} />
      <span className="task-line">
        <strong>{task.title}</strong>
        <span className="muted">
          {task.deleted ? "Capture undone · " : ""}
          {task.notes ? task.notes.slice(0, 110) : "No description"}
        </span>
      </span>
      <span className="task-meta">
        <Badge status={task.status} />
        <small>{day(task.due_date)}</small>
      </span>
    </button>
  );
}
export function QuickActions({
  task,
  onTask,
}: {
  task: Task;
  onTask?: (task: Task) => void;
}) {
  const { run } = useActions();
  const { controller } = useActions();
  const disabled = controller.state.intents.has(task.id);
  async function action(name: string, args: Args) {
    const preview =
      name === "update_item" ? ({ ...task, ...args } as Task) : undefined;
    const result = await run(name, args, task, preview);
    if (result) onTask?.(result.task);
  }
  return (
    <div className="quick-actions">
      <Recovery taskId={task.id} />
      {!task.deleted && (
        <>
          <button
            className="primary"
            disabled={disabled || task.status === "done"}
            onClick={() =>
              action("update_item", {
                task_id: task.id,
                expected_version: task.version,
                status: "done",
                reason: "Marked complete using the task interface.",
              })
            }
          >
            {task.status === "done" ? "Completed" : "Mark complete"}
          </button>
          <button
            disabled={disabled}
            onClick={() =>
              action("update_item", {
                task_id: task.id,
                expected_version: task.version,
                archived: !isArchived(task),
                reason: isArchived(task)
                  ? "Restored from archive using the task interface."
                  : "Archived using the task interface.",
              })
            }
          >
            {isArchived(task) ? "Unarchive" : "Archive"}
          </button>
        </>
      )}
      <button
        disabled={disabled}
        onClick={() =>
          action("undo_change", {
            change_id: task.last_change_id,
            expected_version: task.version,
            reason: "Undid the latest task change using the task interface.",
          })
        }
      >
        {task.deleted ? "Restore capture" : "Undo latest"}
      </button>
    </div>
  );
}
export function ChangeCard({
  change: supplied,
  onSelect,
  api,
}: {
  change: Change;
  onSelect?: (id: string, kind?: "task" | "project" | "recurrence") => void;
  api: Api;
}) {
  const [full, setFull] = useState<Change | null>(null),
    [error, setError] = useState(""),
    [opened, setOpened] = useState(false);
  const change = full || supplied;
  useEffect(() => {
    if (
      !opened ||
      change.detail === "full" ||
      (change.detail === undefined && change.before !== undefined)
    )
      return;
    let active = true;
    api
      .call<Changes>("list_changes", { change_id: change.id, detail: "full" })
      .then((r) => {
        if (active && r.changes[0]) {
          setFull({ ...r.changes[0], activity: supplied.activity ?? r.changes[0].activity });
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [opened, change.id, change.detail, api]);
  const fields = [
    "title",
    "brief",
    "notes",
    "agent_notes",
    "links",
    "location",
    "status",
    "archived",
    "due_date",
    "deleted",
    "project_id",
    "review_date",
    "work_sessions",
    "estimated_minutes",
    "effort",
    "not_before",
    "safety_buffer",
    "work_blocks",
    "completion_result",
    "completed_at",
  ] as const;
  const diff =
    (change.changed_fields?.filter((f) =>
      fields.includes(f as (typeof fields)[number]),
    ) as (typeof fields)[number][]) ||
    fields.filter(
      (f) =>
        JSON.stringify(
          change.before?.[f] ??
            (f === "links" ? [] : f === "archived" ? false : null),
        ) !==
        JSON.stringify(
          change.after[f] ??
            (f === "links" ? [] : f === "archived" ? false : null),
        ),
    );
  function shown(value: unknown) {
    if (Array.isArray(value))
      return (
        value
          .map((l) => (l.label ? `${l.label} — ${l.url}` : l.url))
          .join("\n") || "—"
      );
    return value === null || value === undefined || value === ""
      ? "—"
      : String(value);
  }
  return (
    <article className="change">
      <div className="change-head">
        <strong>
          #{change.id} · {change.activity ? categoryNames[change.activity.category] : change.operation}{change.activity?.automatic ? " · Automatic" : ""}
        </strong>
        <span>{change.origin || "unknown"}</span>
      </div>
      {onSelect && (
        <button
          className="link"
          onClick={() =>
            onSelect(
              change.entity_id || change.task_id || change.project_id!,
              change.entity_type,
            )
          }
        >
          {change.after.title}
        </button>
      )}
      <p>{change.reason}</p>
      <details onToggle={(e) => setOpened(e.currentTarget.open)}>
        <summary>
          {diff.length} field{diff.length === 1 ? "" : "s"} changed
          {change.undoes_change_id
            ? ` · reverses #${change.undoes_change_id}`
            : ""}
        </summary>
        {error && (
          <p role="alert">
            {error}
            <button
              onClick={() => {
                setError("");
                setOpened(false);
                requestAnimationFrame(() => setOpened(true));
              }}
            >
              Retry
            </button>
          </p>
        )}
        {change.detail === "summary" ? (
          <p className="muted" role="status">
            Loading original values…
          </p>
        ) : (
          <div className="diff-table">
            {diff.map((field) => (
              <div key={field}>
                <strong>
                  {field === "notes"
                    ? "Description"
                    : field === "agent_notes"
                      ? "Agent notes"
                      : field.replaceAll("_", " ")}
                </strong>
                <del>{shown(change.before?.[field])}</del>
                <ins>{shown(change.after[field])}</ins>
              </div>
            ))}
          </div>
        )}
      </details>
      <small className="muted">
        {time(change.created_at)} · v{change.after.version}
      </small>
    </article>
  );
}
export function Capture({
  onTask,
  onClose,
}: {
  onTask: (t: Task) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(""),
    [notes, setNotes] = useState("");
  const [importance, setImportance] =
    useState<import("./api").Importance>("normal");
  const { run, busy, uncertain, confirmed } = useActions();
  useEffect(() => {
    if (
      confirmed?.change.operation === "capture" &&
      confirmed.task.title === title &&
      confirmed.task.notes === notes
    ) {
      onTask(confirmed.task);
      onClose();
    }
  }, [confirmed]);
  return (
    <section className="capture" aria-label="Capture a task">
      <div className="page-title">
        <h2>Get it out of your head.</h2>
        <button className="quiet" onClick={onClose} aria-label="Close capture">
          ×
        </button>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run("capture_item", {
            title,
            notes,
            importance,
            reason: "Captured using the private website.",
          });
          if (r) {
            onTask(r.task);
            onClose();
          }
        }}
      >
        <label>
          What needs your attention?
          <input
            autoFocus
            required
            maxLength={500}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Write an action or capture a thought…"
          />
        </label>
        <label>
          Description
          <textarea
            rows={3}
            maxLength={10000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <ImportanceField
          value={importance}
          onChange={setImportance}
          disabled={busy || uncertain}
        />
        <div className="form-footer">
          <span className="muted">Added to your inbox</span>
          <button
            className="primary"
            disabled={busy || uncertain || !title.trim()}
          >
            Capture task
          </button>
        </div>
      </form>
    </section>
  );
}
export function usePolling(callback: () => void, enabled = true) {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    const id = setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled]);
}
export function useRefresh() {
  const [revision, setRevision] = useState(0);
  return [revision, useCallback(() => setRevision((n) => n + 1), [])] as const;
}
