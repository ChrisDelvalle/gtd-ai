import { fixtureContent } from "./helpers/content";
import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const origin = process.env.GTD_BASE_URL || "http://127.0.0.1:18081";
type Args = Record<string, unknown>;
function scopeOnly(args: Args | undefined) {
  expect(args?.cursor).toBeUndefined();
  expect([undefined, 0]).toContain(args?.offset);
  const { cursor, offset, ...scope } = args!;
  return scope;
}

for (const operation of ["list_items", "show_tasks"]) {
  test(`host ${operation} pagination preserves the cursor's grouping`, async ({
    page,
    request,
  }) => {
    const prefix = `Pagination ${randomUUID().slice(0, 8)}`;
    const {project} = await call(request, "create_project", {
      request_id: randomUUID(), title: prefix, reason: "Isolate pagination fixture",
    });
    const tasks = [];
    for (const suffix of ["first", "second"])
      tasks.push(
        await call(request, "capture_item", {importance: "normal", estimated_minutes: 30, effort: "medium", 
          request_id: randomUUID(),
          title: `${prefix} ${suffix}`,
          project_id: project.id,
          reason: "Synthetic pagination grouping regression",
        }),
      );
    const args = { project_id: project.id, limit: 1, view: "all" };
    const first = await call(request, operation, args);
    expect(first.group_recurrences).toBe(operation === "show_tasks");
    const second = tasks.find((task) => task.task.id !== first.items[0].id)!;
    const reads: Args[] = [];
    await page.exposeFunction("gtdTool", async (name: string, args: Args) => {
      reads.push(args);
      return {
        structuredContent: await call(request, name, args),
        isError: false,
      };
    });
    const frame = await mount(page, args, {
      structuredContent: first,
      isError: false,
    });
    await expect(
      frame.getByText(first.items[0].title, { exact: true }),
    ).toBeVisible();
    await frame
      .getByRole("button", { name: "Next task page", exact: true })
      .click();
    await expect(
      frame.getByText(second.task.title, { exact: true }),
    ).toBeVisible();
    expect(reads.at(-1)?.cursor).toBe(first.next_cursor);
    expect(reads.at(-1)?.group_recurrences).toBe(first.group_recurrences);
    await expect(
      frame.getByText("View may be stale.", { exact: false }),
    ).toHaveCount(0);
  });
}
async function call(request: APIRequestContext, name: string, args: Args) {
  const response = await request.post(`/api/tools/${name}`, {
    headers: { Origin: origin, "X-GTD-Request": "1" },
    data: fixtureContent(name, args),
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function mount(page: Page, args: Args, result: Args) {
  const html = await readFile("dist/widget-adapter.html", "utf8");
  await page.route("**/__confirmation", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/__confirmation");
  await page.evaluate(
    ({ html, args, result }) => {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "width:680px;height:500px;border:0";
      window.addEventListener("message", async (event) => {
        if (event.source !== iframe.contentWindow) return;
        const message = event.data;
        const send = (data: unknown) =>
          iframe.contentWindow!.postMessage(
            { jsonrpc: "2.0", ...(data as object) },
            "*",
          );
        if (message.method === "ui/initialize")
          send({ id: message.id, result: { hostContext: { theme: "dark" } } });
        if (message.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: { arguments: args },
          });
          send({ method: "ui/notifications/tool-result", params: result });
        }
        if (message.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(message.params.name))
          message.params = {...message.params, name:message.params.arguments.operation, arguments:message.params.arguments.arguments};
        if (message.method === "tools/call" && ["view_snapshot","widget_pages"].includes(message.params.name)) {
          send({id:message.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (message.method === "tools/call") {
          if (["gtd_ui_read","gtd_ui_write"].includes(message.params.name)) message.params = {...message.params, name: message.params.arguments.operation, arguments: message.params.arguments.arguments};
          const reply = await (window as any).gtdTool(
            message.params.name,
            message.params.arguments,
          );
          send({ id: message.id, result: reply });
        }
      });
      iframe.srcdoc = html;
      document.body.append(iframe);
    },
    { html, args, result },
  );
  return page.frameLocator("iframe");
}
test("write results render only the affected task; refresh is scoped; retries load current state", async ({
  page,
  request,
}) => {
  const reads: Args[] = [];
  await page.exposeFunction("gtdTool", async (name: string, args: Args) => {
    expect(name).toBe("list_items");
    reads.push(args);
    return {
      structuredContent: await call(request, name, args),
      isError: false,
    };
  });
  const captureArgs = {
    importance: "normal", estimated_minutes: 30, effort: "medium",
    title: "Confirmation " + randomUUID().slice(0, 8) + " <b>safe</b>",
    request_id: randomUUID(),
    reason: "Synthetic confirmation test",
  };
  const created = await call(request, "capture_item", captureArgs);
  const updateArgs = {
    task_id: created.task.id,
    request_id: randomUUID(),
    expected_version: created.task.version,
    status: "done",
    reason: "Test update confirmation",
  };
  const updated = await call(request, "update_item", updateArgs);
  const undoArgs = {
    change_id: updated.change.id,
    request_id: randomUUID(),
    expected_version: updated.task.version,
    reason: "Test undo confirmation",
  };
  const undone = await call(request, "undo_change", undoArgs);
  for (const [args, data] of [
    [captureArgs, created],
    [updateArgs, updated],
    [undoArgs, undone],
  ] as const) {
    const frame = await mount(page, args, {
      structuredContent: data,
      isError: false,
    });
    await expect(
      frame.getByRole("button", {
        name: `Details: ${created.task.title}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(frame.locator("article")).toHaveCount(1);
    await expect(frame.locator("b")).toHaveCount(0);
    await expect(frame.getByRole("heading")).toHaveCount(0);
    const completionLabel =
      data.task.status === "done" ? "Reopen: " : "Mark complete: ";
    await expect(
      frame.getByRole("button", {
        name: completionLabel + data.task.title,
        exact: true,
      }),
    ).toBeVisible();
    await frame
      .getByRole("button", { name: "Refresh tasks", exact: true })
      .click();
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    expect(scopeOnly(reads.pop())).toEqual({
      task_id: created.task.id,
      include_deleted: true,
    });
  }
  // The persisted retry snapshot is version 1. Current server state is version 4/done.
  await call(request, "update_item", {
    ...updateArgs,
    expected_version: undone.task.version,
    request_id: randomUUID(),
  });
  const replay = await call(request, "capture_item", captureArgs);
  expect(replay.replayed).toBe(true);
  expect(replay.task.version).toBe(1);
  const frame = await mount(page, captureArgs, {
    structuredContent: replay,
    isError: false,
  });
  await expect(
    frame.getByRole("button", {
      name: `Reopen: ${created.task.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    frame.getByText("Previously saved result.", { exact: false }),
  ).toHaveCount(0);
  expect(scopeOnly(reads.pop())).toEqual({
    task_id: created.task.id,
    include_deleted: true,
  });
});
test("a rejected or unconfirmed capture never shows a success card or refreshes all tasks", async ({
  page,
}) => {
  const reads: Args[] = [];
  await page.exposeFunction("gtdTool", async (_name: string, args: Args) => {
    reads.push(args);
    return {};
  });
  for (const [code, message, expected] of [
    ["validation_error", "Title is required", "Change was rejected"],
    ["storage_error", "Storage unavailable", "Change not confirmed"],
  ]) {
    const frame = await mount(
      page,
      { request_id: randomUUID(), title: "" },
      { isError: true, structuredContent: { code, message } },
    );
    await frame
      .getByRole("button", { name: "View connection problem", exact: true })
      .click();
    await expect(frame.getByRole("alert")).toContainText(expected);
    await expect(frame.locator("article")).toHaveCount(0);
    await expect(frame.getByText("Loading…")).toHaveCount(0);
    await expect(
      frame.getByRole("button", { name: "Retry refresh" }),
    ).toHaveCount(0);
    expect(reads).toHaveLength(0);
  }
});

test("one selected-task card reflects bulk updates and undo without widening Refresh", async ({
  page,
  request,
}) => {
  const created = await call(request, "apply_changes", {
    request_id: randomUUID(),
    operations: [
      {importance: "normal", estimated_minutes: 30, effort: "medium", 
        operation: "capture",
        title: "Bulk A " + randomUUID(),
        reason: "Synthetic bulk card test",
      },
      {importance: "normal", estimated_minutes: 30, effort: "medium", 
        operation: "capture",
        title: "Bulk B " + randomUUID(),
        reason: "Synthetic bulk card test",
      },
    ],
  });
  const ids = created.results.map((r: any) => r.entity_id);
  const filter = { task_ids: ids, include_deleted: true };
  const calls: Args[] = [];
  await page.exposeFunction("gtdTool", async (name: string, args: Args) => {
    expect(name).toBe("list_items");
    calls.push(args);
    return {
      structuredContent: await call(request, name, args),
      isError: false,
    };
  });
  const data = await call(request, "show_tasks", filter);
  const frame = await mount(page, filter, {
    structuredContent: data,
    isError: false,
  });
  await expect(frame.locator("article")).toHaveCount(2);
  const edited = await call(request, "apply_changes", {
    request_id: randomUUID(),
    operations: created.results.map((r: any) => ({
      operation: "update",
      task_id: r.entity_id,
      expected_version: r.version,
      status: "done",
      reason: "Complete synthetic batch",
    })),
  });
  await frame
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(frame.locator(".is-done")).toHaveCount(2);
  expect(scopeOnly(calls.pop())).toEqual(filter);
  await call(request, "apply_changes", {
    request_id: randomUUID(),
    operations: edited.results.map((r: any) => ({
      operation: "undo",
      change_id: r.change_id,
      expected_version: r.version,
      reason: "Undo synthetic batch",
    })),
  });
  await frame
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await expect(frame.locator(".is-done")).toHaveCount(0);
  await expect(frame.locator("article")).toHaveCount(2);
  expect(scopeOnly(calls.pop())).toEqual(filter);
  await page.screenshot({ path: "test-results/bulk-card.png" });
});
