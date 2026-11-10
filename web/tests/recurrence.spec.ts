import { readFile } from "node:fs/promises";
import { test, expect, type Page, type Route } from "@playwright/test";
import type { Args, Task, RepeatRule, RepeatTemplate } from "../src/api";

const rule: RepeatRule = {
  start_date: "2026-10-01",
  frequency: "daily",
  interval: 1,
  weekdays: [],
  month_day: null,
  ordinal: null,
  until: null,
  count: null,
};
const template: RepeatTemplate = {
  title: "Review the daily plan",
  brief: "Review current commitments and choose the next action.",
  notes: "Keep each day independently actionable.",
  links: [],
  location: null,
  project_id: null,
  status: "next",
  importance: "normal", estimated_minutes: 30, effort: "medium",
  due_offset_days: null,
  review_offset_days: null,
};
const originalSeries: Task = {
  id: "series-audit",
  entity_type: "recurrence",
  title: template.title,
  brief: template.brief,
  notes: "",
  status: "active",
  version: 3,
  last_change_id: 3,
  deleted: false,
  archived: false,
  due_date: null,
  recurrence: {
    segments: [{ from: rule.start_date, rule, template }],
    pauses: [],
    ended_on: null,
  },
};
const occurrence = (date: string, status: Task["status"] = "next"): Task => ({
  id: `occurrence-${date}`,
  title: template.title,
  brief: template.brief,
  notes: "",
  status,
  importance: "normal", estimated_minutes: 30, effort: "medium",
  version: 2,
  last_change_id: 4,
  deleted: false,
  archived: false,
  due_date: null,
  occurrence: {
    series_id: originalSeries.id,
    original_date: date,
    scheduled_date: date,
    skipped: false,
    overrides: [],
  },
});

