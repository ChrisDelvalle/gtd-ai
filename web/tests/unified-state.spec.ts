import { test, expect } from "@playwright/test";
import { openWidget, title } from "./helpers/widget-host";

// Keep these route/state assertions separate from the visual audit. All HTTP
// records are synthetic, and global setup refuses a production target.
test("uncertain writes survive navigation and retry with the original identity", async ({
  page,
}) => {
  const { frame, requests } = await openWidget(page, { uncertainWrite: true });
  await frame
    .getByRole("button", { name: `Mark complete: ${title}`, exact: true })
    .click();
  await frame
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  await frame.getByRole("menuitemradio", { name: "Activity", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await requests("tools/call")).filter(
          (m) => m.params.name === "update_item",
        ).length,
    )
    .toBe(2);
  await expect(
    frame.getByRole("button", { name: "GTD navigation", exact: true }),
  ).toBeVisible();
  const writes = (await requests("tools/call")).filter(
    (m) => m.params.name === "update_item",
  );
  expect(writes[0].params.arguments.request_id).toBeTruthy();
  expect(writes[1].params.arguments).toEqual(writes[0].params.arguments);
  await frame
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  await frame.getByRole("menuitemradio", { name: "Done", exact: true }).click();
  await expect(
    frame.getByRole("button", { name: `Reopen: ${title}`, exact: true }),
  ).toBeVisible();
});

