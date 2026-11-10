import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const empty = () => ({ items: [], next_offset: null, next_cursor: null });
const task = (epoch: number) => ({
  id: "refresh-task",
  title: `Agent task update ${epoch}`,
  notes: `The current action, revision ${epoch}.`,
  status: "next",
  version: epoch + 1,
  last_change_id: epoch + 1,
  deleted: false,
  archived: false,
  due_date: null,
  links: [],
});
const project = (epoch: number, count = 0) => ({
  ...task(epoch),
  id: "refresh-project",
  title: `Agent project update ${epoch}`,
  entity_type: "project",
  status: "active",
  task_counts: { next: count },
});
const rule = {
  start_date: "2026-10-01",
  frequency: "daily",
  interval: 1,
  weekdays: [],
  month_day: null,
  ordinal: null,
  until: null,
  count: null,
};

async function fixture(page: Page) {
  const calls: { name: string; args: any }[] = [];
  const releases = new Set<() => void>();
  const gates = new Map<string, Promise<void>>();
  const state = {
    epoch: 0,
    projectCount: 0,
    failure: "",
    calls,
    hold(name: string) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(name, promise);
      releases.add(release);
      return () => {
        gates.delete(name);
        releases.delete(release);
        release();
      };
    },
    releaseAll() {
      gates.clear();
      for (const release of releases) release();
      releases.clear();
    },
  };
  const handle = async (route: Route, name: string, args: any = {}) => {
    calls.push({ name, args });
    await (gates.get(name) || gates.get("all"));
    if (state.failure === name)
      return route.fulfill({
        status: 503,
        json: { message: "Refresh unavailable. Try again." },
      });
    const epoch = state.epoch;
    let json: any;
    if (name === "home") {
      const empty = {items:[],next_cursor:null};
      json={data:{next:{...empty,items:[task(epoch)]},waiting:empty,someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}};
    } else if (name === "list_items")
      json = {
        ...empty(),
        items: [
          {
            ...task(epoch),
            id:
              args.task_id ||
              `refresh-task-${args.project_id || ""}-${args.review_on ? "review" : args.status || "next"}`,
            status: args.status || "next",
            archived: args.archived === true,
            review_date: args.review_on || null,
            project_id: args.project_id || null,
          },
        ],
      };
    else if (name === "list_projects")
      json = {
        projects: [project(epoch, state.projectCount)],
        next_cursor: null,
        complete: true,
      };
    else if (name === "list_occurrences") {
      const series = {
        ...task(epoch),
        id: "refresh-series",
        title: `Agent repeat update ${epoch}`,
        entity_type: "recurrence",
        status: "active",
        recurrence: {
          segments: [
            {
              from: rule.start_date,
              rule,
              template: {
                ...task(epoch),
                title: `Agent repeat update ${epoch}`,
                project_id: null,
              },
            },
          ],
          pauses: [],
          ended_on: null,
        },
      };
      json = {
        series_list: args.series_id ? [] : [series],
        series: args.series_id ? series : null,
        occurrences: [],
        next_cursor: null,
        complete: true,
      };
    } else if (name === "list_changes")
      json = {
        changes: [
          {
            id: epoch + 10,
            task_id: "refresh-task",
            entity_type: "task",
            operation: "update_item",
            reason: `Agent activity update ${epoch}`,
            before: null,
            after: task(epoch),
            origin: "mcp",
            created_at: "2026-10-06T15:00:00Z",
            undoes_change_id: null,
          },
        ],
        next_before_id: args.before_id ? null : 10,
      };
    else if (name === "health")
      json = {
        database: true,
        tunnel: { ready: true },
        diagnostics: { available: true, failure_markers: [] },
        search: { ready: true },
        version: `fixture-v${epoch}`,
        checked_at: "2026-10-06T15:00:00Z",
      };
    else if (name === "logs")
      json = {
        events: [
          {
            id: epoch + 10,
            call_id: "fixture",
            created_at: "2026-10-06T15:00:00Z",
            source: "mcp",
            operation: "list_items",
            outcome: "success",
            duration_ms: 1,
            message: `Agent log update ${epoch}`,
          },
        ],
        next_before_id: args.before_id ? null : 10,
        expired_events: 0,
      };
    else throw new Error(`Unexpected fixture call: ${name}`);
    await route.fulfill({ json });
  };
  await page.route("**/api/tools/*", (route) =>
    handle(
      route,
      route.request().url().split("/").at(-1)!,
      route.request().postDataJSON(),
    ),
  );
  await page.route("**/api/view", route => handle(route, "home", route.request().postDataJSON()));
  await page.route("**/api/health", (route) => handle(route, "health"));
  await page.route("**/api/logs?*", (route) =>
    handle(
      route,
      "logs",
      Object.fromEntries(new URL(route.request().url()).searchParams),
    ),
  );
  await page.goto("/");
  await expect(
    page.getByText("Agent task update 0", { exact: true }).first(),
  ).toBeVisible();
  return state;
}

