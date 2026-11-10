import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";

test.use({ reducedMotion: "reduce" });

const tasks = Array.from({ length: 14 }, (_, i) => ({
  id: `overlay-${i}`,
  title: i ? `Next step ${i}` : "Prepare the workshop",
  status: "next",
  brief: "Prepare everything needed for the workshop.",
  importance:"normal",estimated_minutes:30,effort:"medium",archived:false,
  notes:
    "Review the brief and confirm the equipment.\nBring the printed checklist and your ID.",
  links: [{ label: "Workshop brief", url: "https://example.com/brief" }],
  location: "Library, 10 Main St",
  version: 1,
  last_change_id: i + 1,
  deleted: false,
  due_date: null,
}));
const list = (items = tasks) => ({
  items,
  history: [],
  next_offset: null,
  next_history_after: null,
});
async function website(page: Page) {
  await page.route("**/api/view", (route) => route.fulfill({
    json: { data: {
      next: list(tasks), waiting: list([]), someday: list([]),
      reviewTasks: list([]), reviewProjects: { projects: [] }, remaining: null,
    } },
  }));
  await page.route("**/api/tools/activity_summary", (route) => route.fulfill({
    json: { has_history: false,days:[],categories:{},total:0,automatic_count:0,snapshot:"fixture",window:{timezone:"America/New_York"} },
  }));
  await page.route("**/api/tools/list_items", (route) => {
    const args = route.request().postDataJSON();
    return route.fulfill({
      json: list(
        args.status === "someday" || args.blocked_by_id
          ? []
          : args.task_id
            ? tasks.filter((t) => t.id === args.task_id)
            : tasks,
      ),
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", {
      name: "Details: Prepare the workshop",
      exact: true,
    }),
  ).toBeVisible();
}
async function rect(locator: Locator) {
  return locator.evaluate((e) => e.getBoundingClientRect().toJSON());
}
async function fits(
  panel: Locator,
  width: number,
  height: number,
  top = 0,
  bottom = 0,
) {
  const b = await rect(panel);
  expect(b.x).toBeGreaterThanOrEqual(7);
  expect(b.right).toBeLessThanOrEqual(width - 7);
  expect(b.y).toBeGreaterThanOrEqual(top + 7);
  expect(b.bottom).toBeLessThanOrEqual(height - bottom - 7);
  // A visible bounding box isn't enough: the panel must win hit testing.
  expect(
    await panel.evaluate((e) => {
      const b = e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(b.left + 20, b.top + 20));
    }),
  ).toBeTruthy();
}
for (const mobile of [false, true]) {
  test.describe(mobile ? "phone overlays" : "desktop overlays", () => {
    test.use({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      hasTouch: mobile,
      isMobile: mobile,
    });
    test("task menu holds content still, dismisses, and supports keyboard navigation", async ({
      page,
    }) => {
      await website(page);
      if (mobile)
        await page.evaluate(() => {
          document.documentElement.style.setProperty("--safe-top", "44px");
          document.documentElement.style.setProperty("--safe-bottom", "34px");
        });
      const card = page.locator(".home-focus");
      await card.getByRole("button", { name: /^Details:/ }).click();
      const notes = card.locator(".task-markdown");
      const trigger = card.getByRole("button", {
        name: "More options: Prepare the workshop",
      });
      await expect(notes).toContainText("Review the brief");
      await expect(page.locator("[data-resizing=true]")).toHaveCount(0);
      const before = {
        card: await rect(card),
        notes: await rect(notes),
        scroll: await page.locator(".gtd-main").evaluate((e) => e.scrollHeight),
      };
      await trigger.click();
      const menu = page.getByRole("menu", { name: "Task menu" });
      await expect(menu).toBeVisible();
      expect(await rect(card)).toEqual(before.card);
      expect(await rect(notes)).toEqual(before.notes);
      expect(
        await page.locator(".gtd-main").evaluate((e) => e.scrollHeight),
      ).toBe(before.scroll);
      await fits(
        menu,
        mobile ? 390 : 1280,
        mobile ? 844 : 900,
        mobile ? 44 : 0,
        mobile ? 34 : 0,
      );
      await expect(
        menu.getByRole("menuitem", { name: "Details", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        menu.getByRole("menuitem", { name: "Edit", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("End");
      await expect(
        menu.getByRole("menuitem", { name: "Archive", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      // Notes may be covered by the correctly floating menu on a phone.
      await page.getByRole("heading", { name: "Home", exact: true }).click();
      await expect(menu).toHaveCount(0);
      // An actual outside scroll gesture dismisses; automatic anchoring does not.
      await expect(page.locator(".task-expansion[data-resizing]")).toHaveCount(
        0,
      );
      await trigger.click();
      if (mobile) await notes.dispatchEvent("touchmove");
      else {
        await notes.hover({ position: { x: 8, y: 8 } });
        await page.mouse.wheel(0, 120);
      }
      await expect(menu).toHaveCount(0);
      await page.evaluate(() => window.scrollTo(0, 0));
      await trigger.click();
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: test
          .info()
          .outputPath(`${mobile ? "phone" : "desktop"}-menu.png`),
      });
    });
    test("filters and add-detail are overlays; draft and focus survive dismissal", async ({
      page,
    }) => {
      await website(page);
      if (mobile)
        await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .getByRole("button", { name: "All tasks", exact: true })
        .click();
      const first = page.locator(".compact-row").first();
      const before = await rect(first);
      const filter = page.getByRole("button", {
        name: /^Sort and filter tasks/,
      });
      await filter.click();
      const panel = page.getByRole("dialog", { name: "Sort and filter tasks" });
      await expect(panel).toBeVisible();
      expect(await rect(first)).toEqual(before);
      await fits(panel, mobile ? 390 : 1280, mobile ? 844 : 900);
      await panel
        .getByRole("combobox", { name: "Maximum effort" })
        .selectOption("low");
      await expect(panel).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(filter).toBeFocused();
      await expect(panel).toHaveCount(0);
      await page
        .getByRole("button", { name: "More options: Prepare the workshop" })
        .click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      const editor = page.getByRole("region", {
        name: "Task details",
        exact: true,
      });
      await editor
        .getByRole("textbox", { name: "Title", exact: true })
        .fill("A retained draft");
      const add = editor.getByRole("button", {
        name: "Add detail",
        exact: true,
      });
      await add.scrollIntoViewIfNeeded();
      const beforeAdd = await rect(add);
      await add.click();
      const menu = page.getByRole("menu", { name: "Add detail" });
      await expect(menu).toBeVisible();
      expect(await rect(add)).toEqual(beforeAdd);
      await fits(menu, mobile ? 390 : 1280, mobile ? 844 : 900);
      await page.keyboard.press("Escape");
      await expect(add).toBeFocused();
      await expect(editor).toBeVisible();
      await expect(
        editor.getByRole("textbox", { name: "Title", exact: true }),
      ).toHaveValue("A retained draft");
      await add.click();
      await menu.getByRole("menuitem", { name: "Link", exact: true }).click();
      await expect(
        editor.getByRole("textbox", { name: "Link 2 URL", exact: true }),
      ).toBeVisible();
    });
  });
}

test("near-bottom menus flip, reposition on resize, and scroll without moving the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await website(page);
  const trigger = page.getByRole("button", {
    name: "More options: Next step 3",
    exact: true,
  });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.evaluate(async (e) => {
    window.scrollBy(0, e.getBoundingClientRect().bottom - (innerHeight - 110));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const anchor = await rect(trigger);
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Task menu" });
  await expect(menu).toHaveAttribute("data-placement", "top");
  expect(await rect(trigger)).toEqual(anchor);
  await fits(menu, 720, 480);
  await page.setViewportSize({ width: 360, height: 480 });
  await expect(menu).toBeVisible();
  await expect
    .poll(async () => (await rect(menu)).right)
    .toBeLessThanOrEqual(353);
  await fits(menu, 360, 480);
});

for (const count of [1, 5]) {
  test(`widget with ${count} tasks overlays without moving rows; host height settles and restores`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: count === 1 ? "no-preference" : "reduce",
    });
    const html = await readFile("dist/widget-adapter.html", "utf8");
    await page.route("**/__overlay-card", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body><p style='height:700px'>Conversation</p><button id='outside'>Outside card</button></body>",
      }),
    );
    await page.goto("/__overlay-card");
    await page.evaluate(
      ({ html, tasks }) => {
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.style.cssText = "width:360px;height:60px;border:0;display:block";
        (window as any).sizes = [];
        window.addEventListener("message", (event) => {
          if (event.source !== iframe.contentWindow) return;
          const m = event.data;
          const send = (v: any) =>
            iframe.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
          if (m.method === "ui/initialize")
            send({ id: m.id, result: { hostContext: { theme: "dark" } } });
          if (m.method === "ui/notifications/initialized") {
            send({
              method: "ui/notifications/tool-input",
              params: {
                arguments: tasks.length === 1 ? { task_id: tasks[0].id } : {},
              },
            });
            send({
              method: "ui/notifications/tool-result",
              params: {
                structuredContent: {
                  items: tasks,
                  history: [],
                  next_offset: null,
                  next_history_after: null,
                },
              },
            });
          }
          if (m.method === "ui/notifications/size-changed") {
            (window as any).sizes.push(m.params.height);
          }
          if (
            m.method === "ui/notifications/size-changed" ||
            m.method === "fixture/auto-size"
          ) {
            iframe.style.height = `${m.params.height}px`;
          }
        });
        // The live sandbox also sizes its root surface independently of hints.
        iframe.srcdoc = html.replace(
          '<div id="root"></div>',
          '<div id="root"></div><script>const surface=document.getElementById("root");new ResizeObserver(()=>parent.postMessage({method:"fixture/auto-size",params:{height:Math.ceil(surface.getBoundingClientRect().height)}},"*")).observe(surface);</script>',
        );
        document.body.append(iframe);
      },
      { html, tasks: tasks.slice(0, count) },
    );
    const card = page.frameLocator("iframe");
    const trigger = card.getByRole("button", {
      name: "More options: Prepare the workshop",
    });
    await expect(trigger).toBeVisible();
    await expect.poll(async () => (await rect(card.locator(".widget-surface"))).height - (await rect(card.locator(".compact-row").first())).bottom).toBeGreaterThanOrEqual(0);
    await expect.poll(() => card.locator(".widget-surface").evaluate(el => el.getAnimations().some(animation => animation.playState === "running"))).toBe(false);
    const before = await rect(card.locator(".compact-row").first());
    const height = Math.ceil((await rect(card.locator("#root"))).height);
    await expect
      .poll(async () => (await rect(page.locator("iframe"))).height)
      .toBe(height);
    const sizeStart = await page.evaluate(() => (window as any).sizes.length);
    await trigger.click();
    const menu = card.getByRole("menu", { name: "Task menu" });
    await expect(menu).toBeVisible();
    await expect
      .poll(async () => (await rect(menu)).height)
      .toBeGreaterThan(120);
    expect(await rect(card.locator(".compact-row").first())).toEqual(before);
    await expect
      .poll(async () =>
        Math.abs(
          (await rect(page.locator("iframe"))).height -
            Math.ceil((await rect(card.locator("body"))).height),
        ),
      )
      .toBeLessThanOrEqual(1);
    const steps: number[] = await page.evaluate(
      (start) => (window as any).sizes.slice(start),
      sizeStart,
    );
    if (count === 1) {
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every((n, i) => !i || n >= steps[i - 1])).toBeTruthy();
    } else expect(steps.length).toBeLessThanOrEqual(2);
    await fits(menu, 360, (await rect(page.locator("iframe"))).height);
    await expect.poll(() => card.locator(".widget-surface").evaluate(el => el.getAnimations().some(animation => animation.playState === "running"))).toBe(false);
    expect(
      Math.abs(
        (await rect(card.locator("#root"))).height -
          (await rect(card.locator("body"))).height,
      ),
    ).toBeLessThanOrEqual(1);
    // An opaque widget cannot scroll its cross-origin conversation. The host
    // owns that viewport. Scrolling the conversation must keep its menu open.
    await page.mouse.move(900, 400);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(async () => {
        const iframe = await rect(page.locator("iframe"));
        return iframe.y + (await rect(menu)).bottom;
      })
      .toBeLessThanOrEqual(1000);
    await expect(menu).toBeVisible();
    await expect.poll(() => card.locator(".widget-surface").evaluate(el => el.getAnimations().some(animation => animation.playState === "running"))).toBe(false);
    const notifications = await page.evaluate(
      () => (window as any).sizes.length,
    );
    await page.waitForTimeout(200);
    expect(
      await page.evaluate(() => (window as any).sizes.length),
    ).toBeLessThanOrEqual(notifications + 1);
    await page.screenshot({
      path: test.info().outputPath(`card-${count}-menu.png`),
    });
    const closeStart = await page.evaluate(() => (window as any).sizes.length);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect
      .poll(async () => (await rect(page.locator("iframe"))).height)
      .toBe(height);
    const collapse: number[] = await page.evaluate(
      (start) => (window as any).sizes.slice(start),
      closeStart,
    );
    if (count === 1) {
      expect(collapse.length).toBeGreaterThan(0);
      expect(collapse.every((n, i) => !i || n <= collapse[i - 1])).toBeTruthy();
    }
    await trigger.click();
    await page.getByRole("button", { name: "Outside card" }).click();
    await expect(menu).toHaveCount(0);
    await trigger.click();
    await expect
      .poll(async () =>
        Math.abs(
          (await rect(page.locator("iframe"))).height -
            Math.ceil((await rect(card.locator("body"))).height),
        ),
      )
      .toBeLessThanOrEqual(1);
    // A bounded menu may scroll when the remaining host viewport is short.
    // Its actions must remain reachable rather than forcing more host height.
    await expect(menu).toHaveCSS("overflow-y", "auto");
    await menu.locator('[role="menuitem"]').last().scrollIntoViewIfNeeded();
    // Reopening after the outside button may have scrolled the short host back
    // to its top. Reveal the expanded frame as a conversation user would.
    await page.mouse.move(900, 400);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(async () => {
        const iframe = await rect(page.locator("iframe"));
        return iframe.y + (await rect(menu)).bottom;
      })
      .toBeLessThanOrEqual(1000);
    await menu.press("Escape");
    if (
      await card.getByRole("button", { name: "Show list controls" }).isVisible()
    )
      await card.getByRole("button", { name: "Show list controls" }).click();
    const filters = card.getByRole("button", {
      name: "Sort and filter tasks",
      exact: true,
    });
    await filters.click();
    const options = card.getByRole("dialog", { name: "Sort and filter tasks" });
    await expect(options).toBeVisible();
    expect(await rect(card.locator(".compact-row").first())).toEqual(before);
    await expect
      .poll(async () => (await rect(options)).height)
      .toBeGreaterThan(150);
    await expect
      .poll(() =>
        card
          .locator(".widget-surface")
          .evaluate((el) =>
            el
              .getAnimations()
              .some((animation) => animation.playState === "running"),
          ),
      )
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await rect(options)).bottom -
          (await rect(page.locator("iframe"))).height,
      )
      .toBeLessThanOrEqual(-7);
    await fits(options, 360, (await rect(page.locator("iframe"))).height);
    expect(
      await options.evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(options).toHaveCount(0);
    await expect(filters).toBeFocused();
  });
}

