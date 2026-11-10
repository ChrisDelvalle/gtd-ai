import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const source = await build({
  entryPoints: [new URL("./src/routes.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { destinationUrl, urlDestination, safeReturnPath } = await import(
  "data:text/javascript;base64," +
    Buffer.from(source.outputFiles[0].text).toString("base64")
);
const parse = (url) => urlDestination(new URL(url, "https://gtd.invalid"));
test("canonical task filters round trip without drafts or cursors", () => {
  const route = {
    page: "Tasks",
    scope: "all",
    input: {
      view: "all",
      archived: false,
      exclude_statuses: ["done", "someday"],
      query: "doctor & dentist",
      due_from: "2026-10-09",
      max_effort: "low",
      max_estimated_minutes: 30,
      cursor: "private",
      notes: "draft",
      request_id: "write",
    },
  };
  const url = destinationUrl(route);
  assert.ok(!/private|draft|write/.test(url));
  const actual = parse(url);
  assert.equal(actual.page, "Tasks");
  assert.equal(actual.input.query, route.input.query);
  assert.deepEqual(actual.input.exclude_statuses, ["done", "someday"]);
});
test("archive opt-in, legacy blocked, focused records and unknown routes", () => {
  assert.equal(parse("/tasks").input.archived, false);
  assert.equal(parse("/tasks?view=all&archived=any").input.archived, undefined);
  assert.equal(parse("/tasks?status=planned").scope, "blocked");
  const id = "12345678-1234-1234-1234-123456789abc";
  for (const [page, key] of [
    ["Tasks", "task_id"],
    ["Projects", "project_id"],
    ["Repeating", "series_id"],
  ]) {
    const url = destinationUrl({ page, input: { [key]: id } });
    assert.equal(parse(url).input[key], id);
    if (page === "Projects")
      assert.equal(parse(url + "?project_id=aaaaaaaa-1234-1234-1234-123456789abc").input[key], id);
  }
  assert.equal(parse("/api/tools/capture_item"), null);
  assert.equal(parse("/tasks/not-an-id"), null);
  assert.equal(safeReturnPath("//evil.test", "https://gtd.invalid"), "/");
  assert.equal(
    safeReturnPath("/tasks?status=next", "https://gtd.invalid"),
    "/tasks?status=next",
  );
});

test("all project lifecycle filters round trip", () => {
  for (const input of [
    { status: "active" },
    { status: "someday" },
    { status: "done" },
    { archived: true },
    { view: "all" },
  ]) {
    assert.deepEqual(
      parse(destinationUrl({ page: "Projects", input })).input,
      input,
    );
  }
});