async function navigate(page: Page, name: string) {
  if (name === "Home") return;
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  const sidebar = page.locator(".gtd-sidebar:visible");
  if (["Activity", "Service health", "Logs"].includes(name)) {
    await sidebar
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await page.getByRole("menuitem", {name,exact:true}).click();
  } else await sidebar.getByRole("button", { name, exact: true }).click();
  await expect(page.locator(".gtd-main:visible")).not.toHaveAttribute("inert");
  await expect
    .poll(() =>
      page
        .locator(".gtd-sidebar:visible")
        .evaluate((el) => el.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
}

async function pull(page: Page, selector = ".gtd-main:visible") {
  await page.locator(selector).evaluate(async (element) => {
    for (const [name, y] of [
      ["touchstart", 160],
      ["touchmove", 336],
      ["touchend", 336],
    ] as const) {
      const event = new Event(name, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: name === "touchend" ? [] : [{ clientX: 180, clientY: y }],
      });
      element.dispatchEvent(event);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }
  });
}
const spinner = (page: Page) =>
  page.getByRole("status", { name: "Refreshing", exact: true });
async function held(page: Page) {
  await expect(spinner(page)).toBeVisible();
  // Past the idle frames: only a settled request may end the loading state.
  await page.waitForTimeout(120);
  await expect(spinner(page)).toBeVisible();
  await expect(page.locator(".mobile-refresh-content:visible")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 88)",
  );
}
async function rested(page: Page) {
  await expect(spinner(page)).toHaveCount(0);
  await expect(page.locator(".mobile-refresh-content:visible")).toHaveCSS(
    "transform",
    "none",
  );
}

