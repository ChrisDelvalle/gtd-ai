import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function fixture(
  page: Page,
  view: "review" | "activity" | "help",
  { width = 390, empty = false, denied = false, dark = true } = {},
) {
  await page.setViewportSize({ width: Math.max(390, width), height: 900 });
  const html = await readFile("dist/widget-adapter.html", "utf8");
  await page.route("**/__secondary", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body style='margin:0'><p>Conversation before</p><div id='card'></div><p>Conversation after</p></body>",
    }),
  );
  await page.goto("/__secondary");
  await page.evaluate(
    ({ html, view, width, empty, denied, dark }) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      frame.style.cssText = `width:${width}px;height:100px;border:0`;
      let mode = "inline";
      const calls: any[] = [];
      const records = Array.from({ length: empty ? 0 : 9 }, (_, i) => ({
        id: `task-${i}`,
        title:
          i === 1
            ? "Review an unusually long task title that still fits naturally into two concise lines on a narrow screen"
            : `Review item ${i + 1}`,
        notes: "## Context\nRead the brief and choose the next action.",
        status: "next",
        due_date: null,
        review_date: "2026-10-01",
        version: 1,
        last_change_id: i + 1,
        deleted: false,
        archived: false,
      }));
      const projects = empty
        ? []
        : [
            {
              ...records[0],
              id: "project-1",
              title: "Autumn project",
              entity_type: "project",
              status: "active",
              task_counts: { next: 0 },
            },
          ];
      const changes = records.map((task, i) => ({
        id: i + 100,
        task_id: task.id,
        entity_id: task.id,
        entity_type: i === 3 ? "recurrence" : "task",
        detail: "summary",
        operation: i === 3 ? "create_recurrence" : i ? "update" : "capture",
        changed_fields: i === 3 ? ["title", "deleted", "status"] : [i ? "notes" : "title"],
        reason: "Internal audit reason should not be in the compact list.",
        before: null,
        after: task,
        created_at: `2026-10-04T12:${String(i).padStart(2, "0")}:00Z`,
        origin: "mcp",
        undoes_change_id: null,
      }));
      const send = (message: any) =>
        frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...message }, "*");
      const context = () => ({
        theme: dark ? "dark" : "light",
        displayMode: mode,
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions:
          mode === "fullscreen"
            ? { width, height: 760 }
            : { width, maxHeight: 450 },
      });
      (window as any).secondary = {
        calls,
        back: () => {
          mode = "inline";
          send({
            method: "ui/notifications/host-context-changed",
            params: context(),
          });
        },
      };
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data;
        if (m.method === "ui/initialize")
          send({ id: m.id, result: { hostContext: context() } });
        if (m.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: { arguments: { view } },
          });
          send({
            method: "ui/notifications/tool-result",
            params: { structuredContent: { app: "gtd", view } },
          });
        }
        if (m.method === "ui/request-display-mode") {
          mode = denied ? "inline" : "fullscreen";
          if (mode === "fullscreen") frame.style.height = "760px";
          send({ id: m.id, result: { mode } });
          send({
            method: "ui/notifications/host-context-changed",
            params: context(),
          });
        }
        if (m.method === "ui/notifications/size-changed" && mode === "inline")
          frame.style.height = `${m.params.height}px`;
        if (m.method === "tools/call") {
          if (["gtd_ui_read","gtd_ui_write"].includes(m.params.name)) m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
          const { name, arguments: args } = m.params;
          calls.push({ name, args });
          if (["widget_pages", "view_snapshot"].includes(name)) {
            send({id:m.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
          }
          let result: any = {};
          if (name === "list_items")
            result = {
              items: records.filter(
                (task) => !args.task_id || args.task_id === task.id,
              ),
              history: [],
              next_cursor: null,
              next_offset: null,
            };
          if (name === "list_projects")
            result = { projects, next_cursor: null };
          if (name === "list_changes")
            result = {
              changes: args.change_id
                ? changes
                    .filter((change) => change.id === args.change_id)
                    .map((change) => ({ ...change, detail: "full" }))
                : changes,
              next_before_id: null,
            };
          send({ id: m.id, result: { structuredContent: result } });
        }
      });
      frame.srcdoc = html;
      document.getElementById("card")!.append(frame);
    },
    { html, view, width, empty, denied, dark },
  );
  return page.frameLocator("iframe");
}

