import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  type Planning,
  type Effort,
  type SafetyBuffer,
  type WorkBlock,
  type RelativeWorkBlock,
  type RelativeMoment,
  type Moment,
  type Clock,
  type Api,
  type List,
  effortLevels,
  today,
} from "./api";
import {
  MomentField,
  ClockFields,
  defaultZone,
  momentInstant,
} from "./planning-fields";

export function taskBlocks(value: Planning): WorkBlock[] {
  return (
    value.work_blocks ??
    (value.planned_start
      ? [
          {
            id: "legacy",
            start: value.planned_start,
            finish: value.planned_finish,
          },
        ]
      : [])
  );
}
export function EstimateFields({
  value,
  onChange,
  required = false,
}: {
  value: { estimated_minutes?: number | null; effort?: Effort | null };
  onChange: (v: {
    estimated_minutes?: number | null;
    effort?: Effort | null;
  }) => void;
  required?: boolean;
}) {
  return (
    <div className="estimate-fields">
      <label>
        Remaining minutes
        <input
          aria-label="Remaining minutes"
          type="number"
          inputMode="numeric"
          min="0"
          max="5256000"
          step="1"
          required={required}
          value={value.estimated_minutes ?? ""}
          onChange={(e) =>
            onChange({
              estimated_minutes:
                e.target.value === "" ? null : Number(e.target.value),
            })
          }
        />
      </label>
      <label>
        Effort
        <select
          aria-label="Effort"
          required={required}
          value={value.effort || ""}
          onChange={(e) =>
            onChange({ effort: (e.target.value || null) as Effort | null })
          }
        >
          <option value="">Choose</option>
          {effortLevels.map((v) => (
            <option key={v} value={v}>
              {v[0].toUpperCase() + v.slice(1)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
export function BufferField({
  value,
  timed,
  onChange,
}: {
  value?: SafetyBuffer | null;
  timed: boolean;
  onChange: (v: SafetyBuffer | null) => void;
}) {
  return (
    <div className="buffer-field">
      <label>
        Buffer
        <input
          aria-label="Buffer"
          type="number"
          min="1"
          max={value?.unit === "days" ? 3660 : 5256000}
          step="1"
          value={value?.value ?? ""}
          placeholder="None"
          onChange={(e) =>
            onChange(
              e.target.value === ""
                ? null
                : {
                    value: Number(e.target.value),
                    unit: value?.unit || "days",
                  },
            )
          }
        />
      </label>
      <label>
        <span className="sr-only">Buffer unit</span>
        <select
          aria-label="Buffer unit"
          value={value?.unit || "days"}
          disabled={!value}
          onChange={(e) =>
            value &&
            onChange({ ...value, unit: e.target.value as SafetyBuffer["unit"] })
          }
        >
          <option value="days">Days</option>
          <option value="hours" disabled={!timed}>
            Hours
          </option>
          <option value="minutes" disabled={!timed}>
            Minutes
          </option>
        </select>
      </label>
      {value && (
        <button
          type="button"
          className="icon-button"
          aria-label="Remove buffer"
          onClick={() => onChange(null)}
        >
          <X />
        </button>
      )}
    </div>
  );
}
function interval(block: WorkBlock) {
  return [
    momentInstant(block.start),
    block.finish
      ? momentInstant(block.finish, true)
      : momentInstant(
          { ...block.start, time: null, utc_offset_minutes: null },
          true,
        ),
  ];
}
export function WorkBlockFields({
  value,
  onChange,
  api,
  taskId,
  notBefore,
  dueDate,
  deadlineClock,
}: {
  value: WorkBlock[];
  onChange: (v: WorkBlock[]) => void;
  api: Api;
  taskId: string;
  notBefore?: Moment | null;
  dueDate: string;
  deadlineClock?: Clock | null;
}) {
  const [overlaps, setOverlaps] = useState<string[]>([]),
    [error, setError] = useState(false);
  const key = JSON.stringify(value.map((b) => [b.start, b.finish]));
  useEffect(() => {
    let active = true;
    setOverlaps([]);
    setError(false);
    if (!value.length) return;
    const timer = setTimeout(async () => {
      try {
        const dates = value
          .flatMap((b) => [b.start.date, b.finish?.date || b.start.date])
          .sort();
        const offset = (date: string, n: number) => {
          const d = new Date(date + "T12:00:00Z");
          d.setUTCDate(d.getUTCDate() + n);
          return d.toISOString().slice(0, 10);
        };
        const found = new Set<string>();
        let cursor: string | null | undefined;
        do {
          const r = await api.call<List>("list_items", {
            view: "all",
            archived: false,
            detail: "full",
            planned_from: offset(dates[0], -2),
            planned_through: offset(dates[dates.length - 1], 2),
            ...(cursor ? { cursor } : {}),
          });
          for (let t of r.items) {
            if (t.id === taskId || t.status === "done") continue;
            if (!t.work_blocks && (t.work_block_count || 0) > 1) {
              const full = await api.call<List>("list_items", {
                task_id: t.id,
              });
              if (!active) return;
              t = full.items[0] || t;
            }
            for (const other of taskBlocks(t)) {
              const [x, y] = interval(other);
              if (
                value.some((b) => {
                  const [a, z] = interval(b);
                  return (
                    x != null &&
                    y != null &&
                    a != null &&
                    z != null &&
                    x < z &&
                    y > a
                  );
                })
              )
                found.add(t.title);
            }
          }
          cursor = r.next_cursor;
        } while (active && cursor);
        if (active) setOverlaps([...found]);
      } catch {
        if (active) setError(true);
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, taskId, key]);
  const update = (i: number, block: WorkBlock) =>
    onChange(value.map((b, j) => (i === j ? block : b)));
  const deadline = dueDate
    ? momentInstant(
        {
          date: dueDate,
          time: deadlineClock?.time,
          timezone: deadlineClock?.timezone || defaultZone,
          utc_offset_minutes: deadlineClock?.utc_offset_minutes,
        },
        true,
      )
    : undefined;
  const available = notBefore ? momentInstant(notBefore) : undefined;
  const selfOverlap = value.some((b, i) => {
    const [a, z] = interval(b);
    return value.slice(i + 1).some((other) => {
      const [x, y] = interval(other);
      return a != null && z != null && x != null && y != null && a < y && z > x;
    });
  });
  return (
    <div className="work-blocks">
      <div className="work-block-heading">
        <span>Work blocks</span>
        <button
          type="button"
          className="text-action"
          disabled={value.length >= 100}
          onClick={() =>
            onChange([
              ...value,
              {
                id: crypto.randomUUID(),
                start: { date: today(), timezone: defaultZone },
                finish: null,
              },
            ])
          }
        >
          <Plus />
          Add block
        </button>
      </div>
      {value.map((b, i) => {
        const [a, z] = interval(b);
        return (
          <div className="work-block" key={b.id}>
            <div className="work-block-heading">
              <span>Block {i + 1}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove block ${i + 1}`}
                onClick={() => onChange(value.filter((_, j) => i !== j))}
              >
                <X />
              </button>
            </div>
            <MomentField
              label={i ? `Block ${i + 1} start` : "Planned start"}
              value={b.start}
              onChange={(start) =>
                start
                  ? update(i, { ...b, start })
                  : onChange(value.filter((_, j) => j !== i))
              }
            />
            <MomentField
              label={i ? `Block ${i + 1} finish` : "Planned finish"}
              value={b.finish ?? null}
              onChange={(finish) => update(i, { ...b, finish })}
            />
            <label>
              Calendar event
              <input
                type="url"
                aria-label={`Block ${i + 1} calendar event`}
                maxLength={2048}
                value={b.calendar_event?.url || ""}
                placeholder="Optional link"
                onChange={(e) =>
                  update(i, {
                    ...b,
                    calendar_event: e.target.value
                      ? { ...b.calendar_event, url: e.target.value }
                      : null,
                  })
                }
              />
            </label>
            {available != null && a != null && a < available && (
              <p className="planning-hint" role="status">
                This block begins before availability.
              </p>
            )}
            {deadline != null &&
              ((a != null && a >= deadline) || (z != null && z > deadline)) && (
                <p className="planning-hint" role="status">
                  This block extends beyond the deadline.
                </p>
              )}
          </div>
        );
      })}
      {(selfOverlap || overlaps.length > 0) && (
        <p className="planning-hint" role="status">
          {selfOverlap ? "Work blocks overlap. " : ""}
          {overlaps.length
            ? `Overlaps ${overlaps.slice(0, 2).join("; ")}${overlaps.length > 2 ? ` and ${overlaps.length - 2} more` : ""}. `
            : ""}
          You can keep these blocks.
        </p>
      )}
      {error && (
        <p className="planning-hint" role="status">
          Other planned work could not be checked.
        </p>
      )}
    </div>
  );
}
export function RelativeMomentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: RelativeMoment | null;
  onChange: (v: RelativeMoment | null) => void;
}) {
  return (
    <div className="planning-field">
      <div className="planning-date-row">
        <label>
          {label}
          <input
            type="number"
            aria-label={label}
            min={-3660}
            max={3660}
            placeholder="Not set"
            value={value?.offset_days ?? ""}
            onChange={(e) =>
              onChange(
                e.target.value === ""
                  ? null
                  : {
                      ...value,
                      offset_days: Number(e.target.value),
                      timezone: value?.timezone || defaultZone,
                    },
              )
            }
          />
        </label>
        {!value?.time && (
          <button
            type="button"
            className="text-action"
            disabled={!value}
            onClick={() => value && onChange({ ...value, time: "09:00" })}
          >
            Add time<span className="sr-only"> to {label.toLowerCase()}</span>
          </button>
        )}
      </div>
      <small className="muted">Days from occurrence · 0 is the same day</small>
      {value?.time && (
        <ClockFields
          label={label}
          value={{ time: value.time, timezone: value.timezone }}
          onChange={(v) =>
            onChange(
              v
                ? { ...value, ...v }
                : { offset_days: value.offset_days, timezone: value.timezone },
            )
          }
        />
      )}
    </div>
  );
}
export function RelativeBlockFields({
  value,
  onChange,
}: {
  value: RelativeWorkBlock[];
  onChange: (v: RelativeWorkBlock[]) => void;
}) {
  const update = (i: number, b: RelativeWorkBlock) =>
    onChange(value.map((old, j) => (i === j ? b : old)));
  return (
    <div className="work-blocks">
      <div className="work-block-heading">
        <span>Work blocks</span>
        <button
          type="button"
          className="text-action"
          disabled={value.length >= 100}
          onClick={() =>
            onChange([
              ...value,
              {
                id: crypto.randomUUID(),
                start: { offset_days: 0, timezone: defaultZone },
              },
            ])
          }
        >
          <Plus />
          Add block
        </button>
      </div>
      {value.map((b, i) => (
        <div className="work-block" key={b.id}>
          <div className="work-block-heading">
            <span>Block {i + 1}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove block ${i + 1}`}
              onClick={() => onChange(value.filter((_, j) => i !== j))}
            >
              <X />
            </button>
          </div>
          <RelativeMomentField
            label={i ? `Block ${i + 1} start` : "Planned start"}
            value={b.start}
            onChange={(start) =>
              start
                ? update(i, { ...b, start })
                : onChange(value.filter((_, j) => j !== i))
            }
          />
          <RelativeMomentField
            label={i ? `Block ${i + 1} finish` : "Planned finish"}
            value={b.finish}
            onChange={(finish) => update(i, { ...b, finish })}
          />
        </div>
      ))}
    </div>
  );
}
