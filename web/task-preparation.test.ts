import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { taskPreparation } from "./src/task-preparation.ts";
import type { Api, Task } from "./src/api.ts";
const record = (i: number, version = 1) => ({ id: String(i), version }) as Task;
function fixture() {
  const pending: { id: string; resolve: (r: unknown) => void }[] = [];
  const api = {
    call: (_name: string, args: { task_id: string }) =>
      new Promise((resolve) => pending.push({ id: args.task_id, resolve })),
  } as Api;
  return { pending, prepare: taskPreparation(api) };
}
test("preparation is bounded, cancels queued intent, and preserves record versions", async () => {
  const doc = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible" },
  });
  try {
    const { pending, prepare } = fixture(),
      accepted: Task[] = [];
    for (let i = 0; i < 5; i++)
      prepare.schedule(record(i), (t) => accepted.push(t), 0);
    await wait(5);
    assert.equal(pending.length, 2);
    pending[0].resolve({ items: [record(0)] });
    await wait(5);
    assert.equal(pending.length, 3);
    pending[1].resolve({ items: [record(1, 2)] });
    pending[2].resolve({ items: [record(2)] });
    await wait(5);
    assert.equal(pending.length, 3);
    assert.deepEqual(
      accepted.map((t) => t.id),
      ["0", "2"],
    );
    prepare.dispose();
    const f = fixture();
    const cancel = f.prepare.schedule(
      record(1),
      () => assert.fail("cancelled"),
      20,
    );
    cancel();
    await wait(25);
    assert.equal(f.pending.length, 0);
    f.prepare.schedule(record(2), () => assert.fail("disposed"), 0);
    await wait(5);
    f.prepare.dispose();
    f.pending[0].resolve({ items: [record(2)] });
    await wait(5);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { visibilityState: "hidden" },
    });
    const hidden = fixture();
    hidden.prepare.schedule(record(0), () => {}, 0);
    await wait(5);
    assert.equal(hidden.pending.length, 0);
    hidden.prepare.dispose();
  } finally {
    if (doc) Object.defineProperty(globalThis, "document", doc);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
