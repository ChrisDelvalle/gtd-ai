import { fixtureContent } from "./helpers/content";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const origin = process.env.GTD_BASE_URL || "http://127.0.0.1:18081";
async function call(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown>,
) {
  const r = await request.post(`/api/tools/${name}`, {
    headers: { Origin: origin, "X-GTD-Request": "1" },
    data: fixtureContent(name, args),
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
test("capture, safely render text, preserve a draft through concurrent edits, undo and inspect logs", async ({
  page,
  request,
}) => {
  const title =
    "Browser test " +
    randomUUID().slice(0, 8) +
    " <img src=x onerror=alert(1)>";
  await page.goto("/");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Add to inbox", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Capture task", exact: true }).click();
  await expect(
    page.getByRole("region", {
      name: `Task information: ${title}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `More options: ${title}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const inspector = page.getByRole("region", { name: "Task details" });
  await expect(inspector.getByLabel("Title", { exact: true })).toHaveValue(
    title,
  );
  await expect(page.locator("img")).toHaveCount(0);
  await inspector
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Confidential sentinel never belongs in diagnostics");
  await inspector.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(
      async () =>
        (await call(request, "list_items", { query: title, detail: "full" }))
          .items[0]?.notes,
    )
    .toBe("Confidential sentinel never belongs in diagnostics");
  await expect(
    inspector.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await inspector
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("My unsaved draft");
  const listed = await call(request, "list_items", { query: title });
  const task = listed.items[0];
  await call(request, "update_item", {
    task_id: task.id,
    expected_version: task.version,
    status: "waiting",
    brief: "Wait for the response to this disposable fixture.",
    estimated_minutes: 30,
    effort: "medium",
    request_id: randomUUID(),
    reason: "Concurrent test change",
  });
  // The visible website polls; users do not need a manual refresh control.
  await expect(
    inspector.getByText("This task changed on the server.", { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    inspector.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("My unsaved draft");
  await expect(
    inspector.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await inspector
    .getByRole("button", { name: "Apply my edited fields to latest version" })
    .click();
  await expect(
    inspector.getByRole("combobox", { name: "Status", exact: true }),
  ).toHaveValue("waiting");
  await inspector.getByRole("button", { name: "Save changes" }).click();
  await expect(
    inspector.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Undo last change" }).click();
  await expect(
    inspector.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Confidential sentinel never belongs in diagnostics");
  await page.screenshot({
    path: test.info().outputPath("tasks-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath("tasks-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Logs", exact: true }).click();
  await expect(
    page
      .locator(".gtd-main:visible")
      .getByText("Confidential sentinel never belongs in diagnostics", {
        exact: false,
      }),
  ).toHaveCount(0);
  await page.getByLabel("Operation", { exact: true }).fill("update_item");
  await expect(
    page.locator("tbody").getByText("update_item", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Service health", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Task database", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".health-card")
      .filter({ hasText: "OpenAI tunnel" })
      .getByText("Needs attention", { exact: true }),
  ).toBeVisible();
});

for (const bridgeKind of ["mcp", "chatgpt", "adapter"] as const) {
  test(`${bridgeKind} bridge renders real task data and safely retries a lost write acknowledgement`, async ({
    page,
    request,
  }) => {
    const captured = await call(request, "capture_item", {importance: "normal", estimated_minutes: 30, effort: "medium", 
      title: "Widget integration " + randomUUID().slice(0, 8),
      notes: "Widget-only sample notes",
      request_id: randomUUID(),
      reason: "Widget test fixture",
    });
    const data = await call(request, "show_tasks", {
      task_id: captured.task.id,
    });
    const widget = await readFile(
      bridgeKind === "chatgpt"
        ? "dist/widget-chatgpt.html"
        : bridgeKind === "adapter"
          ? "dist/widget-adapter.html"
          : "dist/widget.html",
      "utf8",
    );
    let dropped = false;
    let failReads = false;
    let writeIds: string[] = [];
    const wireNames: string[] = [];
    await page.exposeFunction(
      "gtdTool",
      async (name: string, args: Record<string, unknown>) => {
        wireNames.push(name);
        if (["gtd_ui_read", "gtd_ui_write"].includes(name)) {
          name = String(args.operation); args = args.arguments as Record<string, unknown>;
        }
        if (["view_snapshot", "widget_pages"].includes(name)) return {
          isError: true, structuredContent: {code:"invalid_arguments", message:"Unsupported UI operation"},
        };
        if (failReads && name === "list_items") return { lost: true };
        const result = await call(request, name, args);
        if (name === "update_item") {
          writeIds.push(String(args.request_id));
          if (!dropped) {
            dropped = true;
            return { lost: true };
          }
        }
        return { structuredContent: result, isError: false, content: [] };
      },
    );
    await page.route("**/__widget_test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      }),
    );
    await page.goto("/__widget_test");
    await page.evaluate(
      ({ html, initial, id, bridgeKind }) => {
        const frame = document.createElement("iframe");
        frame.style.cssText = "width:680px;height:1000px;border:0";
        window.addEventListener("message", async (event) => {
          if (event.source !== frame.contentWindow) return;
          const message = event.data;
          const send = (body: unknown) =>
            frame.contentWindow!.postMessage(body, "*");
          if (message.method === "ui/initialize") {
            send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2026-01-26",
                hostInfo: { name: "test-host", version: "1" },
                hostCapabilities: { serverTools: {} },
                hostContext: {
                  theme: "light",
                  displayMode: "inline",
                  availableDisplayModes: ["inline"],
                },
              },
            });
          }
          if (message.method === "ui/notifications/initialized") {
            send({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-input",
              params: {
                arguments: (window as any).gtdLaunchArgs || { task_id: id },
              },
            });
            send({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: {
                structuredContent: (window as any).gtdLaunchResult || initial,
                content: [],
                isError: false,
              },
            });
          }
        if (message.method === "tools/call") {
            const result = await (window as any).gtdTool(
              message.params.name,
              message.params.arguments,
            );
            send(
              result.lost
                ? {
                    jsonrpc: "2.0",
                    id: message.id,
                    error: {
                      code: -32000,
                      message: "Simulated lost acknowledgement",
                    },
                  }
                : { jsonrpc: "2.0", id: message.id, result },
            );
          }
        });
        if (bridgeKind === "chatgpt") {
          frame.onload = () => {
            const child = frame.contentWindow as any;
            child.openai = {
              toolInput: { task_id: id },
              toolOutput: initial,
              theme: "light",
              callTool: async (name: string, args: Record<string, unknown>) => {
                const result = await (window as any).gtdTool(name, args);
                if (result.lost)
                  throw new Error("Simulated lost acknowledgement");
                return result;
              },
              notifyIntrinsicHeight: () => {},
            };
          };
        }
        frame.srcdoc = html;
        document.body.append(frame);
      },
      { html: widget, initial: data, id: captured.task.id, bridgeKind },
    );
    const frame = page.frameLocator("iframe");
    await expect(
      frame.getByText(captured.task.title, { exact: true }),
    ).toBeVisible();
    const taskMenu = () =>
      frame
        .getByRole("button", {
          name: `More options: ${captured.task.title}`,
          exact: true,
        })
        .click();
    const menuItem = (name: string) =>
      frame.getByRole("menuitem", { name, exact: true });
    if (bridgeKind === "adapter") {
      await expect(frame.getByRole("heading")).toHaveCount(0);
      await expect(frame.getByText("Widget-only sample notes")).toHaveCount(0);
      await expect(frame.getByLabel("Deadline", { exact: true })).toHaveCount(
        0,
      );
      const shortCard = await frame
        .locator(".compact-widget")
        .evaluate((el) => ({
          height: el.getBoundingClientRect().height,
          toolbar: el.querySelector(".compact-toolbar")!.getBoundingClientRect()
            .height,
          row: el.querySelector(".compact-task")!.getBoundingClientRect()
            .height,
        }));
      expect(shortCard.toolbar).toBe(48);
      expect(shortCard.height).toBeLessThanOrEqual(
        shortCard.toolbar + shortCard.row + 20,
      );
      expect(shortCard.height).toBeLessThan(150);
      await taskMenu();
      await menuItem("Edit").press("Escape");
      await expect(frame.getByRole("menu")).toHaveCount(0);
      await expect(
        frame.getByRole("button", {
          name: `More options: ${captured.task.title}`,
        }),
      ).toBeFocused();
      await frame
        .getByRole("button", {
          name: `Mark complete: ${captured.task.title}`,
          exact: true,
        })
        .click();
    } else {
      await frame
        .getByRole("button", { name: captured.task.title, exact: false })
        .click();
      await frame
        .getByRole("button", { name: "Mark complete", exact: true })
        .click();
    }
    if (bridgeKind === "adapter") {
      await frame
        .getByRole("button", {
          name: `Resolve save: ${captured.task.title}`,
          exact: true,
        })
        .click();
    }
    await expect(
      frame.getByRole("button", { name: "Retry original change" }),
    ).toBeVisible();
    await frame.getByRole("button", { name: "Retry original change" }).click();
    await expect.poll(() => writeIds.length).toBe(2);
    if (bridgeKind === "adapter") {
      await expect(
        frame.getByRole("button", {
          name: `Reopen: ${captured.task.title}`,
          exact: true,
        }),
      ).toBeEnabled();
      await frame
        .getByRole("menuitem", { name: "Edit", exact: true })
        .press("Escape");
    } else
      await expect(
        frame.getByRole("button", { name: "Completed", exact: true }),
      ).toBeVisible();
    expect(writeIds).toHaveLength(2);
    expect(writeIds[0]).toBe(writeIds[1]);
    expect(wireNames).toContain("gtd_ui_write");
    expect(wireNames.every(name => ["gtd_ui_read", "gtd_ui_write"].includes(name))).toBe(true);
    const history = await call(request, "list_changes", {
      task_id: captured.task.id,
    });
    expect(history.changes).toHaveLength(2);
    if (bridgeKind === "adapter") {
      await taskMenu();
      await menuItem("Undo latest").click();
      await expect(
        frame.getByRole("button", {
          name: `Mark complete: ${captured.task.title}`,
          exact: true,
        }),
      ).toBeEnabled();
    } else {
      await frame.getByRole("button", { name: "Undo latest" }).click();
      await expect(
        frame.getByRole("button", { name: "Mark complete", exact: true }),
      ).toBeEnabled();
    }
    if (bridgeKind === "adapter") {
      // Keep a draft even if a concurrent change removes its task from the current filter.
      const inboxView = await call(request, "list_items", {
        task_id: captured.task.id,
      });
      await page.evaluate(
        ({ data, title }) => {
          const child = document.querySelector("iframe")!.contentWindow!;
          child.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-input",
              params: { arguments: { query: title, status: "inbox" } },
            },
            "*",
          );
          child.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: { structuredContent: data },
            },
            "*",
          );
        },
        { data: inboxView, title: captured.task.title },
      );
      await taskMenu();
      await menuItem("Edit").click();
      await frame.getByLabel("Deadline", { exact: true }).fill("2026-10-25");
      const current = (
        await call(request, "list_items", { task_id: captured.task.id })
      ).items[0];
      await call(request, "update_item", {
        task_id: current.id,
        expected_version: current.version,
        status: "waiting",
        request_id: randomUUID(),
        reason: "Concurrent widget edit",
      });
      await frame
        .getByRole("button", { name: "Refresh tasks", exact: true })
        .click();
      await expect(
        frame.getByText("This task changed on the server.", { exact: false }),
      ).toBeVisible();
      await expect(frame.getByLabel("Deadline", { exact: true })).toHaveValue(
        "2026-10-25",
      );
      await expect(
        frame.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
      const latestView = await call(request, "list_items", {
        task_id: current.id,
      });
      await page.evaluate(
        ({ data, id }) => {
          const child = document.querySelector("iframe")!.contentWindow!;
          child.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-input",
              params: { arguments: { task_id: id } },
            },
            "*",
          );
          child.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: { structuredContent: data },
            },
            "*",
          );
        },
        { data: latestView, id: current.id },
      );
      await frame
        .getByRole("button", {
          name: "Apply my edited fields to latest version",
        })
        .click();
      await frame.getByRole("button", { name: "Save changes" }).click();
      await expect(
        frame.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
      await frame.getByRole("button", { name: "Close details" }).click();
      await taskMenu();
      await menuItem("Edit").click();
      await expect(frame.getByLabel("Deadline", { exact: true })).toHaveValue(
        "2026-10-25",
      );
      await frame.getByLabel("Deadline", { exact: true }).fill("");
      // Returning to the compact preview must preserve the unsaved draft.
      await frame
        .getByRole("button", { name: "Return to preview", exact: true })
        .click();
      await expect(
        frame.getByLabel("Deadline", { exact: true }),
      ).not.toBeVisible();
      await frame
        .getByRole("button", { name: "Expand view", exact: true })
        .click();
      await expect(frame.getByLabel("Deadline", { exact: true })).toHaveValue(
        "",
      );
      await frame.getByRole("button", { name: "Save changes" }).click();
      await expect(
        frame.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
      await frame.getByRole("button", { name: "Close details" }).click();
      await expect
        .poll(
          async () =>
            (await call(request, "list_items", { task_id: current.id }))
              .items[0].due_date,
        )
        .toBeNull();
      await page.evaluate(() => {
        document.querySelector("iframe")!.contentWindow!.postMessage(
          {
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: {
              theme: "dark",
              styles: {
                variables: {
                  "--color-background-primary": "#212121",
                  "--color-text-primary": "#ececec",
                },
              },
            },
          },
          "*",
        );
      });
      await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
      if (
        await frame
          .getByRole("button", { name: "Show list controls" })
          .isVisible()
      )
        await frame.getByRole("button", { name: "Show list controls" }).click();
      await frame
        .getByRole("button", { name: "Search tasks", exact: true })
        .click();
      await frame
        .getByRole("searchbox", { name: "Search titles and notes" })
        .fill("no-matching-task-" + randomUUID());
      await frame.getByRole("button", { name: "Search", exact: true }).click();
      await expect(frame.getByText("No matching tasks")).toBeVisible();
      const other = await call(request, "capture_item", {title:"Pagination fixture "+randomUUID(),importance:"normal",request_id:randomUUID(),reason:"Isolated pagination fixture"});
      const paginationArgs = {task_ids:[captured.task.id,other.task.id],view:"all",limit:1,include_deleted:true};
      const firstPage = await call(request,"list_items",paginationArgs);
      const secondPage = await call(request,"list_items",{...paginationArgs,cursor:firstPage.next_cursor});
      await page.evaluate(
        ({ data, paginationArgs }) => {
          const child = document.querySelector("iframe")!.contentWindow!;
          child.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-input",
              params: { arguments: paginationArgs },
            },
            "*",
          );
          child.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: { structuredContent: data },
            },
            "*",
          );
          (window as any).gtdLaunchArgs = paginationArgs;
          (window as any).gtdLaunchResult = data;
        },
        { data: firstPage, paginationArgs },
      );
      // A late result must not change the current search. A new card launch can.
      await expect(
        frame.getByRole("searchbox", { name: "Search titles and notes" }),
      ).toHaveValue(/no-matching-task-/);
      await page.locator("iframe").evaluate((el, html) => {
        (el as HTMLIFrameElement).srcdoc = html;
      }, widget);
      await expect(
        frame.getByText(firstPage.items[0].title, { exact: true }),
      ).toBeVisible();
      await frame.getByRole("button", { name: "Next task page" }).click();
      await expect(
        frame.getByText(secondPage.items[0].title, { exact: true }),
      ).toBeVisible();
      await frame.getByRole("button", { name: "Previous task page" }).click();
      await expect(
        frame.getByText(firstPage.items[0].title, { exact: true }),
      ).toBeVisible();
      failReads = true;
      await frame
        .getByRole("button", { name: "Refresh tasks", exact: true })
        .click();
      await expect(
        frame.getByRole("button", {
          name: "View connection problem",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        frame.getByText(firstPage.items[0].title, { exact: true }),
      ).toBeVisible();
      failReads = false;
      await frame
        .getByRole("button", { name: "View connection problem", exact: true })
        .click();
      await frame
        .getByRole("button", { name: "Retry refresh", exact: true })
        .click();
      await expect(
        frame.getByText("View may be stale.", { exact: false }),
      ).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("iframe").evaluate((el) => {
        (el as HTMLElement).style.width = "360px";
      });
      expect(
        await frame
          .locator("html")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBeTruthy();
    }
    await page.screenshot({
      path: test.info().outputPath(`widget-${bridgeKind}.png`),
      fullPage: true,
    });
  });
}

test("manual capture recovery clears the composer and preserves one retry identity", async ({
  page,
  request,
}) => {
  const title = "Capture recovery " + randomUUID().slice(0, 8);
  let online = false;
  const attempts: unknown[] = [];
  await page.route("**/api/tools/capture_item", async (route) => {
    attempts.push(route.request().postDataJSON());
    if (online) return route.continue();
    // Commit once but hide every acknowledgement until the user retries.
    if (attempts.length === 1) await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "storage_error",
        message: "Synthetic lost acknowledgement",
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Add to inbox", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Capture task", exact: true }).click();
  await page
    .getByRole("button", { name: "Resolve capture", exact: true })
    .click();
  expect(attempts).toHaveLength(3);
  online = true;
  await page
    .getByRole("button", { name: "Retry original change", exact: true })
    .click();
  await expect(
    page.getByRole("region", {
      name: `Task information: ${title}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Task inspector" }),
  ).toHaveCount(0);
  expect(attempts).toHaveLength(4);
  expect(attempts[0]).toEqual(attempts[3]);
  const listed = await call(request, "list_items", { query: title });
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0].version).toBe(1);
  // Returning to the originating route must not resurrect the acknowledged draft.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(
    page
      .locator(".gtd-main:visible")
      .getByLabel("Add to inbox", { exact: true }),
  ).toHaveValue("");
});