test("constrained menus scroll independently and switching tasks leaves only one menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 290 });
  await website(page);
  const trigger = page.getByRole("button", {
    name: "More options: Prepare the workshop",
    exact: true,
  });
  const original = await rect(trigger);
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Task menu" });
  await expect(menu).toBeVisible();
  await fits(menu, 390, 290);
  expect(
    await menu.evaluate((e) => e.scrollHeight > e.clientHeight),
  ).toBeTruthy();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toBeFocused();
  expect(await rect(trigger)).toEqual(original);
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await page
    .getByRole("button", { name: "More options: Next step 5", exact: true })
    .click();
  await expect(menu).toHaveCount(1);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
});

test("automatic website scroll repositions a menu; intentional scrolling dismisses it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await website(page);
  const trigger = page.getByRole("button", {
    name: "More options: Next step 3",
    exact: true,
  });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Task menu" });
  await expect(menu).toBeVisible();
  const before = await trigger.boundingBox();
  await page.evaluate(() => window.scrollBy(0, 20));
  await expect
    .poll(async () => (await trigger.boundingBox())?.y)
    .toBe(before!.y - 20);
  // A tall menu can remain clamped to the viewport while its anchor moves.
  await fits(menu, 720, 480);
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await trigger.click();
  // Use the page gutter, not a coordinate the repositioned menu can occupy.
  await page.mouse.move(4, 120);
  await page.mouse.wheel(0, 40);
  await expect(menu).toHaveCount(0);
});
