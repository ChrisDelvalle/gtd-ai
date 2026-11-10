import { useState, useEffect } from "react";
import { get, errorText, time } from "./api";
import { usePolling, useRefresh } from "./shared";
import { usePageReads } from "./page-refresh";

type Event = {
  id: number;
  call_id: string;
  created_at: string;
  source: string;
  operation: string;
  outcome: string;
  duration_ms: number | null;
  code: string | null;
  task_id: string | null;
  change_id: number | null;
  replayed: boolean;
  message: string | null;
};
type Events = {
  events: Event[];
  next_before_id: number | null;
  expired_events: number;
};
export function Logs({
  onSelect,
  externalRevision,
}: {
  onSelect: (id: string) => void;
  externalRevision: number;
}) {
  const { track, refreshing, refreshRevision } = usePageReads();
  const [source, setSource] = useState(""),
    [operation, setOperation] = useState(""),
    [outcome, setOutcome] = useState(""),
    [since, setSince] = useState(""),
    [until, setUntil] = useState(""),
    [pageCursor, setPageCursor] = useState<{ id: number; revision: number } | null>(null);
  const cursor = pageCursor?.revision === refreshRevision ? pageCursor.id : null;
  const setCursor = (id: number | null) => setPageCursor(id === null ? null : { id, revision: refreshRevision });
  const [live, setLive] = useState(true),
    [result, setResult] = useState<Events | null>(null),
    [error, setError] = useState(""),
    [revision, refresh] = useRefresh();
  const sinceDate = since ? new Date(since) : null;
  const untilDate = until ? new Date(until) : null;
  const rangeError =
    (sinceDate && !Number.isFinite(sinceDate.getTime())) ||
    (untilDate && !Number.isFinite(untilDate.getTime()))
      ? "Enter a valid date and time."
      : sinceDate && untilDate && sinceDate > untilDate
        ? "The end time must be after the start time."
        : "";
  usePolling(refresh, live && !cursor && !rangeError && !refreshing);
  useEffect(() => {
    if (rangeError) return;
    let active = true;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({
      source,
      operation,
      outcome,
      since: since ? new Date(since).toISOString() : "",
      until: until ? new Date(until).toISOString() : "",
      before_id: cursor?.toString() || "",
    })) {
      if (v) params.set(k, v);
    }
    track(() => get<Events>(`/api/logs?${params}`))
      .then((r) => {
        if (active) {
          setResult(r);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [
    source,
    operation,
    outcome,
    since,
    until,
    cursor,
    revision,
    externalRevision,
    rangeError,
    track,
  ]);
  function change(fn: () => void) {
    setCursor(null);
    fn();
  }
  return (
    <section className="panel">
      <div className="logs-toolbar">
        <label>
          Source
          <select
            value={source}
            onChange={(e) => change(() => setSource(e.target.value))}
          >
            <option value="">All sources</option>
            {["mcp", "web", "tunnel"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select
            value={outcome}
            onChange={(e) => change(() => setOutcome(e.target.value))}
          >
            <option value="">All outcomes</option>
            {["success", "error", "incomplete", "warning", "info"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Operation
          <input
            value={operation}
            placeholder="e.g. update_item"
            onChange={(e) => change(() => setOperation(e.target.value))}
          />
        </label>
        <label>
          From <small>(browser time)</small>
          <input
            type="datetime-local"
            aria-invalid={!!rangeError}
            aria-describedby={rangeError ? "logs-range-error" : undefined}
            value={since}
            onChange={(e) => change(() => setSince(e.target.value))}
          />
        </label>
        <label>
          Through <small>(browser time)</small>
          <input
            type="datetime-local"
            aria-invalid={!!rangeError}
            aria-describedby={rangeError ? "logs-range-error" : undefined}
            value={until}
            onChange={(e) => change(() => setUntil(e.target.value))}
          />
        </label>
      </div>
      {rangeError && (
        <div id="logs-range-error" role="alert" className="banner error">
          {rangeError}
        </div>
      )}
      <div className="logs-actions">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => {
              setLive(e.target.checked);
              if (e.target.checked) setCursor(null);
            }}
          />
          Live follow
        </label>
        {cursor !== null && <button
          onClick={() => {
            setCursor(null);
            refresh();
          }}
        >
          Latest events
        </button>}
        <span className="muted">
          30 days · 256 MiB maximum · {result?.expired_events || 0} expired
        </span>
      </div>
      {error && (
        <div role="alert" className="banner error">
          {error}
          {result
            ? " Showing last loaded events."
            : " Events could not be loaded."}
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Source / operation</th>
              <th>Outcome</th>
              <th>Duration</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {result?.events.map((e) => (
              <tr key={e.id}>
                <td>
                  {time(e.created_at)}
                  <small>#{e.id}</small>
                </td>
                <td>
                  {e.source}
                  <strong>{e.operation}</strong>
                </td>
                <td>
                  <span className={`badge ${e.outcome}`}>{e.outcome}</span>
                  {e.replayed && <small>Replayed safely</small>}
                </td>
                <td>{e.duration_ms === null ? "—" : `${e.duration_ms} ms`}</td>
                <td>
                  {e.code && <strong>{e.code}</strong>}
                  {e.change_id && (
                    <button
                      className="link"
                      onClick={() => e.task_id && onSelect(e.task_id)}
                    >
                      Change #{e.change_id}
                    </button>
                  )}
                  {e.message && <span>{e.message}</span>}
                  <details>
                    <summary>Call details</summary>
                    <code>{e.call_id}</code>
                    {e.task_id && <p>Task: {e.task_id}</p>}
                    {e.outcome === "incomplete" && (
                      <p>
                        Started, but no outcome was recorded. It may still be
                        running or may have been interrupted.
                      </p>
                    )}
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result && !result.events.length && !rangeError && (
        <p className="empty">No events match these filters.</p>
      )}
      <div className="pagination">
        <button disabled={!cursor} onClick={() => setCursor(null)}>
          Back to latest
        </button>
        <button
          disabled={!!rangeError || !result?.next_before_id}
          onClick={() => {
            setLive(false);
            setCursor(result!.next_before_id);
          }}
        >
          Older events →
        </button>
      </div>
    </section>
  );
}
type HealthData = {
  environment: string;
  search: {
    ready: boolean;
    configured: boolean;
    indexed_checkpoint?: number;
    store_checkpoint?: number;
    last_success?: string;
  };
  database: boolean;
  tunnel: {
    reachable: boolean;
    ready: boolean;
    live?: boolean;
    last_poll_success?: string;
    consecutive_failures?: number;
    requests_completed?: number;
    failures?: number;
    timeouts?: number;
    responses_accepted?: number;
  };
  diagnostics: {
    available: boolean;
    failure_markers: string[];
    last_successful_call?: string;
  };
  version: string;
  checked_at: string;
};
export function Health({ revision }: { revision: number }) {
  const { track } = usePageReads();
  const [health, setHealth] = useState<HealthData | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    track(() => get<HealthData>("/api/health"))
      .then((r) => {
        if (active) {
          setHealth(r);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [revision, track]);
  return (
    <>
      {error && (
        <div role="alert" className="banner error">
          {error} Health information below may be stale.
        </div>
      )}
      <div className="health-grid">
        {[
          [
            "Task database",
            health?.database,
            "Authoritative tasks and permanent change history.",
          ],
          [
            "OpenAI tunnel",
            health?.tunnel.ready,
            "A private connection to your ChatGPT plugin.",
          ],
          [
            "Search index",
            health?.search?.ready,
            "Search waits for committed records to be indexed. Other reads and writes remain available.",
          ],
          [
            "Diagnostic logging",
            health
              ? health.diagnostics.available &&
                !health.diagnostics.failure_markers.length
              : undefined,
            "30 days of calls and service events.",
          ],
        ].map(([title, ok, desc]) => (
          <section className="panel health-card" key={String(title)}>
            <span
              className={`health-orb ${ok === true ? "good" : ok === false ? "bad" : ""}`}
            />
            <h2>{title}</h2>
            <strong>
              {ok === undefined
                ? "Checking…"
                : ok
                  ? "Available"
                  : "Needs attention"}
            </strong>
            <p className="muted">{desc}</p>
          </section>
        ))}
      </div>
      {health && (
        <section className="panel health-details">
          <h2>Connection details</h2>
          <dl>
            {[
              [
                "Last successful poll",
                health.tunnel.last_poll_success
                  ? time(health.tunnel.last_poll_success)
                  : undefined,
              ],
              [
                "Last successful task call",
                health.diagnostics.last_successful_call
                  ? time(health.diagnostics.last_successful_call)
                  : undefined,
              ],
              [
                "Completed transport requests",
                health.tunnel.requests_completed,
              ],
              [
                "Responses accepted by OpenAI",
                health.tunnel.responses_accepted,
              ],
              [
                "Consecutive polling failures",
                health.tunnel.consecutive_failures,
              ],
              ["Transport failures", health.tunnel.failures],
              ["Transport timeouts", health.tunnel.timeouts],
              ["Search checkpoint", health.search?.indexed_checkpoint],
              ["Store checkpoint", health.search?.store_checkpoint],
              ["Service version", health.version],
            ].map(([k, v]) => (
              <div key={String(k)}>
                <dt>{k}</dt>
                <dd>{v ?? "Unavailable"}</dd>
              </div>
            ))}
          </dl>
          {health.diagnostics.failure_markers.length > 0 && (
            <p role="alert">
              Logging failure recorded in:{" "}
              {health.diagnostics.failure_markers.join(", ")}
            </p>
          )}
          <p className="muted">
            Transport success does not guarantee that a task operation
            succeeded. Check Logs for application outcomes.
          </p>
          <small>Checked {time(health.checked_at)}</small>
        </section>
      )}
    </>
  );
}
