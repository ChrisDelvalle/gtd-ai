import { isArchived, type HomeSnapshot, type Task } from "./api";
import type { Intent } from "./mutations";

/** Shared presentation selection, separate from the backend recommendation order. */
export function homeModel(
  data: HomeSnapshot | null,
  reviewOn: string,
  intents: ReadonlyMap<string, Intent> = new Map(),
  project: (task: Task) => Task = (task) => task,
) {
  // Keep uncertain writes reachable while they settle, as in the task views.
  const rows = new Map<string, Task>();
  for (const task of [
    ...(data?.next.items || []),
    ...(data?.waiting.items || []),
    ...(data?.someday.items || []),
    ...(data?.reviewTasks.items || []),
    ...(data?.reviewProjects.projects || []),
  ]) {
    const previous = rows.get(task.id);
    if (!previous || task.version >= previous.version) rows.set(task.id, task);
  }
  for (const intent of intents.values()) {
    const task = intent.before || intent.preview;
    if (task && task.id !== "capture" && !rows.has(task.id))
      rows.set(task.id, task);
  }
  const effective = (task: Task) =>
    intents.get(task.id)?.before || project(task);
  // Backend order is authoritative. Append unresolved writes without inventing a
  // second recommendation policy while their responses are pending.
  const ordered = [...rows.values()].filter(
    (t) =>
      !effective(t).deleted &&
      !isArchived(effective(t)) &&
      effective(t).status !== "done",
  );
  const tasks = ordered.filter((t) => t.entity_type !== "project");
  const next = tasks.filter((t) => effective(t).status === "next");
  const lead = next[0];
  const waiting = tasks.filter((t) => effective(t).status === "waiting");
  const someday = tasks.filter((t) => effective(t).status === "someday");
  const review = ordered
    .filter((t) => {
      const current = effective(t);
      return current.review_date && current.review_date <= reviewOn;
    })
    .sort(
      (a, b) =>
        (effective(a).review_date || "").localeCompare(
          effective(b).review_date || "",
        ) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
  const empty = !lead && !review.length && !waiting.length && !someday.length;
  return { next, lead, waiting, someday, review, empty, effective };
}
