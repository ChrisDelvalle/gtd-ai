import {
  ApiError,
  type Api,
  type Args,
  type Task,
  type Mutation,
  type List,
  type Projects,
  type Occurrences,
  recordRead,
} from "./api.ts";

export type Intent = {
  key: string;
  name: string;
  args: Args;
  before?: Task;
  preview?: Task;
  phase: "saving" | "retrying" | "error";
  error?: ApiError;
  started: number;
  attempt: number;
};
export type SaveState = {
  intents: Map<string, Intent>;
  saved: Map<string, Mutation>;
  current: Map<string, Task>;
  lastTaskId: string | null;
  captureReceipt: Mutation | null;
  receipts: Map<string, Mutation>;
  receiptRequests: Map<string, string>;
  serial: number;
};
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
// Transport errors are uncertain, never evidence that the write was rejected.
export function retryable(error: ApiError) {
  return [
    "network",
    "response",
    "bridge_timeout",
    "storage_error",
    "internal_error",
    "429",
    "502",
    "503",
    "504",
  ].includes(error.code);
}
export class MutationController {
  state: SaveState = {
    intents: new Map(),
    saved: new Map(),
    current: new Map(),
    lastTaskId: null,
    captureReceipt: null,
    receipts: new Map(),
    receiptRequests: new Map(),
    serial: 0,
  };
  listeners = new Set<() => void>();
  constructor(
    private api: Api,
    private changed: () => void,
    private wait = pause,
    private random = Math.random,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  private publish() {
    this.state = {
      ...this.state,
      intents: new Map(this.state.intents),
      saved: new Map(this.state.saved),
      receipts: new Map(this.state.receipts),
      receiptRequests: new Map(this.state.receiptRequests),
      current: new Map(this.state.current),
      serial: this.state.serial + 1,
    };
    this.listeners.forEach((fn) => fn());
  }
  clearConfirmation() {
    this.state.lastTaskId = null;
    this.publish();
  }
  project(task: Task, state = this.state): Task {
    const saved = state.current.get(task.id);
    const current =
      saved &&
      (saved.version > task.version ||
        (saved.version === task.version && !task.widget_preview &&
          (saved.notes !== undefined || task.notes === undefined)))
        ? saved
        : task;
    const intent = state.intents.get(task.id);
    return intent?.preview &&
      (intent.phase !== "error" || intent.error?.uncertain)
      ? intent.preview
      : current;
  }
  observe(tasks: Task[]) {
    let changed = false;
    for (const task of tasks) {
      const previous = this.state.current.get(task.id);
      if (
        !previous ||
        task.version > previous.version ||
        (task.version === previous.version &&
          (previous.notes === undefined && task.notes !== undefined ||
            !!task.widget_preview && task.widget_preview !== previous.widget_preview))
      ) {
        this.state.current.set(task.id, task);
        changed = true;
      }
    }
    if (changed) this.publish();
  }
  async run(name: string, args: Args, before?: Task, preview?: Task, intentKey?: string) {
    const key =
      intentKey ||
      before?.id ||
      String(
        args.task_id ||
          args.project_id ||
          (name === "create_project" ? "create_project" : "capture"),
      );
    if (this.state.intents.has(key)) return null;
    const intent: Intent = {
      key,
      name,
      args: JSON.parse(
        JSON.stringify({ ...args, request_id: crypto.randomUUID() }),
      ),
      before,
      preview:
        preview && before
          ? {
              ...preview,
              id: before.id,
              version: before.version,
              last_change_id: before.last_change_id,
              created_at: before.created_at,
              updated_at: before.updated_at,
            }
          : preview,
      phase: "saving",
      started: Date.now(),
      attempt: 0,
    };
    this.state.intents.set(key, intent);
    this.publish();
    return this.send(intent);
  }
  async retry(key: string) {
    const intent = this.state.intents.get(key);
    if (!intent || intent.phase !== "error" || !intent.error?.uncertain)
      return null;
    intent.phase = "saving";
    intent.error = undefined;
    intent.started = Date.now();
    this.publish();
    return this.send(intent);
  }
  dismiss(key: string) {
    const intent = this.state.intents.get(key);
    if (intent?.phase === "error" && !intent.error?.uncertain) {
      this.state.intents.delete(key);
      this.publish();
    }
  }
  private async send(intent: Intent): Promise<Mutation | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      intent.attempt++;
      intent.phase = attempt ? "retrying" : "saving";
      this.publish();
      try {
        const raw = await this.api.call<Mutation>(intent.name, intent.args);
        const receipt = { ...raw, task: raw.project || raw.series || raw.task };
        if (!receipt.task?.id || !receipt.change?.id)
          throw new ApiError("Incomplete save receipt.", "response", true);
        // Compact receipts contain authoritative scalars, while unchanged long
        // fields remain from the full draft. Never merge a replay into a new state.
        if (!receipt.replayed && intent.name !== "undo_change") {
          receipt.task = {
            ...(intent.preview ||
              intent.before || {
                brief: intent.args.brief || "",
                notes: intent.args.notes || "",
                links: intent.args.links || [],
                location: intent.args.location || null,
                work_sessions: intent.args.work_sessions || [],
                completion_result: intent.args.completion_result || null,
              }),
            ...receipt.task,
          } as Task;
          // Long agent context is explicitly fetched and must not survive an
          // unrelated version change as if it were current.
          if (
            raw.project?.agent_notes === undefined &&
            raw.series?.agent_notes === undefined &&
            raw.task?.agent_notes === undefined
          )
            delete receipt.task.agent_notes;
          if (!receipt.task.has_completion_result)
            receipt.task.completion_result = null;
          receipt.change = { ...receipt.change, before: intent.before || null };
        }
        // Stored retry receipts can be older than the task. Do not unlock writes on an old version.
        let result = receipt;
        if (receipt.replayed || intent.name === "undo_change") {
          let current: { items: Task[] };
          try {
            const [name, args] = recordRead(receipt.task);
            const read = await this.api.call<List & Projects & Occurrences>(
              name,
              {
                ...args,
                ...(intent.args.agent_notes !== undefined
                  ? { include_agent_notes: true }
                  : {}),
              },
            );
            current = {
              items: read.series ? [read.series] : read.projects || read.items,
            };
          } catch (e) {
            // A rejected follow-up read does not reject the already committed write.
            throw new ApiError(
              "The change is recorded, but its current task could not be read.",
              e instanceof ApiError ? e.code : "response",
              true,
            );
          }
          if (!current.items[0])
            throw new ApiError(
              "The change is recorded, but its current task could not be read.",
              "response",
              true,
            );
          result = { ...receipt, task: current.items[0] };
        }
        const existing = this.state.saved.get(result.task.id);
        if (!existing || result.task.version >= existing.task.version)
          this.state.saved.set(result.task.id, result);
        const current = this.state.current.get(result.task.id);
        if (!current || result.task.version >= current.version)
          this.state.current.set(result.task.id, result.task);
        this.state.lastTaskId = result.task.id;
        this.state.receipts.set(intent.key, result);
        this.state.receiptRequests.set(intent.key, String(intent.args.request_id));
        if (intent.name === "capture_item" && intent.key === "capture")
          this.state.captureReceipt = result;
        this.state.intents.delete(intent.key);
        this.publish();
        this.changed();
        return result;
      } catch (e) {
        const error =
          e instanceof ApiError
            ? e
            : new ApiError("The response was not confirmed.", "unknown", true);
        intent.error = error;
        if (retryable(error) && attempt < 2) {
          intent.phase = "retrying";
          this.publish();
          await this.wait(600 * 2 ** attempt + Math.floor(this.random() * 250));
          continue;
        }
        // A conflict is a definite rejection. Read current values, but preserve the user's intent.
        if (!error.uncertain && intent.before) {
          try {
            const [name, args] = recordRead(intent.before);
            const current = await this.api.call<List & Projects & Occurrences>(
              name,
              {
                ...args,
                ...(intent.args.agent_notes !== undefined
                  ? { include_agent_notes: true }
                  : {}),
              },
            );
            const task =
              current.series || (current.projects || current.items)[0];
            if (task) this.observe([task]);
          } catch {
            /* The next refresh may recover; the draft remains attached to the error. */
          }
        }
        intent.phase = "error";
        this.publish();
        this.changed();
        return null;
      }
    }
    return null;
  }
}
