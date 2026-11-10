import type { Api, Args } from "./api";

export const readTools = new Set([
  "list_items",
  "list_projects",
  "list_occurrences",
  "list_changes",
  "sync_state", "activity_summary", "activity_day", "priority_grid", "request_results", "view_snapshot",
]);

/** Share only concurrent reads. Never cache writes or change their retry identity. */
export function coalescedApi(source: Api): Api {
  const pending = new Map<string, Promise<unknown>>();
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, stable(child)]),
          )
        : value;
  function read<T>(
    name: string,
    args: Args,
    load: () => Promise<T>,
  ): Promise<T> {
    const key = name + JSON.stringify(stable(args));
    const previous = pending.get(key);
    if (previous) return previous as Promise<T>;
    const request = load();
    pending.set(key, request);
    void request
      .finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      })
      .catch(() => {});
    return request;
  }
  return {
    taskPreparation: source.taskPreparation,
    invalidateReads() {
      pending.clear();
      source.invalidateReads?.();
    },
      identityScope: source.identityScope?.bind(source),
    openLink: source.openLink?.bind(source),
    home: source.home
      ? (date) => read("internal:home", { date }, () => source.home!(date))
      : undefined,
    call<T>(name: string, args: Args): Promise<T> {
      if (!readTools.has(name)) {
        return source.call<T>(name, args).finally(() => pending.clear());
      }
      return read(name, args, () => source.call<T>(name, args));
    },
  };
}