for (const [name, endpoint, updated] of [
  ["Home", "home", "Agent task update 1"],
  ...[
    "Next",
    "Inbox",
    "Waiting",
    "Someday",
    "Blocked",
    "Done",
    "Archive",
    "All tasks",
  ].map((name) => [name, "list_items", "Agent task update 1"]),
  ["Projects", "list_projects", "Agent project update 1"],
  ["Repeating", "list_occurrences", "Agent repeat update 1"],
  ["Review", "list_projects", "Agent project update 1"],
  ["Activity", "list_changes", "Agent task update 1"],
  ["Service health", "health", "fixture-v1"],
  ["Logs", "logs", "Agent log update 1"],
]) {
  test(`pull refreshes ${name} and waits for its live data`, async ({
    page,
  }, info) => {
    const state = await fixture(page);
    try {
      if (name === "Review") await page.emulateMedia({ colorScheme: "dark" });
      await navigate(page, name);
      await expect(page.getByRole("button", { name: /^Refresh (tasks|projects)$/ })).toHaveCount(0);
      await expect
        .poll(() => state.calls.some((call) => call.name === endpoint))
        .toBe(true);
      const before = state.calls.length;
      state.epoch = 1;
      const release = state.hold("all");
      await pull(page);
      await held(page);
      if (["Projects", "Review", "Repeating"].includes(name)) {
                await page.screenshot({
          path: test.info().outputPath(`${info.project.name}-${name.toLowerCase()}-loading.png`),
        });
      }
      expect(
        state.calls.slice(before).some((call) => call.name === endpoint),
      ).toBe(true);
      release();
      await rested(page);
      if (name === "Repeating")
        await expect(
          page.getByRole("button", {
            name: `${updated} Every day`,
            exact: true,
          }),
        ).toBeVisible();
      else
        await expect(
          page
            .locator(".gtd-main:visible")
            .getByText(updated, { exact: true })
            .first(),
        ).toBeVisible();
    } finally {
      state.releaseAll();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

test("Review waits for both lists, retains failed data, and recovers on the next pull", async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    await navigate(page, "Review");
    await expect(
      page
        .locator(".gtd-main:visible")
        .getByText("Agent task update 0", { exact: true }),
    ).toBeVisible();
    state.epoch = 1;
    const release = state.hold("list_items");
    await pull(page);
    await expect(
      page
        .locator(".gtd-main:visible")
        .getByText("Agent project update 1", { exact: true }),
    ).toBeVisible();
    await held(page);
    state.failure = "list_items";
    release();
    await rested(page);
    await expect(
      page
        .locator(".gtd-main:visible")
        .getByText("Agent task update 0", { exact: true }),
    ).toBeVisible();
    state.failure = "";
    await pull(page);
    await rested(page);
    await expect(
      page
        .locator(".gtd-main:visible")
        .getByText("Agent task update 1", { exact: true }),
    ).toBeVisible();
  } finally {
    state.releaseAll();
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const name of ["Activity", "Logs"]) {
  test(`${name} refresh returns from older pages to the latest data`, async ({
    page,
  }) => {
    const state = await fixture(page);
    try {
      await navigate(page, name);
      await page
        .getByRole("button", {
          name: name === "Activity" ? "Load older changes" : "Older events →",
          exact: true,
        })
        .click();
      const endpoint = name === "Activity" ? "list_changes" : "logs";
      await expect
        .poll(() =>
          state.calls.some(
            (call) => call.name === endpoint && call.args.before_id,
          ),
        )
        .toBe(true);
      await page
        .locator(".gtd-main:visible")
        .evaluate((el) => (el.scrollTop = 0));
      state.epoch = 1;
      const before = state.calls.length;
      const release = state.hold(endpoint);
      await pull(page);
      await held(page);
      expect(
        state.calls
          .slice(before)
          .some((call) => call.name === endpoint && !call.args.before_id),
      ).toBe(true);
      release();
      await rested(page);
    } finally {
      state.releaseAll();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

test("Help stays static and navigating away cancels the refresh indicator", async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    await navigate(page, "Projects");
    const release = state.hold("list_projects");
    await pull(page);
    await held(page);
    await navigate(page, "Help");
    const before = state.calls.length;
    await pull(page);
    await expect(spinner(page)).toHaveCount(0);
    expect(state.calls.length).toBe(before);
    release();
    await navigate(page, "Projects");
    await rested(page);
  } finally {
    state.releaseAll();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a project refresh waits for newly populated task groups", async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    await navigate(page, "Projects");
    await page
      .getByRole("button", { name: "Agent project update 0", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Agent project update 0",
        exact: true,
      }),
    ).toBeVisible();
    state.projectCount = 1;
    state.epoch = 1;
    const release = state.hold("list_items");
    await pull(page);
    await expect(
      page.getByRole("heading", {
        name: "Agent project update 1",
        exact: true,
      }),
    ).toBeVisible();
    await held(page);
    expect(
      state.calls.some(
        (c) =>
          c.name === "list_items" && c.args.project_id === "refresh-project",
      ),
    ).toBe(true);
    release();
    await rested(page);
    await expect(
      page
        .locator(".gtd-main:visible")
        .getByText("Agent task update 1", { exact: true }),
    ).toBeVisible();
  } finally {
    state.releaseAll();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("refresh updates an open repeat's title and description", async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    await navigate(page, "Repeating");
    await page
      .getByRole("button", {
        name: "Agent repeat update 0 Every day",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "Agent repeat update 0", exact: true }),
    ).toBeVisible();
    state.epoch = 1;
    const release = state.hold("list_occurrences");
    await pull(page);
    await held(page);
    release();
    await rested(page);
    await expect(
      page.getByRole("heading", { name: "Agent repeat update 1", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".repeat-overview")
        .getByText("The current action, revision 1.", { exact: true }),
    ).toBeVisible();
  } finally {
    state.releaseAll();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a pending composed Home refresh keeps spinning, then retains content on failure", async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    state.failure = "home";
    const release = state.hold("home");
    await pull(page);
    await held(page);
    release();
    await rested(page);
    await expect(
      page.getByRole("button", {
        name: "View connection problem",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Agent task update 0", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    state.releaseAll();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("pulling from an input or while a project draft is dirty does not refresh", async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    await navigate(page, "Projects");
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    const title = page.getByLabel("Desired outcome", { exact: true });
    await expect(title).toBeVisible();
    const before = state.calls.length;
    await pull(
      page,
      "input[placeholder='What will be true when this is finished?']",
    );
    await rested(page);
    await title.fill("Keep my unsaved outcome");
    await pull(page);
    await rested(page);
    expect(state.calls.length).toBe(before);
    await expect(title).toHaveValue("Keep my unsaved outcome");
  } finally {
    state.releaseAll();
    await page.unrouteAll({ behavior: "wait" });
  }
});
