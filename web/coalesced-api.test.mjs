import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// Bundle the actual adapter, without a renderer dependency, for Node's runner.
const compiled = await build({
  entryPoints: [new URL("./src/read-coordinator.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { coalescedApi } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("equivalent concurrent reads share one request even with reordered nested keys", async () => {
  const result = deferred();
  const calls = [];
  const api = coalescedApi({
    call(name, args) {
      calls.push({ name, args });
      return result.promise;
    },
  });
  const one = api.call("list_items", {
    query: "résumé",
    filter: {
      due: { through: "2026-11-01", from: "2026-10-01" },
      statuses: ["next", "planned"],
    },
  });
  const two = api.call("list_items", {
    filter: {
      statuses: ["next", "planned"],
      due: { from: "2026-10-01", through: "2026-11-01" },
    },
    query: "résumé",
  });
  assert.equal(calls.length, 1);
  assert.equal(one, two);
  result.resolve({ items: [] });
  assert.deepEqual(await two, { items: [] });
});

test("filters, cursor boundaries, array ordering, and operations remain independent", async () => {
  const calls = [];
  const api = coalescedApi({
    call(name, args) {
      calls.push({ name, args });
      return Promise.resolve(calls.length);
    },
  });
  await Promise.all([
    api.call("list_items", { view: "active" }),
    api.call("list_items", { view: "all" }),
    api.call("list_items", { view: "active", cursor: "next" }),
    api.call("list_projects", { view: "active" }),
    api.call("list_items", { task_ids: ["a", "b"] }),
    api.call("list_items", { task_ids: ["b", "a"] }),
  ]);
  assert.equal(calls.length, 6);
});

test("completed reads are not cached and failures can be retried", async () => {
  let calls = 0;
  const api = coalescedApi({
    call() {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("temporarily offline"))
        : Promise.resolve(calls);
    },
  });
  const first = api.call("list_occurrences", { series_id: "series" });
  const same = api.call("list_occurrences", { series_id: "series" });
  assert.equal(first, same);
  await assert.rejects(first, /offline/);
  assert.equal(await api.call("list_occurrences", { series_id: "series" }), 2);
  assert.equal(await api.call("list_occurrences", { series_id: "series" }), 3);
});

test("writes never coalesce or change request IDs or arguments", async () => {
  const calls = [];
  const api = coalescedApi({
    call(name, args) {
      calls.push({ name, args });
      return Promise.resolve({ ok: true });
    },
  });
  const args = {
    request_id: "same-retry-key",
    task_id: "task",
    expected_version: 7,
    notes: "draft",
  };
  await Promise.all([
    api.call("update_item", args),
    api.call("update_item", args),
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args, args);
  assert.equal(calls[1].args, args);
});

test("all read operations are coalesced, while unknown operations are passed through", async () => {
  const pending = deferred();
  const calls = [];
  const api = coalescedApi({
    call(name, args) {
      calls.push({ name, args });
      return pending.promise;
    },
  });
  for (const name of [
    "list_items",
    "list_projects",
    "list_occurrences",
    "list_changes",
    "sync_state",
  ]) {
    assert.equal(api.call(name, {}), api.call(name, {}));
  }
  api.call("future_operation", {});
  api.call("future_operation", {});
  assert.equal(calls.length, 7);
  pending.resolve({});
  await pending.promise;
});

test("external-link capability retains its original receiver", async () => {
  const source = {
    origin: "host",
    call: async () => ({}),
    async openLink(url) {
      assert.equal(this, source);
      return `${this.origin}:${url}`;
    },
  };
  assert.equal(
    await coalescedApi(source).openLink("https://example.com"),
    "host:https://example.com",
  );
});

test("a read after a settled write does not join a snapshot requested before it", async () => {
  const stale = deferred();
  const reads = [];
  const api = coalescedApi({
    call(name, args) {
      if (name === "update_item") return Promise.resolve({ saved: true });
      reads.push(args);
      return reads.length === 1
        ? stale.promise
        : Promise.resolve({ items: ["newly saved record"] });
    },
  });
  const first = api.call("list_items", { view: "active" });
  await api.call("update_item", {
    request_id: "stable-write-key",
    task_id: "task",
    expected_version: 1,
  });
  const fresh = api.call("list_items", { view: "active" });
  assert.notEqual(fresh, first);
  assert.equal(reads.length, 2);
  assert.deepEqual(await fresh, { items: ["newly saved record"] });
  stale.resolve({ items: [] });
  assert.deepEqual(await first, { items: [] });
});
