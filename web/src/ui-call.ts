import type {Args} from "./api";
const reads = new Set(["show_gtd", "list_items", "show_tasks", "list_projects", "show_projects", "list_occurrences", "list_changes", "sync_state", "activity_summary", "activity_day", "priority_grid", "request_results", "view_snapshot", "widget_pages"]);
// Keep the original operation and intent arguments intact across retries and upgrades.
export function uiCall(operation: string, args: Args) {
  return {name: reads.has(operation) ? "gtd_ui_read" : "gtd_ui_write", arguments: {operation, arguments: args}};
}
