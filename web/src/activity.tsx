import { categoryNames } from "./activity-labels";
import { useEffect, useRef, useState } from "react";
import {
  Activity as ActivityIcon,
  Repeat2,
  Check,
  ChevronRight,
  Folder,
  ChevronLeft,
} from "lucide-react";
import { type Change, type Changes, type Args, errorText } from "./api";
import { useEnvironment } from "./app-context";
import { usePageReads } from "./page-refresh";
import { useExpandedView } from "./expanded-view";
import { ChangeCard } from "./shared";
import { SecondaryPages } from "./secondary-pages";
import { defaultZone } from "./calendar-context";

function activityAction(change: Change) {
  if (change.activity) return `${categoryNames[change.activity.category] || "Edited"}${change.activity.automatic ? " · Automatic" : ""}${change.activity.undone_by_change_id ? " · Undone" : ""}`;
  if (change.undoes_change_id) return "Undid a change";
  if (change.operation === "create_recurrence") return "Started repeating";
  if (change.operation === "create_project") return "Created project";
  const fields = change.changed_fields || [];
  if (change.operation === "capture")
    return change.entity_type === "project"
      ? "Created project"
      : change.entity_type === "recurrence"
        ? "Started repeating"
        : "Added";
  if (
    fields.includes("deleted") ||
    (change.before?.deleted !== undefined &&
      change.before.deleted !== change.after.deleted)
  )
    return change.after.deleted ? "Deleted" : "Restored";
  if (
    fields.includes("archived") ||
    (change.before?.archived !== undefined &&
      change.before.archived !== change.after.archived)
  )
    return change.after.archived ? "Archived" : "Unarchived";
  if (
    fields.includes("status") ||
    (change.before && change.before.status !== change.after.status)
  )
    return change.after.status === "done"
      ? "Completed"
      : `Moved to ${change.after.status === "next" ? "Next actions" : change.after.status.charAt(0).toUpperCase() + change.after.status.slice(1)}`;
  if (fields.includes("due_date"))
    return change.after.due_date ? "Changed due date" : "Cleared due date";
  return change.entity_type === "recurrence" ? "Updated repeat" : "Edited";
}
function activityTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: defaultZone,
  }).format(new Date(value));
}

