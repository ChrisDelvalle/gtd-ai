import { environmentGuard } from "./environment-guard.ts";
import { websiteIdentity } from "./website-identity.ts";
import { defaultZone } from "./calendar-context.ts";
import { applicationNow } from "./application-clock.ts";
export const statuses = [
  "inbox",
  "next",
  "waiting",
  "blocked",
  "someday",
  "done",
] as const;
export type Status =
  (typeof statuses)[number] | "archived" | "active" | "planned"; // legacy audit snapshots
export type TaskLink = { url: string; label?: string | null };
export const importanceLevels = [
  "critical",
  "very_high",
  "high",
  "normal",
  "low",
  "very_low",
  "unimportant",
] as const;
export type Importance = (typeof importanceLevels)[number];
export type Clock = {
  time: string;
  timezone: string;
  utc_offset_minutes?: number | null;
};
export type Moment = {
  date: string;
  time?: string | null;
  timezone: string;
  utc_offset_minutes?: number | null;
};
export type RelativeMoment = {
  offset_days: number;
  time?: string | null;
  timezone: string;
};
export const effortLevels = [
  "trivial",
  "low",
  "medium",
  "high",
  "extreme",
] as const;
export type Effort = (typeof effortLevels)[number];
export type SafetyBuffer = {
  value: number;
  unit: "days" | "hours" | "minutes";
};
export type WorkBlock = {
  id: string;
  start: Moment;
  finish?: Moment | null;
  calendar_event?: TaskLink | null;
};
export type RelativeWorkBlock = {
  id: string;
  start: RelativeMoment;
  finish?: RelativeMoment | null;
};
export type Planning = {
  estimated_minutes?: number | null;
  effort?: Effort | null;
  not_before?: Moment | null;
  safety_buffer?: SafetyBuffer | null;
  work_blocks?: WorkBlock[] | null;
  buffer_target?: Moment | null;
  buffer_adjustment?: string | null;
  importance?: Importance | null;
  deadline_time?: Clock | null;
  start_by?: Moment | null;
  planned_start?: Moment | null;
  planned_finish?: Moment | null;
  started?: boolean;
  started_at?: Moment | null;
};
export type DependencyLabel = {
  id: string;
  title: string;
  status: Task["status"];
  occurrence?: { scheduled_date: string; skipped: boolean } | null;
};
export type Task = Planning & {
  widget_preview?: {
    prerequisites: DependencyLabel[];
    dependents: DependencyLabel[];
    more: boolean;
    project_title: string | null;
    project_version?: number | null;
    repeat_rule?: RepeatRule | null;
  };
  work_block_count?: number;
  blocked_by?: string[];
  manual_block?: boolean;
  blocking_reasons?: {
    kind: string;
    available_at?: Moment;
    task_ids?: string[];
  }[];
  unresolved_blocker_ids?: string[];
  recommendation?: {
    source_task_id?: string;
    effective_deadline?: Moment | null;
    deadline_project?: { id: string; title: string } | null;
    project_fallback?: { deadline: Moment; source: { id: string; title: string } } | null;
    policy?: string;
    revision?: number;
    reason: string;
    evaluated_at: string;
    next_change_at?: string | null;
    key: string;
  };
  timing_adjustments?: string[];
  occurrence?: {
    series_id: string;
    original_date: string;
    scheduled_date: string;
    skipped: boolean;
    overrides: string[];
  };
  pending_occurrence_count?: number;
  recurrence?: {
    timezone?: string;
    segments: { from: string; rule: RepeatRule; template: RepeatTemplate }[];
    pauses: { from: string; through: string | null }[];
    ended_on: string | null;
  };
  recurrence_summary?: {
    segment_count: number;
    paused: boolean;
    ended_on: string | null;
    current_rule: RepeatRule;
  };
  entity_type?: "task" | "project" | "recurrence";
  project_id?: string | null;
  review_date?: string | null;
  work_sessions?: TaskLink[];
  completion_result?: string | null;
  completed_at?: string | null;
  has_completion_result?: boolean;
  blocking_count?: number;
  detail?: "summary" | "full";
  omitted_fields?: string[];
  id: string;
  title: string;
  brief?: string;
  notes?: string;
  has_notes?: boolean;
  agent_notes?: string;
  has_agent_notes?: boolean;
  links?: TaskLink[];
  location?: string | null;
  link_count?: number;
  has_location?: boolean;
  status: Status;
  archived?: boolean;
  due_date: string | null;
  version: number;
  created_at?: string;
  updated_at?: string;
  deleted: boolean;
  last_change_id: number;
};
export type Change = {
  activity?: { category: string; automatic: boolean; completion_eligible: boolean; undone_by_change_id: number | null; transitions: Record<string, {from: unknown; to: unknown}> };
  entity_type?: "task" | "project" | "recurrence";
  entity_id?: string;
  project_id?: string;
  detail?: "summary" | "full";
  changed_fields?: string[];
  id: number;
  task_id: string;
  operation: string;
  reason: string;
  before?: Task | null;
  after: Task;
  undoes_change_id: number | null;
  created_at: string;
  origin: string;
};
export type List = {
  evaluated_at?: string;
  next_change_at?: string | null;
  group_recurrences?: boolean;
  next_cursor?: string | null;
  complete?: boolean;
  scope?: string;
  detail?: "summary" | "full";
  sort?: string;
  items: Task[];
  next_offset: number | null;
  history: Change[];
  next_history_after: number | null;
};
export type Changes = { changes: Change[]; next_before_id: number | null; next_cursor?: string | null; snapshot?: string; total?: number };
export type Mutation = {
  task: Task;
  project?: Task;
  series?: Task;
  change: Change;
  replayed: boolean;
};
export type Project = Task & {
  task_counts?: Partial<Record<Status, number>>;
  needs_next_action?: boolean;
};
export type Projects = {
  projects: Project[];
  next_cursor: string | null;
  complete?: boolean;
};
export const projectStatuses = ["active", "someday", "done"] as const;
export function recordRead(task: Task): [string, Args] {
  if (task.entity_type === "recurrence")
    return ["list_occurrences", { series_id: task.id, limit: 1 }];
  return task.entity_type === "project"
    ? [
        "list_projects",
        { project_id: task.id, include_deleted: true, detail: "full" },
      ]
    : [
        "list_items",
        { task_id: task.id, include_deleted: true, detail: "full" },
      ];
}
export function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: defaultZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(applicationNow()));
}

