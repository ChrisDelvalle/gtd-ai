import type { Args } from "./api";
import { ChartSelector } from "./chart-controls";

export const sortLabels: Record<string, string> = {
  action: "Recommended", effective_due: "Deadline", due: "Task deadline",
  importance: "Importance", updated: "Recently changed", created: "Oldest first",
  created_desc: "Newest first", relevance: "Relevance", title: "Name A–Z",
  review: "Review date", result_order: "Result order",
};
export function defaultTaskSort(args: Args) {
  return String(args.sort || (args.query ? "relevance" : args.review_on ? "review"
    : args.status === "done" || args.archived === true ? "updated" : "action"));
}
export function SortControl({ value, select, options, pending, labels }: {
  value: string; select: (sort: string) => void; options?: string[]; pending?: string; labels?: Record<string, string>;
}) {
  return <ChartSelector value={value} select={select}
    options={options || ["action", "effective_due", "importance", "updated", "created", "created_desc"]}
    labels={{...sortLabels, ...labels}} label="Sort" prefix="Sort" pending={pending} />;
}
