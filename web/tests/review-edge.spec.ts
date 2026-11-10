import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function reviewCard(page: Page, selected = false) {
  const html = await readFile("dist/widget-adapter.html", "utf8");
  await page.route("**/__review-card", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body style='margin:0'></body>",
    }),
  );
  await page.goto("/__review-card");
  await page.evaluate(
    ({ html, selected }) => {
      const frame = document.createElement("iframe");
      frame.style.cssText = "width:320px;height:60px;border:0;display:block";
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      const tasks = Array.from({ length: selected ? 1 : 6 }, (_, i) => ({
        id: `review-${i}`,
        title: `Review task ${i + 1}`,
        notes: "The task details remain available.",
        links: [],
        location: null,
        status: "next",
        archived: false,
        deleted: false,
        version: 1,
        last_change_id: i + 1,
        due_date: null,
      }));
      const result = {
        items: tasks,
        history: [],
        next_offset: null,
        next_history_after: null,
      };
      (window as any).calls = [];
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data;
        const send = (v: any) =>
          frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
        if (m.method === "ui/initialize")
          send({ id: m.id, result: { hostContext: { theme: "dark" } } });
        if (m.method === "ui/notifications/initialized") {
          if (selected)
            send({
              method: "ui/notifications/tool-input",
              params: { arguments: { task_id: tasks[0].id } },
            });
          send({
            method: "ui/notifications/tool-result",
            params: { structuredContent: result },
          });
        }
        if (m.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(m.params.name))
          m.params = {...m.params, name:m.params.arguments.operation, arguments:m.params.arguments.arguments};
        if (m.method === "tools/call" && ["view_snapshot","widget_pages"].includes(m.params.name)) {
          send({id:m.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (m.method === "tools/call") {
          if (["gtd_ui_read","gtd_ui_write"].includes(m.params.name)) m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
          (window as any).calls.push(m.params.arguments);
          send({
            id: m.id,
            result:
              m.params.arguments.query === "offline"
                ? {
                    isError: true,
                    structuredContent: {
                      code: "storage_error",
                      message: "Search is temporarily unavailable.",
                    },
                  }
                : { structuredContent: result },
          });
        }
        if (m.method === "ui/notifications/size-changed")
          frame.style.height = `${m.params.height}px`;
      });
      frame.srcdoc = html;
      document.body.append(frame);
    },
    { html, selected },
  );
  const card = page.frameLocator("iframe");
  await expect(card.locator(".compact-row:visible")).toHaveCount(
    selected ? 1 : 4,
  );
  return card;
}

test("a failed search exposes recovery while the search field stays open", async ({
  page,
}) => {
  const card = await reviewCard(page);
  await card.getByRole("button", { name: "Search tasks", exact: true }).click();
  const search = card.getByRole("searchbox");
  await search.fill("offline");
  await search.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.length))
    .toBe(1);
  await expect(
    card.getByRole("button", { name: "View connection problem" }),
  ).toBeVisible();
  await expect(search).toHaveValue("offline");
  await expect(card.getByRole("alert")).toContainText(
    "Previously loaded tasks may not match",
  );
  await expect(card.getByRole("alert")).toContainText(
    "Search is temporarily unavailable.",
  );
});

test("paging cached results does not submit an unfinished search", async ({
  page,
}) => {
  const card = await reviewCard(page);
  await card.getByRole("button", { name: "Search tasks", exact: true }).click();
  await card.getByRole("searchbox").fill("unfinished query");
  await card
    .getByRole("button", { name: "Next task page", exact: true })
    .click();
  await expect(card.locator(".compact-row:visible")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).calls)).toEqual([]);
});

test("closing task details with the keyboard restores the disclosure trigger", async ({
  page,
}) => {
  const card = await reviewCard(page);
  const trigger = card.getByRole("button", {
    name: "Details: Review task 1",
    exact: true,
  });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await trigger.focus();
  await trigger.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
});

test("focused navigation overlays do not move the task or their own target", async ({
  page,
}) => {
  const card = await reviewCard(page, true);
  const toggle = card.getByRole("button", {
    name: "GTD navigation",
    exact: true,
  });
  const row = card.locator(".compact-row:visible");
  const before = await row.boundingBox();
  const corner = await toggle.boundingBox();
  for (let i = 0; i < 3; i++) {
    await toggle.click();
    await expect(card.getByRole("menu", { name: "GTD views" })).toBeVisible();
    expect(await toggle.boundingBox()).toEqual(corner);
    expect(await row.boundingBox()).toEqual(before);
    await toggle.click();
    await expect(card.getByRole("menu", { name: "GTD views" })).toHaveCount(0);
    await expect(toggle).toBeFocused();
  }
  await card
    .getByRole("button", { name: "More options: Review task 1" })
    .click();
  const menu = card.getByRole("menu", { name: "Task menu" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Details",
    "Edit",
    "Mark started",
    "Agent notes",
    "History",
    "Undo latest",
    "Archive",
  ]);
  await expect(card.getByText("About this card")).toHaveCount(0);
});

