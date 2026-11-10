import type { Args } from "./api";

type ObjectValue = Record<string, unknown>;
type Page = { operation: string; arguments: Args; data: ObjectValue };
type Scope = { account?: string; environment?: string; timezone: string };
export type WidgetBundle = {
  revision: number;
  evaluated_at: string;
  deferred: boolean;
  revalidate: boolean;
  pages: Page[];
};

function object(value: unknown): value is ObjectValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const operations = new Set([
  "home", "list_items", "list_projects", "list_occurrences", "list_changes",
  "activity_summary", "request_results",
]);
export function widgetBundle(value: unknown, scope: Scope): WidgetBundle | undefined {
  if (!object(value) || value.version !== 1 || !scope.account ||
      value.account !== scope.account || value.environment !== scope.environment ||
      value.timezone !== scope.timezone || !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0 || typeof value.evaluated_at !== "string" ||
      !Number.isFinite(Date.parse(value.evaluated_at)) || !Array.isArray(value.records) ||
      !Array.isArray(value.pages) || value.pages.length > 32 || value.records.length > 1200) return;
  const records = value.records;
  for (const record of records) {
    if (!object(record) || typeof record.id !== "string" || typeof record.title !== "string" ||
        !Number.isSafeInteger(record.version) || Number(record.version) < 1 ||
        typeof record.notes !== "string" || "agent_notes" in record) return;
    if (record.entity_type === "task") {
      const preview = record.widget_preview;
      if (!object(preview) || !Array.isArray(preview.prerequisites) ||
          !Array.isArray(preview.dependents) || typeof preview.more !== "boolean" ||
          !(typeof preview.project_title === "string" || preview.project_title === null)) return;
    }
  }
  function hydrate(data: ObjectValue, field: string) {
    const refs = data[field];
    if (!Array.isArray(refs)) return;
    const rows = [];
    for (const row of refs) {
      const index = object(row) ? row.ref : row;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= records.length) return;
      const record = records[index];
      if (object(row)) {
        const context = row.context;
        if (!object(context) || Object.keys(context).some(key =>
          !["recommendation", "pending_occurrence_count", "blocking_count", "needs_next_action", "task_counts"].includes(key))) return;
        rows.push({ ...record, ...context });
      } else rows.push(record);
    }
    return { ...data, [field]: rows };
  }
  const pages: Page[] = [];
  for (const page of value.pages) {
    if (!object(page) || typeof page.operation !== "string" || !operations.has(page.operation) ||
        !object(page.arguments) || !object(page.data)) return;
    let data: ObjectValue | undefined = page.data;
    if (page.summaries === true) {
      pages.push({ operation: page.operation, arguments: page.arguments, data });
      continue;
    }
    if (page.operation === "home") {
      const home: ObjectValue = { ...data, revalidate: value.revalidate === true };
      for (const name of ["next", "waiting", "someday", "reviewTasks", "reviewProjects"]) {
        const section = data[name];
        if (!object(section)) return;
        const hydrated = hydrate(section, name === "reviewProjects" ? "projects" : "items");
        if (!hydrated) return;
        home[name] = hydrated;
      }
      data = home;
    } else {
      const field = { list_items: "items", list_projects: "projects", request_results: "records" }[page.operation];
      if (field) {
        data = hydrate(data, field);
        if (data) data.widget_bundled = true;
      }
    }
    if (!data) return;
    pages.push({ operation: page.operation, arguments: page.arguments, data });
  }
  return {
    revision: Number(value.revision), evaluated_at: value.evaluated_at,
    deferred: value.deferred === true, revalidate: value.revalidate === true, pages,
  };
}
