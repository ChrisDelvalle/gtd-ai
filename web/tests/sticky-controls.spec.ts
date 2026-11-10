import { fixtureContent } from "./helpers/content";
import {
  test,
  expect,
  type Page,
  type APIRequestContext,
  type Locator,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

async function call(request: APIRequestContext, name: string, args: object) {
  const response = await request.post(`/api/tools/${name}`, {
    headers: { Origin: process.env.GTD_BASE_URL!, "X-GTD-Request": "1" },
    data: fixtureContent(name, args),
  });
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBe(true);
  return result;
}

async function openCard(
  page: Page,
  request: APIRequestContext,
  width: number,
  projectCard: boolean,
) {
  const { project } = await call(request, "create_project", {
    request_id: randomUUID(),
    title: "Prepare the weekly review",
    notes: "Review open commitments and choose the next actions.",
    reason: "Isolated sticky controls test",
  });
  for (const title of [
    "Review the supporting material",
    "Choose the next action",
  ])
    await call(request, "capture_item", {importance: "normal", estimated_minutes: 30, effort: "medium", 
      request_id: randomUUID(),
      project_id: project.id,
      title,
      status: "next",
      notes: Array.from(
        { length: 35 },
        (_, i) =>
          `### Step ${i + 1}\n\nRead the supporting material and record the next step. Keep the task controls available while reviewing a longer description.`,
      ).join("\n\n"),
      reason: "Isolated sticky controls test",
    });
  const input = { project_id: project.id };
  const initial = await call(
    request,
    projectCard ? "list_projects" : "show_tasks",
    input,
  );
  const html = await readFile("dist/widget-adapter.html", "utf8");
  await page.exposeFunction(
    "stickyTool",
    async (name: string, args: object) => ({
      structuredContent: await call(request, name, args),
    }),
  );
  await page.route("**/__sticky-card", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body style='margin:0'></body>",
    }),
  );
  await page.goto("/__sticky-card");
  await page.evaluate(
    ({ html, width, initial, input }) => {
      const frame = document.createElement("iframe");
      frame.style.cssText = `width:${width}px;height:640px;border:0;display:block`;
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      window.addEventListener("message", async (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data;
        // Simulate the app-only facade used by the authenticated adapter.
        if (m.method === "tools/call" && ["gtd_ui_read", "gtd_ui_write"].includes(m.params.name)) {
          m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
        }
        const send = (v: object) =>
          frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
        if (m.method === "ui/initialize")
          send({
            id: m.id,
            result: {
              hostContext: {
                theme: width < 500 ? "dark" : "light",
                availableDisplayModes: ["inline"],
              },
            },
          });
        if (m.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: { arguments: input },
          });
          send({
            method: "ui/notifications/tool-result",
            params: { structuredContent: initial },
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
            result: await (window as any).stickyTool(
              m.params.name,
              m.params.arguments,
            ),
          });
        if (m.method === "ui/notifications/size-changed")
          frame.style.height = `${m.params.height}px`;
      });
      frame.srcdoc = html;
      document.body.append(frame);
    },
    { html, width, initial, input },
  );
  return page.frameLocator("iframe");
}

async function expectClickable(control: Locator) {
  expect(
    await control.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const hit = e.ownerDocument.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return hit === e || e.contains(hit);
    }),
  ).toBe(true);
}

for (const width of [390, 760]) {
  for (const projectCard of [false, true]) {
    test(`${projectCard ? "project" : "task"} card keeps controls usable while scrolling at ${width}px`, async ({
      page,
      request,
    }) => {
      const frame = await openCard(page, request, width, projectCard);
      await frame
        .getByRole("button", { name: "Expand view", exact: true })
        .click();
      const card = frame.locator(".widget-scroll");
      const task = frame.locator(".compact-task").first();
      const row = task.locator(".compact-row");
      const details = row.getByRole("button", { name: /^Details:/ });
      await details.click();
      await expect(
        task.getByRole("heading", { name: "Step 35", exact: true }),
      ).toBeVisible();
      await expect(card.locator(".task-expansion[data-resizing]")).toHaveCount(
        0,
      );
      const inset = await card.evaluate((e) =>
        parseFloat(getComputedStyle(e).paddingTop),
      );
      const banner = (await frame.locator(".test-mode").count()) ? 28 : 0;
      const offset = inset + 48 + banner;
      for (const distance of [350, 700, 1400]) {
        await card.evaluate(
          (el, y) => el.scrollTo({ top: y, behavior: "instant" }),
          distance,
        );
        await expect
          .poll(async () => {
            const a = await card.boundingBox(),
              b = await row.boundingBox();
            return Math.abs(b!.y - a!.y - offset);
          })
          .toBeLessThan(1);
        await expectClickable(details);
        if (projectCard) {
          const toolbar = frame.locator(".project-toolbar");
          expect(
            Math.abs(
              (await toolbar.boundingBox())!.y -
                (await card.boundingBox())!.y -
                inset -
                banner,
            ),
          ).toBeLessThan(1);
          await expectClickable(
            toolbar.getByRole("button", {
              name: "Project options",
              exact: true,
            }),
          );
        }
      }
      const scrollBefore = await card.evaluate((e) => e.scrollTop);
      const menuTrigger = row.getByRole("button", { name: /^More options:/ });
      // Playwright's scroll-into-view can scroll a sticky child back to its
      // flow position. Hit-test then click the visible control as a user does.
      await expectClickable(menuTrigger);
      const menuBox = (await menuTrigger.boundingBox())!;
      await page.mouse.click(
        menuBox.x + menuBox.width / 2,
        menuBox.y + menuBox.height / 2,
      );
      expect(await card.evaluate((e) => e.scrollTop)).toBe(scrollBefore);
      await expect(
        frame.getByRole("menuitem", { name: "Edit", exact: true }),
      ).toBeVisible();
      await expectClickable(
        frame.getByRole("menuitem", { name: "Edit", exact: true }),
      );
      await page.keyboard.press("Escape");
      await expect(menuTrigger).toBeFocused();
      expect(await card.evaluate((e) => e.scrollTop)).toBe(scrollBefore);
      if (projectCard) {
        await frame
          .getByRole("button", { name: "Project options", exact: true })
          .click();
        await expectClickable(
          frame.getByRole("menuitem", { name: "Edit project", exact: true }),
        );
        await page.keyboard.press("Escape");
      }
      expect(
        await frame
          .locator("body")
          .evaluate((e) => e.scrollWidth <= e.clientWidth),
      ).toBe(true);
      await page.locator("iframe").screenshot({
        path: `test-results-sticky/${projectCard ? "project" : "task"}-${width}.png`,
      });
      // A header must leave with its own task, not cover the following task.
      await card.evaluate((e) =>
        e.scrollTo({ top: e.scrollHeight, behavior: "instant" }),
      );
      const nextDetails = frame
        .locator(".compact-task")
        .nth(1)
        .getByRole("button", { name: /^Details:/ });
      await expectClickable(nextDetails);
      await card.evaluate((e) => e.scrollTo({ top: 500, behavior: "instant" }));
      await details.click();
      await expect(details).toHaveAttribute("aria-expanded", "false");
      await expect(
        task.getByRole("heading", { name: "Step 35", exact: true }),
      ).not.toBeVisible();
    });
  }
}
