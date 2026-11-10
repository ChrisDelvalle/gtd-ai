import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("dependency-free UI probe initializes and refreshes through its parent only", async ({
  page,
}) => {
  const html = await readFile("dist/widget-probe.html", "utf8");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/__probe_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/__probe_test");
  await page.evaluate((html) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.cssText = "width:680px;height:500px";
    const content = (title: string) => ({
      structuredContent: { items: [{ title, status: "inbox" }] },
    });
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow) return;
      const m = event.data;
      const send = (value: unknown) =>
        frame.contentWindow!.postMessage(value, "*");
      if (m.method === "ui/initialize") {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: { protocolVersion: "2026-01-26" },
        });
      } else if (m.method === "ui/notifications/initialized") {
        send({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { include_deleted: true } },
        });
        send({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: content("Initial task <img src=x>"),
        });
      } else if (m.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(m.params.name))
          m.params = {...m.params, name:m.params.arguments.operation, arguments:m.params.arguments.arguments};
        if (m.method === "tools/call" && ["view_snapshot","widget_pages"].includes(m.params.name)) {
          send({id:m.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (m.method === "tools/call") {
          if (["gtd_ui_read","gtd_ui_write"].includes(m.params.name)) m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
        if (
          m.params.name !== "list_items" ||
          m.params.arguments.include_deleted !== true
        ) {
          throw new Error("Probe must preserve filters and only read tasks");
        }
        send({ jsonrpc: "2.0", id: m.id, result: content("Refreshed task") });
      }
    });
    frame.srcdoc = html;
    document.body.append(frame);
  }, html);
  const frame = page.frameLocator("iframe");
  await expect(
    frame.getByRole("heading", { name: "Private GTD connection check" }),
  ).toBeVisible();
  await expect(
    frame.getByText("Initial task <img src=x> · inbox", { exact: true }),
  ).toBeVisible();
  await expect(frame.locator("img")).toHaveCount(0);
  await frame.getByRole("button", { name: "Refresh tasks" }).click();
  await expect(
    frame.getByText("Refreshed task · inbox", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
