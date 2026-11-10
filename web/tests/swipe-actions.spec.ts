import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { openWidget, title as widgetTitle } from "./helpers/widget-host";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const longTitle =
  "Prepare the application and check the supporting documents before the meeting";
const task = (id: string, title: string) => ({
  id,
  title,
  notes:
    "### Prepare\n\n" +
    "Read the supporting documents and choose the next action.\n\n".repeat(20),
  status: "next",
  archived: false,
  deleted: false,
  version: 1,
  last_change_id: 1,
  due_date: null,
  links: [],
});
async function fixture(page: Page) {
  let tasks: any[] = [
    task("swipe-a", "Read the proposal"),
    task("swipe-b", longTitle),
  ];
  const writes: any[] = [];
  const reads: any[] = [];
  let failed = false;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  await page.route("**/api/tools/*", async (route) => {
    const name = route.request().url().split("/").at(-1);
    const args = route.request().postDataJSON();
    if (name === "list_items") {
      reads.push(args);
      if (args.blocked_by_id) return route.fulfill({ json: { items: [], next_cursor: null } });
      const items = tasks.filter((t) =>
        args.task_id
          ? t.id === args.task_id
          : (!args.status || args.status === t.status) &&
            (args.archived ? t.archived : !t.archived) &&
            (!args.review_on || t.review_date),
      );
      return route.fulfill({
        json: { items, next_cursor: null, next_offset: null },
      });
    }
    if (name === "list_projects")
      return route.fulfill({ json: { projects: [], next_cursor: null } });
    if (name === "update_item") {
      writes.push(args);
      if (gate) await gate;
      if (failed)
        return route.fulfill({
          status: 409,
          json: {
            code: "conflict",
            message: "Task changed. Review the current version.",
          },
        });
      const before = tasks.find((t) => t.id === args.task_id);
      const after = {
        ...before,
        ...args,
        version: before.version + 1,
        last_change_id: 2,
      };
      tasks = tasks.map((t) => (t.id === args.task_id ? after : t));
      return route.fulfill({
        json: {
          task: after,
          change: { id: 2, operation: name, task_id: after.id, before, after },
          replayed: false,
        },
      });
    }
    throw new Error(`Unexpected tool ${name}`);
  });
  await page.goto("/tasks?archived=false&view=all");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .locator(".gtd-sidebar:visible")
    .getByRole("button", { name: "All tasks", exact: true })
    .click();
  await expect(page.locator(".gtd-main:visible")).not.toHaveAttribute("inert");
  await expect
    .poll(() =>
      page
        .locator(".gtd-sidebar:visible")
        .evaluate((el) => el.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(
    page.getByRole("button", {
      name: "Details: Read the proposal",
      exact: true,
    }),
  ).toBeVisible();
  return {
    writes,
    reads,
    fail() {
      failed = true;
    },
    hold() {
      gate = new Promise((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      gate = undefined;
    },
    tasks() {
      return tasks;
    },
  };
}
const rows = (page: Page) => page.locator(".gtd-main:visible .task-swipe-row");
const actions = (row: Locator) => row.locator(".task-swipe-actions");
async function swipe(
  row: Locator,
  dx = -110,
  dy = 0,
  end = "touchend",
  x = 230,
) {
  await row.evaluate(
    async (el, { dx, dy, end, x }) => {
      for (const [name, progress] of [
        ["touchstart", 0],
        ["touchmove", 0.3],
        ["touchmove", 0.7],
        [end, 1],
      ] as const) {
        if (progress === 1) {
          const move = new Event("touchmove", {
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(move, "touches", {
            value: [{ clientX: x + dx, clientY: 200 + dy }],
          });
          el.dispatchEvent(move);
        }
        const event = new Event(name, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", {
          value:
            progress === 1
              ? []
              : [{ clientX: x + dx * progress, clientY: 200 + dy * progress }],
        });
        el.dispatchEvent(event);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      }
    },
    { dx, dy, end, x },
  );
}
async function reveal(row: Locator) {
  await swipe(row);
  await expect(row).toHaveAttribute("data-swipe-open", "true");
  await expect(row.locator(".task-swipe-front")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, -144, 0)",
  );
}
async function closed(row: Locator) {
  await expect(row).not.toHaveAttribute("data-swipe-open");
  await expect(row.locator(".task-swipe-front")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );
}
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("left swipe reveals labelled actions without changing layout or writing", async ({
  page,
}, info) => {
  const state = await fixture(page);
  const row = rows(page).first();
  const before = await row.boundingBox();
  await expect(actions(row)).toHaveAttribute("inert");
  await expect(
    row.getByRole("button", { name: "Archive", exact: true }),
  ).toHaveCount(0);
  await reveal(row);
  expect(await row.boundingBox()).toEqual(before);
  expect(state.writes).toHaveLength(0);
  for (const name of ["Edit", "Archive"]) {
    const button = actions(row).getByRole("button", { name, exact: true });
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
    await page.screenshot({
    path: test.info().outputPath(`${info.project.name}-website-light.png`),
  });
  await swipe(row, 100);
  await closed(row);
  await expect(
    row.getByRole("button", { name: "Archive", exact: true }),
  ).toHaveCount(0);
});

test("only one row opens; outside press, Escape and scrolling dismiss it", async ({
  page,
}) => {
  await fixture(page);
  const first = rows(page).first(),
    second = rows(page).nth(1);
  await reveal(first);
  await reveal(second);
  await closed(first);
  await actions(second)
    .getByRole("button", { name: "Edit", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await closed(second);
  await expect(second.locator(".task-title")).toBeFocused();
  await reveal(first);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await closed(first);
  await page
    .locator(".gtd-sidebar:visible")
    .getByRole("button", { name: "Close navigation", exact: true })
    .click();
  await expect(page.locator(".gtd-main:visible")).not.toHaveAttribute("inert");
  await reveal(first);
  await page.locator(".gtd-main:visible").dispatchEvent("scroll");
  await closed(first);
});

test("vertical, diagonal, short, cancelled and edge gestures do not reveal or write", async ({
  page,
}) => {
  const state = await fixture(page);
  const row = rows(page).first();
  for (const [dx, dy, end, x] of [
    [-8, 0, "touchend", 230],
    [-22, 55, "touchend", 230],
    [0, -90, "touchend", 230],
    [-100, 0, "touchcancel", 230],
    [-100, 0, "touchend", 15],
    [-100, 0, "touchend", 385],
  ] as const) {
    await swipe(row, dx, dy, end, x);
    await closed(row);
  }
  const before = state.reads.length;
  await swipe(row, 0, 180);
  await expect.poll(() => state.reads.length).toBeGreaterThan(before);
  await closed(row);
  expect(state.writes).toHaveLength(0);
});

test("a long swipe never archives; the synthetic end-click cannot open details", async ({
  page,
}) => {
  const state = await fixture(page);
  const row = rows(page).first();
  await swipe(row, -210);
  await expect(row).toHaveAttribute("data-swipe-open", "true");
  await row.locator(".task-title").dispatchEvent("click", { detail: 1 });
  await expect(row.locator(".task-title")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(state.writes).toHaveLength(0);
});

test("archive and unarchive use existing versioned task updates", async ({
  page,
}) => {
  const state = await fixture(page);
  await reveal(rows(page).first());
  await actions(rows(page).first())
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    task_id: "swipe-a",
    expected_version: 1,
    archived: true,
  });
  expect(state.writes[0].request_id).toBeTruthy();
  expect(state.writes[0]).not.toHaveProperty("status");
  await expect(
    page.getByRole("button", {
      name: "Details: Read the proposal",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .locator(".gtd-sidebar:visible")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await reveal(rows(page).first());
  await actions(rows(page).first())
    .getByRole("button", { name: "Unarchive", exact: true })
    .click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toMatchObject({
    task_id: "swipe-a",
    expected_version: 2,
    archived: false,
  });
});

test("edit opens the existing editor and draft blocks further swipes", async ({
  page,
}) => {
  await fixture(page);
  await reveal(rows(page).first());
  await actions(rows(page).first())
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Title", exact: true });
  await expect(editor).toBeVisible();
  await editor.fill("Keep this draft");
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  await swipe(rows(page).first());
  await closed(rows(page).first());
  await expect(editor).toHaveValue("Keep this draft");
});

for (const expanded of [false, true]) {
  test(`ChatGPT ${expanded ? "fullscreen" : "preview"} reveals actions, then expands to edit`, async ({
    page,
  }, info) => {
    const { frame, surface, requests } = await openWidget(page, {
      long: false,
      theme: "dark",
    });
    if (expanded)
      await frame
        .getByRole("button", { name: "Expand view", exact: true })
        .click();
    const row = frame.locator(".task-swipe-row").first();
    if (!expanded)
      await expect
        .poll(() =>
          surface.evaluate((el) =>
            Math.abs(
              el.getBoundingClientRect().height -
                el.querySelector(".widget-content")!.getBoundingClientRect()
                  .height -
                2,
            ),
          ),
        )
        .toBeLessThan(1);
    await expect
      .poll(() =>
        surface.evaluate(
          (el) =>
            el.getAnimations().filter((a) => a.playState === "running").length,
        ),
      )
      .toBe(0);
    const height = (await surface.boundingBox())!.height;
    await reveal(row);
    expect((await surface.boundingBox())!.height).toBe(height);
    await page.screenshot({
      path: test.info().outputPath(`${info.project.name}-${expanded ? "fullscreen" : "preview"}-dark.png`),
    });
    await actions(row)
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await expect(surface).toHaveAttribute("data-display", "fullscreen");
    await expect(
      frame.getByRole("textbox", { name: "Title", exact: true }),
    ).toHaveValue(widgetTitle);
    expect(
      (await requests("tools/call")).filter(
        (r) => r.params.name === "update_item",
      ),
    ).toHaveLength(0);
  });
}

test("expanded descriptions stay still and selectable; reduced motion closes immediately", async ({
  page,
}) => {
  await fixture(page);
  const row = rows(page).first();
  await row.locator(".task-title").click();
  const details = page.getByRole("region", {
    name: "Task information: Read the proposal",
    exact: true,
  });
  await expect(details).toBeVisible();
  await expect(details.locator(".task-markdown")).toContainText("Read the supporting documents");
  await expect(
    page.locator(".gtd-main:visible .task-expansion[data-resizing]"),
  ).toHaveCount(0);
  const before = await details.boundingBox();
  await reveal(row);
  expect(await details.boundingBox()).toEqual(before);
  await swipe(details);
  await closed(row);
  await reveal(row);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Escape");
  await expect(row.locator(".task-swipe-front")).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await closed(row);
});

test("an unconfirmed swipe archive retries the same write and survives display changes", async ({
  page,
}) => {
  const { frame, surface, requests, changeMode } = await openWidget(page, {
    long: false,
    uncertainWrite: true,
  });
  const row = frame.locator(".task-swipe-row").first();
  await reveal(row);
  await changeMode("fullscreen");
  await expect(surface).toHaveAttribute("data-display", "fullscreen");
  await closed(row);
  await reveal(row);
  await actions(row)
    .getByRole("button", { name: "Archive", exact: true })
    .tap();
  const writes = async () =>
    (await requests("tools/call")).filter(
      (r) => r.params.name === "update_item",
    );
  await expect.poll(async () => (await writes()).length).toBe(2);
  const attempts = await writes();
  expect(attempts[1].params.arguments).toEqual(attempts[0].params.arguments);
  expect(attempts[0].params.arguments).toMatchObject({
    archived: true,
    expected_version: 1,
  });
  expect(attempts[0].params.arguments.request_id).toBeTruthy();
  await expect(
    frame.getByRole("button", {
      name: "Resolve save: " + widgetTitle,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    frame.getByRole("button", { name: "Undo last change", exact: true }),
  ).toBeVisible();
});

test("rejected archive actions cannot be repeated by swiping", async ({
  page,
}) => {
  const state = await fixture(page);
  try {
    state.hold();
    state.fail();
    await reveal(rows(page).first());
    await actions(rows(page).first())
      .getByRole("button", { name: "Archive", exact: true })
      .tap();
    await expect.poll(() => state.writes.length).toBe(1);
    state.release();
    const row = rows(page).first();
    await expect(
      page.getByRole("button", {
        name: "Resolve save: Read the proposal",
        exact: true,
      }),
    ).toBeVisible();
    await swipe(row);
    await closed(row);
    expect(state.writes).toHaveLength(1);
    await page
      .getByRole("button", {
        name: "Resolve save: Read the proposal",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Task changed. Review the current version.", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    state.release();
  }
});

test("touch selection, multi-touch and mouse dragging leave tasks alone", async ({
  page,
}) => {
  const state = await fixture(page);
  const row = rows(page).first();
  await row.locator(".task-title").click();
  await expect(
    page.locator(".gtd-main:visible .task-expansion[data-resizing]"),
  ).toHaveCount(0);
  await page
    .locator(".gtd-main:visible .task-disclosure p")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
  expect(
    await page.evaluate(() => window.getSelection()!.toString()),
  ).toBeTruthy();
  await swipe(row);
  await closed(row);
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await reveal(row);
  await row.evaluate((el) => {
    const event = new Event("touchstart", { bubbles: true });
    Object.defineProperty(event, "touches", {
      value: [
        { clientX: 100, clientY: 200 },
        { clientX: 150, clientY: 200 },
      ],
    });
    el.dispatchEvent(event);
  });
  await closed(row);
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 20, { steps: 8 });
  await page.mouse.up();
  await closed(row);
  expect(state.writes).toHaveLength(0);
});

test("closed actions do not bleed through card corners", async ({ page }) => {
  await fixture(page);
  const row = rows(page).nth(1);
  await reveal(row);
  await swipe(row, 100);
  await closed(row);
  await expect(actions(row)).toHaveCSS("visibility", "hidden");
  const withActions = await row.screenshot({ animations: "disabled" });
  await actions(row).evaluate(
    (el) => ((el as HTMLElement).style.display = "none"),
  );
  expect(
    (await row.screenshot({ animations: "disabled" })).equals(withActions),
  ).toBe(true);
});

test("a narrow expanded card keeps the sticky header opaque when actions open", async ({
  page,
}, info) => {
  const { frame, surface, scroll } = await openWidget(page, { width: 320 });
  await frame
    .getByRole("button", { name: `Details: ${widgetTitle}`, exact: true })
    .click();
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(surface).toHaveAttribute("data-display", "fullscreen");
  await expect(frame.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  await scroll.evaluate((el) => (el.scrollTop = 400));
  const row = frame.locator(".task-swipe-row").first();
  const before = await row.boundingBox();
  await reveal(row);
  expect(await row.boundingBox()).toEqual(before);
  await expect
    .poll(() => row.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBe(true);
  const visible = await page.screenshot({
    clip: before!,
    animations: "disabled",
  });
  const details = frame.locator(".task-expansion").first();
  await details.evaluate(
    (el) => ((el as HTMLElement).style.visibility = "hidden"),
  );
  expect(
    (await page.screenshot({ clip: before!, animations: "disabled" })).equals(
      visible,
    ),
  ).toBe(true);
  await details.evaluate((el) =>
    (el as HTMLElement).style.removeProperty("visibility"),
  );
  await page.screenshot({
    path: test.info().outputPath(`${info.project.name}-sticky-320.png`),
  });
});

test("native Chromium touch input reveals, closes and preserves vertical scrolling", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "CDP native touch injection is Chromium-only; WebKit uses frame-separated touch events.",
  );
  const state = await fixture(page);
  const row = rows(page).first();
  const client = await page.context().newCDPSession(page);
  async function nativeSwipe(x: number, y: number, dx: number, dy: number) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 8; step++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * step) / 8, y: y + (dy * step) / 8 }],
      });
      await page.waitForTimeout(16);
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  const box = (await row.boundingBox())!;
  await nativeSwipe(box.x + 200, box.y + box.height / 2, -110, 0);
  await expect(row).toHaveAttribute("data-swipe-open", "true");
  // Start on the revealed action strip and swipe right without invoking it.
  await nativeSwipe(box.x + 185, box.y + box.height / 2, 95, 0);
  await closed(row);
  expect(state.writes).toHaveLength(0);
  await row.locator(".task-title").tap();
  await expect(
    page.locator(".gtd-main:visible .task-expansion[data-resizing]"),
  ).toHaveCount(0);
  await nativeSwipe(210, 550, 3, -220);
  await expect
    .poll(() =>
      page.evaluate(() => window.scrollY),
    )
    .toBeGreaterThan(100);
  await closed(row);
  await client.detach();
});
