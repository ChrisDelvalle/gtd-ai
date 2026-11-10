import { test } from "node:test";
import assert from "node:assert/strict";
import { MutationController } from "./src/mutations.ts";
import { ApiError, type Task, type Mutation, type Api } from "./src/api.ts";
const task: Task = {
  id: "one",
  title: "Synthetic",
  status: "next",
  notes: "original",
  due_date: null,
  version: 1,
  last_change_id: 1,
  deleted: false,
};
const receipt: Mutation = {
  task: { ...task, status: "done", version: 2, last_change_id: 2 },
  change: {
    id: 2,
    task_id: task.id,
    operation: "update",
    reason: "test",
    before: task,
    after: { ...task, status: "done", version: 2 },
    undoes_change_id: null,
    created_at: "2026-10-02T12:00:00Z",
    origin: "mcp",
  },
  replayed: false,
};
const args = {
  task_id: task.id,
  expected_version: 1,
  status: "done",
  reason: "test",
};
test("compact acknowledgements do not carry stale hidden agent context into a newer version", async () => {
  const previous = { ...task, agent_notes: "Prior working notes" };
  const c = controller(async () => receipt as any);
  const result = await c.run("update_item", args, previous, { ...previous, status: "done" });
  assert.equal(result?.task.version, 2);
  assert.equal(result?.task.agent_notes, undefined);
});
test("replayed series agent notes reconcile through an explicitly opted-in series read", async () => {
  const series = { ...task, entity_type: "recurrence" as const };
  const calls: { name: string; args: any }[] = [];
  const c = controller(async (name, args) => {
    calls.push({ name, args });
    return name === "list_occurrences"
      ? { series: { ...series, version: 4, agent_notes: "Current series context" } } as any
      : { series: { ...series, version: 2 }, change: { id: 2 }, replayed: true } as any;
  });
  const result = await c.run("update_recurrence", { series_id: series.id, expected_version: 1, action: "edit", scope: "all", agent_notes: "Submitted notes", reason: "test" }, series);
  assert.equal(result?.task.version, 4);
  assert.equal(result?.task.agent_notes, "Current series context");
  assert.equal(calls[1].name, "list_occurrences");
  assert.deepEqual(calls[1].args, { series_id: series.id, limit: 1, include_agent_notes: true });
});
function controller(call: Api["call"], wait = async () => {}) {
  return new MutationController(
    { call },
    () => {},
    wait,
    () => 0,
  );
}
test("optimistic immediately, isolates rows, and serializes one task intent", async () => {
  let finish!: (r: Mutation) => void;
  const c = controller(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish;
      }),
  );
  const write = c.run("update_item", args, task, { ...task, status: "done" });
  assert.equal(c.project(task).status, "done");
  assert.equal(c.project({ ...task, id: "two" }).status, "next");
  assert.equal(await c.run("update_item", args, task), null);
  finish(receipt);
  await write;
  assert.equal(c.project(task).version, 2);
  assert.equal(c.state.intents.size, 0);
});
test("lost acknowledgement retries identical arguments and reads current version after replay", async () => {
  const writes: unknown[] = [];
  let reads = 0;
  const waits: number[] = [];
  const c = controller(
    async (name, a) => {
      if (name === "list_items") {
        reads++;
        return {
          items: [{ ...receipt.task, version: 5, status: "waiting" }],
        } as any;
      }
      writes.push(structuredClone(a));
      if (writes.length < 3) throw new ApiError("Lost", "network", true);
      return { ...receipt, replayed: true } as any;
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  const r = await c.run("update_item", args, task, { ...task, status: "done" });
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0], writes[2]);
  assert.deepEqual(waits, [600, 1200]);
  assert.equal(reads, 1);
  assert.equal(r?.task.version, 5);
  assert.equal(c.project(task).status, "waiting");
});
test("exhausted retries keep uncertain intent and key, manual retry confirms it", async () => {
  const writes: any[] = [];
  let online = false;
  const c = controller(async (_, a) => {
    writes.push(structuredClone(a));
    if (!online) throw new ApiError("Offline", "network", true);
    return receipt as any;
  });
  await c.run("update_item", args, task, { ...task, status: "done" });
  assert.equal(writes.length, 3);
  assert.equal(c.project(task).status, "done");
  assert.equal(c.state.intents.get("one")?.phase, "error");
  c.dismiss("one");
  assert.equal(c.state.intents.size, 1);
  online = true;
  await c.retry("one");
  assert.deepEqual(writes[0], writes[3]);
  assert.equal(c.state.intents.size, 0);
});
for (const code of [
  "conflict",
  "validation_error",
  "permission_denied",
  "cancelled",
])
  test(
    code + " is not automatically retried; draft remains available",
    async () => {
      let writes = 0;
      const c = controller(async (name) => {
        if (name === "list_items")
          return {
            items: [{ ...task, version: 3, notes: "concurrent" }],
          } as any;
        writes++;
        throw new ApiError(code, code, false);
      });
      const preview = { ...task, title: "My draft" };
      await c.run("update_item", args, task, preview);
      assert.equal(writes, 1);
      assert.equal(c.project(task).title, "Synthetic");
      assert.equal(c.project(task).version, 3);
      assert.equal(c.state.intents.get("one")?.preview?.title, "My draft");
      c.dismiss("one");
      assert.equal(c.state.intents.size, 0);
    },
  );
