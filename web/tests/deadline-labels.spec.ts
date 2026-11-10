import { test, expect, type Locator } from "@playwright/test";
import type { Task } from "../src/api";
import { openWidget } from "./helpers/widget-host";

// Device date must not override the account's calendar year.
test.use({ timezoneId: "Pacific/Auckland" });

const task = (
  id: string,
  due_date: string,
  extra: Partial<Task> = {},
): Task => ({
  id,
  title: `Review ${id} and decide the next action`,
  brief: "Review the supporting material.",
  notes: "Keep the date readable beside a wrapping title.",
  status: "next",
  due_date,
  version: 1,
  last_change_id: 1,
  deleted: false,
  importance: "normal",
  ...extra,
});
const yearTasks = [
  task("This year", "2026-12-30"),
  task("Next year", "2027-06-30"),
  task("Following year", "2028-06-30"),
  task("Earlier year", "2025-06-30"),
];

async function contained(row: Locator) {
  const geometry = await row.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const date = el.querySelector(".date-chip")!;
    const label = date.getBoundingClientRect();
    const title = el.querySelector(".task-title")!.getBoundingClientRect();
    const menu = el
      .querySelector("button[aria-label^='More options']")!
      .getBoundingClientRect();
    return {
      inside: label.left >= rect.left && label.right <= rect.right,
      overlap: title.right > label.left + 1 || label.right > menu.left + 1,
      clipped: date.scrollWidth > date.clientWidth + 1,
    };
  });
  expect(geometry).toEqual({ inside: true, overlap: false, clipped: false });
}

for (const width of [320, 390, 480, 1280])
  for (const theme of ["light", "dark"] as const)
    test(`compact years and overdue dates stay readable at ${width}px ${theme}`, async ({
      page,
    }, info) => {
      await page.clock.install({ time: new Date("2026-11-10T18:00:00Z") });
      const { frame, changeMode } = await openWidget(page, {
        width,
        theme,
        tasks: yearTasks,
        account: {
          id: "00000000-0000-4000-8000-000000000001",
          timezone: "America/New_York",
        },
      });
      const dates = frame.locator(".date-chip:visible");
      await expect(dates).toHaveText([
        "Dec 30",
        "Jun 30, 2027",
        "Jun 30, 2028",
        "Overdue: Jun 30, 2025",
      ]);
      await expect(dates.nth(3)).toHaveAttribute("data-overdue", "true");
      await expect(dates.nth(3)).toHaveAttribute(
        "title",
        /Overdue.*Jun 30, 2025/,
      );
      for (const row of await frame.locator(".task-swipe-row:visible").all())
        await contained(row);
      await page.screenshot({ path: info.outputPath("inline-dates.png") });
      await changeMode("fullscreen", 800);
      for (const row of await frame.locator(".task-swipe-row:visible").all())
        await contained(row);
      await page.screenshot({ path: info.outputPath("expanded-dates.png") });
    });

