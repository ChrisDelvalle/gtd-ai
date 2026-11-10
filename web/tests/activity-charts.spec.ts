import { test, expect, type Page, type FrameLocator, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

async function selectChart(page: Page | FrameLocator, mode: "heatmap" | "bars" | "priorities") {
  await page.getByRole("button", {name: /^Chart: /}).click();
  await page.getByRole("menuitemradio", {name: {heatmap: "Heatmap", bars: "Bar Chart", priorities: "Priorities"}[mode], exact: true}).click();
  expect(await page.getByRole("button", {name: /^Chart: /}).evaluate(e => getComputedStyle(e).outlineStyle)).toBe("none");
}

async function expectPriorityFills(chart: Locator) {
  const fills = await chart.locator(".priority-square:enabled").evaluateAll(cells =>
    cells.map(cell => getComputedStyle(cell).backgroundColor));
  expect(fills).not.toContain("rgba(0, 0, 0, 0)");
  expect(new Set(fills).size).toBeGreaterThan(1);
}

function middleSquareOffsetFromPane(chart: Locator) {
  return chart.locator(".priority-square").nth(3).evaluate(square => {
    const box = square.getBoundingClientRect();
    const pane = square.closest(".gtd-main")!.getBoundingClientRect();
    return box.left + box.width / 2 - (pane.left + pane.width / 2);
  });
}

async function verticalGesture(page: Page, browserName: string, x: number, y: number, dy: number) {
  if (browserName !== "chromium") {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -dy);
    return;
  }
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y}]});
    for (let i = 1; i <= 4; i++) {
      await client.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x, y: y + dy * i / 4}]});
      await page.waitForTimeout(12);
    }
    await client.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
  } finally {
    await client.detach();
  }
}