test("lists keep their toolbar and focused search restores focus to its toolbar", async ({
  page,
}) => {
  let card = await reviewCard(page);
  await expect(
    card.getByRole("button", { name: "GTD navigation" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: /list controls/ })).toHaveCount(
    0,
  );
  card = await reviewCard(page, true);
  const search = card.getByRole("button", {
    name: "Search tasks",
    exact: true,
  });
  await search.click();
  await card.getByRole("searchbox").press("Escape");
  await expect(card.getByRole("searchbox")).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("closing search cancels an unfinished query and clears an applied search explicitly", async ({
  page,
}) => {
  const card = await reviewCard(page, true);
  const open = card.getByRole("button", { name: "Search tasks", exact: true });
  await open.click();
  let search = card.getByRole("searchbox");
  await search.fill("unfinished query");
  await card.getByRole("button", { name: "Close search", exact: true }).click();
  await expect(search).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).calls)).toEqual([]);
  await expect(open).toBeFocused();
  await open.click();
  search = card.getByRole("searchbox");
  await expect(search).toHaveValue("");
  await search.fill("applied query");
  await search.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.length))
    .toBe(1);
  await search.press("Escape");
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.length))
    .toBe(2);
  expect(
    await page.evaluate(() => (window as any).calls[1].query),
  ).toBeUndefined();
  await expect(open).toBeFocused();
});

test("focused filters close on a second click, preserve settings, and return focus", async ({
  page,
}) => {
  const card = await reviewCard(page, true);
  const trigger = card.getByRole("button", {
    name: "Sort and filter tasks",
    exact: true,
  });
  const panel = card.getByRole("dialog", {
    name: "Sort and filter tasks",
    exact: true,
  });
  await trigger.click();
  await panel.getByRole("combobox", { name: "Sort tasks" }).selectOption("due");
  await panel.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(panel.getByRole("combobox", { name: "Sort tasks" })).toHaveValue(
    "due",
  );
  await trigger.click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(panel.getByRole("combobox", { name: "Sort tasks" })).toHaveValue(
    "due",
  );
});

test("a failed search retries its exact query without hiding the draft", async ({
  page,
}) => {
  const card = await reviewCard(page, true);
  await card.getByRole("button", { name: "Search tasks", exact: true }).click();
  await card.getByRole("searchbox").fill("offline");
  await card.getByRole("searchbox").press("Enter");
  await expect(card.getByRole("alert")).toContainText(
    "Search is temporarily unavailable.",
  );
  await card
    .getByRole("button", { name: "Retry refresh", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.length))
    .toBe(2);
  const calls = await page.evaluate(() => (window as any).calls);
  expect(calls[1]).toEqual(calls[0]);
  await expect(card.getByRole("searchbox")).toHaveValue("offline");
  await expect(card.getByRole("alert")).toContainText(
    "Search is temporarily unavailable.",
  );
});

test("selected-task view menu survives switching from filters and restores focus", async ({
  page,
}) => {
  const card = await reviewCard(page, true);
  const view = card.getByRole("button", {
    name: "GTD navigation",
    exact: true,
  });
  const menu = card.getByRole("menu", { name: "GTD views", exact: true });
  async function openViews() {
    await card
      .getByRole("button", { name: "Sort and filter tasks", exact: true })
      .click();
    await expect(
      card.getByRole("dialog", { name: "Sort and filter tasks" }),
    ).toBeVisible();
    await view.click();
    await expect(menu).toBeVisible();
    await expect(view).toHaveAttribute("aria-expanded", "true");
  }
  await openViews();
  await view.click();
  await expect(menu).toHaveCount(0);
  await expect(view).toBeFocused();
  await openViews();
  await menu.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(view).toBeFocused();
  await openViews();
  await menu
    .getByRole("menuitemradio", { name: "All tasks", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(view).toContainText("All tasks");
  await expect(view).toBeFocused();
  await expect(card.getByRole("button", { name: /list controls/ })).toHaveCount(
    0,
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.at(-1)))
    .toEqual({
      view: "all",
      archived: false,
      group_recurrences: true,
    });
});