test("date-only and timed deadlines update at their own boundaries, without reads", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-12-31T23:59:00Z") });
  const project = task("Project", "", {
    due_date: null,
    recommendation: {
      effective_deadline: {
        date: "2027-01-01",
        time: "09:00",
        timezone: "Asia/Tokyo",
      },
      deadline_project: { id: "project", title: "Prepare the release" },
      reason: "project",
      key: "test",
      evaluated_at: "2026-12-31T23:59:00Z",
    },
  });
  const tasks = [
    task("Date only", "2026-12-31"),
    task("Timed", "2026-12-31", {
      deadline_time: { time: "19:00", timezone: "America/New_York" },
    }),
    project,
    task("Skipped", "2020-01-01", {
      occurrence: {
        series_id: "repeat",
        original_date: "2020-01-01",
        scheduled_date: "2020-01-01",
        skipped: true,
        overrides: [],
      },
    }),
  ];
  const { frame, requests } = await openWidget(page, {
    tasks,
    width: 1280,
    account: {
      id: "00000000-0000-4000-8000-000000000002",
      timezone: "America/New_York",
    },
  });
  const dates = frame.locator(".date-chip:visible");
  await expect(dates).toHaveCount(4);
  await expect(
    frame.locator('.date-chip[data-overdue="true"]:visible'),
  ).toHaveCount(0);
  const calls = (await requests("tools/call")).length;
  await page.clock.fastForward(61_000);
  await expect(dates.nth(1)).toHaveAttribute("data-overdue", "true");
  await expect(dates.nth(2)).toHaveAttribute("data-overdue", "true");
  await expect(dates.nth(0)).not.toHaveAttribute("data-overdue", "true");
  await expect(dates.nth(0)).toHaveText("Dec 31");
  await page.clock.fastForward(5 * 3600_000);
  await expect(dates.nth(0)).toHaveAttribute("data-overdue", "true");
  await expect(dates.nth(0)).toHaveText("Overdue: Dec 31, 2026");
  await expect(dates.nth(2).locator(".date-chip-source")).toHaveText("Project");
  await expect(
    frame.locator('.date-chip[data-overdue="true"]:visible'),
  ).toHaveCount(3);
  expect((await requests("tools/call")).length).toBe(calls);
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`website Home and Next retain dates at ${width}px ${theme}`, async ({
      page,
    }, info) => {
      await page.clock.install({ time: new Date("2026-11-10T18:00:00Z") });
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const list = (items: Task[]) => ({
        items,
        history: [],
        next_cursor: null,
        next_offset: null,
      });
      await page.route("**/api/view", (route) =>
        route.fulfill({
          json: {
            data: {
              next: list(yearTasks),
              waiting: list([]),
              someday: list([]),
              reviewTasks: list([]),
              reviewProjects: { projects: [] },
              remaining: null,
            },
          },
        }),
      );
      await page.route("**/api/tools/list_items", (route) =>
        route.fulfill({ json: list(yearTasks) }),
      );
      await page.goto("/");
      const dates = page.locator(".date-chip:visible");
      await expect(dates).toHaveText([
        "Dec 30",
        "Jun 30, 2027",
        "Jun 30, 2028",
        "Overdue: Jun 30, 2025",
      ]);
      for (const row of await page.locator(".task-swipe-row:visible").all())
        await contained(row);
      const focus = page.getByRole("region", {
        name: "Next action",
        exact: true,
      });
      expect(
        await focus.locator(".date-chip").evaluate((date) => {
          const r = date.getBoundingClientRect(),
            row = date.closest(".task-swipe-front")!.getBoundingClientRect();
          return Math.abs(r.y + r.height / 2 - row.y - row.height / 2);
        }),
      ).toBeLessThan(1);
      await page.screenshot({ path: info.outputPath("home-dates.png") });
      await page.goto("/tasks?status=next");
      await expect(dates).toHaveCount(4);
      for (const row of await page.locator(".task-swipe-row:visible").all())
        await contained(row);
      await expect(dates.nth(3)).toHaveAttribute("data-overdue", "true");
      expect(await dates.nth(3).locator("time").ariaSnapshot()).toContain(
        "Overdue:",
      );
      await page.screenshot({ path: info.outputPath("next-dates.png") });
    });

test("completed and archived dates stay neutral; deleted rows remain hidden", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-10T18:00:00Z") });
  const tasks = [
    task("Done", "2020-01-01", { status: "done" }),
    task("Archived", "2020-01-01", { archived: true }),
    task("Deleted", "2020-01-01", { deleted: true }),
  ];
  await page.route("**/api/tools/list_items", (route) =>
    route.fulfill({
      json: { items: tasks, history: [], next_cursor: null, next_offset: null },
    }),
  );
  await page.goto("/tasks?view=all&include_deleted=true");
  const dates = page.locator(".date-chip:visible");
  await expect(dates).toHaveCount(2);
  await expect(dates).toHaveText(["Jan 1, 2020", "Jan 1, 2020"]);
  await expect(
    page.locator('.date-chip[data-overdue="true"]:visible'),
  ).toHaveCount(0);
});

test("repeated DST hour respects the stored offset", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-01T06:00:00Z") });
  const { frame } = await openWidget(page, {
    width: 1280,
    tasks: [-240, -300].map((offset) =>
      task(`Offset ${offset}`, "2026-11-01", {
        deadline_time: {
          time: "01:30",
          timezone: "America/New_York",
          utc_offset_minutes: offset,
        },
      }),
    ),
  });
  await expect(frame.locator(".date-chip:visible").nth(0)).toHaveAttribute(
    "data-overdue",
    "true",
  );
  await expect(frame.locator(".date-chip:visible").nth(1)).not.toHaveAttribute(
    "data-overdue",
    "true",
  );
});
