import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const task = {
  id: "read-recovery",
  title: "Previously loaded task",
  notes: "",
  status: "next",
  due_date: null,
  version: 1,
  last_change_id: 1,
  deleted: false,
};
const result = (items = [task]) => ({
  items,
  history: [],
  next_offset: null,
  next_cursor: null,
  next_history_after: null,
});

for (const retained of [false, true]) {
  test(`website search reports failure and retries with ${retained ? "retained" : "empty"} prior results`, async ({
    page,
  }) => {
    let failed = false;
    let retry = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reads: Record<string, unknown>[] = [];
    await page.route("**/api/tools/list_projects", (route) =>
      route.fulfill({ json: { projects: [], next_cursor: null } }),
    );
    await page.route("**/api/tools/list_items", async (route) => {
      const args = route.request().postDataJSON();
      if (args.query === "needle") {
        reads.push(args);
        if (!retry) {
          failed = true;
          await gate;
          return route.fulfill({
            status: 503,
            json: {
              code: "storage_error",
              message: "Search is temporarily unavailable.",
            },
          });
        }
        return route.fulfill({
          json: result([
            { ...task, title: "Recovered needle result", version: 2 },
          ]),
        });
      }
      return route.fulfill({ json: result(retained ? [task] : []) });
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Search tasks", exact: true })
      .click();
    const search = page.getByRole("searchbox", {
      name: "Search all tasks in view",
    });
    if (retained)
      await expect(
        page.getByRole("button", { name: `Details: ${task.title}` }),
      ).toBeVisible();
    else
      await expect(
        page.getByText("No matching tasks", { exact: true }),
      ).toBeVisible();
    await search.fill("needle");
    await expect.poll(() => failed).toBe(true);
    await expect(
      page.getByText("No matching tasks", { exact: true }),
    ).toHaveCount(0);
    release!();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Search is temporarily unavailable.");
    await expect(alert).toContainText("Previously loaded tasks may not match");
    await expect(
      page.getByText("No matching tasks", { exact: true }),
    ).toHaveCount(0);
    await expect(search).toHaveValue("needle");
    if (retained)
      await expect(
        page.getByRole("button", { name: `Details: ${task.title}` }),
      ).toBeVisible();
    retry = true;
    await alert.getByRole("button", { name: "Retry refresh" }).click();
    await expect(alert).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Details: Recovered needle result" }),
    ).toBeVisible();
    expect(reads).toHaveLength(2);
    expect(reads[1].query).toBe("needle");
  });
}

test("card read errors retry original filters while write recovery stays compact and scoped", async ({
  page,
}) => {
  const html = await readFile("dist/widget-adapter.html", "utf8");
  await page.route("**/__read-errors", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body style='margin:0'></body>",
    }),
  );
  await page.goto("/__read-errors");
  await page.evaluate(
    ({ html, result }) => {
      const frame = document.createElement("iframe");
      frame.style.cssText = "width:320px;height:300px;border:0";
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      (window as any).readErrorCalls = [];
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        const send = (value: any) =>
          frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...value }, "*");
        if (message.method === "ui/initialize")
          send({ id: message.id, result: { hostContext: { theme: "light" } } });
        if (message.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: { arguments: { view: "all", query: "needle" } },
          });
          send({
            method: "ui/notifications/tool-result",
            params: {
              isError: true,
              structuredContent: {
                code: "storage_error",
                message: "Search is temporarily unavailable.",
              },
            },
          });
        }
        if (message.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(message.params.name))
          message.params = {...message.params, name:message.params.arguments.operation, arguments:message.params.arguments.arguments};
        if (message.method === "tools/call" && ["view_snapshot","widget_pages"].includes(message.params.name)) {
          send({id:message.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (message.method === "tools/call") {
          if (["gtd_ui_read","gtd_ui_write"].includes(message.params.name)) message.params = {...message.params, name: message.params.arguments.operation, arguments: message.params.arguments.arguments};
          (window as any).readErrorCalls.push(message.params);
          send({ id: message.id, result: { structuredContent: result } });
        }
        if (message.method === "ui/notifications/size-changed")
          frame.style.height = `${message.params.height}px`;
      });
      frame.srcdoc = html;
      document.body.append(frame);
    },
    {
      html,
      result: result([
        { ...task, title: "Recovered needle result", version: 2 },
      ]),
    },
  );
  const card = page.frameLocator("iframe");
  await expect(card.getByRole("alert")).toContainText("could not be loaded");
  await expect(
    card.getByText("No matching tasks", { exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).readErrorCalls)).toEqual([]);
  await card.getByRole("button", { name: "Retry refresh" }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Details: Recovered needle result" }),
  ).toBeVisible();
  const calls = await page.evaluate(() => (window as any).readErrorCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    name: "list_items",
    arguments: { view: "all", query: "needle" },
  });

  await page.evaluate((taskId) => {
    const frame = document.querySelector("iframe")!;
    frame.contentWindow!.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: {
          arguments: {
            request_id: "rejected-update",
            task_id: taskId,
            status: "done",
          },
        },
      },
      "*",
    );
    frame.contentWindow!.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          isError: true,
          structuredContent: {
            code: "validation_error",
            message: "Update was rejected.",
          },
        },
      },
      "*",
    );
  }, task.id);
  const recovery = card.getByRole("button", {
    name: "View connection problem",
  });
  await expect(recovery).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).readErrorCalls),
  ).toHaveLength(1);
  await recovery.click();
  await expect(card.getByRole("alert")).toContainText("Change was rejected");
  await card.getByRole("button", { name: "Retry refresh" }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  const scopedCalls = await page.evaluate(() => (window as any).readErrorCalls);
  // Explicit recovery reads the failed record, then may refresh the preserved
  // active route. Neither step may replay the write.
  expect(scopedCalls.length).toBeGreaterThanOrEqual(2);
  expect(
    scopedCalls.every((call: { name: string }) => call.name === "list_items"),
  ).toBe(true);
  expect(scopedCalls[1]).toMatchObject({
    name: "list_items",
    arguments: { task_id: task.id, include_deleted: true },
  });
  expect(scopedCalls[1].arguments.query).toBeUndefined();

  // A later rejected capture must not reuse the old read result as permission
  // to refresh with its empty (unknown task) filter.
  await page.evaluate(() => {
    const frame = document.querySelector("iframe")!;
    frame.contentWindow!.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { request_id: "failed-capture", title: "" } },
      },
      "*",
    );
    frame.contentWindow!.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          isError: true,
          structuredContent: {
            code: "storage_error",
            message: "Capture was not confirmed.",
          },
        },
      },
      "*",
    );
  });
  await expect(recovery).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await recovery.click();
  await expect(card.getByRole("alert")).toContainText("Change not confirmed");
  await expect(card.getByRole("button", { name: "Retry refresh" })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => (window as any).readErrorCalls)).toEqual(
    scopedCalls,
  );
});
