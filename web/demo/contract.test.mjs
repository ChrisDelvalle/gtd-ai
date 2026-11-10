import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { loadFixture } from "./fixture.mjs";
const built = await build({
  entryPoints: ["src/demo/store.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { DemoStore } = await import(
  "data:text/javascript;base64," +
    Buffer.from(built.outputFiles[0].text).toString("base64")
);
const fixture = await loadFixture(),
  oracle = JSON.parse(
    await readFile(new URL("./oracle.json", import.meta.url), "utf8"),
  );
const store = () => new DemoStore(fixture, "test");
test("fictional source has the intended year, records, and closed references", () => {
  assert.equal(
    fixture.records.filter((t) => t.entity_type === "task").length,
    1082,
  );
  assert.equal(
    fixture.records.filter((t) => t.entity_type === "project").length,
    11,
  );
  assert.equal(
    fixture.records.filter((t) => t.entity_type === "recurrence").length,
    4,
  );
  assert.equal(fixture.changes.length, 1303);
  assert.equal(fixture.now, "2026-11-06T18:00:00.000Z");
  const ids = new Set(fixture.records.map((t) => t.id));
  for (const t of fixture.records) {
    for (const id of [
      ...(t.blocked_by || []),
      ...(t.project_id ? [t.project_id] : []),
      ...(t.occurrence ? [t.occurrence.series_id] : []),
    ])
      assert.ok(ids.has(id));
  }
});
test("priority counts match disposable Rust reference", () => {
  assert.deepEqual(
    store().execute("priority_grid", {}).counts,
    oracle.priority_grid.counts,
  );
});
test("Next ordering and inherited recommendations match Rust reference", () => {
  const actual = store()
    .execute("list_items", { status: "next", limit: 100, detail: "full" })
    .items.slice(0, oracle.list_items.items.length);
  assert.deepEqual(
    actual.map((t) => t.id),
    oracle.list_items.items.map((t) => t.id),
  );
  assert.deepEqual(
    actual.map((t) => t.recommendation.source_task_id || null),
    oracle.list_items.items.map((t) => t.recommendation.source_task_id || null),
  );
});
test("completion history matches Rust daily aggregates", () => {
  const actual = store().execute("activity_summary", {
    from: "2025-11-09",
    through: "2026-11-07",
    metric: "completed",
  });
  assert.equal(actual.total, oracle.activity_summary.total);
  assert.deepEqual(
    actual.days.map((d) => [d.date, d.count]),
    oracle.activity_summary.days.map((d) => [d.date, d.count]),
  );
});
const capture = (s, title, extra = {}) =>
  s.execute("capture_item", {
    request_id: "add-" + title,
    title,
    brief: title,
    status: "next",
    importance: "normal",
    estimated_minutes: 10,
    effort: "low",
    reason: "Demo contract test",
    ...extra,
  });
test("edits, version conflicts, retries and undo/redo preserve history", () => {
  const s = store(),
    first = capture(s, "Local example");
  assert.equal(capture(s, "Local example").replayed, true);
  assert.equal(s.changes.length, fixture.changes.length + 1);
  const done = s.execute("update_item", {
    request_id: "done",
    task_id: first.task.id,
    expected_version: 1,
    status: "done",
  });
  assert.equal(done.task.completed_at, fixture.now);
  assert.throws(
    () =>
      s.execute("update_item", {
        request_id: "stale",
        task_id: first.task.id,
        expected_version: 1,
        title: "Stale",
      }),
    /changed/,
  );
  const before = s.execute("activity_summary", {
    from: "2026-11-06",
    through: "2026-11-06",
    metric: "completed",
  });
  const undo = s.execute("undo_change", {
    request_id: "undo",
    change_id: done.change.id,
    expected_version: done.task.version,
  });
  assert.equal(undo.task.status, "next");
  assert.equal(
    s.execute("activity_summary", {
      from: "2026-11-06",
      through: "2026-11-06",
      metric: "completed",
    }).total,
    before.total - 1,
  );
  assert.equal(
    s.execute("activity_summary", {
      from: "2026-11-06",
      through: "2026-11-06",
      metric: "completed",
      snapshot: before.snapshot,
    }).total,
    before.total,
  );
  const redo = s.execute("undo_change", {
    request_id: "redo",
    change_id: undo.change.id,
    expected_version: undo.task.version,
  });
  assert.equal(redo.task.status, "done");
  assert.equal(
    s.execute("activity_summary", {
      from: "2026-11-06",
      through: "2026-11-06",
      metric: "completed",
    }).total,
    before.total,
  );
});
test("dependency effects are coupled to undo, and inherit importance and urgency", () => {
  const s = store(),
    a = capture(s, "Prerequisite"),
    b = capture(s, "Critical dependent", {
      blocked_by: [a.task.id],
      importance: "critical",
      due_date: "2026-11-05",
    });
  assert.equal(b.task.status, "blocked");
  let grid = s.execute("priority_grid", {});
  assert.ok(grid.previews[48].some((t) => t.id === a.task.id));
  const done = s.execute("update_item", {
    request_id: "complete-prerequisite",
    task_id: a.task.id,
    expected_version: 1,
    status: "done",
  });
  assert.equal(s.records.find((t) => t.id === b.task.id).status, "next");
  s.execute("undo_change", {
    request_id: "undo-prerequisite",
    change_id: done.change.id,
    expected_version: done.task.version,
  });
  assert.equal(s.records.find((t) => t.id === b.task.id).status, "blocked");
  assert.throws(
    () =>
      s.execute("update_item", {
        request_id: "cycle",
        task_id: a.task.id,
        expected_version: 3,
        blocked_by: [b.task.id],
      }),
    /cycle/,
  );
});
test("atomic batches and references do not leak across sandboxes", () => {
  const s = store(),
    other = store(),
    length = s.records.length;
  assert.throws(
    () =>
      s.execute("apply_changes", {
        request_id: "bad-batch",
        operations: [
          { operation: "capture", title: "First" },
          { operation: "capture", title: "" },
        ],
      }),
    /title/,
  );
  assert.equal(s.records.length, length);
  const r = s.execute("apply_changes", {
    request_id: "batch",
    operations: [
      { operation: "capture", title: "One" },
      { operation: "create_project", title: "Project" },
    ],
  });
  assert.equal(
    s.execute("request_results", { from_request_ids: ["batch"] }).records
      .length,
    2,
  );
  assert.equal(
    s.execute("apply_changes", {
      request_id: "batch",
      operations: [
        { operation: "capture", title: "One" },
        { operation: "create_project", title: "Project" },
      ],
    }).replayed,
    true,
  );
  assert.throws(
    () => other.execute("request_results", { from_request_ids: ["batch"] }),
    /unavailable/,
  );
  assert.equal(r.results.length, 2);
});
test("pagination and priority drilldowns retain their snapshot through edits", () => {
  const s = store(),
    args = { status: "next", limit: 4 },
    page = s.execute("list_items", args),
    grid = s.execute("priority_grid", {});
  const original = s.execute("list_items", {
    ...args,
    cursor: page.next_cursor,
  });
  const t = page.items[0];
  s.execute("update_item", {
    request_id: "archive",
    task_id: t.id,
    expected_version: t.version,
    archived: true,
  });
  assert.deepEqual(
    s.execute("list_items", { ...args, cursor: page.next_cursor }).items,
    original.items,
  );
  for (let i = 0; i < 7; i++)
    for (let u = 0; u < 7; u++) {
      const cell = {
        importance: [
          "unimportant",
          "very_low",
          "low",
          "normal",
          "high",
          "very_high",
          "critical",
        ][i],
        urgency: [
          "undated",
          "later",
          "weeks",
          "within_7_days",
          "within_48_hours",
          "immediate",
          "overdue",
        ][u],
        scope: "all",
      };
      const rows = s.execute("priority_grid", {
        snapshot: grid.snapshot,
        cell,
        limit: 100,
      }).items;
      assert.equal(
        rows.length,
        Object.values(grid.counts[i][u]).reduce((a, b) => a + b, 0),
      );
    }
});
test("search, context filters, projects, work blocks, and limitations", () => {
  const s = store(),
    rows = s.execute("list_items", {
      status: "next",
      max_estimated_minutes: 20,
      max_effort: "low",
      location: "Home",
      limit: 100,
    }).items;
  assert.ok(rows.length >= 3);
  assert.ok(
    rows.every(
      (t) =>
        t.location === "Home" &&
        t.estimated_minutes <= 20 &&
        ["low", "trivial"].includes(t.effort),
    ),
  );
  const project = s.execute("create_project", {
    request_id: "project",
    title: "A small project",
  }).project;
  const t = capture(s, "A planned task", {
    project_id: project.id,
    work_blocks: [
      {
        start: {
          date: "2026-11-06",
          time: "13:30",
          timezone: "America/New_York",
        },
        finish: {
          date: "2026-11-06",
          time: "14:00",
          timezone: "America/New_York",
        },
      },
    ],
  });
  assert.equal(
    s.execute("list_items", {
      view: "all",
      project_id: project.id,
      query: "planned",
    }).items[0].id,
    t.task.id,
  );
  assert.equal(
    s
      .execute("list_items", {
        view: "all",
        planned_from: "2026-11-06",
        planned_through: "2026-11-06",
      })
      .items.some((x) => x.id === t.task.id),
    true,
  );
  assert.throws(() => s.execute("update_recurrence", {}), /view-only/);
});