test("current authoritative version beats an older refresh or receipt", async () => {
  const c = controller(async () => receipt as any);
  await c.run("update_item", args, task, { ...task, status: "done" });
  assert.equal(
    c.project({ ...task, version: 10, status: "archived" }).status,
    "archived",
  );
});
test("a full detail read is never hidden by a same-version cached summary", () => {
  const c = controller(async () => receipt as any);
  const { notes, ...summary } = task;
  c.observe([summary]);
  assert.equal(c.project(task).notes, "original");
  c.observe([task]);
  c.observe([summary]);
  assert.equal(c.project(summary).notes, "original");
});
test("undo targets the most recently acknowledged edit, including a repeatedly edited task", async () => {
  let next = receipt;
  const c = controller(async () => next as any);
  await c.run("update_item", args, task);
  const two = { ...task, id: "two" };
  next = { ...receipt, task: { ...receipt.task, id: "two" } };
  await c.run("update_item", { ...args, task_id: "two" }, two);
  assert.equal(c.state.lastTaskId, "two");
  next = {
    ...receipt,
    task: { ...receipt.task, version: 3, last_change_id: 4 },
  };
  await c.run("update_item", { ...args, expected_version: 2 }, receipt.task);
  assert.equal(c.state.lastTaskId, "one");
  c.observe([{ ...next.task, version: 7, last_change_id: 9 }]);
  assert.equal(c.project(task).last_change_id, 9);
});

test("failed reconciliation never turns a committed replay into a rejected write", async () => {
  const writes: any[] = [];
  let readable = false;
  const c = controller(async (name, a) => {
    if (name === "list_items") {
      if (!readable)
        throw new ApiError("Read denied", "permission_denied", false);
      return { items: [receipt.task] } as any;
    }
    writes.push(structuredClone(a));
    return { ...receipt, replayed: true } as any;
  });
  await c.run("update_item", args, task, { ...task, status: "done" });
  assert.equal(writes.length, 1);
  assert.equal(c.state.intents.get(task.id)?.error?.uncertain, true);
  c.dismiss(task.id);
  assert.equal(c.state.intents.size, 1);
  readable = true;
  await c.retry(task.id);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(c.state.intents.size, 0);
});

test("a manually recovered capture publishes its receipt once confirmed", async () => {
  let online = false;
  const c = controller(async () => {
    if (!online) throw new ApiError("Offline", "network", true);
    return {
      ...receipt,
      change: { ...receipt.change, operation: "capture" },
    } as any;
  });
  await c.run("capture_item", { title: "Synthetic", reason: "test" });
  assert.equal(c.state.captureReceipt, null);
  online = true;
  await c.retry("capture");
  assert.equal(c.state.captureReceipt?.task.id, task.id);
});

