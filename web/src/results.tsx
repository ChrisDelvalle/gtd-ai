import { useEffect, useRef, useState } from "react";
import { type Args, type Task, errorText } from "./api";
import { useAppNavigation, useEnvironment } from "./app-context";
import { TaskRow } from "./task-row";
import { TaskLine } from "./shared";
import { useActions } from "./actions";
import { interactionInProgress } from "./interaction-order";
export type RequestResults = {
  records: Task[];
  from_request_ids: string[];
  next_cursor: string | null;
  snapshot: string;
  app: "gtd";
  view: "results";
};
export function Results({
  input,
  revision,
  onDirtyChange,
}: {
  input: Args;
  revision: number;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { api } = useEnvironment(),
    app = useAppNavigation();
  const ids = input.from_request_ids as string[] | undefined;
  const { controller } = useActions();
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const dirty = Object.values(drafts).some(Boolean);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const [data, setData] = useState<RequestResults | null>(
      (input.initial_results as RequestResults) || null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0);
  const limit = typeof input.limit === "number" ? input.limit : undefined;
  const key = JSON.stringify([ids, limit]);
  const initial = useRef({ key, revision, value: input.initial_results });
  const generation = useRef(0);
  const scope = api.identityScope?.();
  useEffect(() => {
    let alive = true;
    let deferred: ReturnType<typeof setTimeout>;
    generation.current++;
    if (
      initial.current.value &&
      initial.current.key === key &&
      initial.current.revision === revision &&
      retry === 0
    ) {
      return () => {
        generation.current++;
      };
    }
    initial.current.value = undefined;
    if (!ids?.length) {
      setError("Choose committed request results to display.");
      return;
    }
    setBusy(true);
    api
      .call<RequestResults>("request_results", { from_request_ids: ids, limit })
      .then((r) => {
        const commit = () => {
          if (!alive) return;
          if (dirtyRef.current || controller.snapshot().intents.size || interactionInProgress()) {
            deferred = setTimeout(commit, 150);
            return;
          }
          controller.observe(r.records);
          setData(r);
          setError("");
        };
        commit();
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
      clearTimeout(deferred);
      generation.current++;
    };
  }, [api, key, revision, retry, scope]);
  async function more() {
    if (busy || !data?.next_cursor) return;
    setBusy(true);
    const current = generation.current;
    try {
      const r = await api.call<RequestResults>("request_results", {
        from_request_ids: ids,
        limit,
        cursor: data.next_cursor,
      });
      if (current !== generation.current) return;
      setData({ ...r, records: [...data.records, ...r.records] });
      setError("");
    } catch (e) {
      if (current !== generation.current) return;
      setError(errorText(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function open(t: Task) {
    app.go(
      t.entity_type === "project"
        ? {
            page: "Projects",
            input: { project_id: t.id, include_deleted: true },
          }
        : t.entity_type === "recurrence"
          ? {
              page: "Repeating",
              input: { series_id: t.id, include_deleted: true },
            }
          : {
              page: "Tasks",
              input: {
                task_id: t.id,
                include_deleted: true,
                open_details: true,
              },
            },
    );
  }
  return (
    <section
      className="results-list"
      aria-label="Request results"
      aria-busy={busy}
    >
      {error && (
        <div role="alert">
          {error} <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
        </div>
      )}
      {!data && !error && <p role="status">Loading…</p>}
      {data?.records.map((t) =>
        t.deleted ? (
          <div className="result-removed" key={t.id}>
            <strong>{t.title}</strong>
            <span>Removed</span>
            <button
              onClick={() =>
                app.go({
                  page: "Activity",
                  input:
                    t.entity_type === "project"
                      ? { project_id: t.id }
                      : { task_id: t.id, entity_type: t.entity_type },
                })
              }
            >
              History
            </button>
          </div>
        ) : t.entity_type === "task" ? (
          <TaskRow
            key={t.id}
            task={t}
            api={api}
            inlineDetails
            update={(record) => controller.observe([record])}
            onDraft={(record, value) => setDrafts(old => old[record.id] === value ? old : { ...old, [record.id]: value })}
          />
        ) : (
          <TaskLine
            key={t.id}
            task={t}
            selected={false}
            onSelect={() => open(t)}
          />
        ),
      )}
      {data && !data.records.length && !error && (
        <p className="empty">No records in these results.</p>
      )}
      {data?.next_cursor && (
        <button disabled={busy} onClick={more}>
          Show more
        </button>
      )}
      {ids?.length && (
        <button
          className="text-action"
          onClick={() =>
            app.go({ page: "Activity", input: { from_request_ids: ids } })
          }
        >
          Related activity
        </button>
      )}
    </section>
  );
}