export function Activity({
  revision,
  input = {},
  onSelect,
}: {
  revision: number;
  input?: Args;
  onSelect: (id: string, kind?: "task" | "project" | "recurrence") => void;
}) {
  const { api, compact } = useEnvironment();
  const [automatic, setAutomatic] = useState(false);
  const chart = input.chart as Args | undefined;
  const query = chart ? {...chart, automatic, ...(automatic ? {category: undefined} : {})} : input;
  const queryKey = JSON.stringify(query);
  const operation = chart ? "activity_day" : "list_changes";
  const { refreshRevision } = usePageReads();
  const expand = useExpandedView();
  const [selectedChange, setSelectedChange] = useState<Change | null>(null);
  const [page, setPage] = useState(0);
  const [changes, setChanges] = useState<Change[]>([]),
    [cursor, setCursor] = useState<string | number | null>(null),
    [error, setError] = useState(""),
    [olderRevision, setOlderRevision] = useState<number | null>(null),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const generation = useRef(0),
    paging = useRef(false);
  const older = olderRevision === refreshRevision;
  const setOlder = (value: boolean) =>
    setOlderRevision(value ? refreshRevision : null);
  useEffect(() => {
    if (older) return;
    const current = ++generation.current;
    setLoading(true);
    setPage(0);
    api
      .call<Changes>(operation, { ...query, limit: 30 })
      .then((r) => {
        if (current === generation.current) {
          setChanges(r.changes);
          setCursor(r.next_cursor ?? r.next_before_id);
          setError("");
        }
      })
      .catch((e) => {
        if (current === generation.current) setError(errorText(e));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      if (current === generation.current) generation.current++;
    };
  }, [revision, older, retry, queryKey]);
  async function loadOlder() {
    if (paging.current || cursor === null) return;
    paging.current = true;
    const current = ++generation.current;
    setOlder(true);
    setLoading(true);
    setError("");
    try {
      const r = await api.call<Changes>(operation, {
        ...query,
        ...(typeof cursor === "number" ? {before_id: cursor} : {cursor}),
        limit: 30,
      });
      if (current === generation.current) {
        setChanges((previous) => {
          const ids = new Set(previous.map((change) => change.id));
          return [
            ...previous,
            ...r.changes.filter((change) => !ids.has(change.id)),
          ];
        });
        setCursor(r.next_cursor ?? r.next_before_id);
      }
    } catch (e) {
      if (current === generation.current) setError(errorText(e));
    } finally {
      paging.current = false;
      if (current === generation.current) setLoading(false);
    }
  }
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(changes.length / 4) - 1),
  );
  if (selectedChange)
    return (
      <section className="activity-detail">
        <div className="expanded-only">
          <button
            className="text-action"
            onClick={() => setSelectedChange(null)}
          >
            <ChevronLeft />
            Back to activity
          </button>
          <ChangeCard change={selectedChange} onSelect={onSelect} api={api} />
        </div>
        <button
          className="text-action preview-resume secondary-resume"
          onClick={() => expand(() => {})}
        >
          View change <ChevronRight />
        </button>
      </section>
    );
  const heading = chart && <div className="chart-controls"><span>{String(chart.day)}{chart.category ? ` · ${categoryNames[String(chart.category)]}` : ""}</span><label><input type="checkbox" checked={automatic} onChange={e=>{setOlder(false);setAutomatic(e.target.checked);}}/> Automatic</label></div>;
  if (compact)
    return (
      <section
        className="compact-widget compact-secondary compact-activity"
        aria-label="Recent activity"
        aria-busy={loading}
      >
        {heading}
        {error && (
          <div className="secondary-error" role="alert">
            {error}
            <button
              disabled={loading}
              onClick={() =>
                older ? void loadOlder() : setRetry((n) => n + 1)
              }
            >
              Retry
            </button>
          </div>
        )}
        {!changes.length && !error && (
          <div className="compact-empty">
            {loading ? "Loading…" : "No activity yet."}
          </div>
        )}
        <div className="secondary-rows">
          {changes
            .slice(currentPage * 4, (currentPage + 1) * 4)
            .map((change) => (
              <button
                className="secondary-record"
                key={change.id}
                onClick={() => expand(() => setSelectedChange(change))}
                aria-label={`View change: ${change.after.title}`}
              >
                <span className="activity-glyph" aria-hidden="true">
                  {change.entity_type === "project" ? (
                    <Folder />
                  ) : change.entity_type === "recurrence" ? (
                    <Repeat2 />
                  ) : change.after.status === "done" ? (
                    <Check />
                  ) : (
                    <ActivityIcon />
                  )}
                </span>
                <span>
                  <strong>{change.after.title}</strong>
                  <small>
                    {activityAction(change)} ·{" "}
                    <time dateTime={change.created_at}>
                      {activityTime(change.created_at)}
                    </time>
                  </small>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            ))}
        </div>
        <SecondaryPages
          page={currentPage}
          more={(currentPage + 1) * 4 < changes.length || cursor !== null}
          busy={loading}
          previous={() => setPage(currentPage - 1)}
          next={() => {
            if ((currentPage + 1) * 4 < changes.length)
              setPage(currentPage + 1);
            else void loadOlder().then(() => setPage(currentPage + 1));
          }}
        />
      </section>
    );
  return (
    <section className="panel activity" aria-busy={loading}>
      {heading}
      {error && (
        <div role="alert" className="banner error">
          {error}{" "}
          <button
            disabled={loading}
            onClick={() =>
              older ? void loadOlder() : setRetry((value) => value + 1)
            }
          >
            Retry
          </button>
        </div>
      )}
      {older && (
        <div className="banner">
          Viewing older history.{" "}
          <button disabled={loading} onClick={() => setOlder(false)}>
            Back to latest
          </button>
        </div>
      )}
      {!changes.length && !error && (
        <p className="empty" role={loading ? "status" : undefined}>
          {loading ? "Loading activity…" : "No activity in this period."}
        </p>
      )}
      {changes.map((c) => (
        <ChangeCard key={c.id} change={c} onSelect={onSelect} api={api} />
      ))}
      {cursor !== null && (
        <button disabled={loading} onClick={loadOlder}>
          {loading && older ? "Loading older changes…" : "Load older changes"}
        </button>
      )}
    </section>
  );
}
