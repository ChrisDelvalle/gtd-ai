import { useEffect, useMemo, useReducer } from "react";
import { AlertCircle, CalendarDays } from "lucide-react";
import { isArchived, type Moment, type Task } from "./api";
import { applicationNow } from "./application-clock";
import { defaultZone } from "./calendar-context";
import {
  clockLabel,
  momentInstant,
  momentLabel,
  shortTimezone,
} from "./planning-fields";

const monthDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function DeadlineChip({
  deadline,
  project,
  live,
  onEdit,
}: {
  deadline: Moment;
  project?: string;
  live: boolean;
  onEdit?: () => void;
}) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const now = applicationNow();
  const yearFormat = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        timeZone: defaultZone,
      }),
    [defaultZone],
  );
  const year = yearFormat.format(now);
  const boundary = useMemo(
    () => momentInstant(deadline, true),
    [
      deadline.date,
      deadline.time,
      deadline.timezone,
      deadline.utc_offset_minutes,
    ],
  );
  const nextYear = useMemo(
    () =>
      momentInstant({
        date: `${Number(year) + 1}-01-01`,
        timezone: defaultZone,
      }),
    [year, defaultZone],
  );
  // Only a local label update: an idle row must not require an MCP round trip.
  // Recheck after visibility changes and cap long timers at a day (no overflow).
  useEffect(() => {
    const update = () => refresh();
    const next = Math.min(
      ...[boundary, nextYear].filter((t): t is number => t != null && t > now),
    );
    const timer = window.setTimeout(
      update,
      Math.min(next - now + 25, 86400_000),
    );
    const visible = () => {
      if (!document.hidden) update();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [boundary, nextYear, now]);
  const overdue = live && boundary != null && now >= boundary;
  const differentYear = deadline.date.slice(0, 4) !== year;
  const label = `${overdue ? "Overdue · " : ""}${project ? `Project deadline · ${project}` : "Deadline"}: ${momentLabel(deadline)}`;
  const Icon = overdue ? AlertCircle : CalendarDays;
  const content = (
    <>
      <Icon aria-hidden="true" />
      <span>
        <time dateTime={deadline.date}>
          {overdue && <span className="sr-only">Overdue: </span>}
          {monthDay.format(new Date(`${deadline.date}T12:00:00Z`))}
          {differentYear && (
            <>
              <span className="date-chip-comma">, </span>
              <span className="date-chip-year">
                {deadline.date.slice(0, 4)}
              </span>
            </>
          )}
          {deadline.time && (
            <span className="date-chip-time">{` · ${clockLabel(deadline.time)} ${shortTimezone(deadline)}`}</span>
          )}
        </time>
        {project && <small className="date-chip-source">Project</small>}
      </span>
    </>
  );
  const props = {
    className: "date-chip",
    title: label,
    "data-overdue": overdue || undefined,
  };
  return onEdit ? (
    <button
      type="button"
      {...props}
      aria-label={`Edit due date: ${deadline.date}${overdue ? " (overdue)" : ""}`}
      onClick={onEdit}
    >
      {content}
    </button>
  ) : (
    <span {...props}>{content}</span>
  );
}

export function TaskDeadline({
  task,
  onEdit,
}: {
  task: Task;
  onEdit?: () => void;
}) {
  // Match Planning::deadline: legacy date-only deadlines use this stored-policy
  // timezone, not the browser zone or the account default for new input.
  const own = task.due_date && {
    date: task.due_date,
    timezone: "America/New_York",
    ...task.deadline_time,
  };
  const inherited =
    task.recommendation?.deadline_project &&
    task.recommendation.effective_deadline;
  const deadline = own || inherited;
  if (!deadline) return null;
  return (
    <DeadlineChip
      deadline={deadline}
      project={!own ? task.recommendation?.deadline_project?.title : undefined}
      live={
        task.status !== "done" &&
        !isArchived(task) &&
        !task.deleted &&
        !task.occurrence?.skipped
      }
      onEdit={own ? onEdit : undefined}
    />
  );
}