type Call = { name: string; args: Args };
type Intercept = (call: Call, route: Route) => Promise<boolean | void>;
async function fixture(
  page: Page,
  options: {
    open?: boolean;
    phone?: boolean;
    task?: Task;
    view?: "settings" | "details" | "occurrences" | "overview";
  } = {},
) {
  const control = {
    intercept: undefined as Intercept | undefined,
    preview: ["2026-10-04", "2026-10-05"],
    projects: [] as Task[],
  };
  if (options.phone) await page.setViewportSize({ width: 390, height: 844 });
  let series = structuredClone(originalSeries);
  let tasks = [
    occurrence("2026-10-01"),
    occurrence("2026-10-02"),
    occurrence("2026-10-03", "done"),
  ];
  if (options.task) tasks = [options.task];
  const calls: Call[] = [];
  await page.route("**/api/tools/*", async (route) => {
    const name = route.request().url().split("/").at(-1)!;
    const args = route.request().postDataJSON();
    calls.push({ name, args });
    if (await control.intercept?.({ name, args }, route)) return;
    if (name === "list_occurrences") {
      if (args.rule)
        return route.fulfill({
          json: {
            series: null,
            occurrences: control.preview.map((date) => ({
              original_date: date,
              scheduled_date: date,
              preview: true,
            })),
            next_cursor: null,
            complete: true,
          },
        });
      if (!args.series_id)
        return route.fulfill({
          json: {
            series_list: [series],
            occurrences: [],
            next_cursor: null,
            complete: true,
          },
        });
      return route.fulfill({
        json: {
          series,
          occurrences: [
            ...tasks
              .filter((task) => task.occurrence)
              .map((task) => ({
                original_date: task.occurrence!.original_date,
                scheduled_date: task.occurrence!.scheduled_date,
                task,
                preview: false,
              })),
            ...(!tasks.some(
              (task) => task.occurrence?.original_date === "2026-10-04",
            )
              ? [
                  {
                    original_date: "2026-10-04",
                    scheduled_date: "2026-10-04",
                    preview: true,
                  },
                ]
              : []),
          ],
          next_cursor: null,
          complete: true,
        },
      });
    }
    if (name === "list_projects")
      return route.fulfill({
        json: { projects: control.projects, next_cursor: null },
      });
    if (name === "list_items")
      return route.fulfill({
        json: {
          items: args.task_id
            ? tasks.filter((task) => task.id === args.task_id)
            : tasks,
          history: [],
          next_offset: null,
          next_cursor: null,
          next_history_after: null,
        },
      });
    if (
      ["update_item", "update_recurrence", "create_recurrence"].includes(name)
    ) {
      let saved: Task;
      let key = "task";
      if (name === "update_item") {
        const task = tasks.find((task) => task.id === args.task_id)!;
        task.status = args.status as Task["status"];
        task.version++;
        saved = task;
      } else if (args.scope === "this") {
        let task = tasks.find(
          (task) => task.occurrence?.original_date === args.original_date,
        );
        if (!task) {
          task = occurrence(String(args.original_date));
          task.version = 0;
          tasks.push(task);
        }
        task.version++;
        if (args.scheduled_date)
          task.occurrence!.scheduled_date = String(args.scheduled_date);
        if (args.action === "skip" || args.action === "unskip")
          task.occurrence!.skipped = args.action === "skip";
        saved = task;
      } else {
        series.version++;
        const segment = series.recurrence!.segments[0];
        if (args.rule) segment.rule = args.rule as RepeatRule;
        if (args.template) {
          segment.template = args.template as RepeatTemplate;
          series.title = segment.template.title;
        }
        if (args.action === "pause")
          series.recurrence!.pauses = [{ from: "2026-10-03", through: null }];
        if (args.action === "resume") series.recurrence!.pauses = [];
        saved = series;
        key = "series"; // Actual projection::mutation contract.
      }
      return route.fulfill({
        json: { [key]: saved, change: { id: 8 }, replayed: false },
      });
    }
    return route.fulfill({
      status: 400,
      json: {
        code: "validation_error",
        message: `Unexpected fixture call: ${name}`,
      },
    });
  });
  await page.route("**/api/view", route => {
    const empty={items:[],next_cursor:null};
    return route.fulfill({json:{data:{next:{...empty,items:tasks.filter(t=>t.status==="next").slice(0,7)},waiting:empty,someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}}});
  });
  await page.goto("/");
  if (options.open !== false)
    await openSeries(page, options.phone, options.view);
  return { calls, tasks, series, control };
}
async function openSeries(page: Page, phone = false, view = "occurrences") {
  if (phone)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await page.getByRole("button", { name: "Repeating", exact: true }).click();
  await page.getByRole("button", { name: /Review the daily plan/ }).click();
  // Retained navigation screens can contain the same summary while hidden.
  await expect(page.locator(".repeat-overview:visible").getByText("Every day", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: /^Occurrence / })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Starts", { exact: true })).toHaveCount(0);
  // The summary renders before its lazy Markdown body. A cold WebKit trace
  // showed that body replacing its taller placeholder between pointer-down
  // and pointer-up, moving Edit schedule away from the click. Wait for the
  // fixture's actual notes before targeting controls beneath them.
  if (view !== "overview")
    await expect(page.locator(".repeat-overview:visible .task-markdown")).toBeVisible();
  if (view === "settings")
    await page
      .getByRole("button", { name: "Edit schedule", exact: true })
      .click();
  if (view === "details")
    await page
      .getByRole("button", { name: "Edit task details", exact: true })
      .click();
  if (view === "occurrences") await manageRepeat(page);
  if (view === "settings")
    await expect(page.getByLabel("Starts", { exact: true })).toHaveValue(
      rule.start_date,
    );
}
async function manageRepeat(page: Page) {
  await page
    .getByRole("button", { name: "More options for repeat", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Manage occurrences", exact: true })
    .click();
}
async function manageTask(surface: Page | ReturnType<Page["frameLocator"]>) {
  await surface
    .getByRole("button", {
      name: `More options: ${template.title}`,
      exact: true,
    })
    .click();
  await surface
    .getByRole("menuitem", { name: "Manage occurrences", exact: true })
    .click();
}
async function reschedule(page: Page, date = "2026-10-02") {
  await page
    .getByRole("button", {
      name: `Actions for occurrence ${date}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Reschedule", exact: true }).click();
  await expect(
    page.getByLabel("Scheduled date", { exact: true }),
  ).toBeFocused();
}
const writes = (calls: Call[]) =>
  calls.filter((call) =>
    ["update_item", "update_recurrence", "create_recurrence"].includes(
      call.name,
    ),
  );
for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"} individual completion and reschedule preserve identity`, async ({
    page,
  }, testInfo) => {
    const state = await fixture(page, { phone });
    await expect(page.getByLabel("Starts", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Complete occurrence 2026-10-02",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Reopen occurrence 2026-10-02",
        exact: true,
      }),
    ).toBeVisible();
    expect(writes(state.calls)[0]).toMatchObject({
      name: "update_item",
      args: {
        task_id: "occurrence-2026-10-02",
        expected_version: 2,
        status: "done",
      },
    });
    await expect(
      page.getByRole("button", {
        name: "Complete occurrence 2026-10-01",
        exact: true,
      }),
    ).toBeVisible();
    await reschedule(page);
    await page.getByLabel("Scheduled date", { exact: true }).fill("2026-10-09");
    await page
      .getByRole("heading", { name: template.title, exact: true })
      .click();
    await expect(
      page.getByLabel("Scheduled date", { exact: true }),
    ).toHaveValue("2026-10-09");
    await expect(
      page.getByRole("button", { name: "Back to repeat", exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel("Starts", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Save date", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".task-expansion[data-resizing]")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(
        `recurrence-${phone ? "phone" : "desktop"}-date-draft.png`,
      ),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Save date", exact: true }).click();
    await expect(
      page.getByRole("group", { name: "Occurrence 2026-10-02", exact: true }),
    ).toContainText("Oct 9, 2026");
    await expect(
      page.getByRole("group", { name: "Occurrence 2026-10-02", exact: true }),
    ).toContainText("Originally Oct 2, 2026");
    expect(writes(state.calls)[1].args).toMatchObject({
      scope: "this",
      action: "edit",
      original_date: "2026-10-02",
      expected_version: 3,
      expected_occurrence_version: 3,
      scheduled_date: "2026-10-09",
    });
    expect(writes(state.calls)[1].args).not.toHaveProperty("rule");
    expect(writes(state.calls)[1].args).not.toHaveProperty("template");
    await expect(
      page.getByRole("button", { name: "Back to repeat", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  });
}

test("uncertain occurrence writes require explicit retry with the same frozen request", async ({
  page,
}) => {
  const state = await fixture(page);
  let failed = false;
  state.control.intercept = async ({ name }, route) => {
    if (name === "update_recurrence" && !failed) {
      failed = true;
      await route.fulfill({
        status: 503,
        json: { code: "storage_error", message: "Write outcome unknown" },
      });
      return true;
    }
  };
  await reschedule(page);
  await page.getByLabel("Scheduled date", { exact: true }).fill("2026-10-09");
  await page.getByRole("button", { name: "Save date", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry same change", exact: true }),
  ).toBeVisible();
  expect(writes(state.calls)).toHaveLength(1);
  await expect(
    page.getByLabel("Scheduled date", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Discard date draft", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Complete occurrence 2026-10-01",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Retry same change", exact: true })
    .click();
  await expect(page.getByLabel("Scheduled date", { exact: true })).toHaveCount(
    0,
  );
  expect(writes(state.calls)).toHaveLength(2);
  expect(writes(state.calls)[1]).toEqual(writes(state.calls)[0]);
});

test("occurrence conflicts rebase versions while preserving the unsaved date", async ({
  page,
}) => {
  const state = await fixture(page);
  let failed = false;
  state.control.intercept = async ({ name }, route) => {
    if (name === "update_recurrence" && !failed) {
      failed = true;
      state.series.version = 4;
      state.tasks[1].version = 5;
      await route.fulfill({
        status: 409,
        json: { code: "conflict", message: "Occurrence changed elsewhere" },
      });
      return true;
    }
  };
  await reschedule(page);
  await page.getByLabel("Scheduled date", { exact: true }).fill("2026-10-09");
  await page.getByRole("button", { name: "Save date", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save date", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Read current occurrences", exact: true })
    .click();
  await expect(page.getByLabel("Scheduled date", { exact: true })).toHaveValue(
    "2026-10-09",
  );
  expect(writes(state.calls)).toHaveLength(1);
  await page.getByRole("button", { name: "Save date", exact: true }).click();
  await expect(page.getByLabel("Scheduled date", { exact: true })).toHaveCount(
    0,
  );
  expect(writes(state.calls)[1].args).toMatchObject({
    expected_version: 4,
    expected_occurrence_version: 5,
    original_date: "2026-10-02",
    scheduled_date: "2026-10-09",
  });
  expect(writes(state.calls)[1].args.request_id).not.toBe(
    writes(state.calls)[0].args.request_id,
  );
});

test("preview occurrence reschedules omit materialized-version preconditions", async ({
  page,
}) => {
  const state = await fixture(page);
  await reschedule(page, "2026-10-04");
  await page.getByLabel("Scheduled date", { exact: true }).fill("2026-10-12");
  await page.getByRole("button", { name: "Save date", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Occurrence 2026-10-04", exact: true }),
  ).toContainText("Oct 12, 2026");
  expect(writes(state.calls)[0].args).not.toHaveProperty(
    "expected_occurrence_version",
  );
  await page
    .getByRole("button", {
      name: "Actions for occurrence 2026-10-04",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Skip", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Occurrence 2026-10-04", exact: true }),
  ).toContainText("Skipped");
  await expect(
    page.getByRole("button", {
      name: "Complete occurrence 2026-10-04",
      exact: true,
    }),
  ).toBeDisabled();
});

test("series mutation responses use the series receipt and retain a clean form", async ({
  page,
}) => {
  const state = await fixture(page, { view: "settings" });
  await page.getByLabel("Every", { exact: false }).fill("2");
  await expect(
    page.getByRole("button", { name: "Save repeat", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save repeat", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save repeat", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry same change", exact: true }),
  ).toHaveCount(0);
  expect(writes(state.calls)[0].args).toMatchObject({
    scope: "all",
    expected_version: 3,
    rule: { interval: 2 },
  });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  expect(writes(state.calls)[1].args.expected_version).toBe(4);
});

test("settings, occurrences, and preview read failures remain visible and recoverable", async ({
  page,
}) => {
  const state = await fixture(page, { open: false });
  let resolvedRoute = false;
  state.control.intercept = async ({ name, args }, route) => {
    if (name === "list_occurrences" && args.series_id) {
      // Resolve the focused URL once; fail the summary/settings/occurrence reads
      // inside that screen, rather than preventing the screen from opening.
      if (!resolvedRoute) { resolvedRoute = true; return; }
      await route.fulfill({
        status: 503,
        json: { message: "Repeat data unavailable" },
      });
      return true;
    }
  };
  await page.getByRole("button", { name: "Repeating", exact: true }).click();
  await page.getByRole("button", { name: /Review the daily plan/ }).click();
  await expect(
    page.getByRole("button", { name: "Reload repeat summary", exact: true }),
  ).toBeVisible();
  await manageRepeat(page);
  await expect(
    page.getByRole("button", { name: "Reload occurrences", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No occurrences in this date range.", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Back to repeat", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reload repeat settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back to repeat", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Discard repeat draft", exact: true }),
  ).toHaveCount(0);
  state.control.intercept = async ({ name, args }, route) => {
    if (name === "list_occurrences" && args.rule) {
      await route.fulfill({
        status: 503,
        json: { message: "Preview unavailable now" },
      });
      return true;
    }
  };
  await page
    .getByRole("button", { name: "Reload repeat settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry schedule preview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save repeat", exact: true }),
  ).toBeDisabled();
  state.control.intercept = undefined;
  await page
    .getByRole("button", { name: "Retry schedule preview", exact: true })
    .click();
  await expect(page.locator(".repeat-preview")).toContainText("Oct 5, 2026");
  expect(writes(state.calls)).toHaveLength(0);
});

test("adopting a future task anchors deadline offsets to the first preview date", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-04T14:00:00Z"));
  const task = {
    ...occurrence("2026-10-02"),
    occurrence: undefined,
    brief: "Review the day’s commitments and select the next action.",
    due_date: "2026-10-12",
    review_date: "2026-10-10",
  };
  const state = await fixture(page, { open: false, task });
  await page
    .getByRole("button", { name: `More options: ${task.title}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Repeat", exact: true }).click();
  await page.getByText("Task defaults", { exact: true }).click();
  await expect(page.getByLabel("Deadline offset", { exact: true })).toHaveValue(
    "8",
  );
  await expect(page.getByLabel("Review offset", { exact: true })).toHaveValue(
    "6",
  );
  await page.getByLabel("Deadline offset", { exact: true }).fill("2");
  state.control.preview = ["2026-10-08", "2026-10-15"];
  await page.getByLabel("Monday", { exact: true }).check();
  await expect(page.locator(".repeat-preview")).toContainText("Oct 8, 2026");
  await expect(page.getByLabel("Deadline offset", { exact: true })).toHaveValue(
    "2",
  );
  await expect(page.getByLabel("Review offset", { exact: true })).toHaveValue(
    "2",
  );
  await page
    .getByRole("button", { name: "Start repeating", exact: true })
    .click();
  await expect.poll(() => writes(state.calls).length).toBe(1);
  expect(writes(state.calls)[0].args).toMatchObject({
    task_id: task.id,
    expected_task_version: 2,
    template: { due_offset_days: 2, review_offset_days: 2 },
  });
});

test("series conflict preserves edited fields and incorporates untouched server fields", async ({
  page,
}) => {
  const state = await fixture(page, { view: "settings" });
  let failed = false;
  state.control.intercept = async ({ name }, route) => {
    if (name === "update_recurrence" && !failed) {
      failed = true;
      state.series.version = 7;
      state.series.recurrence!.segments[0].template.notes = "Updated elsewhere";
      await route.fulfill({
        status: 409,
        json: { code: "conflict", message: "Repeat changed elsewhere" },
      });
      return true;
    }
  };
  await page.getByLabel("Every", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Save repeat", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Read current version", exact: true })
    .click();
  await expect(page.getByLabel("Every", { exact: true })).toHaveValue("3");
  expect(state.series.recurrence!.segments[0].template.notes).toBe(
    "Updated elsewhere",
  );
  expect(writes(state.calls)).toHaveLength(1);
  await page.getByRole("button", { name: "Save repeat", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save repeat", exact: true }),
  ).toBeDisabled();
  expect(writes(state.calls)[1].args).toMatchObject({
    expected_version: 7,
    rule: { interval: 3 },
  });
});

test("uncertain repeat writes lock other actions and reuse the exact request", async ({
  page,
}) => {
  const state = await fixture(page, { view: "settings" });
  let failed = false;
  state.control.intercept = async ({ name }, route) => {
    if (name === "update_recurrence" && !failed) {
      failed = true;
      await route.fulfill({
        status: 503,
        json: { message: "Repeat outcome unknown" },
      });
      return true;
    }
  };
  await page.getByLabel("Every", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save repeat", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry same change", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Every", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Back to repeat", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Discard repeat draft", exact: true }),
  ).toHaveCount(0);
  expect(writes(state.calls)).toHaveLength(1);
  await page
    .getByRole("button", { name: "Retry same change", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeVisible();
  expect(writes(state.calls)[1]).toEqual(writes(state.calls)[0]);
});

test("phone occurrence draft survives navigation and discards explicitly", async ({
  page,
}) => {
  await fixture(page, { phone: true });
  await reschedule(page);
  await page.getByLabel("Scheduled date", { exact: true }).fill("2026-10-09");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Keep this edit?" });
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Getting things done", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Repeating", exact: true }).click();
  await expect(page.getByLabel("Scheduled date", { exact: true })).toHaveValue(
    "2026-10-09",
  );
  await page
    .getByRole("button", { name: "Discard date draft", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Back to repeat", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Back to repeat", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Back to repeats", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Review the daily plan/ }),
  ).toBeFocused();
});

test("failed repeating list reads never present an empty success state", async ({
  page,
}) => {
  const state = await fixture(page, { open: false });
  state.control.intercept = async ({ name, args }, route) => {
    if (name === "list_occurrences" && !args.series_id && !args.rule) {
      await route.fulfill({
        status: 503,
        json: { message: "Repeating list unavailable" },
      });
      return true;
    }
  };
  await page.getByRole("button", { name: "Repeating", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Repeating list unavailable",
  );
  await expect(
    page.getByText("No repeating tasks.", { exact: false }),
  ).toHaveCount(0);
  state.control.intercept = undefined;
  await page
    .getByRole("button", { name: "Reload repeating tasks", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Review the daily plan/ }),
  ).toBeVisible();
  expect(writes(state.calls)).toHaveLength(0);
});

test("following edits retain original identity and anchor at current scheduled date", async ({
  page,
}) => {
  const task = occurrence("2026-10-02");
  task.occurrence!.scheduled_date = "2026-10-08";
  const state = await fixture(page, { open: false, task });
  await page
    .getByRole("button", { name: `More options: ${task.title}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page
    .getByRole("button", { name: "Repeat settings", exact: true })
    .click();
  await expect(page.getByLabel("Starts", { exact: true })).toHaveValue(
    rule.start_date,
  );
  await page.getByLabel("Every", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save repeat", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "This and following", exact: true })
    .click();
  await expect.poll(() => writes(state.calls).length).toBe(1);
  expect(writes(state.calls)[0].args).toMatchObject({
    scope: "following",
    original_date: "2026-10-02",
    rule: { start_date: "2026-10-08", interval: 2 },
  });
});

test("compact overview and aligned schedule editor fit desktop and phone", async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-10-04T14:00:00Z"));
  await fixture(page, { view: "overview" });
  await expect(
    page.locator(".metadata-row").filter({ hasText: "Next:" }).getByText("Oct 4, 2026", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".occurrence-row")).toHaveCount(0);
  await expect(page.getByLabel("Starts", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("overview-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await expect(page.locator(".repeat-preview")).toContainText("Oct 5, 2026");
  await expect(page.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("schedule-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Open navigation", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".gtd-sidebar:visible")
        .evaluate((el) => el.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("schedule-phone.png"),
    fullPage: true,
  });
  for (const input of await page
    .locator(".repeat-form input:visible,.repeat-form select:visible")
    .all()) {
    expect(
      await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page
    .getByRole("button", { name: "Back to repeat", exact: true })
    .click();
  await expect(page.locator(".occurrence-row")).toHaveCount(0);
  await expect(
    page.locator(".metadata-row").filter({ hasText: "Next:" }).getByText("Oct 4, 2026", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("overview-phone.png"),
    fullPage: true,
  });
});

for (const phone of [false, true]) {
  test(`repeat overview shows human context without opening an editor (${phone ? "phone" : "desktop"})`, async ({
    page,
  }, info) => {
    const state = await fixture(page, { open: false, phone });
    const defaults = state.series.recurrence!.segments[0].template;
    defaults.notes =
      "## Prepare\nRead the **brief** and choose one next action.";
    defaults.links = [
      { label: "Review guide", url: "https://example.com/review" },
    ];
    defaults.location = "Main library";
    defaults.agent_notes = "Working context stays out of the overview.";
    state.control.intercept = async ({ name, args }, route) => {
      if (name !== "list_occurrences" || args.series_id || args.rule) return;
      const { recurrence, ...summary } = state.series;
      await route.fulfill({
        json: { series_list: [summary], occurrences: [], next_cursor: null },
      });
      return true;
    };
    await openSeries(page, phone, "overview");
    const context = page.locator(".repeat-overview .task-context-content");
    await expect(
      context.getByRole("heading", { name: "Prepare" }),
    ).toBeVisible();
    await expect(context.locator("strong")).toHaveText("brief");
    await expect(
      context.getByRole("link", { name: "Review guide" }),
    ).toHaveAttribute("href", "https://example.com/review");
    await expect(
      context.getByRole("link", { name: "Main library" }),
    ).toHaveAttribute("href", /maps\/search/);
    await expect(
      page.getByText(defaults.agent_notes, { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Notes", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".occurrence-row")).toHaveCount(0);
    expect(state.calls.some((call) => call.args.include_agent_notes)).toBe(
      false,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (phone) {
      await expect
        .poll(() =>
          page
            .locator(".gtd-sidebar:visible")
            .evaluate((el) => el.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(1);
    }
    await page.screenshot({
      path: info.outputPath("repeat-description.png"),
      fullPage: true,
    });
  });
}

test("repeat overview retrieves omitted defaults and leaves an empty description quiet", async ({
  page,
}) => {
  const state = await fixture(page, { open: false });
  state.control.intercept = async ({ name, args }, route) => {
    if (name === "list_occurrences" && args.series_id) {
      const { recurrence, ...summary } = state.series;
      await route.fulfill({
        json: { series: summary, occurrences: [], next_cursor: null },
      });
      return true;
    }
    if (name === "list_changes") {
      await route.fulfill({ json: { changes: [{ after: state.series }] } });
      return true;
    }
  };
  await openSeries(page, false, "overview");
  await expect(page.locator(".repeat-overview .task-markdown")).toHaveText(
    template.notes,
  );
  state.series.recurrence!.segments[0].template.notes = "";
  state.series.recurrence!.segments[0].template.brief = "";
  await page
    .getByRole("button", { name: "Back to repeats", exact: true })
    .click();
  await page.getByRole("button", { name: /Review the daily plan/ }).click();
  await expect(
    page.getByText("No upcoming occurrence in this date range.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator(".repeat-overview .task-context-content"),
  ).toHaveCount(0);
  await expect(
    page.getByText("No additional details.", { exact: true }),
  ).toHaveCount(0);
});

test("an occurrence keeps its own description without repeating the series defaults", async ({
  page,
}) => {
  await fixture(page, {
    open: false,
    task: {
      ...occurrence("2026-10-02"),
      notes: "Instructions for this occurrence only.",
    },
  });
  await page
    .getByRole("button", {
      name: "Details: Review the daily plan",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Instructions for this occurrence only.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(template.notes, { exact: true })).toHaveCount(0);
  await expect(page.locator(".task-markdown")).toHaveCount(1);
});

test("task detail defaults remain compact and occurrence manager preserves its draft on back", async ({
  page,
}) => {
  const state = await fixture(page, {
    open: false,
    task: occurrence("2026-10-02"),
  });
  // Home keeps its featured task collapsed; occurrence management stays in the menu.
  await expect(
    page.getByRole("button", {
      name: `More options: ${template.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".occurrence-row")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Manage occurrences", exact: true }),
  ).toHaveCount(0);
  await manageTask(page);
  await expect(
    page.getByRole("region", { name: "Manage occurrences", exact: true }),
  ).toBeVisible();
  await reschedule(page);
  await page.getByLabel("Scheduled date", { exact: true }).fill("2026-10-09");
  await page
    .getByRole("button", { name: "Back to task details", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: `More options: ${template.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await manageTask(page);
  await expect(page.getByLabel("Scheduled date", { exact: true })).toHaveValue(
    "2026-10-09",
  );
  await page.getByRole("button", { name: "Save date", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Occurrence 2026-10-02", exact: true }),
  ).toContainText("Oct 9, 2026");
  expect(writes(state.calls)).toHaveLength(1);
});

test("repeat overview skips completed and skipped dates when finding the next occurrence", async ({
  page,
}) => {
  const state = await fixture(page, { open: false });
  state.control.intercept = async ({ name, args }, route) => {
    if (name !== "list_occurrences" || !args.series_id) return;
    const done = occurrence("2099-01-01", "done"),
      skipped = occurrence("2099-01-02");
    skipped.occurrence!.skipped = true;
    await route.fulfill({
      json: {
        series: args.cursor
          ? {
              id: state.series.id,
              title: state.series.title,
              entity_type: "recurrence",
              version: state.series.version,
            }
          : state.series,
        occurrences: args.cursor
          ? [
              {
                original_date: "2099-01-03",
                scheduled_date: "2099-01-03",
                preview: true,
              },
            ]
          : [done, skipped].map((task) => ({
              original_date: task.occurrence!.original_date,
              scheduled_date: task.occurrence!.scheduled_date,
              task,
              preview: false,
            })),
        next_cursor: args.cursor ? null : "page-two",
        complete: !!args.cursor,
      },
    });
    return true;
  };
  await openSeries(page, false, "overview");
  await expect(
    page.locator(".repeat-overview .metadata-row").filter({ hasText: "Next:" }).filter({ hasText: "Jan 3, 2099" }),
  ).toBeVisible();
  await expect(page.locator(".occurrence-row")).toHaveCount(0);
  await expect(page.locator(".repeat-overview .task-markdown")).toHaveText(
    template.notes,
  );
});

test("embedded card keeps occurrences behind a focused bounded manager", async ({
  page,
}, testInfo) => {
  const html = await readFile(
    new URL("../dist/widget-adapter.html", import.meta.url),
    "utf8",
  );
  const task = occurrence("2026-10-02");
  await page.route("**/__recurrence-card", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body style='margin:0'></body>",
    }),
  );
  await page.goto("/__recurrence-card");
  await page.evaluate(
    ({ html, task, series }) => {
      const frame = document.createElement("iframe");
      frame.style.cssText = "width:360px;height:60px;border:0;display:block";
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      const list = {
        items: [task],
        history: [],
        next_offset: null,
        next_history_after: null,
      };
      (window as any).recurrenceCalls = [];
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data,
          send = (v: any) =>
            frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
        if (m.method === "ui/initialize")
          send({ id: m.id, result: { hostContext: { theme: "light" } } });
        if (m.method === "ui/notifications/initialized")
          send({
            method: "ui/notifications/tool-result",
            params: { structuredContent: list },
          });
        if (m.method === "tools/call") {
          if (["gtd_ui_read","gtd_ui_write"].includes(m.params.name)) m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
          const { name, arguments: args } = m.params;
          (window as any).recurrenceCalls.push({ name, args });
          let result: any = list;
          if (name === "list_occurrences")
            result = {
              series,
              occurrences: [
                {
                  original_date: task.occurrence!.original_date,
                  scheduled_date: task.occurrence!.scheduled_date,
                  task,
                  preview: false,
                },
              ],
              next_cursor: null,
              complete: true,
            };
          if (name === "update_recurrence") {
            task.occurrence!.scheduled_date = args.scheduled_date;
            task.version++;
            result = { task, change: { id: 9 }, replayed: false };
          }
          send({ id: m.id, result: { structuredContent: result } });
        }
        if (m.method === "ui/notifications/size-changed")
          frame.style.height = `${m.params.height}px`;
      });
      frame.srcdoc = html;
      document.body.append(frame);
    },
    { html, task, series: originalSeries },
  );
  const frame = page.frameLocator("iframe");
  await frame
    .getByRole("button", { name: `Details: ${task.title}`, exact: true })
    .click();
  await expect(frame.getByText("Every day", { exact: true })).toBeVisible();
  await expect(frame.locator(".occurrence-row")).toHaveCount(0);
  await manageTask(frame);
  await expect(
    frame.getByRole("region", { name: "Manage occurrences", exact: true }),
  ).toBeVisible();
  await frame
    .getByRole("button", {
      name: "Actions for occurrence 2026-10-02",
      exact: true,
    })
    .click();
  await frame
    .getByRole("menuitem", { name: "Reschedule", exact: true })
    .click();
  await frame.getByLabel("Scheduled date", { exact: true }).fill("2026-10-09");
  await expect(
    frame.getByRole("button", { name: "Save date", exact: true }),
  ).toBeEnabled();
  await frame
    .getByRole("button", { name: "Back to task details", exact: true })
    .click();
  await manageTask(frame);
  await expect(frame.getByLabel("Scheduled date", { exact: true })).toHaveValue(
    "2026-10-09",
  );
  await expect(frame.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("embedded-occurrence-manager.png"),
  });
  expect(
    (await frame
      .getByRole("region", { name: "Manage occurrences", exact: true })
      .boundingBox())!.height,
  ).toBeLessThanOrEqual(420);
  await frame.getByRole("button", { name: "Save date", exact: true }).click();
  await expect(
    frame.getByRole("group", { name: "Occurrence 2026-10-02", exact: true }),
  ).toContainText("Oct 9, 2026");
  expect(
    await page.evaluate(
      () =>
        (window as any).recurrenceCalls.filter(
          (call: any) => call.name === "update_recurrence",
        ).length,
    ),
  ).toBe(1);
});

test("discarding a conflicted repeat draft reloads the current settings without trapping the editor", async ({
  page,
}) => {
  const state = await fixture(page, { view: "settings" });
  state.control.intercept = async ({ name }, route) => {
    if (name !== "update_recurrence") return;
    state.series.version = 7;
    state.series.recurrence!.segments[0].rule.interval = 4;
    await route.fulfill({
      status: 409,
      json: { code: "conflict", message: "Changed elsewhere" },
    });
    return true;
  };
  await page.getByLabel("Every", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save repeat", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Read current version", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Discard repeat draft", exact: true })
    .click();
  await expect(page.getByLabel("Every", { exact: true })).toHaveValue("4");
  await expect(page.getByLabel("Every", { exact: true })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Back to repeat", exact: true }),
  ).toBeEnabled();
  expect(writes(state.calls)).toHaveLength(1);
});

test("website task, repeating, and project items share subtle individual cards", async ({
  page,
}, testInfo) => {
  const state = await fixture(page, { open: false });
  state.control.projects = [
    {
      ...originalSeries,
      id: "project-a",
      entity_type: "project",
      title: "Plan the autumn workshop",
      recurrence: undefined,
    },
    {
      ...originalSeries,
      id: "project-b",
      entity_type: "project",
      title: "Refresh the shared handbook",
      recurrence: undefined,
    },
  ];
  await expect(page.locator(".home-focus")).toBeVisible();
  const homeCard = await page.locator(".home-focus").evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      background: style.backgroundColor,
      radius: style.borderRadius,
      inset: style.paddingLeft,
    };
  });
  const surfaces: [string, string][] = [
    ["All tasks", ".task-browser .compact-task"],
    ["Repeating", ".repeat-series"],
    ["Projects", ".project-row"],
  ];
  const colors: string[] = [];
  for (const [name, selector] of surfaces) {
    await page.getByRole("button", { name, exact: true }).click();
    const first = page.locator(selector + ":visible").first();
    await expect(first).toBeVisible();
    const style = await first.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        radius: style.borderRadius,
        inset: style.paddingLeft,
      };
    });
    expect(style).toEqual(homeCard);
    colors.push(style.background);
    await page.screenshot({
      path: testInfo.outputPath(`cards-${name.toLowerCase()}-desktop.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Open navigation", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".gtd-sidebar:visible")
        .evaluate((el) => el.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(1);
  for (const [name, selector] of surfaces) {
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(selector + ":visible").first()).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".gtd-sidebar:visible")
          .evaluate((el) => el.getBoundingClientRect().right),
      )
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`cards-${name.toLowerCase()}-phone.png`),
      fullPage: true,
    });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await expect
    .poll(() =>
      page
        .locator(".project-row")
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .not.toBe(colors[2]);
  expect(
    colors.every(
      (color) => color === colors[0] && color !== "rgba(0, 0, 0, 0)",
    ),
  ).toBe(true);
});

test("repeat task details edit structured defaults without sending a schedule rule", async ({
  page,
}, testInfo) => {
  const state = await fixture(page, { open: false });
  state.control.projects = [
    {
      ...originalSeries,
      id: "project-a",
      entity_type: "project",
      title: "Autumn planning",
      recurrence: undefined,
    },
  ];
  await openSeries(page, false, "details");
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue(template.title);
  await expect(page.getByLabel("Starts", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Task defaults", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save task details", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Prepare the daily plan");
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Review the agenda before each planning session.");
  await page
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("waiting");
  await page.getByRole("button", { name: "Add detail", exact: true }).click();
  await page.getByRole("menuitem", { name: "Link", exact: true }).click();
  await page.getByLabel("Link 1 label", { exact: true }).fill("Agenda");
  await page
    .getByRole("button", { name: "Save task details", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  expect(writes(state.calls)).toHaveLength(0);
  await expect(page.getByLabel("Link 1 URL", { exact: true })).toBeFocused();
  await page
    .getByLabel("Link 1 URL", { exact: true })
    .fill("https://example.com/agenda");
  await page.getByRole("button", { name: "Add detail", exact: true }).click();
  await page.getByRole("menuitem", { name: "Location", exact: true }).click();
  await page
    .getByLabel("Location", { exact: true })
    .fill("Library, second floor");
  await page
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption("project-a");
  await expect(page.getByLabel("Deadline offset", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector("main")?.scrollTo(0, 0);
  });
  await page.screenshot({
    path: testInfo.outputPath("repeat-details-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Save task details", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save task details", exact: true }),
  ).toBeDisabled();
  expect(writes(state.calls)).toHaveLength(1);
  expect(writes(state.calls)[0].args).not.toHaveProperty("rule");
  expect(writes(state.calls)[0].args).toMatchObject({
    scope: "all",
    expected_version: 3,
    template: {
      title: "Prepare the daily plan",
      notes: "Review the agenda before each planning session.",
      status: "waiting",
      links: [{ label: "Agenda", url: "https://example.com/agenda" }],
      location: "Library, second floor",
      project_id: "project-a",
      due_offset_days: null,
      review_offset_days: null,
    },
  });
  await expect(
    page.getByRole("heading", { name: "Prepare the daily plan", exact: true }),
  ).toBeVisible();
});

test("repeat task detail conflicts preserve local title and current untouched notes", async ({
  page,
}) => {
  const state = await fixture(page, { view: "details" });
  let fail = true;
  state.control.intercept = async ({ name }, route) => {
    if (name === "update_recurrence" && fail) {
      fail = false;
      state.series.version = 6;
      state.series.recurrence!.segments[0].template.notes = "Server notes";
      await route.fulfill({
        status: 409,
        json: { code: "conflict", message: "Details changed elsewhere" },
      });
      return true;
    }
  };
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("My preserved title");
  await page
    .getByRole("button", { name: "Save task details", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Read current version", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("My preserved title");
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Server notes");
  expect(writes(state.calls)).toHaveLength(1);
  await page
    .getByRole("button", { name: "Save task details", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save task details", exact: true }),
  ).toBeDisabled();
  expect(writes(state.calls)[1].args).toMatchObject({
    expected_version: 6,
    template: { title: "My preserved title", notes: "Server notes" },
  });
  expect(writes(state.calls)[1].args).not.toHaveProperty("rule");
});

test("phone repeat details are directly editable and preserve drafts through navigation", async ({
  page,
}, testInfo) => {
  await fixture(page, { view: "details", phone: true });
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue(template.title);
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Keep this mobile details draft.");
  await expect(
    page.getByRole("button", { name: "Back to repeat", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await expect(page.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("repeat-details-phone.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Save task details", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Save task details", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("repeat-details-phone-actions.png"),
  });
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Getting things done", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Repeating", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Keep this mobile details draft.");
  await page
    .getByRole("button", { name: "Discard details draft", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Back to repeat", exact: true }),
  ).toBeEnabled();
});
