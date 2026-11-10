import { fixtureContent } from "./helpers/content";
import { test, expect, type Locator } from "@playwright/test";
import { openWidget, title as widgetTitle, projectTitle } from "./helpers/widget-host";
async function fillTiming(e: Locator) {
  await e.getByLabel("Importance", { exact: true }).selectOption("very_high");
  await e.getByLabel("Deadline", { exact: true }).fill("2027-04-16");
  await e.getByRole("button", { name: "Timing", exact: true }).click();
  await e
    .getByRole("button", { name: "Add time to deadline", exact: true })
    .click();
  await e.getByLabel("Deadline time", { exact: true }).fill("12:00");
  await e.getByLabel("Start by", { exact: true }).fill("2027-04-15");
  await e.getByRole("button", { name: "Add block", exact: true }).click();
  for (const [name, clock] of [
    ["Planned start", "14:00"],
    ["Planned finish", "15:00"],
  ]) {
    await e.getByLabel(name, { exact: true }).fill("2027-04-14");
    await e
      .getByRole("button", {
        name: `Add time to ${name.toLowerCase()}`,
        exact: true,
      })
      .click();
    await e.getByLabel(`${name} time`, { exact: true }).fill(clock);
  }
}
async function bounded(e: Locator) {
  await expect(e.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  const bad = await e.locator("input,select,textarea").evaluateAll((nodes) =>
    nodes
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.left < 0 || r.right > innerWidth + 1);
      })
      .map((el) => el.getAttribute("aria-label") || el.outerHTML.slice(0, 100)),
  );
  expect(bad).toEqual([]);
  const offsets = await e.locator(".planning-clock-row").evaluateAll((rows) =>
    rows.map((row) => {
      const input = row.querySelector("input")!.getBoundingClientRect();
      const button = row.querySelector("button")!.getBoundingClientRect();
      return Math.abs(
        (input.top + input.bottom - button.top - button.bottom) / 2,
      );
    }),
  );
  for (const offset of offsets) expect(offset).toBeLessThan(1);
  expect(
    (await e.getByLabel("Importance", { exact: true }).boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
}
for (const width of [320, 390, 1280])
  test(`website planning edits and conflict drafts at ${width}`, async ({
    page,
    request,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({
      colorScheme: width === 390 ? "dark" : "light",
      reducedMotion: "reduce",
    });
    const headers = { Origin: baseURL!, "X-GTD-Request": "1" };
    const call = async (name: string, args: object) => {
      const r = await request.post(`/api/tools/${name}`, {
        headers,
        data: fixtureContent(name, args),
      });
      expect(r.ok()).toBeTruthy();
      return r.json();
    };
    const title = "Planning " + crypto.randomUUID().slice(0, 8);
    const { task } = await call("capture_item", {
      title,
      notes: "Prepare the application. " + "LongText".repeat(80),
      status: "next",
      estimated_minutes: 30, effort: "medium",
      importance: width === 320 ? "critical" : width === 390 ? "very_high" : "high",
      request_id: crypto.randomUUID(),
      reason: "Isolated planning UI fixture",
    });
    await page.route("**/api/tools/list_items", (route) =>
      route.continue({
        postData: JSON.stringify({
          ...route.request().postDataJSON(),
          task_id: task.id,
        }),
      }),
    );
    await page.goto("/");
    const disclosure = page.getByRole("button", { name: `Details: ${title}`, exact: true }).first();
    await disclosure.click();
    await page.locator(".importance-badge").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("importance-badge.png") });
    await disclosure.click();
    await page
      .getByRole("button", { name: `More options: ${title}`, exact: true })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const e = page.getByRole("region", { name: "Task details", exact: true });
    await fillTiming(e);
    await bounded(e);
    await e
      .getByLabel("Planned finish time", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("planning-editor.png") });
    const write = page.waitForResponse(response =>
      response.url().endsWith("/api/tools/update_item") && response.request().method() === "POST",
    );
    await e.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await write).ok()).toBeTruthy();
    await expect(e.getByText("All changes saved", { exact: true })).toBeVisible();
    await expect(
      e.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeDisabled();
    const saved = (await call("list_items", { task_id: task.id })).items[0];
    expect(saved.importance).toBe("very_high");
    expect(saved.deadline_time.time).toBe("12:00");
    expect(saved.planned_finish.time).toBe("15:00");
    expect(saved.started).toBe(false);
    await e.getByLabel("Importance", { exact: true }).selectOption("critical");
    await call("update_item", {
      task_id: task.id,
      expected_version: saved.version,
      notes: "Updated independently",
      request_id: crypto.randomUUID(),
      reason: "Conflict fixture",
    });
    await expect(e.getByLabel("Importance", { exact: true })).toHaveValue(
      "critical",
    );
    await expect(e.getByText(/changed|conflict|version/i).first()).toBeVisible({
      timeout: 10000,
    });
    await bounded(e);
  });