test("expanded task scroll position and disclosure survive visiting another destination", async ({
  page,
}) => {
  const { frame, scroll } = await openWidget(page, { width: 900 });
  await frame.getByRole("button", {name:"GTD navigation",exact:true}).click();
  await frame.getByRole("menuitemradio", {name:"All tasks",exact:true}).click();
  await frame
    .getByRole("button", { name: `Details: ${title}`, exact: true })
    .click();
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(frame.getByRole("heading", {name:"Step 24",exact:true})).toHaveCount(1);
  await expect(frame.locator('[data-resizing="true"]')).toHaveCount(0);
  await scroll.evaluate((el) => el.scrollTo(0, 680));
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(600);
  const before = await scroll.evaluate((el) => el.scrollTop);
  await frame
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await frame.getByRole("button", { name: "Help", exact: true }).click();
  await frame
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await frame.getByRole("button", { name: "All tasks", exact: true }).click();
  await expect(
    frame.getByRole("button", { name: `Details: ${title}`, exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(before - 3);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeLessThan(before + 3);
});

test("capturing elsewhere does not clear a retained capture draft", async ({
  page,
}) => {
  const draft = `Keep this draft ${crypto.randomUUID()}`;
  const saved = `Other route capture ${crypto.randomUUID()}`;
  const submittedTitles: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/tools/capture_item"))
      submittedTitles.push(request.postDataJSON().title);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Add to inbox", exact: true })
    .fill(draft);
  await page
    .getByRole("button", { name: "Close capture", exact: true })
    .click();
  // Establish that closing kept the draft before testing receipt ownership
  // across routes; this localizes any failure to the relevant transition.
  await expect(
    page.getByRole("button", { name: "Continue adding task", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "All tasks", exact: true }).click();
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Add to inbox", exact: true })
    .fill(saved);
  await page.getByRole("button", { name: "Capture task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Details: ${saved}`, exact: true }),
  ).toBeVisible();
  expect(submittedTitles).toEqual([saved]);
  // The optimistic row can appear before capture navigates to its focused
  // destination. Wait for that route before clicking its navigation controls.
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await page.locator(".gtd-sidebar:visible").getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("button", { name: "Continue adding task", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Add to inbox", exact: true }),
  ).toHaveValue(draft);
});

test("delayed capture completion does not override navigation", async ({
  page,
}) => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => (complete = resolve));
  await page.route("**/api/tools/capture_item", async (route) => {
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Add to inbox", exact: true })
    .fill(`Delayed receipt ${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Capture task", exact: true }).click();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  complete();
  await expect(
    page.getByRole("heading", { name: "Getting things done" }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  await expect(
    page.getByRole("heading", { name: "Getting things done" }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
});

test("loaded project pages remain loaded after navigation and refresh", async ({
  page,
}) => {
  const rows = Array.from({ length: 32 }, (_, i) => ({
    id: `state-project-${i}`,
    title: `Project ${String(i + 1).padStart(2, "0")}`,
    notes: "Synthetic pagination fixture.",
    entity_type: "project",
    status: "active",
    archived: false,
    deleted: false,
    version: 1,
    last_change_id: i + 1,
    due_date: null,
    task_counts: { next: 1 },
  }));
  const reads: Record<string, unknown>[] = [];
  await page.route("**/api/tools/list_projects", async (route) => {
    const args = route.request().postDataJSON();
    reads.push(args);
    const second = args.cursor === "page-two";
    await route.fulfill({
      json: {
        projects: second ? rows.slice(20) : rows.slice(0, 20),
        next_cursor: second ? null : "page-two",
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(
    page.locator(".project-browser:visible .project-row"),
  ).toHaveCount(20);
  await page
    .getByRole("button", { name: "More projects", exact: true })
    .click();
  await expect(
    page.locator(".project-browser:visible .project-row"),
  ).toHaveCount(32);
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const before = reads.length;
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect.poll(() => reads.length).toBeGreaterThan(before);
  await expect(
    page.locator(".project-browser:visible .project-row"),
  ).toHaveCount(32);
  await expect(page.getByRole("button", { name: "Refresh projects", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("gtd:changed")));
  await expect(
    page.locator(".project-browser:visible .project-row"),
  ).toHaveCount(32);
  await page.unrouteAll({ behavior: "wait" });
});

test("creating a project in Review does not replace a retained Projects editor", async ({
  page,
  request,
  baseURL,
}) => {
  const prefix = `Receipt ownership ${crypto.randomUUID()}`;
  const response = await request.post("/api/tools/create_project", {
    headers: { Origin: baseURL!, "X-GTD-Request": "1" },
    data: {
      request_id: crypto.randomUUID(),
      title: `${prefix} original`,
      brief: "Complete the shared-state fixture project.",
      review_date: "2020-01-01",
      notes: "Original description.",
      reason: "Synthetic shared-state regression",
    },
  });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  await page.route("**/api/tools/list_projects", async (route) => {
    const args = route.request().postDataJSON();
    // Isolate this UI fixture without depending on a running search worker.
    // Search behavior has its own integration suite.
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: args.project_id ? data : {
      ...data, projects: data.projects.filter((p: { title: string }) => p.title.startsWith(prefix)),
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page
    .locator(".project-row:visible")
    .filter({ hasText: project.title })
    .click();
  await page
    .getByRole("button", { name: "Project options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit project", exact: true })
    .click();
  const draft = `Keep the original project draft ${crypto.randomUUID()}`;
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill(draft);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Desired outcome", exact: true })
    .fill(`${prefix} second`);
  await page.locator("form.project-create:visible").getByRole("textbox", {name:"Brief",exact:true}).fill("Complete the second fixture project.");
  await page
    .locator("form.project-create:visible")
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: `${prefix} second`, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue(draft);
  await expect(
    page.getByRole("heading", { name: project.title, exact: true }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
});

async function openLaunchHost(
  page: import("@playwright/test").Page,
  input: Record<string, unknown>,
  first: Record<string, unknown>,
) {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(
    new URL("../dist/widget-adapter.html", import.meta.url),
    "utf8",
  );
  await page.route("**/__state-launch", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="fixture"></div>',
    }),
  );
  await page.goto("/__state-launch");
  await page.evaluate(
    ({ html, input, first }) => {
      const frame = document.createElement("iframe");
      frame.title = "State launch fixture";
      frame.style.cssText = "width:760px;height:450px;border:0";
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      const calls: any[] = [];
      const send = (value: object) =>
        frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...value }, "*");
      (window as any).stateLaunch = {
        calls,
        sendResult: (result: object) =>
          send({ method: "ui/notifications/tool-result", params: result }),
      };
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        if (message.method === "ui/initialize")
          send({
            id: message.id,
            result: {
              hostContext: {
                theme: "light",
                displayMode: "inline",
                availableDisplayModes: ["inline", "fullscreen"],
                containerDimensions: { width: 760, maxHeight: 450 },
              },
            },
          });
        if (message.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: { arguments: input },
          });
          send({ method: "ui/notifications/tool-result", params: first });
        }
        if (message.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(message.params.name))
          message.params = {...message.params, name:message.params.arguments.operation, arguments:message.params.arguments.arguments};
        if (message.method === "tools/call" && ["view_snapshot","widget_pages"].includes(message.params.name)) {
          send({id:message.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (message.method === "tools/call") {
          if (["gtd_ui_read","gtd_ui_write"].includes(message.params.name)) message.params = {...message.params, name: message.params.arguments.operation, arguments: message.params.arguments.arguments};
          calls.push(message.params);
          send({
            id: message.id,
            result: {
              structuredContent: {
                projects: [],
                items: [],
                history: [],
                next_cursor: null,
                next_offset: null,
                next_history_after: null,
              },
            },
          });
        }
        if (message.method === "ui/notifications/size-changed")
          frame.style.height = `${message.params.height}px`;
      });
      document.getElementById("fixture")!.append(frame);
      frame.srcdoc = html;
    },
    { html, input, first },
  );
  return page.frameLocator('iframe[title="State launch fixture"]');
}

test("filtered project launches keep exact filters when refreshing", async ({
  page,
}) => {
  const input = {
    query: "résumé",
    view: "all",
    review_from: "2026-10-01",
    review_through: "2026-10-31",
    include_deleted: true,
    limit: 7,
  };
  const frame = await openLaunchHost(page, input, {
    structuredContent: { projects: [], next_cursor: null },
  });
  await expect(frame.getByText("No projects in this view.")).toBeVisible();
  await frame
    .getByRole("button", { name: "Refresh projects", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).stateLaunch.calls.length))
    .toBeGreaterThan(0);
  const calls = await page.evaluate(() => (window as any).stateLaunch.calls);
  expect(calls.at(-1).name).toBe("list_projects");
  expect(calls.at(-1).arguments).toMatchObject(input);
  expect(calls.at(-1).arguments.status).toBeUndefined();
});

test("a valid later host result recovers an initial failed launch without remounting", async ({
  page,
}) => {
  const frame = await openLaunchHost(
    page,
    {},
    {
      isError: true,
      structuredContent: {
        code: "storage_error",
        message: "Temporary failure",
      },
    },
  );
  await expect(
    frame.getByText("The task view could not be loaded. Try Refresh."),
  ).toBeVisible();
  const task = {
    id: "recovered-task",
    title: "Recovered host launch",
    notes: "Recovered description",
    status: "next",
    version: 1,
    last_change_id: 1,
    due_date: null,
    deleted: false,
  };
  await page.evaluate(
    (task) =>
      (window as any).stateLaunch.sendResult({
        structuredContent: {
          items: [task],
          history: [],
          next_cursor: null,
          next_offset: null,
          next_history_after: null,
        },
      }),
    task,
  );
  await expect(
    frame.getByRole("button", {
      name: "Details: Recovered host launch",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    frame.getByText("The task view could not be loaded. Try Refresh."),
  ).toHaveCount(0);
});

test("the expand glyph matches neighboring toolbar icon dimensions and stroke", async ({
  page,
}) => {
  const { frame } = await openWidget(page, { width: 760, long: false });
  const metrics = [];
  for (const label of [
    "Search tasks",
    "Refresh tasks",
    "Sort and filter tasks",
    "Expand view",
  ]) {
    const icon = frame
      .getByRole("button", { name: label, exact: true })
      .locator("svg")
      .first();
    metrics.push(
      await icon.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          stroke: getComputedStyle(el).strokeWidth,
          buttonWidth: el.parentElement!.getBoundingClientRect().width,
          buttonHeight: el.parentElement!.getBoundingClientRect().height,
        };
      }),
    );
  }
  expect(metrics[3]).toEqual(metrics[0]);
  expect(metrics[3]).toEqual(metrics[1]);
  expect(metrics[3]).toEqual(metrics[2]);
});
