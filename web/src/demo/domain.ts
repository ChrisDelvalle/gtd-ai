import { importanceLevels, type Task, type Moment, type Change } from "../api";
export const NOW = "2026-11-06T18:00:00.000Z";
export const TODAY = "2026-11-06";
export const ZONE = "America/New_York";
export const HOUR = 3600000,
  DAY = 24 * HOUR;
export const shift = (day: string, n: number) =>
  new Date(Date.parse(day + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  if (!formatters.has(zone))
    formatters.set(
      zone,
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    );
  return formatters.get(zone)!;
}
export const localDate = (at: string, zone = ZONE) =>
  formatter(zone).format(new Date(at)).slice(0, 10);
export function bound(m: Moment, end = false): number {
  const day = !m.time && end ? shift(m.date, 1) : m.date;
  const wall = day + "T" + (m.time || "00:00") + ":00";
  const naive = Date.parse(wall + "Z");
  const candidates = new Set<number>();
  for (const h of [-36, -12, 0, 12, 36]) {
    const sample = naive + h * HOUR;
    const text = formatter(m.timezone || ZONE)
      .format(new Date(sample))
      .replace(" ", "T");
    const offset = (Date.parse(text + "Z") - sample) / 60000;
    const instant = naive - offset * 60000;
    if (
      formatter(m.timezone || ZONE)
        .format(new Date(instant))
        .replace(" ", "T") === wall &&
      (m.utc_offset_minutes == null || offset === m.utc_offset_minutes)
    )
      candidates.add(instant);
  }
  if (!candidates.size || !Number.isFinite(naive))
    throw new Error("Choose a valid date and time in its timezone.");
  if (candidates.size > 1 && m.time && m.utc_offset_minutes == null)
    throw new Error("Choose an offset for this repeated local time.");
  return Math.min(...candidates);
}
export const importance = (t: Task) =>
  6 - importanceLevels.indexOf(t.importance || "normal");
export const live = (t: Task) =>
  t.entity_type === "task" &&
  !t.deleted &&
  !t.archived &&
  t.status !== "done" &&
  !t.occurrence?.skipped;
export function blocks(t: Task) {
  return (
    t.work_blocks ??
    (t.planned_start
      ? [{ id: "legacy", start: t.planned_start, finish: t.planned_finish }]
      : [])
  ).map((b) => ({
    block: b,
    start: bound(b.start),
    end: b.finish
      ? bound(b.finish, true)
      : bound({ ...b.start, time: null, utc_offset_minutes: null }, true),
  }));
}
export function constraints(t: Task): [string, Moment][] {
  return [
    ...(t.due_date
      ? [
          [
            "Deadline",
            { date: t.due_date, timezone: ZONE, ...t.deadline_time },
          ] as [string, Moment],
        ]
      : []),
    ...(!t.started && t.start_by
      ? [["Start by", t.start_by] as [string, Moment]]
      : []),
  ];
}
export function buffer(t: Task): number | undefined {
  if (!t.due_date || !t.safety_buffer) return;
  const m: Moment = { date: t.due_date, timezone: ZONE, ...t.deadline_time };
  const b = t.safety_buffer;
  if (b.unit === "days")
    return bound({ ...m, date: shift(m.date, -b.value) }, true);
  return bound(m, true) - b.value * (b.unit === "hours" ? HOUR : 60000);
}
const now = Date.parse(NOW);
export function rank(t: Task) {
  const cs = constraints(t)
    .map(([label, m]) => ({ label, m, end: bound(m, true) }))
    .sort((a, b) => a.end - b.end);
  const earliest = cs[0];
  const immediate = cs.some(
    (c) =>
      c.end <= now ||
      (c.m.time && c.end <= now + 2 * HOUR) ||
      (!c.m.time && bound(c.m) <= now),
  );
  const block = blocks(t)
    .filter((b) => b.start <= now && b.end > now)
    .sort((a, b) => a.end - b.end)[0];
  const target = buffer(t);
  const plan =
    target !== undefined && (!earliest || target < earliest.end)
      ? { end: target, label: "Buffer target" }
      : earliest;
  const boost = plan
    ? plan.end <= now + 48 * HOUR
      ? 2
      : plan.end <= now + 7 * DAY
        ? 1
        : 0
    : 0;
  const group = immediate ? 0 : block ? 1 : 2;
  const imp = importance(t);
  const value = imp + (group === 2 ? boost : 0);
  const at = group === 1 ? block?.end : group === 2 ? plan?.end : earliest?.end;
  return {
    key: `${group}:${String(8 - value).padStart(2, "0")}:${String(6 - imp).padStart(2, "0")}:${String(at === undefined ? 999999999999999 : at + 100000000000000).padStart(15, "0")}`,
    reason: immediate
      ? `${earliest.label} ${earliest.end <= now ? "overdue" : "due soon"}`
      : block
        ? "Planned now"
        : boost
          ? `${(t.importance || "normal").replaceAll("_", " ")} importance · approaching ${plan.label.toLowerCase()}`
          : `${(t.importance || "normal").replaceAll("_", " ")} importance`,
    evaluated_at: NOW,
    next_change_at: null as null,
    source_task_id: undefined as string | undefined,
  };
}
export const urgencyNames = [
  "undated",
  "later",
  "weeks",
  "within_7_days",
  "within_48_hours",
  "immediate",
  "overdue",
];
const upcoming = (at: number) =>
  at <= now + 48 * HOUR
    ? 4
    : at <= now + 7 * DAY
      ? 3
      : at <= now + 28 * DAY
        ? 2
        : 1;
export function timing(t: Task, seriesZone = ZONE) {
  let urgency = 0,
    work_block: Moment | null = null,
    scheduled: Moment | undefined;
  for (const [, m] of constraints(t)) {
    const end = bound(m, true);
    const immediate = m.time ? end - 2 * HOUR : bound(m);
    urgency = Math.max(
      urgency,
      now >= end ? 6 : now >= immediate ? 5 : upcoming(end),
    );
  }
  if (urgency) {
    const target = buffer(t);
    if (urgency < 5 && target !== undefined && upcoming(target) >= 3)
      urgency = Math.max(urgency, upcoming(target));
    return { urgency, work_block, scheduled };
  }
  const choices = blocks(t).sort((a, b) => {
    const k = (v: typeof a) =>
      v.end <= now
        ? [2, now - v.end]
        : v.start <= now
          ? [0, v.end - now]
          : [1, v.start - now];
    const x = k(a),
      y = k(b);
    return x[0] - y[0] || x[1] - y[1];
  });
  const b = choices[0];
  if (b) {
    urgency =
      now >= b.end
        ? 6
        : now >= (b.block.start.time ? b.start - 2 * HOUR : b.start)
          ? 5
          : upcoming(b.start);
    work_block = b.block.start;
  } else if (t.occurrence) {
    scheduled = { date: t.occurrence.scheduled_date, timezone: seriesZone };
    urgency =
      now >= bound(scheduled, true)
        ? 6
        : now >= bound(scheduled)
          ? 5
          : upcoming(bound(scheduled));
  }
  return { urgency, work_block, scheduled };
}
export function graph(records: Task[]) {
  const byId = new Map(records.filter((t) => !t.deleted).map((t) => [t.id, t]));
  const order: Task[] = [];
  const visited = new Set<string>(),
    visiting = new Set<string>();
  function visit(t: Task) {
    if (visited.has(t.id)) return;
    if (visiting.has(t.id))
      throw new Error("Dependencies cannot form a cycle.");
    visiting.add(t.id);
    for (const id of t.blocked_by || []) {
      const b = byId.get(id);
      if (!b || b.entity_type !== "task")
        throw new Error("Choose an available prerequisite.");
      visit(b);
    }
    visiting.delete(t.id);
    visited.add(t.id);
    order.push(t);
  }
  for (const t of byId.values()) visit(t);
  const ranks = new Map(records.map((t) => [t.id, rank(t)]));
  const placements = new Map(
    records.filter(live).map((t) => [
      t.id,
      {
        ...timing(t),
        importance: importance(t),
        priority_from: null as { id: string; title: string } | null,
        urgency_from: undefined as { id: string; title: string } | undefined,
      },
    ]),
  );
  for (const t of order.reverse()) {
    for (const id of t.blocked_by || []) {
      const source = placements.get(t.id),
        target = placements.get(id);
      if (source && target) {
        if (source.importance > target.importance) {
          target.importance = source.importance;
          target.priority_from = source.priority_from || {
            id: t.id,
            title: t.title,
          };
        }
        if (source.urgency > target.urgency) {
          target.urgency = source.urgency;
          target.urgency_from = source.urgency_from || {
            id: t.id,
            title: t.title,
          };
        }
      }
      const b = byId.get(id)!;
      if (
        live(t) &&
        live(b) &&
        ["next", "blocked", "waiting"].includes(t.status) &&
        ["next", "blocked", "waiting"].includes(b.status) &&
        ranks.get(t.id)!.key < ranks.get(id)!.key
      )
        ranks.set(id, {
          ...ranks.get(t.id)!,
          source_task_id: ranks.get(t.id)!.source_task_id || t.id,
        });
    }
  }
  return { byId, ranks, placements };
}
const timingFields = [
  "due_date",
  "deadline_time",
  "start_by",
  "not_before",
  "planned_start",
  "planned_finish",
  "work_blocks",
  "safety_buffer",
  "review_date",
];
export const different = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
function schedule(value: any) {
  return value
    ? {
        segments: value.segments?.map((s: any) => ({
          from: s.from,
          rule: s.rule,
          timing: Object.fromEntries(
            [...timingFields, "due_offset_days", "review_offset_days"].map(
              (k) => [k, s.template?.[k] ?? null],
            ),
          ),
        })),
        pauses: value.pauses,
        ended_on: value.ended_on,
      }
    : null;
}
export function classify(c: Change) {
  const a = c.after,
    b = c.before;
  const changed = (key: string) =>
    different((a as any)[key], (b as any)?.[key]);
  const completion =
    !c.undoes_change_id &&
    a.entity_type === "task" &&
    a.status === "done" &&
    !a.deleted &&
    !a.occurrence?.skipped &&
    b?.status !== "done";
  const category = c.undoes_change_id
    ? "undo"
    : completion
      ? "completed"
      : !b
        ? "added"
        : a.started && !b.started
          ? "started"
          : ["status", "archived", "deleted"].some(changed) ||
              different(a.occurrence?.skipped, b.occurrence?.skipped)
            ? "status"
            : timingFields.some(changed) ||
                different(
                  a.occurrence?.scheduled_date,
                  b.occurrence?.scheduled_date,
                ) ||
                different(schedule(a.recurrence), schedule(b.recurrence))
              ? "scheduling"
              : "edited";
  return {
    category,
    automatic: [
      "occurrence",
      "dependency_status",
      "availability_status",
      "require_importance",
      "rename_planned",
      "planning_defaults",
    ].includes(c.operation),
    completion,
  };
}
export function annotate(changes: Change[]) {
  const cancelled = new Map<number, number>();
  for (const c of [...changes].reverse())
    if (c.undoes_change_id && !cancelled.has(c.id))
      cancelled.set(c.undoes_change_id, c.id);
  const known = new Map<number, boolean>();
  return changes.map((c) => {
    const a = classify(c);
    if (c.undoes_change_id)
      a.automatic ||= known.get(c.undoes_change_id) || false;
    known.set(c.id, a.automatic);
    const keys = Object.keys(c.after).filter(
      (k) =>
        ![
          "id",
          "version",
          "created_at",
          "updated_at",
          "last_change_id",
          "entity_type",
        ].includes(k) && different((c.after as any)[k], (c.before as any)?.[k]),
    );
    return {
      ...c,
      changed_fields: keys,
      activity: {
        category: a.category,
        automatic: a.automatic,
        completion_eligible:
          a.completion && !a.automatic && !cancelled.has(c.id),
        undone_by_change_id: cancelled.get(c.id) || null,
        transitions: Object.fromEntries(
          keys
            .filter((k) =>
              [
                "status",
                "started",
                "archived",
                "deleted",
                ...timingFields,
              ].includes(k),
            )
            .map((k) => [
              k,
              {
                from: (c.before as any)?.[k] ?? null,
                to: (c.after as any)[k] ?? null,
              },
            ]),
        ),
      },
    };
  });
}