for (const width of [320, 390, 900])
  test(`widget planning preserves drafts at ${width}`, async ({
    page,
  }, info) => {
    const displayedProject = width === 320
      ? "Prepare the weekly review and organize everything for the coming quarter"
      : projectTitle;
    const { frame, surface, changeMode, requests } = await openWidget(page, {
      width,
      long: false,
      taskProject: true,
      projectName: displayedProject,
    });
    await frame
      .getByRole("button", {
        name: `More options: ${widgetTitle}`,
        exact: true,
      })
      .click();
    await frame.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(surface).toHaveAttribute("data-display", "fullscreen");
    const e = frame.getByRole("region", { name: "Task details", exact: true });
    await fillTiming(e);
    await bounded(e);
    await changeMode("inline");
    await expect(surface).toHaveAttribute("data-display", "preview");
    await frame
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expect(
      e.getByLabel("Planned start time", { exact: true }),
    ).toHaveValue("14:00");
    await e
      .getByLabel("Planned finish time", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("widget-planning.png") });
    await e.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(
      e.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeDisabled();
    const writes = (await requests("tools/call")).filter(
      (r: any) => r.params.name === "update_item",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].params.arguments.importance).toBe("very_high");
    expect(writes[0].params.arguments.work_blocks[0].start.time).toBe("14:00");
    await frame.getByRole("button", { name: "Close details", exact: true }).click();
    await frame.getByRole("button", { name: `More options: ${widgetTitle}`, exact: true }).click();
    await frame.getByRole("menuitem", { name: "Mark started", exact: true }).click();
    await expect(frame.getByRole("button", { name: `Mark complete: ${widgetTitle}`, exact: true })).toHaveAccessibleDescription("Started");
    await frame.getByRole("button", { name: `Details: ${widgetTitle}`, exact: true }).click();
    await expect(frame.locator(".importance-badge")).toBeVisible();
    const projectLink = frame.getByRole("button", { name: displayedProject, exact: true });
    await expect(projectLink).toBeVisible();
    await expect(frame.locator(".task-expansion[data-resizing]")).toHaveCount(0);
    const statusBox = (await frame.locator(".status-badge").boundingBox())!;
    const projectBox = (await projectLink.boundingBox())!;
    const notesBox = (await frame.locator(".task-reading-notes").first().boundingBox())!;
    expect(Math.abs(projectBox.x - statusBox.x)).toBeLessThan(1);
    expect(statusBox.y - projectBox.y - projectBox.height).toBeGreaterThanOrEqual(3.5);
    await expect(projectLink.locator(".metadata-badge")).toHaveCount(0);
    await expect(projectLink.locator("svg")).toBeVisible();
    if (width === 320) {
      const projectName = projectLink.locator(".project-name");
      expect(await projectName.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      await expect(projectName).toHaveCSS("text-overflow", "ellipsis");
      await expect(projectLink).toHaveAttribute("title", displayedProject);
    }
    expect(projectBox.y + projectBox.height).toBeLessThanOrEqual(notesBox.y);
    await expect(frame.locator(".task-title").first()).toBeVisible();
    if (width === 320) await expect(frame.locator(".date-chip")).toBeHidden();
    else {
      await expect(frame.locator(".date-chip")).toBeVisible();
      if (width === 390) await expect(frame.locator(".date-chip-time")).toBeHidden();
      else await expect(frame.locator(".date-chip-time")).toBeVisible();
    }
    await frame.locator(".importance-badge").scrollIntoViewIfNeeded();
    const deadline = frame.locator(".metadata-row").filter({ hasText: "Deadline:" });
    await expect(deadline.locator(".metadata-date")).toHaveText("Apr 16, 2027");
    await expect(deadline.locator(".metadata-time")).toHaveText("12:00 PM EDT");
    const dateBox = (await deadline.locator(".metadata-date").boundingBox())!;
    const timeBox = (await deadline.locator(".metadata-time").boundingBox())!;
    if (width < 440) expect(timeBox.y).toBeGreaterThanOrEqual(dateBox.y + dateBox.height - 1);
    else expect(Math.abs(timeBox.y - dateBox.y)).toBeLessThan(1);
    await expect(frame.locator(".planning-context")).not.toContainText("America/New_York");
    const overflow = await frame.locator(".metadata-row").evaluateAll(rows => rows.some(row => row.scrollWidth > row.clientWidth + 1));
    expect(overflow).toBe(false);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath("widget-importance-badge.png") });
    await frame.getByRole("button", { name: `More options: ${widgetTitle}`, exact: true }).click();
    await frame.getByRole("menuitem", { name: "Reset started", exact: true }).click();
    await expect(frame.locator(".task-started-icon")).toHaveCount(0);
    await projectLink.click();
    await expect(frame.getByRole("heading", { name: displayedProject, exact: true })).toBeVisible();
  });

