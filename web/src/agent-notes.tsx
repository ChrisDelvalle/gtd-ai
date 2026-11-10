import { useEffect, useRef, useState } from "react";
import { Pencil, LoaderCircle, X } from "lucide-react";
import {
  type Api,
  type Task,
  type List,
  type Projects,
  type Occurrences,
  errorText,
  recordRead,
} from "./api";
import { Recovery, SaveIcon, useActions, useTaskState } from "./shared";
import { Menu } from "./floating-panel";
import {useDraftFields} from "./use-record-draft";

/** Separate, explicitly requested working context. Never part of a normal editor draft. */
export function AgentNotes({
  task: supplied,
  api,
  onTask,
  onDirtyChange,
  onClose,
  active: visible = true,
}: {
  task: Task;
  api: Api;
  onTask?: (task: Task) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onClose?: () => void;
  active?: boolean;
}) {
  const { task, intent, controller } = useTaskState(supplied);
  const { run } = useActions();
  const field=useDraftFields(`agent-notes:${task.id}`,()=>({current:null as Task|null,base:null as Task|null,text:"",editing:false}),value=>value.editing&&!!value.base&&value.text!==(value.base.agent_notes||""));
  const [current, setCurrent] = field('current');
  const [base, setBase] = field('base');
  const [text, setText] = field('text');
  const [editing, setEditing] = field('editing');
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const callback = useRef(onDirtyChange);
  callback.current = onDirtyChange;
  const dirty = editing && !!base && text !== (base.agent_notes || "");
  const stale = !!base && !!current && base.version !== current.version;
  const needsCurrent = !current || current.version !== task.version;
  const busy = !!intent;
  useEffect(() => {
    callback.current?.(dirty || busy);
  }, [dirty, busy]);
  useEffect(() => () => callback.current?.(false), []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLoading(true);
    setError("");
    const [name, args] = recordRead(task);
    api
      .call<List & Projects & Occurrences>(name, {
        ...args,
        include_agent_notes: true,
        ...(name !== "list_occurrences" ? { detail: "full" } : {}),
      })
      .then((result) => {
        const fresh = result.series || (result.projects || result.items)?.[0];
        if (!fresh || typeof fresh.agent_notes !== "string")
          throw new Error("Agent notes could not be loaded.");
        if (active) setCurrent(fresh);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, task.id, task.version, attempt, visible]);
  useEffect(() => {
    if (current && (!editing || !dirty)) {
      setBase(current);
      setText(current.agent_notes || "");
    }
  }, [current, editing]);
  function discard() {
    controller.dismiss(task.id);
    setBase(current);
    setText(current?.agent_notes || "");
    setEditing(false);
  }
  async function save() {
    setScope(false);
    if (!base || !dirty || busy || stale || needsCurrent || loading) return;
    const isSeries = task.entity_type === "recurrence",
      isProject = task.entity_type === "project";
    const result = await run(
      isSeries
        ? "update_recurrence"
        : isProject
          ? "update_project"
          : "update_item",
      {
        [isSeries ? "series_id" : isProject ? "project_id" : "task_id"]:
          task.id,
        expected_version: base.version,
        agent_notes: text,
        ...(isSeries ? { scope: "all", action: "edit" } : {}),
        reason: `Edited agent notes${isSeries ? " for the entire series" : ""} using the task interface.`,
      },
      base,
      { ...base, agent_notes: text, has_agent_notes: !!text },
    );
    if (result) {
      // A compact receipt intentionally omits the body. The submitted value is
      // optimistic local state until the explicit read above verifies it.
      const committed = {
        ...result.task,
        agent_notes: result.task.agent_notes ?? text,
      };
      setBase(committed);
      setCurrent(committed);
      setEditing(false);
      onTask?.(result.task);
      setAttempt((n) => n + 1);
    }
  }
  return (
    <section className="agent-notes-panel" aria-label="Agent notes">
      <div className="panel-bar">
        <span>Agent notes</span>
        <SaveIcon taskId={task.id} />
        {!editing && current && !task.deleted && (
          <button
            type="button"
            className="icon-button"
            aria-label="Edit agent notes"
            disabled={busy || loading}
            onClick={() => {
              setBase(current);
              setText(current.agent_notes || "");
              setEditing(true);
            }}
          >
            <Pencil />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className="icon-button"
            aria-label="Close details"
            onClick={onClose}
          >
            <X />
          </button>
        )}
      </div>
      {error && (
        <div className="recovery" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry agent notes
          </button>
        </div>
      )}
      {loading && !current && (
        <LoaderCircle className="spinning" aria-label="Loading agent notes" />
      )}
      {current && !editing && (
        <p className={`agent-notes-body${current.agent_notes ? "" : " muted"}`}>
          {current.agent_notes || "No agent notes."}
        </p>
      )}
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            task.entity_type === "recurrence" ? setScope(!scope) : void save();
          }}
        >
          {stale && (
            <div className="banner error" role="alert">
              This record changed. Your draft is preserved.
              <details>
                <summary>Current agent notes</summary>
                <p className="agent-notes-body">
                  {current?.agent_notes || "No agent notes."}
                </p>
              </details>
              <button
                type="button"
                onClick={() => {
                  controller.dismiss(task.id);
                  setBase(current);
                }}
              >
                Use latest version with my draft
              </button>
            </div>
          )}
          <label>
            <span className="sr-only">Agent notes</span>
            <textarea
              autoFocus
              rows={10}
              maxLength={10000}
              value={text}
              disabled={
                (!!intent && intent.phase !== "error") ||
                !!intent?.error?.uncertain
              }
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {!stale && <Recovery taskId={task.id} />}
          <div className="form-footer">
            <button
              type="button"
              className="text-action"
              disabled={
                (busy && !!intent?.error?.uncertain) ||
                (!!intent && intent.phase !== "error")
              }
              onClick={discard}
            >
              Discard draft
            </button>
            <button
              type="submit"
              className="primary"
              ref={anchor}
              disabled={!dirty || stale || busy || needsCurrent || loading}
              aria-haspopup={
                task.entity_type === "recurrence" ? "menu" : undefined
              }
              aria-expanded={
                task.entity_type === "recurrence" ? scope : undefined
              }
            >
              Save agent notes
            </button>
          </div>
          {scope && (
            <Menu
              label="Repeat change scope"
              anchor={anchor}
              close={() => setScope(false)}
            >
              <button type="button" role="menuitem" onClick={() => void save()}>
                Entire series
              </button>
            </Menu>
          )}
        </form>
      )}
    </section>
  );
}