test("Priorities groups project tasks, freezes drilldowns and keeps warm counts visible", async ({page, request, baseURL}, info) => {
  const call = async (operation: string, data: object) => {
    const response = await request.post(`/api/tools/${operation}`, {
      data, headers: { Origin: baseURL!, "X-GTD-Request": "1" },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const {project} = await call("create_project", {
    title: "Priority fixture project", brief: "Check priority filters.", reason: "Disposable chart fixture", request_id: randomUUID(),
  });
  const add = async (title: string, fields = {}) => (await call("capture_item", {
    title, status: "next", project_id: project.id, importance: "very_high", due_date: "2020-11-05",
    brief: "Verify the exact task opens.", notes: "Priority fixture body.",
    estimated_minutes: 10, effort: "low", reason: "Disposable chart fixture", request_id: randomUUID(), ...fields,
  })).task;
  const first = await add("Priority task one");
  const second = await add("Priority task two");
  await add("Priority someday", {status: "someday"});
  await add("Priority archived", {archived: true});
  await add("Priority completed", {status: "done"});
  await add("Priority review only", {due_date: null, review_date: "2020-01-01"});
  await add("Priority missed block", {
    due_date: null, importance: "high", work_blocks: [{
      start: {date: "2020-11-05", time: "14:15", timezone: "America/New_York"},
      finish: {date: "2020-11-05", time: "15:00", timezone: "America/New_York"},
    }],
  });
  const blocker = await add("Priority shared prerequisite", {importance: "unimportant", due_date: null});
  await add("Priority critical outcome", {
    importance: "critical", due_date: null, project_id: null, blocked_by: [blocker.id],
  });
  await add("Priority early deadline", {
    importance: "normal", project_id: null, blocked_by: [blocker.id],
  });
  const snapshot = await call("priority_grid", {project: project.id});
  expect(snapshot.counts[5][6]).toMatchObject({next: 2, someday: 1});
  const args = {project: project.id, snapshot: snapshot.snapshot, cell: {importance: "very_high", urgency: "overdue"}, limit: 1};
  const firstPage = await call("priority_grid", args);
  expect(firstPage.items.map((task: any) => task.id)).toEqual([first.id]);

  await page.setViewportSize({width: 1440, height: 760});
  await page.goto("/");
  await selectChart(page, "priorities");
  await expect(page.getByRole("button", { name: "Chart: Priorities" })).toBeFocused();
  await page.getByRole("button", { name: "Project: Any project" }).click();
  await page.getByRole("menuitemradio", { name: "Priority fixture project", exact: true }).click();
  const chart = page.getByRole("region", { name: "Priorities chart" });
  const list = page.getByRole("dialog");
  const overdue = chart.getByRole("button", {name: "Very high, Overdue: 2 tasks"});
  await expect(overdue).toBeVisible();
  await expectPriorityFills(chart);
  expect(await chart.locator(".priority-square").count()).toBe(49);
  await expect(page.locator(".gtd-sidebar")).toBeInViewport();
  expect(Math.abs(await middleSquareOffsetFromPane(chart))).toBeLessThan(1);
  await page.setViewportSize({width: 1728, height: 1080});
  expect(Math.abs(await middleSquareOffsetFromPane(chart))).toBeLessThan(1);
  await page.screenshot({path: info.outputPath("priority-pane-wide.png"), animations: "disabled"});
  await page.setViewportSize({width: 1041, height: 760});
  expect(Math.abs(await middleSquareOffsetFromPane(chart))).toBeLessThan(1);
  await page.setViewportSize({width: 1024, height: 760});
  expect(Math.abs(await middleSquareOffsetFromPane(chart))).toBeLessThan(1);
  await page.setViewportSize({width: 1440, height: 760});
  await expect(chart.getByText("Unimportant", {exact: true})).toBeVisible();
  await expect(chart.locator('.priority-column[title="Immediate"] > :first-child')).toHaveText("Now");
  await chart.getByRole("button", {name: "Critical, Overdue: 1 task"}).click();
  await expect(list.getByRole("button", {name: "Priority shared prerequisite", exact: true})).toBeVisible();
  await expect(list.getByRole("button", {name: "Importance from Priority critical outcome"})).toBeVisible();
  await expect(list.getByRole("button", {name: "Urgency from Priority early deadline"})).toBeVisible();
  await list.getByRole("button", {name: "Close task list"}).click();
  await expect(list).toHaveCount(0);
  await chart.getByRole("button", {name: "High, Overdue: 1 task"}).click();
  await expect(list.getByRole("button", {name: "Priority missed block"})).toBeVisible();
  await expect(list.getByText(/^Work block · /)).toBeVisible();
  await list.getByRole("button", {name: "Close task list"}).click();
  await expect(list).toHaveCount(0);
  await overdue.focus();
  await overdue.press("ArrowRight");
  const undated = chart.getByRole("button", {name: "Very high, Undated: 1 task"});
  await expect(undated).toBeFocused();
  await undated.press("Enter");
  await expect(list).toHaveAccessibleName("Very high · Undated");
  await expect(list.getByRole("button", {name: "Priority review only"})).toBeVisible();
  const firstRow = (await page.locator('.priority-square[data-priority-index="0"]').boundingBox())!;
  const middle = (await chart.locator(".priority-square").nth(3).boundingBox())!;
  const placement = (await list.locator(".priority-sheet-placement").boundingBox())!;
  expect(Math.abs(placement.y - firstRow.y)).toBeLessThan(2);
  expect(Math.abs(placement.x + placement.width / 2 - middle.x - middle.width / 2)).toBeLessThan(2);
  const documentScroll = await page.evaluate(() => window.scrollY);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  const panel = list.locator(".priority-sheet-panel");
  expect(await panel.evaluate(node => node.scrollHeight - node.clientHeight)).toBe(0);
  await page.mouse.move(placement.x + 24, placement.y + 70);
  await page.mouse.wheel(0, 200);
  await page.mouse.move(12, 400);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.scrollY)).toBe(documentScroll);
  await page.screenshot({path: info.outputPath("priority-popup.png"), animations: "disabled"});
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(undated).toBeFocused();
  await overdue.click();
  await expect(list.getByRole("button", {name: "Priority task two", exact: true})).toBeVisible();
  await list.getByRole("button", {name: "Priority task one", exact: true}).click();
  await expect(page.getByText("Priority fixture body.", {exact: true})).toBeVisible();
  await page.goBack();
  await expect(list.getByRole("button", {name: "Priority task one", exact: true})).toBeFocused();

  const reads: any[] = [];
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  await page.route("**/api/tools/priority_grid", async (route) => {
    const query = route.request().postDataJSON();
    reads.push(query);
    if (!query.cell) await gate;
    await route.continue();
  });
  await call("update_item", { task_id: second.id, expected_version: second.version, status: "done", reason: "Change after chart snapshot", request_id: randomUUID() });
  const nextPage = await call("priority_grid", {...args, cursor: firstPage.next_cursor});
  expect(nextPage.items.map((task: any) => task.id)).toEqual([second.id]);
  await page.evaluate(() => window.dispatchEvent(new Event("gtd:changed")));
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  await expect(list.getByRole("button", {name: "Priority task two", exact: true})).toBeVisible();
  unblock();
  await expect(list.getByRole("button", {name: "Priority task two", exact: true})).toHaveCount(0);
  await list.getByRole("button", {name: "Close task list"}).click();
  await expect(chart.getByRole("button", {name: "Very high, Overdue: 1 task"})).toBeVisible();

  const summaries = reads.filter(query => !query.cell).length;
  await chart.getByRole("button", {name: "Task group: Next"}).click();
  await chart.getByRole("menuitemradio", {name: "Someday", exact: true}).click();
  await chart.getByRole("button", {name: "Very high, Overdue: 1 task"}).click();
  await expect(list.getByRole("button", {name: "Priority someday", exact: true})).toBeVisible();
  await list.getByRole("button", {name: "Close task list"}).click();
  expect(reads.filter(query => !query.cell)).toHaveLength(summaries);
  await page.setViewportSize({width: 320, height: 780});
  await page.emulateMedia({colorScheme: "dark", reducedMotion: "reduce"});
  expect(await middleSquareOffsetFromPane(chart)).toBeGreaterThan(0);
  expect(await chart.locator(".priority-grid").evaluate((grid) => {
    const bounds = grid.getBoundingClientRect();
    const chartBounds = grid.parentElement!.getBoundingClientRect();
    return bounds.left >= chartBounds.left && bounds.right <= chartBounds.right &&
      [...grid.querySelectorAll("button")].every(cell => {
      const box = cell.getBoundingClientRect();
      return box.width >= 24 && Math.abs(box.width - box.height) < 1 && box.right <= bounds.right;
    });
  })).toBe(true);
  await page.screenshot({path: info.outputPath("priority-pane-narrow.png"), animations: "disabled"});
  await chart.getByRole("button", {name: "Very high, Overdue: 1 task"}).click();
  const popup = list.locator(".priority-sheet-panel");
  await expect(popup).toBeVisible();
  const mobile = (await popup.boundingBox())!;
  const mobileFirstRow = (await page.locator('.priority-square[data-priority-index="0"]').boundingBox())!;
  expect(Math.abs(mobile.y - mobileFirstRow.y)).toBeLessThan(2);
  expect(mobile.x).toBeGreaterThanOrEqual(15);
  expect(mobile.x + mobile.width).toBeLessThanOrEqual(305);
  expect(await list.evaluate(node => node.getAnimations({subtree: true}).length)).toBe(0);
  await call("update_item", {
    task_id: blocker.id, expected_version: blocker.version, archived: true,
    reason: "Retire the inherited-priority fixture before the widget checks", request_id: randomUUID(),
  });
});

test("phone-width Priorities confines scrolling to the open pop-up", async ({page, request, baseURL, browserName}) => {
  const seeded = await request.post("/api/tools/apply_changes", {
    headers: {Origin: baseURL!, "X-GTD-Request": "1"},
    data: {request_id: randomUUID(), operations: Array.from({length: 24}, (_, i) => ({
      operation: "capture", title: `Priority scroll fixture ${i + 1}`, status: "next",
      brief: "Check scrolling with disposable tasks.", importance: "low", estimated_minutes: 5,
      effort: "low", reason: "Disposable chart scroll fixture",
    }))},
  });
  expect(seeded.ok()).toBeTruthy();
  await page.setViewportSize({width: 390, height: 620});
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto("/");
  await selectChart(page, "priorities");
  await expect(page.locator(".priority-importance-short")).toHaveText("Trivial");
  await expect(page.locator(".priority-importance-short")).toBeVisible();
  await expect(page.locator(".priority-importance:has(.priority-importance-short) .priority-importance-full")).toBeHidden();
  await page.getByRole("button", {name: /^Low, Undated: \d+ tasks$/}).click();
  const list = page.getByRole("dialog", {name: "Low · Undated"});
  const panel = list.locator(".priority-sheet-panel");
  await expect(list.locator("li")).toHaveCount(20);
  await expect(page.locator("html")).toHaveCSS("overflow-y", "hidden");
  const title = (await list.getByRole("heading").boundingBox())!;
  const top = () => panel.evaluate(node => node.scrollTop);
  const background = () => page.evaluate(() => window.scrollY);
  const before = await background();
  await verticalGesture(page, browserName, title.x + 30, title.y + 8, -90);
  await expect.poll(top).toBeGreaterThan(0);
  expect(await background()).toBe(before);
  expect((await list.getByRole("heading").boundingBox())!.y).toBeCloseTo(title.y, 0);

  await panel.evaluate(node => node.scrollTo(0, node.scrollHeight));
  const end = await top();
  await verticalGesture(page, browserName, 190, title.y + 100, -110);
  await verticalGesture(page, browserName, 6, 320, -120);
  expect(Math.abs(await top() - end)).toBeLessThan(2);
  expect(await background()).toBe(before);
  await expect(list).toBeVisible();

  await panel.evaluate(node => node.scrollTo(0, 0));
  const pullIndicator = await list.getByRole("heading").evaluate(async heading => {
    for (const [type, y] of [["touchstart", 200], ["touchmove", 375]] as const) {
      const event = new Event(type, {bubbles: true, cancelable: true});
      Object.defineProperty(event, "touches", {value: [{clientX: 190, clientY: y}]});
      heading.dispatchEvent(event);
    }
    await new Promise(requestAnimationFrame);
    const hidden = heading.closest(".gtd-main")?.querySelector(".pull-indicator")?.getAttribute("aria-hidden");
    heading.dispatchEvent(new Event("touchcancel", {bubbles: true}));
    return hidden;
  });
  expect(pullIndicator).toBe("true");
  await verticalGesture(page, browserName, title.x + 30, title.y + 8, 170);
  await expect(page.locator(".pull-indicator:visible").first()).toHaveAttribute("aria-hidden", "true");
  expect(await background()).toBe(before);
  await list.locator(".priority-sheet-scrim").click({position: {x: 6, y: 320}});
  await expect(list).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveCSS("overflow-y", "hidden");
  // Wheel hit testing uses WebKit's composited scroll tree. Let removal of the
  // modal and its root scroll lock reach a paint before starting a new gesture.
  await page.evaluate(() => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await verticalGesture(page, browserName, 190, 520, -130);
  await expect.poll(background).toBeGreaterThan(before);
});

async function selectCategory(page: Page | FrameLocator, name: string) {
  await page.locator(".chart-footer").getByRole("button", {name: /^Activity: /}).click();
  await page.getByRole("menuitemradio", {name, exact: true}).click();
}

async function expectInlineChartControls(page: Page | FrameLocator, mode: "Heatmap" | "Bar Chart") {
  const header = page.locator(".chart-range");
  const date = (await header.locator(".chart-range-date").boundingBox())!;
  const type = (await header.getByRole("button", {name: `Chart: ${mode}`, exact: true}).boundingBox())!;
  const arrow = (await header.getByRole("button", {name: "Previous period", exact: true}).boundingBox())!;
  const next = (await header.getByRole("button", {name: "Next period", exact: true}).boundingBox())!;
  const bounds = (await header.boundingBox())!;
  expect(date.x + date.width).toBeLessThanOrEqual(type.x);
  expect(arrow.x - (type.x + type.width)).toBeGreaterThanOrEqual(0);
  expect(arrow.x - (type.x + type.width)).toBeLessThan(12);
  expect(Math.abs(next.x + next.width - bounds.x - bounds.width)).toBeLessThan(2);
  expect(Math.abs(date.y + date.height / 2 - type.y - type.height / 2)).toBeLessThan(2);
  expect(Math.abs(arrow.y + arrow.height / 2 - type.y - type.height / 2)).toBeLessThan(2);
  if (mode === "Bar Chart") {
    const period = (await header.getByRole("group", {name: "Period", exact: true}).boundingBox())!;
    expect(date.x + date.width).toBeLessThanOrEqual(period.x);
    expect(period.x + period.width).toBeLessThanOrEqual(type.x);
    const gap = await header.evaluate(e => parseFloat(getComputedStyle(e).columnGap));
    const center = Math.min(bounds.x + bounds.width / 2, type.x - gap - period.width / 2);
    expect(Math.abs(period.x + period.width / 2 - center)).toBeLessThan(2);
    expect(Math.abs(period.y + period.height / 2 - arrow.y - arrow.height / 2)).toBeLessThan(2);
  }
}

function daily(args: any, today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })) {
  const days: any[] = [];
  for (
    let d = new Date(args.from + "T12:00:00Z");
    d.toISOString().slice(0, 10) <= args.through;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const date = d.toISOString().slice(0, 10),
      i = Math.floor(d.getTime() / 86400000);
    const categories = {
      completed: i % 4,
      added: i % 3,
      started: i % 2,
      status: i % 5 === 0 ? 2 : 0,
      scheduling: i % 7 === 0 ? 3 : 0,
      edited: i % 11 === 0 ? 5 : 0,
      undo: i % 13 === 0 ? 1 : 0,
    };
    days.push({
      date,
      count:
        args.metric === "completed"
          ? categories.completed
          : Object.values(categories).reduce((a, b) => a + b, 0),
      categories,
      partial: date === today,
      future: date > today,
    });
  }
  return {
    days,
    total: days.reduce((n, d) => n + (d.future ? 0 : d.count), 0),
    categories: days.filter(d => !d.future).reduce((sum, d) => {
      for (const [key, value] of Object.entries(d.categories)) sum[key] = (sum[key] || 0) + Number(value);
      return sum;
    }, {} as Record<string, number>),
    snapshot: "synthetic-chart-snapshot",
    has_history: true,
    window: { timezone: "America/New_York" },
    automatic_count: 3,
  };
}
test("Home chart has independent loading, exact day selection and local recovery", async ({
  page,
  request,
  baseURL,
}) => {
  const headers = { Origin: baseURL!, "X-GTD-Request": "1" };
  const created = await request.post("/api/tools/capture_item", {
    headers,
    data: {
      request_id: randomUUID(),
      title: "Chart acceptance task",
      importance: "normal",
      status: "done",
      brief: "Synthetic completion.",
      reason: "Chart fixture",
    },
  });
  expect(created.ok()).toBeTruthy();
  let release!: () => void;
  const delay = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/tools/activity_summary", async (route) => {
    await delay;
    await route.continue();
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Chart: / }),
  ).toBeVisible();
  await expect(page.locator(".chart-placeholder")).toBeVisible();
  release();
  await expect(page.locator(".heat-grid")).toBeVisible();
  const date = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const response = page.waitForResponse((r) =>
    r.url().includes("/api/tools/activity_day"),
  );
  await page.locator(".heat-grid button:not([disabled])").last().click();
  const read = await response;
  expect(read.ok()).toBeTruthy();
  expect(read.request().postDataJSON().day).toBe(date);
  expect(read.request().postDataJSON().snapshot).toBeTruthy();
  expect(read.request().postDataJSON().metric).toBe("changes");
  expect(read.request().postDataJSON().category).toBe("completed");
  await expect(
    page.getByRole("button", { name: "Chart acceptance task", exact: true }),
  ).toBeVisible();
  await page.goto("/");
  await page.route("**/api/tools/activity_summary", (r) =>
    r.fulfill({ status: 503, json: { message: "Synthetic chart outage" } }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".chart-error")).toBeVisible();
  await page.unroute("**/api/tools/activity_summary");
  await page.locator(".chart-error button").click();
  await expect(page.locator(".heat-grid")).toBeVisible();
});
for (const width of [1440, 638, 390])
  for (const dark of [false, true])
    test(`chart layout ${width} ${dark ? "dark" : "light"}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.clock.setFixedTime(new Date("2026-11-04T20:00:00Z"));
      await page.emulateMedia({
        colorScheme: dark ? "dark" : "light",
        reducedMotion: "reduce",
      });
      await page.route("**/api/tools/activity_summary", (r) =>
        r.fulfill({ json: daily(r.request().postDataJSON()) }),
      );
      await page.goto("/");
      await expect(page.locator(".heat-grid")).toBeVisible();
      await expectInlineChartControls(page, "Heatmap");
      expect(await page.locator(".heat-grid button").count()).toBe(
        52 * 7,
      );
      expect(await page.locator(".heat-grid button").evaluateAll(cells => cells.every(cell => {
        const box = cell.getBoundingClientRect();
        return Math.abs(box.width - box.height) < 1 && box.width >= 7.9;
      }))).toBeTruthy();
      expect(await page.locator(".heat-scroll").evaluate(e =>
        Math.abs(e.scrollWidth - e.clientWidth - e.scrollLeft) < 2
      )).toBeTruthy();
      expect(await page.locator(".chart-panel").evaluate((panel) => {
        const layout = panel.querySelector(".heat-layout")!;
        const bounds = layout.getBoundingClientRect();
        return [...panel.querySelectorAll(".heat-months span")].every((label) => {
          if (!label.textContent) return true;
          const range = document.createRange(); range.selectNodeContents(label);
          const box = range.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right + 1;
        });
      })).toBeTruthy();
      const active = page.locator('.heat-grid [tabindex="0"]');
      await active.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(page.locator('.heat-grid [tabindex="0"]')).toBeFocused();
      await page.keyboard.press("Home");
      await expect(page.locator('.heat-grid button').first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(page.locator('.heat-grid button:not([disabled])').last()).toBeFocused();
      await page.locator(".charts").screenshot({ path: info.outputPath("completed.png") });
      const selector = page.getByRole("button", {name: "Chart: Heatmap", exact: true});
      await selector.focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitemradio", {name: "Heatmap", exact: true})).toBeFocused();
      await page.screenshot({path: info.outputPath("selector.png")});
      await page.keyboard.press("Escape");
      await expect(selector).toBeFocused();
      expect(await selector.evaluate(e => getComputedStyle(e).outlineStyle)).not.toBe("none");
      await expect(selector).toHaveAttribute("aria-expanded", "false");
      await selectCategory(page, "All activity");
      await expect(page.locator(".chart-footer").getByRole("button", {name: /^Activity: [\d,]+ changes$/})).toBeVisible();
      await page.screenshot({ path: info.outputPath("activity.png") });
      await selectChart(page, "bars");
      await expect(page.locator(".bar-column")).toHaveCount(30);
      await expectInlineChartControls(page, "Bar Chart");
      const picker = page.getByLabel("Chart ending date", { exact: true });
      await picker.focus();
      await expect(picker).toBeFocused();
      await picker.fill("2026-09-17");
      await expect(page.locator(".chart-range")).toContainText("Sep 17, 2026");
      await expect(page.locator('.bar-total').last()).toHaveAttribute("aria-label", /Sep 17, 2026/);
      await selectChart(page, "heatmap");
      await expect(page.locator(".chart-range")).toContainText("Sep 19, 2026");
      await expect(picker).toHaveValue("2026-09-17");
      await selectChart(page, "bars");
      await expect(page.locator(".chart-range")).toContainText("Sep 17, 2026");
      expect(
        await page
          .locator(".bar-stack button")
          .first()
          .evaluate((e) => getComputedStyle(e).backgroundColor),
      ).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: info.outputPath("bars.png") });
      const before = await page.locator(".chart-range").innerText();
      await page
        .getByRole("button", { name: "Previous period", exact: true })
        .click();
      await expect(page.locator(".chart-range")).not.toHaveText(before);
      await page.getByRole("button", { name: "7d", exact: true }).click();
      await expect(page.locator(".bar-column")).toHaveCount(7);
      expect(
        await page
          .locator(".chart-panel")
          .evaluate((e) => e.scrollWidth <= e.clientWidth),
      ).toBeTruthy();
    });
test("bar categories isolate, rescale, toggle and drill into the selected category", async ({page}) => {
  await page.clock.setFixedTime(new Date("2026-11-04T20:00:00Z"));
  await page.emulateMedia({reducedMotion: "no-preference"});
  let reads = 0;
  await page.route("**/api/tools/activity_summary", r => {
    reads++;
    return r.fulfill({json: daily(r.request().postDataJSON())});
  });
  await page.goto("/");
  await selectChart(page, "bars");
  await expect(page.locator(".bar-column")).toHaveCount(30);
  const completed = page.locator(".chart-legend").getByRole("button", {name: /^Completed/});
  await expect(completed).toHaveAttribute("aria-pressed", "true");
  await completed.click();
  const originalTicks = await page.locator(".bar-gridlines").textContent();
  const before = reads;
  await completed.click();
  await expect(completed).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".bar-gridlines")).toHaveText("3210");
  await expect(page.locator(".chart-footer")).toHaveText(`${daily({from: "2026-10-06", through: "2026-11-04", metric: "changes"}).categories.completed} completed`);
  await expect(page.locator('.bar-stack [data-category="added"]').first()).toHaveAttribute("aria-hidden", "true");
  expect(await page.locator(".bar-stack").first().evaluate(e => getComputedStyle(e).transitionDuration)).toBe("0.2s");
  await expect.poll(() => page.locator('.bar-stack [data-category="added"]').nth(0).evaluate(e => e.getBoundingClientRect().height)).toBe(0);
  await completed.click();
  await expect(completed).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".bar-gridlines")).toHaveText(originalTicks);
  const added = page.locator(".chart-legend").getByRole("button", {name: /^Added/});
  await added.focus();
  await page.keyboard.press("Enter");
  await expect(added).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".chart-footer")).toHaveText(`${daily({from: "2026-10-06", through: "2026-11-04", metric: "changes"}).categories.added} added`);
  expect(reads).toBe(before);
  await page.emulateMedia({reducedMotion: "reduce"});
  expect(await page.locator(".bar-stack").first().evaluate(e => getComputedStyle(e).transitionDuration)).toBe("0s");
  await page.route("**/api/tools/activity_day", r => r.fulfill({json: {changes: [], next_cursor: null}}));
  const day = page.waitForRequest(r => r.url().includes("/api/tools/activity_day"));
  await page.locator('.bar-stack [data-category="added"]').last().click();
  expect((await day).postDataJSON().category).toBe("added");
});
test("heatmaps and bars share categories, event counts, selection and drilldowns", async ({page}) => {
  test.setTimeout(120_000);
  await page.clock.setFixedTime(new Date("2026-11-04T20:00:00Z"));
  await page.route("**/api/auth/session", r => r.fulfill({json: {
    authenticated: true, enabled: true, method: "oidc", environment: "test", csrf: "a".repeat(64),
    account: {id: "00000000-0000-4000-8000-000000000001", username: "fixture", display_name: "Fixture", timezone: "America/New_York", administrator: false},
  }}));
  const queries: any[] = [];
  await page.route("**/api/tools/activity_summary", r => {
    const args = r.request().postDataJSON(); queries.push(args);
    return r.fulfill({json: daily(args, "2026-11-04")});
  });
  await page.goto("/");
  const metric = page.locator(".chart-footer").getByRole("button", {name: /^Activity: /});
  await expect(metric).toHaveText(/^[\d,]+ completed$/);
  const labels = {completed: "Completed", added: "Added", started: "Started", status: "Status changed", scheduling: "Scheduling", edited: "Other edits", undo: "Undo / redo"};
  const day = daily({from: "2026-11-04", through: "2026-11-04", metric: "changes"}).days[0];
  for (const [category, label] of Object.entries(labels)) {
    await selectCategory(page, label);
    await expect(page.locator('.heat-grid button:not([disabled])').last()).toHaveAttribute("aria-label", `Nov 4, 2026: ${day.categories[category]} ${day.categories[category] === 1 ? "event" : "events"}, today so far`);
    const before = queries.length;
    await selectCategory(page, label);
    expect(queries.length).toBe(before);
    await selectChart(page, "bars");
    await expect(page.locator('.bar-total').last()).toHaveAttribute("aria-label", `Nov 4, 2026: ${day.categories[category]} ${label}, today so far`);
    await expect(page.locator('.chart-legend').getByRole("button", {name: new RegExp(`^${label}`)})).toHaveAttribute("aria-pressed", "true");
    await selectChart(page, "heatmap");
    await expect(metric).toHaveText(new RegExp(`^[\\d,]+ ${label.toLowerCase()}$`));
  }
  await selectCategory(page, "All activity");
  await selectChart(page, "bars");
  await expect(page.locator('.chart-legend [aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('.bar-total').last()).toHaveAttribute("aria-label", `Nov 4, 2026: ${day.count} changes, today so far`);
  await page.locator('.chart-legend').getByRole("button", {name: /^Added/}).click();
  await selectChart(page, "heatmap");
  await expect(metric).toHaveText(/^[\d,]+ added$/);
  await page.reload();
  await expect(metric).toHaveText(/^[\d,]+ added$/);
  const preferenceKey = "gtd:charts:test:00000000-0000-4000-8000-000000000001:website";
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), preferenceKey)).toEqual({mode: "heatmap", category: "added"});
  await page.route("**/api/tools/activity_day", r => r.fulfill({json: {changes: [], next_cursor: null}}));
  const detail = page.waitForRequest(r => r.url().includes("/api/tools/activity_day"));
  await page.locator('.heat-grid button:not([disabled])').last().click();
  expect((await detail).postDataJSON()).toMatchObject({metric: "changes", category: "added", day: "2026-11-04", snapshot: "synthetic-chart-snapshot"});
  expect(queries.every(q => q.metric === "changes")).toBeTruthy();
  for (const legacy of ["activity", "bars", "completed"]) {
    await page.evaluate(({key, value}) => localStorage.setItem(key, value), {key: preferenceKey, value: legacy});
    await page.goto("/");
    if (legacy === "bars") {
      await expect(page.getByRole("button", {name: "Chart: Bar Chart", exact: true})).toBeVisible();
      await expect(page.locator('.chart-legend [aria-pressed="true"]')).toHaveCount(0);
    } else {
      await expect(metric).toHaveText(legacy === "completed" ? /^[\d,]+ completed$/ : /^[\d,]+ changes$/);
    }
  }
});
test.describe("widget chart navigation", () => {
test.use({ hasTouch: true });
for (const launch of ["home", "results", "charts"]) test(`widget ${launch} navigation and record actions`, async ({
  page,
  request,
  baseURL,
  browserName,
}, info) => {
  const html = await readFile("dist/widget-adapter.html", "utf8");
  const calls: string[] = [];
  let initial: any = { app: "gtd", view: launch };
  let priorities: any, priorityProjects: any;
  let offset: number | undefined;
  const chartRead = async (operation: string, data: object) => {
    const result = await request.post(`/api/tools/${operation}`, {headers: {Origin: baseURL!, "X-GTD-Request": "1"}, data});
    expect(result.ok()).toBeTruthy();
    return result.json();
  };
  if (launch === "charts") {
    await page.clock.setFixedTime(new Date());
    const fields = { brief: "Inspect the overdue task.", status: "next", estimated_minutes: 10, effort: "low", reason: "Disposable chart fixture" };
    const {task: blocker} = await chartRead("capture_item", {
      ...fields, request_id: randomUUID(), title: "Widget priority fixture", notes: "Widget priority fixture notes.", importance: "unimportant",
    });
    await chartRead("capture_item", {
      ...fields, request_id: randomUUID(), title: "Widget critical outcome", importance: "critical", blocked_by: [blocker.id],
    });
    await chartRead("capture_item", {
      ...fields, request_id: randomUUID(), title: "Widget early deadline", importance: "normal", due_date: "2020-01-01", blocked_by: [blocker.id],
    });
    await chartRead("create_project", { title: "Widget chart project", brief: "Test the project picker.", request_id: randomUUID(), reason: "Disposable chart fixture" });
    priorities = await chartRead("priority_grid", {});
    const first = await chartRead("priority_grid", {snapshot: priorities.snapshot, cell: {importance:"critical", urgency:"overdue"}});
    priorities.previews = Array.from({length: 49}, (_, i) => i === 48 ? first.items : []);
    priorities.counts[4][0].next = 21;
    priorities.previews[28] = Array.from({length:20}, (_, i) => ({id:`preview-${i+1}`, title:`Preview task ${i+1}`, status:"next"}));
    priorities.counts[3][0] = {next:100, blocked:900, waiting:0, someday:0, inbox:0};
    priorities.counts[1][0] = {next:100, blocked:0, waiting:0, someday:0, inbox:0};
    priorityProjects = await chartRead("list_projects", {view:"all", archived:false, limit:20});
  }
  if (launch === "results") {
    const id = randomUUID();
    const created = await request.post("/api/tools/capture_item", { headers: { Origin: baseURL!, "X-GTD-Request": "1" }, data: { request_id: id, title: "Results fixture", brief: "Inspect and edit this task.", importance: "normal", reason: "Disposable Results fixture" } });
    expect(created.ok()).toBeTruthy();
    const result = await request.post("/api/tools/request_results", { headers: { Origin: baseURL!, "X-GTD-Request": "1" }, data: { from_request_ids: [id] } });
    expect(result.ok()).toBeTruthy(); initial = await result.json();
  }
  await page.route("**/__chart_widget", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="card"></div>' }),
  );
  await page.goto("/__chart_widget");
  await page.exposeFunction("fixtureRead", async (name: string, args: any) => {
    calls.push(name);
    if (name === "activity_summary") return daily(args);
    if (name === "view_snapshot" && args.query.view === "charts")
      return { kind: "full", token: "chart-fixture", data: { ...daily(args.query.arguments), priorities, priority_projects: priorityProjects } };
    if (launch === "charts" && name === "priority_grid" && args.offset !== undefined) {
      offset = args.offset;
      return {items:[{id:"preview-21",title:"Preview task 21",status:"next"}],next_cursor:null};
    }
    const response = await request.post("/api/tools/" + name, {
      headers: { Origin: baseURL!, "X-GTD-Request": "1" },
      data: args,
    });
    return response.json();
  });
  await page.evaluate(
    ({ html, initial }) => {
      const f = document.createElement("iframe");
      f.style.cssText = "width:390px;height:800px;border:0";
      f.setAttribute("sandbox", "allow-scripts allow-forms");
      const send = (v: any) =>
        f.contentWindow?.postMessage({ jsonrpc: "2.0", ...v }, "*");
      window.addEventListener("message", async (e) => {
        if (e.source !== f.contentWindow) return;
        const m = e.data;
        if (m.method === "ui/initialize")
          send({
            id: m.id,
            result: {
              hostContext: {
                displayMode: "inline",
                availableDisplayModes: ["inline", "fullscreen"],
                theme: "light",
                containerDimensions: { width: 390, maxHeight: 800 },
              },
            },
          });
        if (m.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: { arguments: {} },
          });
          send({
            method: "ui/notifications/tool-result",
            params: { structuredContent: initial },
          });
        }
        if (m.method === "ui/request-display-mode") {
          send({ id: m.id, result: { mode: "inline" } });
          send({ method: "ui/notifications/host-context-changed", params: { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], theme: "light", containerDimensions: { width: 390, maxHeight: 800 } } });
        }
        if (m.method === "tools/call") {
          const args = m.params.arguments;
          send({
            id: m.id,
            result: {
              structuredContent: await (window as any).fixtureRead(
                args.operation,
                args.arguments,
              ),
            },
          });
        }
      });
      f.srcdoc = html;
      document.getElementById("card")!.append(f);
    },
    { html, initial },
  );
  const frame = page.frameLocator("iframe");
  await expect(
    frame.getByRole("button", { name: "GTD navigation" }),
  ).toBeVisible();
  if (launch !== "charts") expect(calls).not.toContain("activity_summary");
  if (launch === "results") {
    await expect(frame.getByRole("button", { name: "Details: Results fixture", exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "More options: Results fixture" }).click();
    await frame.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(frame.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
    await frame.getByRole("textbox", { name: "Title", exact: true }).fill("Unsaved Results draft");
    await frame.getByRole("button", { name: "Close details", exact: true }).click();
  }
  if (launch !== "charts") {
    await frame.getByRole("button", { name: "GTD navigation" }).click();
    await frame.getByRole("menuitemradio", { name: "Charts", exact: true }).click();
  }
  await expect(
    frame.getByRole("button", { name: /^Chart: / }),
  ).toBeVisible();
  await expect(frame.locator(".heat-grid")).toBeVisible();
  await expect(frame.locator(".heat-grid button")).toHaveCount(364);
  expect(await frame.locator(".heat-grid button").first().evaluate(e => {
    const box = e.getBoundingClientRect();
    return Math.abs(box.width - box.height) < 1;
  })).toBeTruthy();
  expect(await frame.locator(".chart-panel").evaluate(e => getComputedStyle(e).borderTopWidth)).toBe("0px");
  expect(await frame.locator(".charts").evaluate(e => parseFloat(getComputedStyle(e).paddingLeft))).toBeGreaterThanOrEqual(16);
  await expectInlineChartControls(frame, "Heatmap");
  const metric = frame.locator(".chart-footer").getByRole("button", {name: /^Activity: /});
  await expect(metric).toHaveText(/^[\d,]+ completed$/);
  expect(calls).toContain("view_snapshot");
  if (launch === "charts") {
    const before = calls.length;
    await metric.focus();
    await metric.press("ArrowDown");
    await expect(frame.getByRole("menuitemradio", {name: "Completed", exact: true})).toBeFocused();
    await frame.getByRole("menuitemradio", {name: "All activity", exact: true}).click();
    await expect(metric).toHaveText(/^[\d,]+ changes$/);
    await frame.getByRole("button", {name: /^Chart: /}).click();
    await expect(frame.getByRole("menu", {name: "Chart type", exact: true})).toBeVisible();
    await frame.locator(".widget-surface").screenshot({path: info.outputPath("widget-selector.png"), animations: "disabled"});
    await frame.getByRole("menuitemradio", {name: "Bar Chart", exact: true}).click();
    await expect(frame.locator(".bar-column")).toHaveCount(30);
    await expectInlineChartControls(frame, "Bar Chart");
    await frame.getByRole("button", {name: "7d", exact: true}).click();
    await expect(frame.locator(".bar-column")).toHaveCount(7);
    await selectChart(frame, "heatmap");
    await expect(frame.locator(".heat-grid button")).toHaveCount(364);
    expect(calls.length).toBe(before);
    await selectChart(frame, "bars");
    await expect(frame.getByRole("button", {name: "Chart: Bar Chart", exact: true})).toBeFocused();
    expect(await frame.getByRole("button", {name: "Chart: Bar Chart", exact: true}).evaluate(e => getComputedStyle(e).outlineStyle)).toBe("none");
  }
  if (launch === "results") {
    await frame.getByRole("button", { name: "Back to previous view" }).click();
    await frame.getByRole("button", { name: "More options: Results fixture" }).click();
    await frame.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(frame.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Unsaved Results draft");
  }
  if (launch === "charts") {
    const start = calls.length;
    await selectChart(frame, "priorities");
    const chart = frame.getByRole("region", {name: "Priorities chart"});
    await expect(chart.locator(".priority-square")).toHaveCount(49);
    expect(await middleSquareOffsetFromPane(chart)).toBeGreaterThan(0);
    await page.locator("iframe").evaluate(iframe => { iframe.style.width = "560px"; });
    await expect.poll(async () => Math.abs(await middleSquareOffsetFromPane(chart))).toBeLessThan(1);
    await page.locator("iframe").evaluate(iframe => { iframe.style.width = "390px"; });
    await expect.poll(() => middleSquareOffsetFromPane(chart)).toBeGreaterThan(0);
    await expectPriorityFills(chart);
    expect(calls.length).toBe(start);
    expect(await chart.locator(".priority-column").evaluateAll(columns => columns.map(c => c.getAttribute("title"))))
      .toEqual(["Overdue", "Immediate", "Within 48 hours", "Within 7 days", "2–4 weeks", "Later", "Undated"]);
    await chart.getByRole("button", {name: "Project: Any project"}).click();
    await expect(frame.getByRole("menuitemradio", {name: "Widget chart project"})).toBeVisible();
    await frame.getByRole("menuitemradio", {name: "Any project"}).click();
    const normalUndated = chart.getByRole("button", {name: /^Normal, Undated:/});
    await expect(normalUndated).toHaveText("100");
    const nextColor = await normalUndated.evaluate(cell => getComputedStyle(cell).backgroundColor);
    await chart.getByRole("button", {name: "Task group: Next"}).click();
    await chart.getByRole("menuitemradio", {name: "All open", exact: true}).click();
    await expect(normalUndated).toHaveText("1,000");
    await expect(normalUndated).toHaveCSS("background-color", nextColor);
    expect(calls.length).toBe(start);
    await page.evaluate(() => document.querySelector("iframe")?.contentWindow?.postMessage({
      jsonrpc: "2.0", method: "ui/notifications/host-context-changed",
      params: { theme: "dark", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], containerDimensions: { width: 390, maxHeight: 350 } },
    }, "*"));
    await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
    for (const [name, number] of [["Very low, Undated: 100 tasks", "100"], ["Normal, Undated: 1,000 tasks", "1,000"]]) {
      const square = chart.getByRole("button", {name, exact: true});
      await expect(square).toHaveText(number);
      const bounds = await square.evaluate(cell => {
        const box = cell.getBoundingClientRect();
        const label = cell.querySelector(".priority-count")!;
        const text = document.createRange();
        text.selectNodeContents(label);
        const count = text.getBoundingClientRect();
        return {fontSize: getComputedStyle(label).fontSize, square: box.toJSON(), count: count.toJSON()};
      });
      expect(bounds.count.left, JSON.stringify(bounds)).toBeGreaterThanOrEqual(bounds.square.left);
      expect(bounds.count.right, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.square.right);
      expect(bounds.count.top, JSON.stringify(bounds)).toBeGreaterThanOrEqual(bounds.square.top);
      expect(bounds.count.bottom, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.square.bottom);
    }
    const label = chart.locator(".priority-importance").last();
    await expect(label.locator(".priority-importance-short")).toBeVisible();
    await expect(label.locator(".priority-importance-full")).toBeHidden();
    expect(await label.evaluate(element => {
      const text = element.querySelector(".priority-importance-short")!.getBoundingClientRect();
      const cell = element.nextElementSibling!.getBoundingClientRect();
      return cell.left - text.right;
    })).toBeGreaterThan(3);
    const overdue = chart.getByRole("button", {name: "Critical, Overdue: 1 task", exact: true});
    const list = frame.getByRole("dialog");
    await overdue.evaluate(button => {
      button.ownerDocument.addEventListener("transitionrun", event => {
        const dialog = (event.target as Element).closest<HTMLDialogElement>(".priority-sheet");
        if (dialog) dialog.dataset.enterTransitions = `${dialog.dataset.enterTransitions || ""} ${event.propertyName}`;
      });
    });
    await overdue.tap();
    const task = list.getByRole("button", {name:"Widget priority fixture", exact:true});
    await expect(task).toBeVisible();
    await expect(list.getByRole("button", {name:"Importance from Widget critical outcome"})).toBeVisible();
    await expect(list.getByRole("button", {name:"Urgency from Widget early deadline"})).toBeVisible();
    const close = list.getByRole("button", {name: "Close task list"});
    const closeStyle = await close.evaluate(button => {
      const {backgroundColor, borderTopWidth, boxShadow} = getComputedStyle(button);
      const hit = button.getBoundingClientRect();
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      return {
        backgroundColor, borderTopWidth, boxShadow, width: hit.width, height: hit.height,
        offsetX: Math.abs(hit.x + hit.width / 2 - icon.x - icon.width / 2),
        offsetY: Math.abs(hit.y + hit.height / 2 - icon.y - icon.height / 2),
      };
    });
    expect(closeStyle).toMatchObject({backgroundColor: "rgba(0, 0, 0, 0)", borderTopWidth: "0px", boxShadow: "none"});
    expect(closeStyle.width).toBeCloseTo(44);
    expect(closeStyle.height).toBeCloseTo(44);
    expect(closeStyle.offsetX).toBeLessThan(1);
    expect(closeStyle.offsetY).toBeLessThan(1);
    expect(calls.length).toBe(start);
    await expect(frame.locator(".priority-square[data-preview-clipped]")).toHaveCount(0);
    await expect(frame.getByRole("button", {name: "Open full view"})).toHaveCount(0);
    await expect.poll(async () => (await list.getAttribute("data-enter-transitions"))?.split(" "))
      .toEqual(expect.arrayContaining(["background-color", "translate", "opacity"]));
    await expect.poll(() => list.evaluate(node => node.getAnimations({subtree: true}).length)).toBe(0);
    const closing = await list.evaluate(node => {
      node.querySelector<HTMLButtonElement>('button[aria-label="Close task list"]')!.click();
      const properties = node.getAnimations({subtree: true}).map(animation =>
        animation instanceof CSSTransition ? animation.transitionProperty : "");
      return {open: (node as HTMLDialogElement).open, properties};
    });
    expect(closing.open).toBe(true);
    expect(closing.properties).toEqual(expect.arrayContaining(["background-color", "translate", "opacity"]));
    await expect(list).toHaveCount(0);
    await overdue.tap();
    await list.tap({position: {x: 12, y: 8}});
    await expect(list).toHaveCount(0);
    await expect(overdue).toBeFocused();
    await overdue.tap();
    await task.tap();
    await expect(frame.getByText("Widget priority fixture notes.", {exact: true})).toBeVisible();
    await frame.getByRole("button", {name: "Back to previous view"}).click();
    await expect(task).toBeFocused();
    await list.getByRole("button", {name: "Close task list"}).tap();
    await chart.getByRole("button", {name:"High, Undated: 21 tasks"}).tap();
    await expect(list.locator("li")).toHaveCount(20);
    const panel = list.locator(".priority-sheet-panel");
    await expect.poll(() => panel.evaluate(element => {
      const card = element.closest(".widget-surface")!.getBoundingClientRect();
      return element.scrollHeight > element.clientHeight && element.getBoundingClientRect().bottom <= card.bottom;
    })).toBe(true);
    const heading = (await list.getByRole("heading").boundingBox())!;
    await verticalGesture(page, browserName, heading.x + 20, heading.y + 8, -55);
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const widgetScroll = frame.locator(".widget-scroll");
    await expect(widgetScroll).toHaveCSS("overflow-y", "hidden");
    const startScroll = await widgetScroll.evaluate(element => element.scrollTop);
    await page.locator("#card").evaluate(element => { element.style.minHeight = "150vh"; });
    const hostScroll = await page.evaluate(() => window.scrollY);
    const backdrop = (await list.boundingBox())!;
    await verticalGesture(page, browserName, backdrop.x + 5, backdrop.y + 85, -60);
    expect(await widgetScroll.evaluate(element => element.scrollTop)).toBe(startScroll);
    expect(await page.evaluate(() => window.scrollY)).toBe(hostScroll);
    await expect(list).toBeVisible();
    await frame.locator(".widget-surface").screenshot({path: info.outputPath("priority-sheet.png"), animations: "disabled"});
    const beforeMore = calls.length;
    await list.getByRole("button", {name:"Load more"}).click();
    await expect(list.locator("li")).toHaveCount(21);
    expect(offset).toBe(20);
    expect(calls.slice(beforeMore)).toEqual(["priority_grid"]);
    await expect(frame.locator(".priority-square[data-preview-clipped]")).toHaveCount(0);
    await list.getByRole("button", {name: "Close task list"}).tap();
    await expect(list).toHaveCount(0);
    await page.evaluate(() => {
      const iframe = document.querySelector("iframe")!;
      iframe.style.width = "1280px";
      iframe.contentWindow?.postMessage({
        jsonrpc: "2.0", method: "ui/notifications/host-context-changed",
        params: { displayMode: "fullscreen", containerDimensions: { width: 1280, height: 800 } },
      }, "*");
    });
    await expect(frame.locator(".widget-surface")).toHaveAttribute("data-display", "fullscreen");
    await expect(frame.getByRole("complementary", {name: "Navigation"})).toBeInViewport();
    await expect.poll(async () => Math.abs(await middleSquareOffsetFromPane(chart))).toBeLessThan(1);
  }
});
});


test("malformed chart data stays a local recoverable failure",async({page})=>{
 const empty={items:[],next_cursor:null};
 const task={id:"chart-failure-task",title:"Prepare the library workshop",brief:"Confirm the room.",status:"next",importance:"normal",archived:false,deleted:false,version:1,last_change_id:1};
 await page.route("**/api/view",route=>route.fulfill({json:{data:{next:{...empty,items:[task]},waiting:empty,someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}}}));
 await page.route("**/api/tools/activity_summary",route=>route.fulfill({json:{has_history:false}}));
 await page.goto("/");
 await expect(page.getByRole("button",{name:`Details: ${task.title}`,exact:true})).toBeVisible();
 await expect(page.locator(".chart-error")).toContainText("Could not load chart data. Try again.");
 await expect(page.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
});