for (const width of [320, 390, 760])
  test(`compact Review is a concise paged list at ${width}px`, async ({
    page,
  }, info) => {
    const card = await fixture(page, "review", { width, dark: width < 500 });
    await expect(
      card.getByRole("region", { name: "Items to review" }),
    ).toBeVisible();
    await expect(card.locator(".secondary-rows > *:visible")).toHaveCount(4);
    await expect(
      card.getByText("Reconsider these items.", { exact: false }),
    ).toBeHidden();
    await expect(
      card.getByRole("button", { name: "Create project", exact: true }),
    ).toHaveCount(0);
    await expect(
      card.getByRole("button", { name: "Open full view", exact: true }),
    ).toHaveCount(0);
    expect(
      (await page.locator("iframe").boundingBox())!.height,
    ).toBeLessThanOrEqual(450);
    expect(
      await card
        .locator("body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const taskButton = card.getByRole("button", {name: "Details: Review item 1", exact: true});
    expect(await taskButton.evaluate(el => ({border: getComputedStyle(el).borderTopWidth, align: getComputedStyle(el).textAlign, flex: getComputedStyle(el).flexGrow}))).toEqual({border: "0px", align: "left", flex: "1"});
    const titleBox = (await taskButton.boundingBox())!;
    const caretBox = (await taskButton.locator('.disclosure-chevron').boundingBox())!;
    expect(caretBox.y - titleBox.y).toBeLessThan(12);
    expect(await card.getByRole('button', {name: 'Next page', exact: true}).evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('0px');
    await page.screenshot({ path: info.outputPath("review.png") });
    await card.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(card.getByLabel("Page 2", { exact: true })).toBeVisible();
    await card
      .getByRole("button", { name: "GTD navigation", exact: true })
      .click();
    await expect(
      card.getByRole("menuitemradio", { name: "Help", exact: true }),
    ).toHaveCount(0);
    await card
      .getByRole("menuitemradio", { name: "Activity", exact: true })
      .click();
    await card
      .getByRole("button", { name: "GTD navigation", exact: true })
      .click();
    await card
      .getByRole("menuitemradio", { name: "Review", exact: true })
      .click();
    await expect(card.getByLabel("Page 2", { exact: true })).toBeVisible();
    const backIcon = (await card.getByRole('button', {name: 'Back to previous view', exact: true}).locator('svg').boundingBox())!;
    const expandIcon = (await card.getByRole('button', {name: 'Expand view', exact: true}).locator('svg').boundingBox())!;
    expect(Math.abs(backIcon.y + backIcon.height / 2 - expandIcon.y - expandIcon.height / 2)).toBeLessThan(2);
    await page.screenshot({ path: info.outputPath("review-return.png") });
    const reads = await page.evaluate(() => (window as any).secondary.calls);
    expect(
      reads
        .filter((call: any) =>
          ["list_items", "list_projects"].includes(call.name),
        )
        .every((call: any) => !!call.args.review_on),
    ).toBe(true);
    expect(reads.some((call: any) => call.args.include_agent_notes)).toBe(
      false,
    );
  });

test("compact Review has one quiet empty state", async ({ page }) => {
  const card = await fixture(page, "review", { empty: true });
  await expect(
    card.getByText("Nothing to review.", { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("navigation", { name: "List pages" }),
  ).toHaveCount(0);
  await expect(
    card.getByText("No matching tasks", { exact: true }),
  ).toHaveCount(0);
  expect((await page.locator("iframe").boundingBox())!.height).toBeLessThan(
    150,
  );
});

test("compact Review task editing expands into the shared inspector", async ({
  page,
}) => {
  const card = await fixture(page, "review");
  await card
    .getByRole("button", { name: "More options: Review item 1", exact: true })
    .click();
  await card.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(card.locator(".widget-surface")).toHaveAttribute(
    "data-display",
    "fullscreen",
  );
  await expect(
    card.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("## Context\nRead the brief and choose the next action.");
  const calls = await page.evaluate(() => (window as any).secondary.calls);
  expect(
    calls.some((call: any) => Object.hasOwn(call.args, "open_panel")),
  ).toBe(false);
});

for (const width of [320, 390, 760])
  test(`compact Activity shows titles and human actions at ${width}px`, async ({
    page,
  }, info) => {
    const card = await fixture(page, "activity", { width, dark: width < 500 });
    await expect(card.getByText("Started repeating", {exact: false})).toBeVisible();
    await expect(card.getByText("Restored", {exact: false})).toHaveCount(0);
    await expect(
      card.getByRole("region", { name: "Recent activity" }),
    ).toBeVisible();
    await expect(card.locator(".secondary-record")).toHaveCount(4);
    await expect(
      card.getByText(
        "Internal audit reason should not be in the compact list.",
      ),
    ).toHaveCount(0);
    await expect(card.getByText(/field.*changed/)).toHaveCount(0);
    await expect(
      card.getByRole("button", { name: "Open full view", exact: true }),
    ).toHaveCount(0);
    expect(
      (await page.locator("iframe").boundingBox())!.height,
    ).toBeLessThanOrEqual(450);
    await page.screenshot({ path: info.outputPath("activity.png") });
    await card.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(card.getByLabel("Page 2", { exact: true })).toBeVisible();
    await card
      .getByRole("button", { name: "Previous page", exact: true })
      .click();
    await card
      .getByRole("button", { name: "View change: Review item 1", exact: true })
      .click();
    await expect(card.locator(".widget-surface")).toHaveAttribute(
      "data-display",
      "fullscreen",
    );
    await expect(
      card.getByText(
        "Internal audit reason should not be in the compact list.",
        { exact: true },
      ),
    ).toBeVisible();
    await card
      .getByRole("button", { name: "Back to activity", exact: true })
      .click();
    await expect(card.locator(".activity .change")).toHaveCount(9);
  });

for (const denied of [false, true])
  test(`Help previews with a fade and expands explicitly (${denied ? "fallback" : "fullscreen"})`, async ({page}, info) => {
    const card = await fixture(page, "help", { denied });
    await expect(card.locator(".widget-surface")).toHaveAttribute("data-display", "preview");
    await expect(card.getByRole("heading", {name: "Getting things done", exact: true})).toBeVisible();
    await expect(card.getByRole("button", {name: "Read Help", exact: true})).toHaveCount(0);
    await expect(card.getByRole("button", {name: "Open full view", exact: true})).toBeVisible();
    expect((await page.locator("iframe").boundingBox())!.height).toBeLessThanOrEqual(450);
    await page.screenshot({path: info.outputPath("help-preview.png")});
    await card.getByRole("button", {name: "Open full view", exact: true}).click();
    await expect(card.locator(".widget-surface")).toHaveAttribute("data-display", denied ? "fallback" : "fullscreen");
    if (denied) await card.getByRole("button", {name:"Return to preview",exact:true}).click();
    else await page.evaluate(() => (window as any).secondary.back());
    await expect(card.locator(".widget-surface")).toHaveAttribute("data-display", "preview");
    await expect(card.getByRole("button", {name: "Open full view", exact: true})).toBeVisible();
  });

test("scrolled widget navigation keeps its position when the host resizes", async ({page}) => {
  const card=await fixture(page,"activity",{width:320});
  await card.getByRole("button",{name:"GTD navigation",exact:true}).click();
  const menu=card.getByRole("menu",{name:"GTD views"});
  await menu.evaluate(el=>{el.scrollTop=100;});
  await expect.poll(()=>menu.evaluate(el=>el.scrollTop)).toBeGreaterThan(50);
  const before=await menu.evaluate(el=>el.scrollTop);
  await page.locator('iframe').evaluate(el=>{el.style.width='321px';});
  await menu.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(()=>menu.evaluate((el, previous)=>Math.abs(el.scrollTop-previous),before)).toBeLessThan(2);
  await card.getByRole("menuitemradio",{name:"Review",exact:true}).click();
  await expect(card.getByRole("region",{name:"Items to review"})).toBeVisible();
});
