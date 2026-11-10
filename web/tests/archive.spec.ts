import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const origin = process.env.GTD_BASE_URL || "http://127.0.0.1:18081";
const headers = { Origin: origin, "X-GTD-Request": "1" };
test.use({ reducedMotion: "reduce" });
for (const widget of [false, true]) {
  test(`${widget ? "card" : "website"}: complete and reopen in archive, undo, then unarchive`, async ({
    page,
    request,
  }) => {
    const created = await request.post("/api/tools/capture_item", {
      headers,
      data: {brief: "Complete this disposable interface fixture.", importance: "normal", estimated_minutes: 30, effort: "medium", 
        request_id: randomUUID(),
        title: `Archive UI ${randomUUID().slice(0, 8)}`,
        status: "next",
        archived: true,
        reason: "Synthetic archive UI verification",
      },
    });
    expect(created.ok()).toBeTruthy();
    const { task } = await created.json();
    async function current() {
      const r = await request.post("/api/tools/list_items", {
        headers,
        data: { task_id: task.id, detail: "full" },
      });
      return (await r.json()).items[0];
    }
    if (widget) {
      const html = await readFile("dist/widget-adapter.html", "utf8");
      await page.exposeFunction(
        "archiveTool",
        async (name: string, args: unknown) => {
          if (["gtd_ui_read", "gtd_ui_write"].includes(name)) {
            const wrapped = args as {operation: string; arguments: unknown};
            name = wrapped.operation; args = wrapped.arguments;
          }
          const r = await request.post(`/api/tools/${name}`, {
            headers,
            data: name === "list_items" ? {...(args as object), task_id: task.id} : args,
          });
          return { structuredContent: await r.json(), isError: !r.ok() };
        },
      );
      await page.route("**/__archive-card", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><body></body>",
        }),
      );
      await page.goto("/__archive-card");
      await page.evaluate(
        ({ html, task }) => {
          const iframe = document.createElement("iframe");
          iframe.setAttribute("sandbox", "allow-scripts");
          iframe.style.cssText = "width:390px;height:100px;border:0";
          window.addEventListener("message", async (event) => {
            if (event.source !== iframe.contentWindow) return;
            const m = event.data;
            const send = (v: any) =>
              iframe.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
            if (m.method === "ui/initialize")
              send({ id: m.id, result: { hostContext: { theme: "dark" } } });
            if (m.method === "ui/notifications/initialized") {
              send({
                method: "ui/notifications/tool-input",
                params: { arguments: { archived: true, task_id: task.id } },
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
            if (m.method === "ui/notifications/size-changed")
              iframe.style.height = `${m.params.height}px`;
            if (m.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(m.params.name))
          m.params = {...m.params, name:m.params.arguments.operation, arguments:m.params.arguments.arguments};
        if (m.method === "tools/call" && ["view_snapshot","widget_pages"].includes(m.params.name)) {
          send({id:m.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (m.method === "tools/call")
              send({
                id: m.id,
                result: await (window as any).archiveTool(
                  m.params.name,
                  m.params.arguments,
                ),
              });
          });
          iframe.srcdoc = html;
          document.body.append(iframe);
        },
        { html, task },
      );
    } else {
      await page.route("**/api/tools/list_items", async (route) => {
        const response = await route.fetch({
          postData: JSON.stringify({
            ...route.request().postDataJSON(),
            task_id: task.id,
          }),
        });
        await route.fulfill({ response });
      });
      await page.goto("/");
      await page
        .getByRole("navigation", { name: "Task views" })
        .getByRole("button", { name: "Archive", exact: true })
        .click();
    }
    const ui = widget ? page.frameLocator("iframe") : page;
    const more = () =>
      ui.getByRole("button", {
        name: `More options: ${task.title}`,
        exact: true,
      });
    const check = () =>
      ui.getByRole("button", {
        name: `Mark complete: ${task.title}`,
        exact: true,
      });
    await expect(check()).toBeVisible();
    await check().click();
    await expect
      .poll(async () => [(await current()).status, (await current()).archived])
      .toEqual(["done", true]);
    await expect(
      ui.getByRole("button", { name: `Reopen: ${task.title}`, exact: true }),
    ).toBeVisible();
    await more().click();
    await ui
      .getByRole("menuitem", { name: "Undo latest", exact: true })
      .click();
    await expect
      .poll(async () => [(await current()).status, (await current()).archived])
      .toEqual(["next", true]);
    await expect(check()).toBeVisible();
    await check().click();
    await expect.poll(async () => (await current()).status).toBe("done");
    await ui
      .getByRole("button", { name: `Reopen: ${task.title}`, exact: true })
      .click();
    await expect
      .poll(async () => [(await current()).status, (await current()).archived])
      .toEqual(["inbox", true]);
    await expect(check()).toBeVisible();
    await more().click();
    await ui.getByRole("menuitem", { name: "Unarchive", exact: true }).click();
    await expect.poll(async () => (await current()).archived).toBe(false);
    await expect(check()).toHaveCount(0);
    if (widget) {
      await ui.getByRole("button", { name: "GTD navigation", exact: true }).click();
      await ui
        .getByRole("menuitemradio", { name: "All tasks", exact: true })
        .click();
    } else
      await page
        .getByRole("navigation", { name: "Task views" })
        .getByRole("button", { name: "All tasks", exact: true })
        .click();
    await expect(check()).toBeVisible();
    const history = await request.post("/api/tools/list_changes", {
      headers,
      data: { task_id: task.id },
    });
    const changes = (await history.json()).changes;
    expect(changes).toHaveLength(6);
    const fullChange = await request.post("/api/tools/list_changes", {
      headers,
      data: { change_id: changes[0].id, detail: "full" },
    });
    expect((await fullChange.json()).changes[0].before.archived).toBe(true);
    expect(changes[0].after.archived).toBe(false);
    expect(changes[1].after.archived).toBe(true);
  });
}
