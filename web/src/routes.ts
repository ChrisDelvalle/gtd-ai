import type { Destination } from "./app-context";
import { scopeArgs, scopeOf, type Args } from "./api";

const paths = {
  Home: "/",
  Tasks: "/tasks",
  Projects: "/projects",
  Repeating: "/repeating",
  Review: "/review",
  Activity: "/activity",
  Charts: "/charts",
  Results: "/results",
  Help: "/help",
  Logs: "/logs",
  Health: "/health",
  Users: "/users",
} as const;
const strings = new Set([
  "query",
  "due_from",
  "due_through",
  "planned_from",
  "planned_through",
  "review_from",
  "review_through",
  "review_on",
  "project_id",
  "blocked_by_id",
  "from",
  "through",
]);
const booleans = new Set(["undated", "include_deleted", "group_recurrences"]);
const enums: Record<string, readonly string[]> = {
  status: [
    "next",
    "inbox",
    "waiting",
    "blocked",
    "planned",
    "someday",
    "done",
    "active",
    "archived",
  ],
  view: ["all", "active"],
  sort: ["action", "importance", "due", "updated", "created", "relevance"],
  max_effort: ["trivial", "low", "medium", "high", "extreme"],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only public navigation state belongs in a URL. Never drafts, cursors or writes. */
export function destinationUrl(route: Destination): string {
  const input: Args = {
    ...(route.page === "Tasks" && !route.input
      ? scopeArgs(route.scope || "active")
      : {}),
    ...route.input,
  };
  let path: string = paths[route.page];
  const idKey =
    route.page === "Tasks"
      ? "task_id"
      : route.page === "Projects"
        ? "project_id"
        : route.page === "Repeating"
          ? "series_id"
          : null;
  if (
    idKey &&
    typeof input[idKey] === "string" &&
    uuid.test(input[idKey] as string)
  ) {
    path += "/" + input[idKey];
    delete input[idKey];
  }
  const query = new URLSearchParams();
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (key === "archived") {
      if (typeof value === "boolean") query.set(key, String(value));
      else if (route.page === "Tasks" && input.view === "all")
        query.set(key, "any");
    } else if (strings.has(key) && typeof value === "string" && value)
      query.set(key, value);
    else if (booleans.has(key) && typeof value === "boolean")
      query.set(key, String(value));
    else if (
      enums[key] &&
      typeof value === "string" &&
      enums[key].includes(value)
    )
      query.set(key, value === "planned" ? "blocked" : value);
    else if (
      key === "max_estimated_minutes" &&
      Number.isInteger(value) &&
      Number(value) >= 0
    )
      query.set(key, String(value));
    else if (key === "exclude_statuses" && Array.isArray(value)) {
      for (const status of [...new Set(value)].sort())
        if (
          enums.status.includes(status) &&
          status !== "active" &&
          status !== "archived"
        )
          query.append(key, status === "planned" ? "blocked" : status);
    } else if (key === "task_ids" && Array.isArray(value))
      for (const id of value.slice(0, 50))
        if (typeof id === "string" && uuid.test(id)) query.append(key, id);
  }
  return path + (query.size ? "?" + query : "");
}

export function urlDestination(
  location: Pick<Location, "pathname" | "search">,
): Destination | null {
  const path = location.pathname.replace(/\/$/, "") || "/";
  const parts = path.split("/").filter(Boolean);
  const page = Object.entries(paths).find(
    ([, p]) => p === (parts.length ? "/" + parts[0] : "/"),
  )?.[0] as Destination["page"] | undefined;
  if (!page || parts.length > 2) return null;
  const input: Args = {};
  if (parts.length === 2) {
    if (!uuid.test(parts[1])) return null;
    if (page === "Tasks") {
      input.task_id = parts[1];
      input.open_details = true;
    } else if (page === "Projects") input.project_id = parts[1];
    else if (page === "Repeating") input.series_id = parts[1];
    else return null;
  }
  const query = new URLSearchParams(location.search);
  for (const [key, value] of query) {
    // A query filter cannot redirect a focused record path to another record.
    if (parts.length === 2 && page === "Projects" && key === "project_id") continue;
    if (key === "archived" && ["true", "false", "any"].includes(value))
      input.archived = value === "any" ? undefined : value === "true";
    else if (strings.has(key) && value.length <= 500) input[key] = value;
    else if (booleans.has(key) && ["true", "false"].includes(value))
      input[key] = value === "true";
    else if (enums[key]?.includes(value))
      input[key] = value === "planned" ? "blocked" : value;
    else if (
      key === "max_estimated_minutes" &&
      /^\d+$/.test(value) &&
      Number(value) <= 5256000
    )
      input[key] = Number(value);
    else if (key === "exclude_statuses")
      input[key] = [
        ...new Set(
          query
            .getAll(key)
            .filter(
              (s) =>
                enums.status.includes(s) && s !== "active" && s !== "archived",
            )
            .map((s) => (s === "planned" ? "blocked" : s)),
        ),
      ];
    else if (key === "task_ids")
      input[key] = [
        ...new Set(query.getAll(key).filter((id) => uuid.test(id))),
      ].slice(0, 50);
  }
  if (page === "Tasks") {
    if (
      !input.task_id &&
      !input.task_ids &&
      !input.status &&
      !input.view &&
      !input.review_on
    )
      input.view = "all";
    if (input.view === "all" && !Object.hasOwn(input, "archived"))
      input.archived = false;
    if (input.status) delete input.view;
    return { page, scope: scopeOf(input), input };
  }
  return Object.keys(input).length ? { page, input } : { page };
}

export function safeReturnPath(value: string, origin: string): string {
  try {
    const u = new URL(value, origin);
    return u.origin === origin && urlDestination(u as unknown as Location)
      ? u.pathname + u.search
      : "/";
  } catch {
    return "/";
  }
}
