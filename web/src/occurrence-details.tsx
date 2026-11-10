import { useEffect, useRef, useState } from "react";
import {
  type Api,
  type Task,
  type Occurrences,
  today,
  day,
  errorText,
} from "./api";
import { MetadataRow } from "./metadata";
import { TaskContext } from "./task-context";
import { readSeries, repeatSummary } from "./repeat-model";
type OccurrenceRow = Occurrences["occurrences"][number];

export function OccurrenceDetails({
  task,
  api,
  revision = 0,
  onSeries,
}: {
  task: Task;
  api: Api;
  revision?: number;
  onSeries?: (series: Task) => void;
  onTask?: (task: Task) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const seriesId =
    task.occurrence?.series_id ||
    (task.entity_type === "recurrence" ? task.id : null);
  const preview = task.occurrence ? task.widget_preview : undefined;
  const [data, setData] = useState<Occurrences | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const reportSeries = useRef(onSeries);
  reportSeries.current = onSeries;
  useEffect(() => {
    if (!seriesId || preview) return;
    let active = true;
    const isNext = (row: OccurrenceRow) =>
      row.scheduled_date >= today() &&
      !row.task?.deleted &&
      !row.task?.occurrence?.skipped &&
      row.task?.status !== "done";
    async function read() {
      let result = await api.call<Occurrences>("list_occurrences", {
        series_id: seriesId,
        from: today(),
        limit: task.occurrence ? 1 : 10,
      });
      if (task.entity_type === "recurrence" && !result.series?.recurrence) {
        result.series = await readSeries(api, seriesId!);
      }
      // A completed/skipped date can precede the next actionable date. Read a
      // bounded number of pages rather than mislabeling that as an empty future.
      for (
        let page = 0;
        active &&
        !task.occurrence &&
        result.next_cursor &&
        !result.occurrences.some(isNext) &&
        page < 2;
        page++
      ) {
        const next = await api.call<Occurrences>("list_occurrences", {
          series_id: seriesId,
          from: today(),
          limit: 10,
          cursor: result.next_cursor,
        });
        // Later pages contain compact series summaries; retain the full defaults.
        result = { ...next, series: result.series || next.series };
      }
      return result;
    }
    read()
      .then((result) => {
        if (active) {
          setData(result);
          setError("");
          if (result.series) reportSeries.current?.(result.series);
        }
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [api, seriesId, task.version, preview, revision, attempt]);
  if (!seriesId) return null;
  const series =
    data?.series || (task.entity_type === "recurrence" ? task : null);
  const rule =
    preview?.repeat_rule ?? (series?.recurrence_summary?.current_rule ||
    series?.recurrence?.segments.at(-1)?.rule);
  const next = data?.occurrences.find(
    (row) =>
      row.scheduled_date >= today() &&
      !row.task?.deleted &&
      !row.task?.occurrence?.skipped &&
      row.task?.status !== "done",
  );
  const date = task.occurrence?.scheduled_date || next?.scheduled_date;
  const template =
    task.entity_type === "recurrence"
      ? series?.recurrence?.segments.at(-1)?.template
      : null;
  return (
    <div className="repeat-overview">
      {series &&
        template &&
        (template.brief || template.notes || template.links.length > 0 || template.location) && (
          <TaskContext
            task={{
              ...series,
              title: template.title,
              notes: template.notes,
              brief: template.brief,
              links: template.links,
              location: template.location,
            }}
            api={api}
          />
        )}
      <div className="repeat-overview-summary">
        <MetadataRow label="Repeat">
          {rule
            ? repeatSummary(rule)
            : error || preview
              ? "Schedule unavailable"
              : "Loading schedule…"}
        </MetadataRow>
        {date && (
          <MetadataRow label={task.occurrence ? "Scheduled" : "Next"}>
            {day(date)}
          </MetadataRow>
        )}
        {!date && data && (
          <small className="muted">
            {data.next_cursor
              ? "Open occurrences to see more dates."
              : "No upcoming occurrence in this date range."}
          </small>
        )}
      </div>
      {error && (
        <div role="alert" className="recovery">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt(attempt + 1)}>
            Reload repeat summary
          </button>
        </div>
      )}
    </div>
  );
}