for (const width of [390, 1280])
  test(`started indicator preserves completion and undo at ${width}`, async ({ page, request, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light", reducedMotion: "reduce" });
    const headers = { Origin: baseURL!, "X-GTD-Request": "1" };
    const response = await request.post("/api/tools/capture_item", { headers, data: { brief: "Review the proposal and send feedback.", title: "Review the proposal", status: "next", notes: "Confirm the scope, then send feedback to the team.", importance: "high", estimated_minutes: 30, effort: "medium", request_id: crypto.randomUUID(), reason: "Disposable progress indicator fixture" } });
    expect(response.ok()).toBeTruthy();
    const { task } = await response.json();
    await page.route("**/api/tools/list_items", route => {
      const args = route.request().postDataJSON();
      return route.continue({ postData: JSON.stringify(args.task_id ? args : { ...args, task_ids: [task.id] }) });
    });
    await page.route("**/api/tools/list_projects", route => route.fulfill({ json: { projects: [], next_cursor: null } }));
    await page.goto(`/tasks?task_id=${task.id}&view=all&status=next`);
    const complete = page.getByRole("button", { name: `Mark complete: ${task.title}`, exact: true });
    const menu = page.getByRole("button", { name: `More options: ${task.title}`, exact: true });
    const start = async () => {
      await menu.click();
      await page.getByRole("menuitem", { name: "Mark started", exact: true }).click();
      await expect(complete).toHaveAccessibleDescription("Started");
      await expect(complete).toHaveAttribute("aria-pressed", "false");
      await expect(complete.locator(".task-started-icon")).toBeVisible();
    };
    await expect(complete.locator(".task-started-icon")).toHaveCount(0);
    await start();
    await page.reload();
    await expect(complete).toHaveAccessibleDescription("Started");
    await page.getByRole("button", { name: `Details: ${task.title}`, exact: true }).click();
    await expect(page.locator(".task-expansion[data-resizing]")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("started-task.png") });
    await menu.click();
    await page.getByRole("menuitem", { name: "Reset started", exact: true }).click();
    await expect(complete.locator(".task-started-icon")).toHaveCount(0);
    await start();
    await complete.click();
    await expect(complete).toHaveCount(0);
    await page.getByRole("button", { name: "Undo last change", exact: true }).click();
    await expect(complete).toHaveAccessibleDescription("Started");
    const saved = await request.post("/api/tools/list_items", { headers, data: { task_id: task.id } });
    const current = (await saved.json()).items[0];
    expect(current.status).toBe("next");
    expect(current.started).toBe(true);
  });