export type Args = Record<string, unknown>;
export type Api = {
  identityScope?: () => string | undefined;
  call: <T>(name: string, args: Args) => Promise<T>;
  openLink?: (url: string) => Promise<void>;
  taskPreparation?: "intent" | "widget-intent";
  invalidateReads?: () => void;
  home?: (reviewOn: string) => Promise<HomeSnapshot>;
};
export type HomeSnapshot = {
  revalidate?: boolean;
  next: List;
  waiting: List;
  someday: List;
  reviewTasks: List;
  reviewProjects: Projects;
  remaining: string | null;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public code = "unknown",
    public uncertain = false,
  ) {
    super(message);
  }
}
export const websiteEnvironment = environmentGuard();
let websiteLocked = false;
let websiteLoginGeneration = 0;
export function setWebsiteLocked(locked: boolean) {
  websiteLocked = locked;
  websiteLoginGeneration++;
}
function requireWebsiteLogin(generation = websiteLoginGeneration) {
  if (generation === websiteLoginGeneration) {
    websiteLocked = true;
    window.dispatchEvent(new Event("gtd:authentication-required"));
  }
  return new ApiError(
    "Sign in to continue. Your draft is still here.",
    "authentication_required",
  );
}
function assertWebsiteGeneration(generation: number, uncertain = false) {
  websiteIdentity.assert();
  if (generation !== websiteLoginGeneration) throw new ApiError(
    "The sign-in session changed. Check the current state before retrying.", "session_changed", uncertain,
  );
}
/** Shared same-origin transport for tool calls and composed website reads. */
export async function websitePost<T>(path: string, args: Args): Promise<T> {
  if (websiteLocked) throw requireWebsiteLogin();
  const generation = websiteLoginGeneration;
  websiteEnvironment.assert();
  websiteIdentity.assert();
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GTD-Request": "1",
        ...(websiteEnvironment.expected
          ? { "X-GTD-Environment": websiteEnvironment.expected }
          : {}),
        ...websiteIdentity.headers(),
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(
      "Connection interrupted. The operation may have reached the server.",
      "network",
      true,
    );
  }
  assertWebsiteGeneration(generation, true);
  if (response.status === 401) throw requireWebsiteLogin(generation);
  let value: Record<string, unknown>;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(
      "Unexpected response. Check your connection or sign in again.",
      [404, 405].includes(response.status) ? String(response.status) : "response",
      response.ok || response.status >= 500,
    );
  }
  assertWebsiteGeneration(generation, true);
  if (value.code === "account_changed") websiteIdentity.reject();
  if (value.code === "environment_changed") websiteEnvironment.reject();
  websiteEnvironment.observe(value.environment);
  if (!response.ok)
    throw new ApiError(
      String(value.message || "Request failed"),
      String(value.code || response.status),
      response.status >= 500,
    );
  return value as T;
}
let composedHomeSupported = true;
export const websiteApi: Api = {
  identityScope: () => websiteIdentity.expected ? `${websiteEnvironment.expected}:${websiteIdentity.expected}` : undefined,
  taskPreparation: "intent",
  home: async (reviewOn) => {
    if (composedHomeSupported) {
      try {
        return (await websitePost<{data: HomeSnapshot}>("/api/view", {
          view: "home", review_on: reviewOn, loading: "top-three",
        })).data;
      } catch (error) {
        if (!(error instanceof ApiError) || !["404", "405"].includes(error.code)) throw error;
        composedHomeSupported = false;
      }
    }
    // An already-open new client must also work after rolling back the server.
    const { readHome } = await import("./home-read");
    return readHome({ call: websiteApi.call }, reviewOn);
  },
  call: <T>(name: string, args: Args) =>
    websitePost<T>(`/api/tools/${encodeURIComponent(name)}`, args),
};
export async function get<T>(path: string): Promise<T> {
  if (websiteLocked) throw requireWebsiteLogin();
  const generation = websiteLoginGeneration;
  const response = await fetch(path, { headers: websiteIdentity.headers(), signal: AbortSignal.timeout(10000), cache: "no-store" });
  assertWebsiteGeneration(generation);
  if (response.status === 401) throw requireWebsiteLogin(generation);
  const value = await response.json();
  assertWebsiteGeneration(generation);
  if (value.code === "account_changed") websiteIdentity.reject();
  if (value.code === "environment_changed") websiteEnvironment.reject();
  if (!response.ok) throw new ApiError(value.message || `Could not load this view (${response.status}).`, value.code || String(response.status));
  return value;
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
export function time(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: defaultZone,
  }).format(new Date(value));
}
export function day(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${value}T12:00:00Z`))
    : "No due date";
}

export const views = [
  ["active", "Active"],
  ["next", "Next actions"],
  ["inbox", "Inbox"],
  ["waiting", "Waiting"],
  ["someday", "Someday"],
  ["blocked", "Blocked"],
  ["done", "Done"],
  ["archived", "Archive"],
  ["all", "All tasks"],
] as const;
export function scopeArgs(scope: string): Args {
  if (scope === "planned") scope = "blocked";
  if (scope === "archived") return { archived: true };
  if (scope === "all") return { view: "all", archived: false };
  return scope === "all" || scope === "active"
    ? { view: scope }
    : { status: scope };
}
export function scopeOf(args: Args) {
  if (args.review_on) return "review";
  return String(
    (args.archived === true ? "archived" : null) ||
      (args.status === "planned" ? "blocked" : args.status) ||
      args.view ||
      (args.task_id || args.task_ids ? "selected" : "active"),
  );
}
export function isArchived(task: Task) {
  return task.archived === true || task.status === "archived";
}
export function inScope(task: Task, args: Args) {
  if (task.entity_type === "project") return false;
  if (
    args.blocked_by_id &&
    !task.blocked_by?.includes(String(args.blocked_by_id))
  )
    return false;
  if (args.project_id && task.project_id !== args.project_id) return false;
  if (
    args.review_on &&
    (!task.review_date ||
      task.review_date > String(args.review_on) ||
      task.status === "done" ||
      isArchived(task))
  )
    return false;
  if (task.deleted && !args.include_deleted) return false;
  if (
    Array.isArray(args.exclude_statuses) &&
    args.exclude_statuses.includes(task.status)
  )
    return false;
  if (args.task_id && task.id !== args.task_id) return false;
  if (Array.isArray(args.task_ids) && !args.task_ids.includes(task.id))
    return false;
  const scope = scopeOf(args);
  const archived = isArchived(task);
  if (args.archived === false && archived) return false;
  if (scope === "archived") {
    if (!archived) return false;
    if (
      args.status &&
      args.status !== "archived" &&
      task.status !== args.status
    )
      return false;
  } else if (!["all", "selected"].includes(scope) && archived) return false;
  if (
    scope === "active" &&
    !["next", "inbox", "waiting", "blocked"].includes(task.status)
  )
    return false;
  if (
    !["active", "all", "selected", "archived", "review"].includes(scope) &&
    scope !== task.status
  )
    return false;
  if (args.undated && task.due_date) return false;
  if (
    typeof args.due_from === "string" &&
    (!task.due_date || task.due_date < args.due_from)
  )
    return false;
  if (
    typeof args.due_through === "string" &&
    (!task.due_date || task.due_date > args.due_through)
  )
    return false;
  return true;
}

export type RepeatRule = {
  start_date: string;
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  weekdays: string[];
  month_day: number | null;
  ordinal: number | null;
  until: string | null;
  count: number | null;
};
export type RepeatTemplate = {
  estimated_minutes?: number | null;
  effort?: Effort | null;
  not_before?: RelativeMoment | null;
  safety_buffer?: SafetyBuffer | null;
  work_blocks?: RelativeWorkBlock[] | null;
  importance?: Importance | null;
  deadline_time?: Clock | null;
  start_by?: RelativeMoment | null;
  planned_start?: RelativeMoment | null;
  planned_finish?: RelativeMoment | null;
  clear_planning?: string[];
  title: string;
  brief?: string;
  notes: string;
  agent_notes?: string;
  has_agent_notes?: boolean;
  omitted_fields?: string[];
  links: TaskLink[];
  location: string | null;
  project_id: string | null;
  due_offset_days: number | null;
  review_offset_days: number | null;
  status: Status;
};
export type Occurrences = {
  series: Task | null;
  series_list?: Task[];
  series_omitted?: boolean;
  occurrences: {
    original_date: string;
    scheduled_date: string;
    preview: boolean;
    task?: Task;
    planning?: Planning;
    due_date?: string | null;
    timing_adjustments?: string[];
  }[];
  next_cursor: string | null;
  complete: boolean;
};
