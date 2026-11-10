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
export function facts(t: Task, project?: Task) {
  const eligible = !!project && live(t) && ["next", "blocked", "waiting"].includes(t.status)
    && project?.id === t.project_id && project.entity_type === "project"
    && project.status === "active" && !project.archived && !project.deleted;
  const own = t.due_date ? { date: t.due_date, timezone: ZONE, ...t.deadline_time } : undefined;
  const fallback = eligible && project.due_date ? {
    deadline: { date: project.due_date, timezone: ZONE, ...project.deadline_time },
    source: { id: project.id, title: project.title },
  } : undefined;
  return { deadline: own || fallback?.deadline, project: own ? undefined : fallback?.source, fallback };
}
export function constraints(t: Task, f = facts(t)): [string, Moment][] {
  return [
    ...(f.deadline ? [[f.project ? "Project deadline" : "Deadline", f.deadline] as [string, Moment]] : []),
    ...(!t.started && t.start_by ? [["Start by", t.start_by] as [string, Moment]] : []),
  ];
}
export function buffer(t: Task): number | undefined {
  if (!t.due_date || !t.safety_buffer) return;
  const m: Moment = { date: t.due_date, timezone: ZONE, ...t.deadline_time };
  const b = t.safety_buffer;
  if (b.unit === "days") return bound({ ...m, date: shift(m.date, -b.value) }, true);
  return bound(m, true) - b.value * (b.unit === "hours" ? HOUR : 60000);
}
const now = Date.parse(NOW);
function selectedPlan(t: Task, seriesZone = ZONE) {
  const choices = blocks(t).sort((a, b) => {
    const key = (v: typeof a) => v.end <= now ? [2, now - v.end, 0]
      : v.start <= now ? [0, v.end - now, 0] : [1, v.start - now, v.end];
    const x = key(a), y = key(b);
    return x[0]-y[0] || x[1]-y[1] || x[2]-y[2] || compareText(a.block.id, b.block.id);
  });
  const b = choices[0];
  if (b) return { moment: b.block.start, start: b.start, end: b.end, current: b.start <= now && now < b.end, occurrence: false };
  if (!t.occurrence) return;
  const moment: Moment = { date: t.occurrence.scheduled_date, timezone: seriesZone };
  return { moment, start: bound(moment), end: bound(moment, true), current: false, occurrence: true };
}
// UTF-8 byte order, matching Rust, independent of browser locale.
const encoder = new TextEncoder();
export function compareText(a: string, b: string) {
  const x = encoder.encode(a), y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
const approaching = (at: number) => at <= now + 48*HOUR ? 2 : at <= now + 7*DAY ? 1 : 0;
const timeKey = (at?: number) => at === undefined ? "1" + "0".repeat(20)
  : "0" + (BigInt(at) + (1n << 63n)).toString().padStart(20, "0");
export function rank(t: Task, f = facts(t), seriesZone = ZONE) {
  const cs = constraints(t, f).map(([label, m]) => {
    const end = bound(m, true), immediate = m.time ? end - 2*HOUR : bound(m);
    return { label, end, h: now >= immediate ? 3 : approaching(end) };
  });
  const h = Math.max(0, ...cs.map(c => c.h)), target = buffer(t), b = target === undefined ? 0 : approaching(target);
  const winning = cs.filter(c => c.h === h).sort((a,b) => a.end-b.end)[0];
  const promoted = Math.max(h,b) === 0 ? undefined : h >= b ? winning?.end : target;
  const extra = [...new Set(cs.filter(c => c.h > 0 && c.end !== promoted).map(c => c.end))].sort((a,b) => a-b);
  const plan = selectedPlan(t, seriesZone);
  const tie = plan ? plan.occurrence || plan.start > now ? plan.start : plan.end : undefined;
  const remaining = [...new Set([...cs.filter(c => !c.h).map(c => c.end), ...(tie === undefined ? [] : [tie])])]
    .filter(at => at !== promoted && !extra.includes(at)).sort((a,b) => a-b);
  return {
    key: [String(9-importance(t)-Math.max(h,b)).padStart(2,"0"), 3-h, 6-importance(t), timeKey(promoted),
      timeKey(extra[0]), timeKey(extra[1]), plan?.current ? 0 : 1,
      timeKey(remaining[0]), timeKey(remaining[1]), timeKey(remaining[2])].join(":"),
    reason: h > 0 && h >= b ? h === 3 ? `${winning.label} ${winning.end <= now ? "overdue" : "due soon"}`
      : `${(t.importance || "normal").replaceAll("_", " ")} importance · approaching ${winning.label.toLowerCase()}`
      : b > 0 ? `${(t.importance || "normal").replaceAll("_", " ")} importance · approaching buffer target`
      : plan?.current ? "Planned now" : `${(t.importance || "normal").replaceAll("_", " ")} importance`,
    evaluated_at: NOW, next_change_at: null, source_task_id: undefined as string | undefined,
    effective_deadline: f.deadline, deadline_project: f.project, project_fallback: f.fallback, policy: "priority-v4",
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
export function timing(t: Task, seriesZone = ZONE, f = facts(t)) {
  let urgency = 0, evidence: [number, number] = [3, Number.MAX_SAFE_INTEGER];
  let work_block: Moment | null = null, scheduled: Moment | undefined;
  const plan = selectedPlan(t, seriesZone);
  const flags = (f.deadline ? 1 : 0) | (!t.started && t.start_by ? 2 : 0) | (plan ? 4 : 0);
  for (const [, m] of constraints(t, f)) {
    const end = bound(m, true), immediate = m.time ? end - 2*HOUR : bound(m);
    const u = now >= end ? 6 : now >= immediate ? 5 : upcoming(end);
    if (u > urgency || u === urgency && end < evidence[1]) { urgency = u; evidence = [0,end]; }
  }
  if (urgency) {
    const target = buffer(t);
    if (urgency < 5 && target !== undefined && upcoming(target) >= 3 && upcoming(target) > urgency) {
      urgency = upcoming(target); evidence = [1,target];
    }
  } else if (plan) {
    urgency = now >= plan.end ? 6 : now >= (plan.moment.time ? plan.start-2*HOUR : plan.start) ? 5 : upcoming(plan.start);
    evidence = [2, now >= plan.end ? plan.end : plan.start];
    if (plan.occurrence) scheduled = plan.moment; else work_block = plan.moment;
  }
  return { urgency, work_block, scheduled, flags, evidence, effective_deadline: f.deadline, deadline_project: f.project };
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
  const resolved = new Map(records.map(t => [t.id, facts(t, byId.get(t.project_id || ""))]));
  const ranks = new Map(records.map((t) => [t.id, rank(t, resolved.get(t.id), byId.get(t.occurrence?.series_id || "")?.recurrence?.timezone)]));
  const own = new Map([...ranks].map(([id, r]) => [id, r.key]));
  const placements = new Map(
    records.filter(live).map((t) => [
      t.id,
      {
        ...timing(t, byId.get(t.occurrence?.series_id || "")?.recurrence?.timezone, resolved.get(t.id)),
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
        target.flags |= source.flags;
        const importanceSource = source.priority_from || { id: t.id, title: t.title };
        if (source.importance > target.importance || source.importance === target.importance && target.priority_from && importanceSource.id < target.priority_from.id) {
          target.importance = source.importance;
          target.priority_from = source.priority_from || {
            id: t.id,
            title: t.title,
          };
        }
        const urgencySource = source.urgency_from || { id: t.id, title: t.title };
        const evidenceOrder = source.evidence[0] - target.evidence[0] || source.evidence[1] - target.evidence[1];
        if (source.urgency > target.urgency || source.urgency === target.urgency && (evidenceOrder < 0 || evidenceOrder === 0 && target.urgency_from && urgencySource.id < target.urgency_from.id)) {
          target.evidence = source.evidence;
          target.work_block = source.work_block;
          target.scheduled = source.scheduled;
          target.effective_deadline = source.effective_deadline;
          target.deadline_project = source.deadline_project;
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
        (ranks.get(t.id)!.key < ranks.get(id)!.key || ranks.get(t.id)!.key === ranks.get(id)!.key && ranks.get(id)!.source_task_id &&
          (ranks.get(t.id)!.source_task_id || t.id) < ranks.get(id)!.source_task_id!)
      )
        ranks.set(id, {
          ...ranks.get(id)!, key: ranks.get(t.id)!.key, reason: ranks.get(t.id)!.reason,
          source_task_id: ranks.get(t.id)!.source_task_id || t.id,
        });
    }
  }
  for (const t of records) ranks.get(t.id)!.key += `:${own.get(t.id)}:${live(t) && t.started ? 0 : 1}`;
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
