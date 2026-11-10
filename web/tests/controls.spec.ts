import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function card(page: Page, width: number) {
  const html = await readFile("dist/widget-adapter.html", "utf8");
  await page.route("**/__controls", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body style='margin:0'></body>",
    }),
  );
  await page.goto("/__controls");
  await page.evaluate(
    ({ html, width }) => {
      const frame = document.createElement("iframe");
      frame.style.cssText = `width:${width}px;height:60px;border:0;display:block`;
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      const tasks = Array.from({ length: 12 }, (_, i) => ({
        id: `control-${i}`,
        title: i
          ? `Task ${i} café 日本語 👋`
          : "VeryLongUnbrokenTitle".repeat(15),
        notes: "LongUnbrokenNotes".repeat(50),
        links: [
          { label: "LongLinkLabel".repeat(40), url: "https://example.com/" },
        ],
        location: "A very long address ".repeat(20),
        status: "next",
        archived: false,
        deleted: false,
        version: 1,
        last_change_id: i + 1,
        due_date: null,
      }));
      (window as any).sizes = [];
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data;
        // Simulate the app-only facade used by the authenticated adapter.
        if (m.method === "tools/call" && ["gtd_ui_read", "gtd_ui_write"].includes(m.params.name)) {
          m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
        }
        const send = (v: any) =>
          frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
        const result = (args: any = {}) => ({
          items:
            args.query === "missing"
              ? []
              : args.task_id
                ? tasks.filter((t) => t.id === args.task_id)
                : tasks.slice(args.offset || 0, (args.offset || 0) + 6),
          next_offset:
            args.task_id || args.query === "missing" || args.offset ? null : 6,
          history: [],
          next_history_after: null,
        });
        if (m.method === "ui/initialize")
          send({
            id: m.id,
            result: {
              hostContext: { theme: "dark", availableDisplayModes: ["inline"] },
            },
          });
        if (m.method === "ui/notifications/initialized")
          send({
            method: "ui/notifications/tool-result",
            params: { structuredContent: result() },
          });
        if (m.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(m.params.name))
          m.params = {...m.params, name:m.params.arguments.operation, arguments:m.params.arguments.arguments};
        if (m.method === "tools/call" && ["view_snapshot","widget_pages"].includes(m.params.name)) {
          send({id:m.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (m.method === "tools/call")
          send({
            id: m.id,
            result: { structuredContent: result(m.params.arguments) },
          });
        if (
          m.method === "ui/notifications/size-changed" ||
          m.method === "fixture/auto-size"
        ) {
          (window as any).sizes.push(m.params.height);
          frame.style.height = m.params.height + "px";
        }
      });
      frame.srcdoc = html.replace(
        '<div id="root"></div>',
        '<div id="root"></div><script>const surface=document.getElementById("root");new ResizeObserver(()=>parent.postMessage({method:"fixture/auto-size",params:{height:Math.ceil(surface.getBoundingClientRect().height)}},"*")).observe(surface);</script>',
      );
      document.body.append(frame);
    },
    { html, width },
  );
  const f = page.frameLocator("iframe");
  await expect(f.locator(".compact-row:visible")).toHaveCount(4);
  return f;
}
for (const width of [320, 640]) {
  test(`card controls keep rows stable and search can page at ${width}px`, async ({
    page,
  }) => {
    const f = await card(page, width);
    const before = await f
      .locator(".compact-row:visible")
      .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().toJSON()));
    await f.getByRole("button", { name: "Search tasks", exact: true }).click();
    await expect(f.getByRole("searchbox")).toBeFocused();
    expect(
      await f
        .locator(".compact-row:visible")
        .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().toJSON())),
    ).toEqual(before);
    await f.getByRole("searchbox").fill("missing");
    await f.getByRole("searchbox").press("Enter");
    await expect(f.getByText("No matching tasks")).toBeVisible();
    await f.getByRole("searchbox").fill("");
    await f.getByRole("searchbox").press("Enter");
    await f.getByRole("button", { name: "Next task page" }).click();
    await expect(
      f.getByText("Task 4 café 日本語 👋", { exact: true }),
    ).toBeVisible();
    await f.getByRole("button", { name: "Next task page" }).click();
    await expect(
      f.getByText("Task 6 café 日本語 👋", { exact: true }),
    ).toBeVisible();
    await f.getByRole("button", { name: "Previous task page" }).click();
    await f.getByRole("searchbox").press("Escape");
    await expect(
      f.getByRole("button", { name: "Search tasks", exact: true }),
    ).toBeFocused();
    expect(
      await f.locator("body").evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBeTruthy();
  });
  test(`scope and filter popups stay placed and aligned at ${width}px`, async ({
    page,
  }) => {
    const f = await card(page, width);
    const trigger = f.getByRole("button", { name: "GTD navigation" });
    await trigger.click();
    const menu = f.getByRole("menu", { name: "GTD views" });
    await expect(
      menu.getByRole("menuitem", { name: "Add task", exact: true }),
    ).toBeFocused();
    await trigger.click();
    await expect(menu).toHaveCount(0);
    await trigger.click();
    await menu
      .getByRole("menuitem", { name: "Add task", exact: true })
      .press("End");
    await expect(
      menu.getByRole("menuitemradio", { name: "Activity", exact: true }),
    ).toBeFocused();
    await menu
      .getByRole("menuitemradio", { name: "Activity", exact: true })
      .press("Escape");
    await expect(trigger).toBeFocused();
    await f
      .getByRole("button", { name: "Sort and filter tasks", exact: true })
      .click();
    const panel = f.getByRole("dialog", { name: "Sort and filter tasks" });
    await expect(panel).toBeVisible();
    const frames = await panel.evaluate(async (e) => {
      const frames: any[] = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const tick = () => {
          frames.push({
            side: (e as HTMLElement).dataset.placement,
            x: e.getBoundingClientRect().x,
          });
          performance.now() - start < 450
            ? requestAnimationFrame(tick)
            : resolve();
        };
        tick();
      });
      return frames;
    });
    expect(new Set(frames.map((f) => f.side)).size).toBe(1);
    const dates = await panel.locator('.filter-date-control').evaluateAll(es => es.map(e => e.getBoundingClientRect().toJSON()));
    expect(dates).toHaveLength(4);
    for (const box of dates) expect(Math.abs(box.width - dates[0].width)).toBeLessThan(1);
    if (width >= 360) { expect(dates[0].y).toBe(dates[1].y); expect(dates[2].y).toBe(dates[3].y); }
    await panel
      .getByRole("textbox", { name: "Due from", exact: true })
      .fill("2026-10-01");
    await panel
      .getByRole("textbox", { name: "Due through", exact: true })
      .fill("2026-10-30");
    await panel
      .getByRole("combobox", { name: "Sort tasks" })
      .selectOption("due");
    await panel.getByRole("checkbox", { name: "Undated", exact: true }).check();
    await expect(
      panel.getByRole("textbox", { name: "Due from", exact: true }),
    ).toHaveValue("");
    await panel.getByRole("button", { name: "Clear filters" }).click();
    await panel.press("Escape");
    await expect(panel).toHaveCount(0);
  });
  test(`long details and rapid cross-control transitions stay bounded at ${width}px`, async ({
    page,
  }) => {
    const f = await card(page, width);
    // Use the rendered task's accessible control, including its deliberately long name.
    await f.getByRole("button", { name: "Expand view", exact: true }).click();
    const detail = f.getByRole("button", { name: /^Details:/ }).first();
    await detail.click();
    await expect(f.getByRole("link").first()).toBeVisible();
    expect(
      await f.locator("body").evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBeTruthy();
    await detail.click();
    await detail.click();
    await detail.click();
    await expect(detail).toHaveAttribute("aria-expanded", "false");
    await f.getByRole("button", { name: "Search tasks", exact: true }).click();
    await f.getByRole("searchbox").press("Escape");
    await f.getByRole("button", { name: "GTD navigation" }).click();
    await f
      .getByRole("button", { name: "Sort and filter tasks", exact: true })
      .click();
    await expect(f.getByRole("menu", { name: "GTD views" })).toHaveCount(0);
    await expect(f.getByRole("dialog")).toHaveCount(1);
  });
}
