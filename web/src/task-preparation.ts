import type { Api, List, Task } from "./api";

/** A page-revision budget, not a record cache. Explicit reads still share the
 * existing API's in-flight coalescing. Completion is accepted by the row only
 * while its ID/version still match. Queued guesses never block explicit reads. */
export function taskPreparation(api: Api) {
  let used = 0,
    running = 0,
    disposed = false;
  const attempted = new Set<string>();
  const queue: { key: string; start: () => void; cancelled: boolean }[] = [];
  function drain() {
    const concurrency = api.taskPreparation === "widget-intent" ? 1 : 2;
    while (!disposed && running < concurrency && queue.length) {
      const job = queue.shift()!;
      if (job.cancelled || attempted.has(job.key) || used >= 3) continue;
      attempted.add(job.key);
      used++;
      running++;
      job.start();
    }
  }
  return {
    dispose() {
      disposed = true;
      queue.length = 0;
    },
    schedule(
      task: Task,
      accept: (record: Task) => void,
      delay = api.taskPreparation === "widget-intent" ? 125 : 100,
    ) {
      let cancelled = false;
      const job = {
        key: `${task.id}:${task.version}:${task.recommendation?.policy || ""}:${task.recommendation?.revision || ""}:${task.recommendation?.evaluated_at || ""}`,
        cancelled: false,
        start: () => {
          void api
            .call<List>("list_items", {
              task_id: task.id,
              include_deleted: true,
              detail: "full",
            })
            .then((r) => {
              const record = r.items[0];
              if (
                !disposed &&
                !cancelled &&
                record?.id === task.id &&
                record.version === task.version
              )
                accept({ ...record, recommendation: task.recommendation || record.recommendation });
            })
            .catch(() => {}) // A failed guess never replaces explicit error/retry UI.
            .finally(() => {
              running--;
              drain();
            });
        },
      };
      const timer = setTimeout(() => {
        const connection = (
          navigator as Navigator & { connection?: { saveData?: boolean } }
        ).connection;
        if (
          disposed ||
          document.visibilityState !== "visible" ||
          connection?.saveData ||
          attempted.has(job.key)
        )
          return;
        queue.push(job);
        drain();
      }, delay);
      return () => {
        cancelled = true;
        job.cancelled = true;
        clearTimeout(timer);
      };
    },
  };
}
export type TaskPreparation = ReturnType<typeof taskPreparation>;