test("compact completion receipts retain full edited context and clear results on reopen", async () => {
  const full = {
    ...task,
    links: [{ url: "https://example.com/brief" }],
    work_sessions: [{ url: "https://example.com/calendar" }],
    completion_result: null,
  };
  const completed = {
    ...full,
    status: "done" as const,
    completion_result: "Proposal delivered",
    review_date: "2026-10-10",
  };
  let response: any = {
    task: {
      id: task.id,
      title: task.title,
      status: "done",
      version: 2,
      last_change_id: 2,
      detail: "summary",
      has_completion_result: true,
      completed_at: "2026-10-03T12:00:00Z",
    },
    change: { id: 2, operation: "update", entity_type: "task" },
    replayed: false,
  };
  const c = controller(async () => response);
  const saved = await c.run(
    "update_item",
    { ...args, completion_result: completed.completion_result },
    full,
    completed,
  );
  assert.equal(saved?.task.completion_result, "Proposal delivered");
  assert.equal(saved?.task.notes, full.notes);
  assert.deepEqual(saved?.task.work_sessions, full.work_sessions);
  response = {
    ...response,
    task: {
      ...response.task,
      status: "inbox",
      version: 3,
      last_change_id: 3,
      has_completion_result: false,
      completed_at: null,
    },
    change: { id: 3, operation: "update" },
  };
  const reopened = await c.run(
    "update_item",
    { ...args, expected_version: 2, status: "inbox" },
    saved!.task,
    { ...saved!.task, status: "inbox" },
  );
  assert.equal(reopened?.task.completion_result, null);
  assert.equal(reopened?.task.completed_at, null);
});

test("project receipts and replay reconciliation use the project endpoint", async () => {
  const project = {
    ...task,
    entity_type: "project" as const,
    status: "active" as const,
  };
  const calls: { name: string; args: unknown }[] = [];
  const c = controller(async (name, args) => {
    calls.push({ name, args });
    if (name === "list_projects")
      return {
        projects: [{ ...project, version: 4, status: "someday" }],
      } as any;
    return {
      project: { ...project, version: 2 },
      change: {
        id: 2,
        entity_type: "project",
        project_id: project.id,
        operation: "update",
      },
      replayed: true,
    } as any;
  });
  const saved = await c.run(
    "update_project",
    {
      project_id: project.id,
      expected_version: 1,
      title: "Updated outcome",
      reason: "test",
    },
    project,
  );
  assert.equal(saved?.task.version, 4);
  assert.equal(saved?.task.status, "someday");
  assert.deepEqual(
    calls.map((c) => c.name),
    ["update_project", "list_projects"],
  );
  assert.deepEqual(calls[1].args, {
    project_id: project.id,
    include_deleted: true,
    detail: "full",
  });
  assert.equal(c.state.captureReceipt, null);
});

test("nested project captures keep their own intent and do not publish a global inbox receipt", async () => {
  let finish!: (value: Mutation) => void;
  const c = controller(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish;
      }),
  );
  const saving = c.run("capture_item", {
    project_id: "project-one",
    title: "A project action",
    status: "planned",
    reason: "test",
  });
  assert.equal(c.state.intents.has("project-one"), true);
  assert.equal(c.state.intents.has("capture"), false);
  finish({
    ...receipt,
    task: { ...receipt.task, project_id: "project-one", status: "planned" },
    change: { ...receipt.change, operation: "capture" },
  });
  await saving;
  assert.equal(c.state.captureReceipt, null);
  assert.equal(c.state.intents.size, 0);
});

test("nested capture keeps its own retry slot without treating the project as a task before-image", async () => {
  let finish!: (result: Mutation) => void;
  const c=controller(()=>new Promise(resolve=>{finish=resolve as typeof finish;}));
  const promise=c.run("capture_item",{title:"New action",project_id:"project",reason:"test"},undefined,undefined,"project-capture:project");
  assert(c.state.intents.has("project-capture:project"));
  assert.equal(await c.run("capture_item",{},undefined,undefined,"project-capture:project"),null);
  const created={...task,id:"new"};delete created.notes;
  finish({...receipt,task:created,change:{...receipt.change,operation:"capture",before:null}});
  const result=await promise;
  assert.equal(result?.change.before,null);
  assert.equal(result?.task.notes,"");
  assert.equal(c.state.captureReceipt,null);
  assert.equal(c.state.receipts.get("project-capture:project")?.task.id,"new");
});
