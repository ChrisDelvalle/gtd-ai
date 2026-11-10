import { applicationNow } from "./application-clock";
import { useEffect, useId, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import {
  type Api,
  type Args,
  type Clock,
  type Importance,
  type List,
  type Moment,
  type Planning,
  type RelativeMoment,
  type RepeatTemplate,
  type Task,
  day,
  importanceLevels,
} from "./api";
import {
  EstimateFields,
  BufferField,
  WorkBlockFields,
  RelativeBlockFields,
  RelativeMomentField,
  taskBlocks,
} from "./planning-schedule";
import { TaskExpansion } from "./task-expansion";
import { MetadataRow } from "./metadata";
import { defaultZone } from "./calendar-context";
export { defaultZone } from "./calendar-context";

export const planningKeys = [
  "importance",
  "deadline_time",
  "start_by",
  "estimated_minutes",
  "effort",
  "not_before",
  "safety_buffer",
  "work_blocks",
] as const;
export type PlanningDraft = {
  [K in (typeof planningKeys)[number]]: NonNullable<Planning[K]> | null;
};
export function planningDraft(task: Planning): PlanningDraft {
  return Object.fromEntries(
    planningKeys.map((k) => [
      k,
      k === "work_blocks"
        ? taskBlocks(task)
        : (task[k] ?? (k === "importance" ? "normal" : null)),
    ]),
  ) as PlanningDraft;
}
export function planningArgs(args: Args) {
  const clears: string[] = [];
  for (const key of planningKeys)
    if (key in args && args[key] === null) {
      delete args[key];
      clears.push(key);
    }
  if (clears.length) args.clear_planning = clears;
}
export function importanceLabel(value: Importance) {
  return value.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase());
}
function localText(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((v) => [v.type, v.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function nowMoment(): Moment {
  const now = new Date(applicationNow()),
    local = localText(now, defaultZone),
    time = local.slice(11);
  const offset = Math.round(
    (Date.parse(`${local}Z`) - Math.floor(now.getTime() / 60000) * 60000) /
      60000,
  );
  return {
    date: local.slice(0, 10),
    time,
    timezone: defaultZone,
    utc_offset_minutes: offset,
  };
}
// Enumerate real instants rather than silently normalizing a DST gap or repeated clock time.
export function candidates(m: Moment): { instant: number; offset: number }[] {
  if (!m.time) return [];
  const wall = `${m.date}T${m.time}`,
    naive = Date.parse(`${wall}Z`);
  if (!Number.isFinite(naive)) return [];
  try {
    const offsets = new Set<number>();
    for (const hours of [-36, -12, 0, 12, 36]) {
      const sample = naive + hours * 3600000;
      offsets.add(
        (Date.parse(`${localText(new Date(sample), m.timezone)}Z`) - sample) /
          60000,
      );
    }
    return [...offsets]
      .map((offset) => ({ offset, instant: naive - offset * 60000 }))
      .filter((v) => localText(new Date(v.instant), m.timezone) === wall)
      .sort((a, b) => a.instant - b.instant);
  } catch {
    return [];
  }
}
export function momentInstant(m: Moment, end = false): number | undefined {
  let value = m;
  if (!m.time) {
    const d = new Date(`${m.date}T12:00:00Z`);
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    if (Number.isNaN(d.getTime())) return;
    value = { ...m, date: d.toISOString().slice(0, 10), time: "00:00" };
  }
  const options = candidates(value);
  return (
    value.utc_offset_minutes != null
      ? options.find((c) => c.offset === value.utc_offset_minutes)
      : options.length === 1
        ? options[0]
        : undefined
  )?.instant;
}
export function clockLabel(value: string) {
  const [h, m] = value.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
export function shortTimezone(value: Moment) {
  if (!value.time) return "";
  try {
    const instant = momentInstant(value);
    return (
      new Intl.DateTimeFormat("en-US", {
        timeZone: value.timezone,
        timeZoneName: instant == null ? "shortGeneric" : "short",
      })
        .formatToParts(new Date(instant ?? `${value.date}T12:00:00Z`))
        .find((part) => part.type === "timeZoneName")?.value || ""
    );
  } catch {
    return "";
  }
}
export function momentLabel(value: Moment) {
  return `${day(value.date)}${value.time ? ` · ${clockLabel(value.time)} ${shortTimezone(value)}` : ""}`.trim();
}
export function plannedLines(
  start: Moment,
  finish?: Moment | null,
): [string, string?] {
  const clock = (value: Moment) =>
    value.time
      ? `${clockLabel(value.time)} ${shortTimezone(value)}`.trim()
      : undefined;
  if (!finish) return [day(start.date), clock(start)];
  let date = day(start.date);
  if (start.date !== finish.date) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    date =
      start.date < finish.date
        ? formatter.formatRange(
            new Date(`${start.date}T12:00:00Z`),
            new Date(`${finish.date}T12:00:00Z`),
          )
        : `${day(start.date)} – ${day(finish.date)}`;
  }
  if (!start.time || !finish.time) return [date];
  const zone = shortTimezone(start);
  return [
    date,
    start.timezone === finish.timezone && zone === shortTimezone(finish)
      ? `${clockLabel(start.time)}–${clockLabel(finish.time)} ${zone}`.trim()
      : `${clock(start)} – ${clock(finish)}`,
  ];
}
function DateTimeValue({ date, time }: { date: string; time?: string }) {
  return (
    <>
      <span className="metadata-date">{date}</span>
      {time && <span className="metadata-time">{time}</span>}
    </>
  );
}
export function MomentValue({ value }: { value: Moment }) {
  return (
    <DateTimeValue
      date={day(value.date)}
      time={
        value.time
          ? `${clockLabel(value.time)} ${shortTimezone(value)}`.trim()
          : undefined
      }
    />
  );
}
export function PlannedValue({
  start,
  finish,
}: {
  start: Moment;
  finish?: Moment | null;
}) {
  const [date, time] = plannedLines(start, finish);
  return <DateTimeValue date={date} time={time} />;
}
export function RecordedTimeValue({ value }: { value: string }) {
  const instant = new Date(value);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: defaultZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(instant);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: defaultZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
  return <DateTimeValue date={date} time={time} />;
}
export function ClockFields({
  value,
  date,
  onChange,
  label,
}: {
  value: Clock;
  date?: string;
  onChange: (v: Clock | null) => void;
  label: string;
}) {
  const possible = date ? candidates({ date, ...value }) : [];
  return (
    <div className="planning-clock">
      <div className="planning-clock-row">
        <label>
          Time
          <input
            aria-label={`${label} time`}
            type="time"
            required
            value={value.time}
            onChange={(e) =>
              onChange({
                ...value,
                time: e.target.value,
                utc_offset_minutes: undefined,
              })
            }
          />
        </label>
        <label>
          Timezone
          <input
            aria-label={`${label} timezone`}
            required
            value={value.timezone}
            placeholder={defaultZone}
            onChange={(e) =>
              onChange({
                ...value,
                timezone: e.target.value,
                utc_offset_minutes: undefined,
              })
            }
          />
        </label>
        <button
          type="button"
          className="icon-button"
          aria-label={`Remove ${label.toLowerCase()} time`}
          onClick={() => onChange(null)}
        >
          <X />
        </button>
      </div>
      {possible.length === 2 && (
        <label>
          Clock change
          <select
            aria-label={`${label} clock occurrence`}
            required
            value={value.utc_offset_minutes ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                utc_offset_minutes:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          >
            <option value="">Choose which occurrence</option>
            {possible.map((p, i) => (
              <option key={p.instant} value={p.offset}>
                {i === 0 ? "First" : "Second"} occurrence (UTC
                {p.offset < 0 ? "−" : "+"}
                {Math.floor(Math.abs(p.offset) / 60)}:
                {String(Math.abs(p.offset) % 60).padStart(2, "0")})
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
export function MomentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Moment | null;
  onChange: (v: Moment | null) => void;
}) {
  return (
    <div className="planning-field">
      <div className="planning-date-row">
        <label>
          {label}
          <input
            type="date"
            value={value?.date || ""}
            onChange={(e) =>
              onChange(
                e.target.value
                  ? {
                      ...value,
                      date: e.target.value,
                      timezone: value?.timezone || defaultZone,
                      utc_offset_minutes: undefined,
                    }
                  : null,
              )
            }
          />
        </label>
        {!value?.time && (
          <button
            type="button"
            className="text-action"
            disabled={!value?.date}
            onClick={() => value && onChange({ ...value, time: "09:00" })}
          >
            Add time<span className="sr-only"> to {label.toLowerCase()}</span>
          </button>
        )}
      </div>
      {value?.time && (
        <ClockFields
          label={label}
          value={{
            time: value.time,
            timezone: value.timezone,
            utc_offset_minutes: value.utc_offset_minutes,
          }}
          date={value.date}
          onChange={(clock) =>
            onChange(
              clock
                ? { ...value, ...clock }
                : { date: value.date, timezone: value.timezone },
            )
          }
        />
      )}
    </div>
  );
}
export function ImportanceField({
  value,
  onChange,
  compact = false,
  disabled = false,
}: {
  value: Importance | null | undefined;
  onChange: (v: Importance) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className={compact ? "capture-importance" : undefined}>
      <span className={compact ? "sr-only" : undefined}>Importance</span>
      <select
        aria-label="Importance"
        value={value || "normal"}
        required
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Importance)}
      >
        {importanceLevels.map((i) => (
          <option value={i} key={i}>
            {importanceLabel(i)}
          </option>
        ))}
      </select>
    </label>
  );
}
export function PlanningFields({
  value,
  dueDate,
  onChange,
  api,
  taskId,
  required = false,
}: {
  value: PlanningDraft;
  dueDate: string;
  onChange: (v: PlanningDraft) => void;
  api: Api;
  taskId: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(
    !!(
      value.deadline_time ||
      value.start_by ||
      value.not_before ||
      value.safety_buffer ||
      value.work_blocks?.length
    ),
  );
  const id = useId();
  return (
    <div className="planning-fields">
      <ImportanceField
        value={value.importance}
        onChange={(importance) => onChange({ ...value, importance })}
      />
      <EstimateFields
        value={value}
        required={required}
        onChange={(v) => onChange({ ...value, ...v })}
      />
      <button
        type="button"
        className="text-action"
        aria-controls={id}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Timing <ChevronDown className={open ? "turned" : ""} />
      </button>
      <TaskExpansion open={open}>
        <div id={id} className="planning-fields-inner">
          {dueDate && (
            <div className="planning-field">
              <span className="field-label">Deadline time</span>
              {value.deadline_time ? (
                <ClockFields
                  label="Deadline"
                  date={dueDate}
                  value={value.deadline_time}
                  onChange={(deadline_time) =>
                    onChange({ ...value, deadline_time })
                  }
                />
              ) : (
                <button
                  type="button"
                  className="text-action"
                  onClick={() =>
                    onChange({
                      ...value,
                      deadline_time: { time: "17:00", timezone: defaultZone },
                    })
                  }
                >
                  Add time<span className="sr-only"> to deadline</span>
                </button>
              )}
            </div>
          )}
          {dueDate && (
            <BufferField
              value={value.safety_buffer}
              timed={!!value.deadline_time}
              onChange={(safety_buffer) =>
                onChange({ ...value, safety_buffer })
              }
            />
          )}
          <MomentField
            label="Not before"
            value={value.not_before}
            onChange={(not_before) => onChange({ ...value, not_before })}
          />
          <MomentField
            label="Start by"
            value={value.start_by}
            onChange={(start_by) => onChange({ ...value, start_by })}
          />
          <WorkBlockFields
            value={value.work_blocks || []}
            onChange={(work_blocks) => onChange({ ...value, work_blocks })}
            api={api}
            taskId={taskId}
            notBefore={value.not_before}
            dueDate={dueDate}
            deadlineClock={value.deadline_time}
          />
        </div>
      </TaskExpansion>
    </div>
  );
}
export function PlanningContext({ task }: { task: Task }) {
  return (
    <div className="planning-context">
      {task.importance && (
        <MetadataRow label="Importance" importance={task.importance}>
          {importanceLabel(task.importance)}
        </MetadataRow>
      )}
      {task.due_date && (
        <MetadataRow label="Deadline" kind="deadline">
          {task.deadline_time ? (
            <MomentValue
              value={{ date: task.due_date, ...task.deadline_time }}
            />
          ) : (
            day(task.due_date)
          )}
        </MetadataRow>
      )}
      {task.start_by && (
        <MetadataRow label="Start by">
          <MomentValue value={task.start_by} />
        </MetadataRow>
      )}
      {task.estimated_minutes != null && (
        <MetadataRow label="Estimate">{task.estimated_minutes} min</MetadataRow>
      )}
      {task.effort && (
        <MetadataRow label="Effort">
          {importanceLabel(task.effort as Importance)}
        </MetadataRow>
      )}
      {task.not_before && (
        <MetadataRow label="Available">
          <MomentValue value={task.not_before} />
        </MetadataRow>
      )}
      {task.safety_buffer && (
        <MetadataRow label="Buffer">
          {task.safety_buffer.value} {task.safety_buffer.unit}
        </MetadataRow>
      )}
      {task.buffer_target && (
        <MetadataRow label="Buffer target">
          <MomentValue value={task.buffer_target} />
        </MetadataRow>
      )}
      {taskBlocks(task).map((block, i) => (
        <MetadataRow label={i ? "" : "Planned"} key={block.id}>
          {block.calendar_event ? (
            <a
              href={block.calendar_event.url}
              title={block.calendar_event.label || undefined}
              target="_blank"
              rel="noreferrer"
            >
              <PlannedValue start={block.start} finish={block.finish} />
            </a>
          ) : (
            <PlannedValue start={block.start} finish={block.finish} />
          )}
        </MetadataRow>
      ))}
      {task.buffer_adjustment && (
        <span className="planning-hint">{task.buffer_adjustment}</span>
      )}
      {task.started && (
        <MetadataRow label={task.started_at ? "Started" : "Progress"}>
          {task.started_at ? (
            <MomentValue value={task.started_at} />
          ) : (
            "Started"
          )}
        </MetadataRow>
      )}
      {task.timing_adjustments?.map((v, i) => (
        <span className="planning-hint" key={i}>
          {v}
        </span>
      ))}
    </div>
  );
}
export function repeatPlanning(task: Planning, scheduled: string) {
  const result: Partial<RepeatTemplate> = {
    importance: task.importance || "normal",
    estimated_minutes: task.estimated_minutes,
    effort: task.effort,
    safety_buffer: task.safety_buffer,
    deadline_time: task.deadline_time
      ? { time: task.deadline_time.time, timezone: task.deadline_time.timezone }
      : null,
  };
  for (const key of ["start_by", "not_before"] as const) {
    const m = task[key];
    if (m)
      result[key] = {
        offset_days: Math.round(
          (Date.parse(`${m.date}T12:00:00Z`) -
            Date.parse(`${scheduled}T12:00:00Z`)) /
            86400000,
        ),
        time: m.time,
        timezone: m.timezone,
      };
  }
  const relative = (m: Moment): RelativeMoment => ({
    offset_days: Math.round(
      (Date.parse(m.date + "T12:00:00Z") -
        Date.parse(scheduled + "T12:00:00Z")) /
        86400000,
    ),
    time: m.time,
    timezone: m.timezone,
  });
  result.work_blocks = taskBlocks(task).map((b) => ({
    id: b.id,
    start: relative(b.start),
    finish: b.finish ? relative(b.finish) : null,
  }));
  return result;
}
export function RepeatPlanningFields({
  value,
  onChange,
}: {
  value: RepeatTemplate;
  onChange: (v: RepeatTemplate) => void;
}) {
  const [open, setOpen] = useState(
    !!(
      value.deadline_time ||
      value.start_by ||
      value.not_before ||
      value.safety_buffer ||
      value.work_blocks?.length
    ),
  );
  function set(key: string, v: unknown) {
    const clears = (value.clear_planning || []).filter((k) => k !== key);
    if (v == null) clears.push(key);
    onChange({ ...value, [key]: v, clear_planning: clears });
  }
  return (
    <div className="planning-fields">
      <ImportanceField
        value={value.importance}
        onChange={(v) => set("importance", v)}
      />
      <EstimateFields
        value={value}
        required={["next", "blocked", "waiting"].includes(value.status)}
        onChange={(v) =>
          onChange({
            ...value,
            ...v,
            clear_planning: [
              ...(value.clear_planning || []).filter((k) => !(k in v)),
              ...Object.keys(v).filter((k) => v[k as keyof typeof v] == null),
            ],
          })
        }
      />
      <button
        type="button"
        className="text-action"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Timing <ChevronDown className={open ? "turned" : ""} />
      </button>
      <TaskExpansion open={open}>
        <div className="planning-fields-inner">
          {value.due_offset_days != null && (
            <>
              <div className="planning-field">
                <span className="field-label">Deadline time</span>
                {value.deadline_time ? (
                  <ClockFields
                    label="Deadline"
                    value={value.deadline_time}
                    onChange={(v) => set("deadline_time", v)}
                  />
                ) : (
                  <button
                    type="button"
                    className="text-action"
                    onClick={() =>
                      set("deadline_time", {
                        time: "17:00",
                        timezone: defaultZone,
                      })
                    }
                  >
                    Add time<span className="sr-only"> to deadline</span>
                  </button>
                )}
              </div>
              <BufferField
                value={value.safety_buffer}
                timed={!!value.deadline_time}
                onChange={(v) => set("safety_buffer", v)}
              />
            </>
          )}
          <RelativeMomentField
            label="Not before"
            value={value.not_before}
            onChange={(v) => set("not_before", v)}
          />
          <RelativeMomentField
            label="Start by"
            value={value.start_by}
            onChange={(v) => set("start_by", v)}
          />
          <RelativeBlockFields
            value={value.work_blocks || []}
            onChange={(v) => set("work_blocks", v)}
          />
        </div>
      </TaskExpansion>
    </div>
  );
}
