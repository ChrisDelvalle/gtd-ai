import { fixtureContent } from "./helpers/content";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
const origin = process.env.GTD_BASE_URL || "http://127.0.0.1:18081";
const headers = { Origin: origin, "X-GTD-Request": "1" };
const seed = () => ({
  brief: "Review the resources and bring the required documents.",
  request_id: randomUUID(),
  title: "Context " + randomUUID().slice(0, 8),
  status: "next",
  importance: "normal",
  estimated_minutes: 30,
  effort: "medium",
  due_date: "2025-01-01",
  notes:
    "Bring your ID.\nRead [the brief](https://example.com/brief) or https://example.org/guide. [Article](https://example.org/guide_(reference)).\n<script>window.unsafe=true</script> [bad](javascript:alert(1))",
  links: [
    { url: "https://example.com/form", label: "Application form" },
    { url: "https://example.net/reference" },
  ],
  location: "Library, 10 Main St & 2nd Ave",
  reason: "Synthetic context verification",
});
test("website resources, edits, refresh, undo and responsive layout", async ({
  page,
  request,
}) => {
  const create = await request.post("/api/tools/capture_item", {
    headers,
    data: seed(),
  });
  expect(create.ok()).toBeTruthy();
  const { task: captured } = await create.json();
  const full = await request.post("/api/tools/list_items", {
    headers,
    data: { task_id: captured.id, detail: "full" },
  });
  const task = (await full.json()).items[0];
  await page.route("**/api/tools/list_items", async (route) => {
    const args = route.request().postDataJSON();
    await route.continue({
      postData: JSON.stringify({ ...args, ...(args.task_id ? {} : {task_ids:[task.id]}) }),
    });
  });
  await page.route("**/api/view",async route=>{
    const response=await request.post("/api/tools/list_items",{headers,data:{task_id:task.id}});
    const next=await response.json(),empty={items:[],next_cursor:null};
    await route.fulfill({json:{data:{next,waiting:empty,someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}}});
  });
  await page.goto("/");
  const focus = page.getByRole("region", { name: "Next action", exact: true });
  await focus.getByRole("button", { name: `Details: ${task.title}`, exact: true }).click();
  await expect(
    focus.getByRole("link", { name: "Application form", exact: true }),
  ).toHaveAttribute("href", "https://example.com/form");
  await expect(
    focus.getByRole("link", { name: "example.net", exact: true }),
  ).toHaveAttribute("target", "_blank");
  await expect(
    focus.getByRole("link", { name: "the brief", exact: true }),
  ).toHaveAttribute("href", "https://example.com/brief");
  await expect(
    focus.getByRole("link", { name: "https://example.org/guide", exact: true }),
  ).toHaveAttribute("href", "https://example.org/guide");
  await expect(
    focus.getByRole("link", { name: "Article", exact: true }),
  ).toHaveAttribute("href", "https://example.org/guide_(reference)");
  const map = focus.getByRole("link", { name: task.location, exact: true });
  expect(
    new URL((await map.getAttribute("href"))!).searchParams.get("query"),
  ).toBe(task.location);
  expect(await page.evaluate(() => (window as any).unsafe)).toBeUndefined();
  await expect(focus.locator('a[href^="javascript:"]')).toHaveCount(0);
  await focus
    .getByRole("button", { name: `More options: ${task.title}` })
    .click();
  await focus.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("region", {
    name: "Task details",
    exact: true,
  });
  await expect(
    editor.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await editor
    .getByRole("textbox", { name: "Link 1 label", exact: true })
    .fill("Open application");
  await editor
    .getByRole("textbox", { name: "Location", exact: true })
    .fill("New location");
  // A background refresh must keep the structured-field draft.
  await page.waitForTimeout(5200);
  await expect(
    editor.getByRole("textbox", { name: "Location", exact: true }),
  ).toHaveValue("New location");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(
    focus.getByRole("link", { name: "Open application", exact: true }),
  ).toBeVisible();
  await expect(
    focus.getByRole("link", { name: "New location", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await editor
    .getByRole("button", { name: "Remove link 1", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Remove link 1", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Remove location", exact: true })
    .click();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(focus.locator(".task-resource")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Undo last change", exact: true })
    .click();
  await expect(
    focus.getByRole("link", { name: "Open application", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
    await page.screenshot({
    path: test.info().outputPath("website-light.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(
    focus.getByRole("link", { name: "New location", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: test.info().outputPath("phone-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
});

test("card links use the host bridge, errors stay visible, and edits round-trip", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/tools/capture_item", {
    headers,
    data: seed(),
  });
  const { task: captured } = await response.json();
  const full = await request.post("/api/tools/list_items", {
    headers,
    data: { task_id: captured.id, detail: "full" },
  });
  const task = (await full.json()).items[0];
  const html = await readFile("dist/widget-adapter.html", "utf8");
  const opened: string[] = [];
  let failLink = false;
  await page.exposeFunction("openTestLink", (url: string) => {
    opened.push(url);
    return { isError: failLink };
  });
  await page.exposeFunction("gtdTool", async (name: string, args: unknown) => {
    const r = await request.post(`/api/tools/${name}`, { headers, data: fixtureContent(name, args) });
    return { structuredContent: await r.json(), isError: !r.ok() };
  });
  await page.route("**/__context", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/__context");
  await page.evaluate(
    ({ html, task }) => {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "width:600px;height:780px;border:0";
      window.addEventListener("message", async (event) => {
        if (event.source !== iframe.contentWindow) return;
        const m = event.data;
        // Simulate the app-only facade used by the authenticated adapter.
        if (m.method === "tools/call" && ["gtd_ui_read", "gtd_ui_write"].includes(m.params.name)) {
          m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
        }
        const send = (v: any) =>
          iframe.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
        if (m.method === "ui/initialize")
          send({ id: m.id, result: { hostContext: { theme: "dark" } } });
        if (m.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: { arguments: { task_id: task.id } },
          });
          send({
            method: "ui/notifications/tool-result",
            params: {
              structuredContent: {
                items: [task],
                history: [],
                next_offset: null,
                next_history_after: null,
              },
            },
          });
        }
        if (m.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(m.params.name))
          m.params = {...m.params, name:m.params.arguments.operation, arguments:m.params.arguments.arguments};
        if (m.method === "tools/call" && ["view_snapshot","widget_pages"].includes(m.params.name)) {
          send({id:m.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (m.method === "tools/call")
          send({
            id: m.id,
            result: await (window as any).gtdTool(
              m.params.name,
              m.params.arguments,
            ),
          });
        if (m.method === "ui/open-link")
          send({
            id: m.id,
            result: await (window as any).openTestLink(m.params.url),
          });
      });
      iframe.srcdoc = html;
      document.body.append(iframe);
    },
    { html, task },
  );
  const card = page.frameLocator("iframe");
  await card
    .getByRole("button", { name: `Details: ${task.title}`, exact: true })
    .click();
  await card
    .getByRole("link", { name: "Application form", exact: true })
    .click();
  await expect.poll(() => opened.length).toBe(1);
  expect(opened[0]).toBe("https://example.com/form");
  await card.getByRole("link", { name: task.location, exact: true }).click();
  await expect.poll(() => opened.length).toBe(2);
  expect(new URL(opened[1]).searchParams.get("query")).toBe(task.location);
  failLink = true;
  await card
    .getByRole("link", { name: "Application form", exact: true })
    .click();
  await expect(card.getByRole("status")).toContainText("Could not open link");
  failLink = false;
  await card.getByRole("button", {name: `More options: ${task.title}`, exact: true}).click();
  await card.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await card.getByRole("button", { name: "Add detail", exact: true }).click();
  await card.getByRole("menuitem", { name: "Link", exact: true }).click();
  await card
    .getByRole("textbox", { name: "Link 3 URL", exact: true })
    .fill("https://example.org/new");
  await card
    .getByRole("textbox", { name: "Link 3 label", exact: true })
    .fill("Additional reference");
  await card.getByRole("button", { name: "Save changes" }).click();
  await card.getByRole("button", {name: "Close details", exact: true}).click();
  await expect(
    card.getByRole("link", { name: "Additional reference", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("card-dark.png"),
    fullPage: true,
  });
});
