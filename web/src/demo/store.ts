/** Browser-only sandbox; never imported by production entry points. */
import {
  ApiError,
  effortLevels,
  importanceLevels,
  inScope,
  type Api,
  type Args,
  type Change,
  type Task,
} from "../api";
import {
  annotate,
  blocks,
  bound,
  different,
  graph,
  importance,
  live,
  localDate,
  NOW,
  shift,
  TODAY,
  urgencyNames,
  ZONE,
} from "./domain";
export type Fixture = {
  format: number;
  now: string;
  timezone: string;
  records: Task[];
  changes: Change[];
};
type State = { records: Task[]; changes: Change[] };
type Cursor = {
  operation: string;
  query: string;
  rows: any[];
  offset: number;
  meta: Args;
};
const copy = <T>(v: T): T => structuredClone(v);
function fail(message: string, code = "invalid"): never {
  throw new ApiError(message, code);
}
const queryKey = (args: Args) =>
  JSON.stringify(
    Object.entries(args)
      .filter(([k]) => !["cursor", "offset", "limit"].includes(k))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
const categories = [
  "undo",
  "completed",
  "added",
  "started",
  "status",
  "scheduling",
  "edited",
];
const statuses = ["next", "inbox", "waiting", "blocked", "someday", "done"];
const fields = [
  "title",
  "brief",
  "notes",
  "agent_notes",
  "links",
  "location",
  "status",
  "archived",
  "due_date",
  "review_date",
  "project_id",
  "completion_result",
  "work_sessions",
  "blocked_by",
  "importance",
  "estimated_minutes",
  "effort",
  "not_before",
  "start_by",
  "deadline_time",
  "safety_buffer",
  "work_blocks",
  "planned_start",
  "planned_finish",
  "started",
];
export class DemoStore {
  records: Task[];
  changes: Change[];
  private sequence = 0;
  private cursors = new Map<string, Cursor>();
  private snapshots = new Map<string, State>();
  private receipts = new Map<
    string,
    { fingerprint: string; result: any; ids: string[] }
  >();
  private groups = new Map<number, number[]>();
  private latestSnapshot?: { revision: number; token: string };
  private derived?: ReturnType<typeof graph>;
  readonly api: Api;
  constructor(
    fixture: Fixture,
    readonly scope: string,
  ) {
    if (
      fixture.format !== 1 ||
      fixture.now !== NOW ||
      fixture.timezone !== ZONE
    )
      fail("Unsupported demo fixture.");
    this.records = copy(fixture.records);
    this.changes = copy(fixture.changes);
    this.api = {
      identityScope: () => `demo:${scope}:${ZONE}`,
      taskPreparation: "intent",
      call: async <T>(name: string, args: Args) =>
        copy(this.execute(name, copy(args))) as T,
      openLink: async () => {
        fail(
          "External links and calendar actions are unavailable in this demo.",
          "demo_limitation",
        );
      },
    };
  }
  private token(kind: string) {
    return `${this.scope}:${kind}:${++this.sequence}`;
  }
  private id() {
    return `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`;
  }
  private state(snapshot?: unknown): State {
    if (snapshot) {
      const s = this.snapshots.get(String(snapshot));
      if (!s)
        fail(
          "Reopen this view to start a new demo snapshot.",
          "reset_required",
        );
      return s;
    }
    return { records: this.records, changes: this.changes };
  }
  private freeze() {
    const revision = this.changes.at(-1)?.id || 0;
    if (this.latestSnapshot?.revision === revision)
      return this.latestSnapshot.token;
    const id = this.token("snapshot");
    this.snapshots.set(id, copy(this.state()));
    this.latestSnapshot = { revision, token: id };
    if (this.snapshots.size > 24)
      this.snapshots.delete(this.snapshots.keys().next().value!);
    return id;
  }
  private page(
    operation: string,
    args: Args,
    rows: any[],
    meta: Args = {},
    fallback = 20,
  ) {
    const limit = Math.min(100, Math.max(1, Number(args.limit) || fallback));
    let offset = Number(args.offset) || 0;
    if (args.cursor) {
      const c = this.cursors.get(String(args.cursor));
      if (!c || c.operation !== operation || c.query !== queryKey(args))
        fail(
          "This page is unavailable for the selected query.",
          "reset_required",
        );
      ({ rows, offset, meta } = c);
    }
    const end = offset + limit;
    let cursor: string | null = null;
    if (end < rows.length) {
      cursor = this.token("page");
      this.cursors.set(cursor, {
        operation,
        query: queryKey(args),
        rows: copy(rows),
        offset: end,
        meta: copy(meta),
      });
      if (this.cursors.size > 128)
        this.cursors.delete(this.cursors.keys().next().value!);
    }
    return {
      ...meta,
      rows: copy(rows.slice(offset, end)),
      next_cursor: cursor,
      next_offset: cursor ? end : null,
      complete: cursor === null,
    };
  }
  private derivedFor(records: Task[]) {
    return records === this.records
      ? (this.derived ??= graph(records))
      : graph(records);
  }
  private ordered(records = this.records, args: Args = {}) {
    const ranks = this.derivedFor(records).ranks,
      seq = new Map(records.map((t, i) => [t.id, i]));
    return [...records].sort((a, b) => {
      const date = (key: keyof Task) =>
        String(a[key] || "9999").localeCompare(String(b[key] || "9999"));
      const order = () => seq.get(a.id)! - seq.get(b.id)!;
      if (args.sort === "updated") return b.last_change_id - a.last_change_id;
      if (args.sort === "created") return order();
      if (args.sort === "importance")
        return importance(b) - importance(a) || order();
      if (args.sort === "due") return date("due_date") || order();
      if (args.review_on && date("review_date")) return date("review_date");
      return (
        Number(!!a.archived) - Number(!!b.archived) ||
        statuses.indexOf(a.status) - statuses.indexOf(b.status) ||
        ranks.get(a.id)!.key.localeCompare(ranks.get(b.id)!.key) ||
        order()
      );
    });
  }
  private decorate(t: Task): Task {
    const g = this.derivedFor(this.records),
      label = (x: Task) => ({
        id: x.id,
        title: x.title,
        status: x.status,
        occurrence: x.occurrence,
      });
    const prerequisites = (t.blocked_by || []).flatMap((id) => {
      const b = g.byId.get(id);
      return b ? [label(b)] : [];
    });
    const dependents = this.records
      .filter((b) => !b.deleted && b.blocked_by?.includes(t.id))
      .map(label);
    const project = this.records.find((p) => p.id === t.project_id),
      blocking = prerequisites
        .filter((b) => b.status !== "done" && !b.occurrence?.skipped)
        .map((b) => b.id);
    return {
      ...copy(t),
      detail: "full",
      omitted_fields: [],
      recommendation: g.ranks.get(t.id),
      has_agent_notes: !!t.agent_notes,
      has_notes: !!t.notes,
      has_completion_result: !!t.completion_result,
      unresolved_blocker_ids: blocking,
      blocking_count: dependents.filter((b) => b.status !== "done").length,
      blocking_reasons: [
        ...(blocking.length
          ? [{ kind: "dependencies", task_ids: blocking }]
          : []),
        ...(t.not_before && bound(t.not_before) > Date.parse(NOW)
          ? [{ kind: "not_before", available_at: t.not_before }]
          : []),
        ...(t.manual_block ? [{ kind: "manual" }] : []),
      ],
      widget_preview: {
        prerequisites: prerequisites.slice(0, 5),
        dependents: dependents.slice(0, 5),
        more: prerequisites.length > 5 || dependents.length > 5,
        project_title: project?.title || null,
        project_version: project?.version,
      },
    };
  }
  private tasks(args: Args) {
    let rows = this.ordered(this.records, args).filter(
      (t) =>
        t.entity_type === "task" &&
        inScope(t, args) &&
        (!t.occurrence?.skipped || args.include_skipped),
    );
    const words = String(args.query || "")
      .toLocaleLowerCase("en-US")
      .split(/\s+/)
      .filter(Boolean);
    rows = rows.filter(
      (t) =>
        words.every((word) =>
          [t.title, t.brief, t.notes, t.location]
            .join(" ")
            .toLocaleLowerCase("en-US")
            .includes(word),
        ) &&
        (args.max_estimated_minutes == null ||
          (t.estimated_minutes != null &&
            t.estimated_minutes <= Number(args.max_estimated_minutes))) &&
        (!args.max_effort ||
          (t.effort &&
            effortLevels.indexOf(t.effort) <=
              effortLevels.indexOf(args.max_effort as any))) &&
        (!args.location ||
          t.location?.toLowerCase() === String(args.location).toLowerCase()) &&
        (!args.review_from ||
          (t.review_date && t.review_date >= String(args.review_from))) &&
        (!args.review_through ||
          (t.review_date && t.review_date <= String(args.review_through))) &&
        (!(args.planned_from || args.planned_through) ||
          blocks(t).some(
            (b) =>
              (!args.planned_from ||
                b.block.start.date >= String(args.planned_from)) &&
              (!args.planned_through ||
                b.block.start.date <= String(args.planned_through)),
          )),
    );
    if (args.group_recurrences && !args.task_id && !args.task_ids) {
      const seen = new Set<string>();
      rows = rows.flatMap((t) => {
        if (!t.occurrence || !live(t)) return [t];
        const id = t.occurrence.series_id;
        if (seen.has(id)) return [];
        seen.add(id);
        return [
          {
            ...t,
            pending_occurrence_count: rows.filter(
              (r) => r.occurrence?.series_id === id && live(r),
            ).length,
          },
        ];
      });
    }
    const { rows: items, ...page } = this.page(
      "list_items",
      args,
      rows.map((t) => this.decorate(t)),
      {
        evaluated_at: NOW,
        next_change_at: null,
        detail: "full",
        scope: args.status || args.view || "active",
        sort: args.sort || "action",
        group_recurrences: !!args.group_recurrences,
      },
    );
    return { ...page, items, history: [], next_history_after: null };
  }
  private projects(args: Args) {
    const rows = this.records
      .filter(
        (t) =>
          t.entity_type === "project" &&
          (!t.deleted || args.include_deleted) &&
          (!args.project_id || t.id === args.project_id) &&
          (args.project_id || args.archived === true
            ? t.archived || !!args.project_id
            : !t.archived) &&
          (!args.status || t.status === args.status) &&
          (!args.review_on ||
            (t.review_date &&
              t.review_date <= String(args.review_on) &&
              t.status !== "done")) &&
          (!args.query ||
            t.title.toLowerCase().includes(String(args.query).toLowerCase())),
      )
      .map((t) => {
        const tasks = this.records.filter(
          (x) =>
            x.entity_type === "task" && x.project_id === t.id && !x.deleted,
        );
        return {
          ...this.decorate(t),
          task_counts: Object.fromEntries(
            [...statuses, "archived"].map((s) => [
              s,
              tasks.filter((x) =>
                s === "archived" ? x.archived : !x.archived && x.status === s,
              ).length,
            ]),
          ),
          needs_next_action:
            t.status === "active" &&
            !tasks.some((x) => x.status === "next" && !x.archived),
        };
      });
    const { rows: projects, ...page } = this.page("list_projects", args, rows);
    return { ...page, projects };
  }
  private occurrences(args: Args) {
    if (args.rule || args.template)
      fail(
        "Recurring definitions are view-only in this demo.",
        "demo_limitation",
      );
    const series = this.records.filter(
      (t) =>
        t.entity_type === "recurrence" &&
        !t.deleted &&
        (!args.series_id || t.id === args.series_id),
    );
    const rows = args.series_id
      ? this.records
          .filter(
            (t) =>
              t.occurrence?.series_id === args.series_id &&
              !t.deleted &&
              (!args.from ||
                t.occurrence!.scheduled_date >= String(args.from)) &&
              (!args.through ||
                t.occurrence!.scheduled_date <= String(args.through)),
          )
          .sort((a, b) =>
            b.occurrence!.scheduled_date.localeCompare(
              a.occurrence!.scheduled_date,
            ),
          )
          .map((t) => ({
            original_date: t.occurrence!.original_date,
            scheduled_date: t.occurrence!.scheduled_date,
            preview: false,
            task: this.decorate(t),
          }))
      : [];
    const { rows: occurrences, ...page } = this.page(
      "list_occurrences",
      args,
      rows,
    );
    return {
      ...page,
      series: args.series_id ? series[0] || null : null,
      series_list: series,
      occurrences,
    };
  }
  private history(args: Args) {
    if (args.days && (args.from || args.through))
      fail("Choose days or explicit dates.");
    const snapshot = args.snapshot ? String(args.snapshot) : this.freeze(),
      state = this.state(snapshot);
    const from = args.days ? shift(TODAY, -Number(args.days)) : args.from,
      through = args.days ? shift(TODAY, -1) : args.through;
    let rows = annotate(state.changes).filter(
      (c) =>
        (!args.task_id || c.task_id === args.task_id) &&
        (!args.change_id || c.id === args.change_id) &&
        (!args.project_id ||
          c.after.project_id === args.project_id ||
          c.task_id === args.project_id) &&
        (!args.before_id || c.id < Number(args.before_id)) &&
        (!from || localDate(c.created_at) >= String(from)) &&
        (!through || localDate(c.created_at) <= String(through)),
    );
    if (args.from_request_ids) {
      const ids = this.requestIds(args.from_request_ids);
      rows = rows.filter((c) => ids.includes(c.task_id));
    }
    rows.reverse();
    const { rows: changes, ...page } = this.page(
      "list_changes",
      args,
      rows,
      {
        snapshot,
        total: rows.length,
        window: {
          timezone: ZONE,
          from: from || null,
          through: through || TODAY,
          evaluated_at: NOW,
        },
      },
      30,
    );
    return {
      ...page,
      changes,
      next_before_id: page.next_cursor ? changes.at(-1)?.id : null,
    };
  }
  private activity(name: string, args: Args) {
    const snapshot = args.snapshot ? String(args.snapshot) : this.freeze(),
      events = annotate(this.state(snapshot).changes);
    const from = String(args.from || shift(TODAY, -363)),
      through = String(args.through || TODAY);
    if (
      through < from ||
      Date.parse(through) - Date.parse(from) > 3660 * 86400000
    )
      fail("Choose a valid date range.");
    const window = { timezone: ZONE, from, through, evaluated_at: NOW },
      completed = args.metric === "completed";
    const distinct = new Set<string>(),
      selected = events.filter((c) => {
        if (
          c.activity.automatic ||
          (completed && !c.activity.completion_eligible)
        )
          return false;
        if (!completed) return true;
        const key = localDate(c.created_at) + c.task_id;
        if (distinct.has(key)) return false;
        distinct.add(key);
        return true;
      });
    if (name === "activity_day") {
      const source = args.automatic
        ? events.filter((c) => c.activity.automatic)
        : selected;
      const rows = source
        .filter(
          (c) =>
            localDate(c.created_at) === args.day &&
            (!args.category || c.activity.category === args.category),
        )
        .reverse();
      const { rows: changes, ...page } = this.page(
        name,
        args,
        rows,
        { snapshot, window, total: rows.length },
        30,
      );
      return { ...page, changes, next_before_id: null };
    }
    const totals = Object.fromEntries(categories.map((c) => [c, 0])),
      days = [];
    let total = 0;
    const byDay = new Map<string, typeof selected>();
    for (const c of selected) {
      const d = localDate(c.created_at);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(c);
    }
    for (let date = from; date <= through; date = shift(date, 1)) {
      const rows = byDay.get(date) || [],
        counts = Object.fromEntries(
          categories.map((c) => [
            c,
            rows.filter((e) => e.activity.category === c).length,
          ]),
        );
      for (const c of categories) totals[c] += counts[c];
      const count = date > TODAY ? null : rows.length;
      total += count || 0;
      days.push({
        date,
        count,
        categories: counts,
        partial: date === TODAY,
        future: date > TODAY,
      });
    }
    return {
      days,
      total,
      categories: totals,
      metric: args.metric || "changes",
      snapshot,
      has_history: events.length > 0,
      automatic_count: events.filter(
        (c) =>
          c.activity.automatic &&
          localDate(c.created_at) >= from &&
          localDate(c.created_at) <= through,
      ).length,
      window,
    };
  }
  private priorities(args: Args) {
    const snapshot = args.snapshot ? String(args.snapshot) : this.freeze(),
      records = this.state(snapshot).records,
      g = graph(records);
    const counts = Array.from({ length: 7 }, () =>
        Array.from({ length: 7 }, () =>
          Object.fromEntries(
            ["next", "blocked", "waiting", "someday", "inbox"].map((s) => [
              s,
              0,
            ]),
          ),
        ),
      ),
      previews: any[][] = Array.from({ length: 49 }, () => []);
    for (const t of this.ordered(records)) {
      const p = g.placements.get(t.id);
      if (
        !p ||
        !statuses.includes(t.status) ||
        t.status === "done" ||
        (args.project &&
          (args.project === "all"
            ? !t.project_id
            : t.project_id !== args.project))
      )
        continue;
      counts[p.importance][p.urgency][t.status]++;
      previews[p.importance * 7 + p.urgency].push({
        id: t.id,
        title: t.title,
        status: t.status,
        work_block: p.work_block,
        scheduled: p.scheduled,
        priority_from: p.priority_from,
        urgency_from: p.urgency_from,
      });
    }
    if (args.cell) {
      const cell = args.cell as {
          importance: Task["importance"];
          urgency: string;
          scope: string;
        },
        i = 6 - importanceLevels.indexOf(cell.importance!),
        u = urgencyNames.indexOf(cell.urgency);
      if (i < 0 || u < 0) fail("Invalid priority cell.");
      const rows = previews[i * 7 + u].filter(
        (t) =>
          cell.scope === "all" ||
          (cell.scope === "committed" &&
            ["next", "blocked", "waiting"].includes(t.status)) ||
          t.status === cell.scope,
      );
      const { rows: items, ...page } = this.page("priority_grid", args, rows, {
        snapshot,
      });
      return { ...page, items };
    }
    return {
      counts,
      previews,
      snapshot,
      kind: "priorities",
      evaluated_at: NOW,
      next_change_at: null,
    };
  }
  private requestIds(value: unknown) {
    if (!Array.isArray(value) || !value.length) fail("Choose a saved request.");
    return [
      ...new Set(
        (value as unknown[]).flatMap((id) => {
          const r = this.receipts.get(String(id));
          if (!r)
            fail("This request is unavailable in this demo conversation.");
          return r.ids;
        }),
      ),
    ];
  }
  execute(name: string, args: Args): any {
    switch (name) {
      case "list_items":
        return this.tasks(args);
      case "list_projects":
        return this.projects(args);
      case "list_occurrences":
        return this.occurrences(args);
      case "list_changes":
        return this.history(args);
      case "activity_summary":
      case "activity_day":
        return this.activity(name, args);
      case "priority_grid":
        return this.priorities(args);
      case "request_results": {
        const ids = this.requestIds(args.from_request_ids),
          { rows: records, ...page } = this.page(
            name,
            args,
            ids.map((id) =>
              this.decorate(this.records.find((t) => t.id === id)!),
            ),
            {
              snapshot: this.freeze(),
              from_request_ids: args.from_request_ids,
            },
          );
        return { ...page, records, app: "gtd", view: "results" };
      }
      case "capture_item":
      case "update_item":
      case "create_project":
      case "update_project":
      case "undo_change":
      case "apply_changes":
        return this.write(name, args);
      case "create_recurrence":
      case "update_recurrence":
        fail(
          "Recurring definitions are view-only in this demo. You can still edit their existing tasks.",
          "demo_limitation",
        );
      default:
        fail(
          "This operation is unavailable in the browser demo.",
          "demo_limitation",
        );
    }
  }
  private record(id: unknown, includeDeleted = false) {
    const t = this.records.find(
      (t) => t.id === id && (!t.deleted || includeDeleted),
    );
    if (!t) fail("This record is unavailable.");
    return t;
  }
  private validate(t: Task) {
    if (!t.title.trim() || t.title.length > 500)
      fail("Use a title between 1 and 500 characters.");
    if (
      (t.brief?.length || 0) > 600 ||
      (t.notes?.length || 0) > 10000 ||
      (t.agent_notes?.length || 0) > 10000
    )
      fail("This field exceeds the supported length.");
    if (t.entity_type === "task" && !statuses.includes(t.status))
      fail("Choose a task status.");
    if (
      t.entity_type === "project" &&
      !["active", "someday", "done"].includes(t.status)
    )
      fail("Choose a project status.");
    if (t.entity_type === "task" && !importanceLevels.includes(t.importance!))
      fail("Choose an importance.");
    if (
      t.entity_type === "task" &&
      !t.archived &&
      ["next", "blocked", "waiting"].includes(t.status) &&
      (t.estimated_minutes == null || !t.effort)
    )
      fail("Committed tasks need an estimate and effort.");
    if (
      t.estimated_minutes != null &&
      (!Number.isInteger(t.estimated_minutes) ||
        t.estimated_minutes < 0 ||
        t.estimated_minutes > 5256000)
    )
      fail("Use a valid duration.");
    if (t.effort && !effortLevels.includes(t.effort)) fail("Choose an effort.");
    if (t.project_id && this.record(t.project_id).entity_type !== "project")
      fail("Choose a project.");
    if (
      new Set(t.blocked_by).size !== (t.blocked_by || []).length ||
      (t.blocked_by || []).length > 50
    )
      fail("Use up to 50 distinct prerequisites.");
    for (const id of t.blocked_by || []) {
      const b = this.record(id);
      if (b.entity_type !== "task" || b.id === t.id)
        fail("Choose another task as prerequisite.");
    }
    for (const date of [t.due_date, t.review_date])
      if (
        date &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          new Date(date + "T12:00Z").toISOString().slice(0, 10) !== date)
      )
        fail("Choose a valid date.");
    for (const m of [
      t.not_before,
      t.start_by,
      t.due_date
        ? { date: t.due_date, timezone: ZONE, ...t.deadline_time }
        : null,
    ])
      if (m) bound(m);
    for (const b of blocks(t))
      if (b.end <= b.start) fail("Work block finish must follow its start.");
    if (
      t.safety_buffer &&
      (!t.due_date ||
        t.safety_buffer.value <= 0 ||
        (t.safety_buffer.unit !== "days" && !t.deadline_time))
    )
      fail("A buffer requires a matching deadline.");
    if (t.completion_result && t.status !== "done")
      fail("Completion details require a completed task.");
  }
  private append(
    before: Task | null,
    after: Task,
    operation: string,
    reason: string,
    undo: number | null = null,
  ): Change {
    const id = (this.changes.at(-1)?.id || 0) + 1;
    after = {
      ...copy(after),
      version: (before?.version || 0) + 1,
      created_at: before?.created_at || NOW,
      updated_at: NOW,
      last_change_id: id,
    };
    const change: Change = {
      id,
      task_id: after.id,
      entity_id: after.id,
      entity_type: after.entity_type,
      project_id: after.project_id || undefined,
      operation,
      reason,
      before: copy(before),
      after: copy(after),
      undoes_change_id: undo,
      created_at: NOW,
      origin: "demo",
    };
    const index = this.records.findIndex((t) => t.id === after.id);
    if (index < 0) this.records.push(after);
    else this.records[index] = after;
    this.changes.push(change);
    this.derived = undefined;
    return change;
  }
  private settle() {
    for (const t of [...this.records]) {
      if (!live(t) || !["next", "blocked"].includes(t.status)) continue;
      const waiting = (t.blocked_by || []).some((id) => {
        const p = this.record(id);
        return p.status !== "done" && !p.occurrence?.skipped;
      });
      const held = t.not_before && bound(t.not_before) > Date.parse(NOW),
        status = waiting || held || t.manual_block ? "blocked" : "next";
      if (t.status !== status)
        this.append(
          t,
          { ...t, status },
          "dependency_status",
          "Updated readiness after a prerequisite changed.",
        );
    }
  }
  private mutate(name: string, args: Args): any {
    if (name === "undo_change") {
      const target = this.changes.find((c) => c.id === args.change_id);
      if (!target) fail("This change is unavailable.");
      const current = this.record(target.task_id, true);
      if (
        current.version !== args.expected_version ||
        current.last_change_id !== target.id
      )
        fail(
          "This record changed after that edit. Refresh before undoing.",
          "conflict",
        );
      const changes = (this.groups.get(target.id) || [target.id]).map((id) =>
        this.changes.find((c) => c.id === id)!,
      );
      for (const c of changes)
        if (this.record(c.task_id, true).last_change_id !== c.id)
          fail(
            "A related task changed. This group cannot be undone.",
            "conflict",
          );
      const undone: Change[] = [];
      for (const c of [...changes].reverse()) {
        const t = this.record(c.task_id, true);
        undone.push(
          this.append(
            t,
            c.before || { ...t, deleted: true },
            "undo",
            String(args.reason || "Undid a demo edit."),
            c.id,
          ),
        );
      }
      this.settle();
      const result = undone.find((c) => c.task_id === target.task_id)!;
      for (const c of undone)
        this.groups.set(
          c.id,
          undone.map((c) => c.id),
        );
      return {
        task: copy(result.after),
        change: copy(result),
        replayed: false,
      };
    }
    const create = name === "capture_item" || name === "create_project",
      project = name.endsWith("project"),
      before = create ? null : this.record(args.task_id || args.project_id);
    if (before?.entity_type === "recurrence")
      fail(
        "Recurring definitions are view-only in this demo.",
        "demo_limitation",
      );
    if (before && before.version !== args.expected_version)
      fail("This record changed. Refresh before saving.", "conflict");
    const task: Task = before
      ? copy(before)
      : {
          id: this.id(),
          entity_type: project ? "project" : "task",
          title: "",
          brief: "",
          notes: "",
          agent_notes: "",
          status: project ? "active" : "inbox",
          importance: "normal",
          due_date: null,
          project_id: null,
          review_date: null,
          deleted: false,
          archived: false,
          links: [],
          work_sessions: [],
          version: 0,
          last_change_id: 0,
        };
    for (const key of fields)
      if (args[key] != null && (key !== "project_id" || !project))
        (task as any)[key] = copy(args[key]);
    for (const [flag, key] of [
      ["clear_project", "project_id"],
      ["clear_review_date", "review_date"],
      ["clear_due_date", "due_date"],
    ])
      if (args[flag]) (task as any)[key] = null;
    if (args.clear_due_date) {
      task.deadline_time = null;
      task.safety_buffer = null;
    }
    if (Array.isArray(args.clear_planning))
      for (const key of args.clear_planning) {
        if (!fields.includes(String(key))) fail("Unknown planning field.");
        (task as any)[String(key)] = null;
      }
    if (args.work_blocks) {
      task.work_blocks = (args.work_blocks as any[]).map((b) => ({
        ...b,
        id: b.id || this.id(),
      }));
      task.planned_start = task.work_blocks[0]?.start || null;
      task.planned_finish = task.work_blocks[0]?.finish || null;
    }
    if (args.status === "blocked") task.manual_block = true;
    else if (args.status === "next") task.manual_block = false;
    if (args.started === true && !before?.started)
      task.started_at = { date: TODAY, time: "13:00", timezone: ZONE };
    if (args.started === false) task.started_at = null;
    if (task.status === "done" && before?.status !== "done")
      task.completed_at = NOW;
    else if (task.status !== "done") {
      task.completed_at = null;
      task.completion_result = null;
    }
    this.validate(task);
    graph(this.records.filter((t) => t.id !== task.id).concat(task));
    if (live(task) && ["next", "blocked"].includes(task.status)) {
      const blocked =
        task.manual_block ||
        (task.blocked_by || []).some(
          (id) => this.record(id).status !== "done",
        ) ||
        (task.not_before && bound(task.not_before) > Date.parse(NOW));
      task.status = blocked ? "blocked" : "next";
    }
    const start = this.changes.length,
      change = this.append(
        before,
        task,
        create ? "capture" : "update",
        String(args.reason || "Edited in the browser demo."),
      );
    this.settle();
    const group = this.changes.slice(start).map((c) => c.id);
    for (const id of group) this.groups.set(id, group);
    return {
      task: copy(change.after),
      ...(project ? { project: copy(change.after) } : {}),
      change: copy(change),
      replayed: false,
    };
  }
  private write(name: string, args: Args) {
    if (typeof args.request_id !== "string" || !args.request_id.length)
      fail("A request ID is required.");
    const request = args.request_id as string,
      fingerprint = JSON.stringify([name, args]),
      old = this.receipts.get(request);
    if (old) {
      if (old.fingerprint !== fingerprint)
        fail(
          "This request ID belongs to a different edit.",
          "request_id_conflict",
        );
      return { ...copy(old.result), replayed: true };
    }
    const saved = copy(this.state()),
      groups = new Map(this.groups),
      sequence = this.sequence;
    try {
      let result: any;
      if (name === "apply_changes") {
        if (
          !Array.isArray(args.operations) ||
          !args.operations.length ||
          args.operations.length > 50
        )
          fail("Use 1–50 operations.");
        const results = args.operations.map((op: any) => {
          const names: Record<string, string> = {
            capture: "capture_item",
            update: "update_item",
            create_project: "create_project",
            update_project: "update_project",
          };
          if (!names[op.operation])
            fail("This batch operation is unavailable in the demo.");
          return this.mutate(names[op.operation], {
            ...op,
            reason: op.reason || args.reason,
          });
        });
        result = { results, replayed: false };
      } else result = this.mutate(name, args);
      const ids = (result.results || [result]).map((r: any) => r.task.id);
      this.receipts.set(request, { fingerprint, result: copy(result), ids });
      return { ...result, request_id: request };
    } catch (e) {
      this.records = saved.records;
      this.changes = saved.changes;
      this.groups = groups;
      this.sequence = sequence;
      this.derived = undefined;
      throw e;
    }
  }
}
