import { fixtureContent } from "./helpers/content";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const origin = process.env.GTD_BASE_URL || "http://127.0.0.1:18081";
type Args = Record<string, unknown>;
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
async function call(request: APIRequestContext, name: string, args: Args) {
  const response = await request.post(`/api/tools/${name}`, {
    headers: { Origin: origin, "X-GTD-Request": "1" },
    data: fixtureContent(name, args),
  });
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBeTruthy();
  return result;
}
async function createProject(request: APIRequestContext, extra: Args = {}) {
  return call(request, "create_project", {
    request_id: randomUUID(),
    title: "Project test " + randomUUID().slice(0, 8),
    notes: "The desired outcome is ready for review.",
    reason: "Synthetic project interface test",
    ...extra,
  });
}
async function createTask(request: APIRequestContext, extra: Args = {}) {
  return call(request, "capture_item", {importance: "normal", estimated_minutes: 30, effort: "medium", 
    request_id: randomUUID(),
    title: "Action test " + randomUUID().slice(0, 8),
    status: "blocked",
    notes: "Keep the full action context.",
    reason: "Synthetic project interface test",
    ...extra,
  });
}
async function isolateProjects(page: Page, prefix: string, projectId?: string) {
  // Isolate fixture projects without depending on the separate search service.
  // These tests exercise project workflows; keyword search has its own suite.
    await page.route(`**/api/tools/list_projects`, async (route) => {
      const args = route.request().postDataJSON();
      if(args.project_id) return route.continue();
      const response=await route.fetch({postData:JSON.stringify({...args,...(projectId?{project_id:projectId}:{}),limit:100})});
      const result=await response.json();
      if(response.ok())result.projects=result.projects.filter((p:{title:string})=>p.title.startsWith(prefix));
      await route.fulfill({response,json:result});
    });
}
async function openProject(page: Page, title: string, projectId?: string) {
  await isolateProjects(page, title, projectId);
  await page.goto("/");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.locator(".project-row").filter({ hasText: title }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  return page.getByRole("region", { name: "Projects", exact: true });
}

test("projects create blocked actions and explicitly resolve them before completion", async ({
  page,
  request,
}) => {
  const title = "Deliver outcome " + randomUUID().slice(0, 8);
  await isolateProjects(page, title);
  await page.goto("/");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Desired outcome", exact: true })
    .fill(title);
  await page.getByRole("textbox", {name:"Brief",exact:true}).fill("Prepare and deliver the project outcome.");
  await page
    .locator("form.project-create")
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  const project = page.getByRole("region", { name: "Projects", exact: true });
  await project
    .getByRole("button", { name: "Add action", exact: true })
    .click();
  const actionTitle = "Prepare the materials " + randomUUID().slice(0, 8);
  await project
    .getByRole("textbox", { name: "Action", exact: true })
    .fill(actionTitle);

  await expect(
    project.getByRole("combobox", { name: "Status", exact: true }),
  ).toHaveValue("blocked");
  await project.getByRole("textbox", {name:"Brief",exact:true}).fill("Complete the project action.");
  await project.getByRole("spinbutton", { name: "Remaining minutes" }).fill("30");
  await project.getByRole("combobox", { name: "Effort", exact: true }).selectOption("medium");
  await project
    .locator(".project-capture form")
    .getByRole("button", { name: "Add action", exact: true })
    .click();
  await expect(
    project.getByRole("button", {
      name: `Details: ${actionTitle}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    project.getByRole("button", { name: "Blocked 1", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await project
    .getByRole("button", { name: "Project options", exact: true })
    .click();
  await project
    .getByRole("menuitem", { name: "Complete project", exact: true })
    .click();
  const resolution = project.getByRole("region", {
    name: "Resolve project tasks",
    exact: true,
  });
  await expect(
    resolution.getByRole("combobox", { name: actionTitle, exact: true }),
  ).toHaveValue("");
  await expect(
    resolution.getByRole("button", { name: "Confirm completion", exact: true }),
  ).toBeDisabled();
  await resolution
    .getByRole("combobox", { name: actionTitle, exact: true })
    .selectOption("done");
  await resolution
    .getByRole("button", { name: "Confirm completion", exact: true })
    .click();
  await expect(resolution).toHaveCount(0);
  await expect(project.locator(".project-heading")).toContainText("Completed");
  const savedProject = (
    await call(request, "list_projects", { status: "done", limit:100 })
  ).projects.find((p:{title:string})=>p.title === title);
  const savedTask = (
    await call(request, "list_items", {
      project_id: savedProject.id,
      view: "all",
      detail: "full",
    })
  ).items[0];
  expect(savedTask.status).toBe("done");
  expect(savedTask.archived).toBe(false);
});

test("archived project actions remain accessible and unarchive into the correct group", async ({
  page,
  request,
}) => {
  const { project: created } = await createProject(request);
  await createTask(request, { project_id: created.id });
  const { task: archived } = await createTask(request, {
    project_id: created.id,
  });
  await call(request, "update_item", {
    request_id: randomUUID(),
    task_id: archived.id,
    expected_version: archived.version,
    archived: true,
    reason: "Synthetic archived project action",
  });
  const counts = (
    await call(request, "list_projects", { project_id: created.id })
  ).projects[0].task_counts;
  expect(counts.blocked).toBe(1);
  expect(counts.archived).toBe(1);
  const project = await openProject(page, created.title);
  const archivedGroup = project.getByRole("button", {
    name: "Archived tasks 1",
    exact: true,
  });
  await expect(
    project.getByRole("button", { name: "Blocked 1", exact: true }),
  ).toBeVisible();
  await expect(archivedGroup).toHaveAttribute("aria-expanded", "false");
  await expect(
    project.getByRole("button", {
      name: `Details: ${archived.title}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await archivedGroup.click();
  await project
    .getByRole("button", {
      name: `More options: ${archived.title}`,
      exact: true,
    })
    .click();
  await project
    .getByRole("menuitem", { name: "Unarchive", exact: true })
    .click();
  await expect(
    project.getByRole("button", { name: "Blocked 2", exact: true }),
  ).toBeVisible();
  await expect(archivedGroup).toHaveCount(0);
  await expect(
    project.getByRole("button", {
      name: `Details: ${archived.title}`,
      exact: true,
    }),
  ).toBeVisible();
  const saved = (await call(request, "list_items", { task_id: archived.id }))
    .items[0];
  expect(saved.archived).toBe(false);
  expect(saved.status).toBe("blocked");
});

test("nested action drafts survive website navigation and discard explicitly", async ({
  page,
  request,
}) => {
  const { project: created } = await createProject(request);
  const project = await openProject(page, created.title);
  await project
    .getByRole("button", { name: "Add action", exact: true })
    .click();
  await project
    .getByRole("textbox", { name: "Action", exact: true })
    .fill("Keep this action draft");
  await expect(
    project.getByRole("button", { name: "Back to projects", exact: true }),
  ).toBeDisabled();
  await expect(
    project.getByRole("button", { name: "Project options", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  const warning = page.getByRole("alertdialog", { name: "Keep this edit?" });
  await expect(warning).toHaveCount(0);
  await expect(project).toBeHidden();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(
    project.getByRole("textbox", { name: "Action", exact: true }),
  ).toHaveValue("Keep this action draft");
  await project.getByRole("textbox", { name: "Action", exact: true }).fill("");
  await expect(
    project.getByRole("button", { name: "Back to projects", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(warning).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Projects", exact: true }),
  ).toBeHidden();
});

test("project action editors preserve drafts and completion results through compact receipts", async ({
  page,
  request,
}) => {
  const { project: created } = await createProject(request);
  const { task } = await createTask(request, { project_id: created.id });
  const project = await openProject(page, created.title);
  await project
    .getByRole("button", { name: `More options: ${task.title}`, exact: true })
    .click();
  await project.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const editor = project.getByRole("region", {
    name: "Task details",
    exact: true,
  });
  await editor
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("A protected project action draft");
  await expect(
    project.getByRole("button", { name: "Back to projects", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Keep this edit?" }),
  ).toHaveCount(0);
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("A protected project action draft");
  await editor
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("done");
  const more = editor.getByRole("button", {
    name: "More details",
    exact: true,
  });
  if ((await more.getAttribute("aria-expanded")) === "false")
    await more.click();
  await editor
    .getByLabel(/Completion result/)
    .fill("Materials delivered and approved.");
  await editor.getByLabel("Review on", { exact: true }).fill("2026-10-10");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await call(request, "list_items", { task_id: task.id })).items[0]
          .completion_result,
    )
    .toBe("Materials delivered and approved.");
  const saved = (await call(request, "list_items", { task_id: task.id }))
    .items[0];
  expect(saved.notes).toBe("A protected project action draft");
  expect(saved.review_date).toBe("2026-10-10");
  expect(saved.completed_at).toBeTruthy();
  await expect(
    project.getByRole("button", { name: "Back to projects", exact: true }),
  ).toBeEnabled();
  await project.getByRole("button", { name: "Done 1", exact: true }).click();
  await project
    .getByRole("button", { name: `Details: ${task.title}`, exact: true })
    .click();
  await expect(
    project.getByText("Materials delivered and approved.", { exact: true }),
  ).toBeVisible();
});

test("review includes due someday projects and blocked tasks without changing commitment", async ({
  page,
  request,
}) => {
  const prefix = "Review test " + randomUUID().slice(0, 8);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const { project } = await createProject(request, {
    title: prefix + " outcome",
    status: "someday",
    review_date: today,
  });
  const { task } = await createTask(request, {
    title: prefix + " blocked",
    review_date: today,
  });
  await createTask(request, {
    title: prefix + " later",
    review_date: "2099-01-01",
  });
  await createTask(request, {
    title: prefix + " completed",
    status: "done",
    review_date: today,
  });
  // Keep this review/filter check independent of the optional search service.
  for (const [tool, key] of [["list_items", "items"], ["list_projects", "projects"]]) {
    await page.route(`**/api/tools/${tool}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body[key]) body[key] = body[key].filter((record: { title: string }) => record.title.startsWith(prefix));
      await route.fulfill({ response, json: body });
    });
  }
  const writes: string[] = [];
  page.on("request", (r) => {
    if (
      /\/api\/tools\/(?:update_item|update_project|apply_changes|capture_item|create_project|undo_change)$/.test(
        r.url(),
      )
    )
      writes.push(r.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Details: ${task.title}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".project-row").filter({ hasText: project.title }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Details: ${prefix} later`, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: `Details: ${prefix} completed`,
      exact: true,
    }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(
    (await call(request, "list_projects", { project_id: project.id }))
      .projects[0].status,
  ).toBe("someday");
  expect(
    (await call(request, "list_items", { task_id: task.id })).items[0].status,
  ).toBe("blocked");
});

test("refresh preserves the last dirty action when another editor moves its group", async ({
  page,
  request,
}) => {
  const { project: created } = await createProject(request);
  const { task } = await createTask(request, { project_id: created.id });
  const project = await openProject(page, created.title, created.id);
  await project
    .getByRole("button", { name: `More options: ${task.title}`, exact: true })
    .click();
  await project.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const editor = project.getByRole("region", {
    name: "Task details",
    exact: true,
  });
  await editor
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Do not discard this concurrent draft");
  await call(request, "update_item", {
    request_id: randomUUID(),
    task_id: task.id,
    expected_version: task.version,
    status: "next",
    reason: "Synthetic concurrent project task move",
  });
  await page.evaluate(() => window.dispatchEvent(new Event("gtd:changed")));
  await expect(
    editor.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Do not discard this concurrent draft");
  await expect(
    editor.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await expect(
    project.getByRole("button", { name: "Back to projects", exact: true }),
  ).toBeDisabled();
});

test("compact project receipts open full project cards and grouped actions through the host", async ({
  page,
  request,
}) => {
  const created = await createProject(request);
  const { task } = await createTask(request, {
    project_id: created.project.id,
  });
  const calls: { name: string; args: Args }[] = [];
  await page.exposeFunction("projectTool", async (name: string, args: Args) => {
    calls.push({ name, args });
    return {
      structuredContent: await call(request, name, name === "list_items" && !args.project_id && !args.task_id ? {...args,task_ids:[task.id]} : args),
      isError: false,
    };
  });
  const html = await readFile("dist/widget-adapter.html", "utf8");
  await page.route("**/__project-card", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body style='margin:0'></body>",
    }),
  );
  await page.goto("/__project-card");
  await page.evaluate(
    ({ html, created }) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      frame.style.cssText = "width:390px;height:60px;border:0;display:block";
      window.addEventListener("message", async (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data;
        // Simulate the app-only facade used by the authenticated adapter.
        if (m.method === "tools/call" && ["gtd_ui_read", "gtd_ui_write"].includes(m.params.name)) {
          m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
        }
        const send = (value: object) =>
          frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...value }, "*");
        if (m.method === "ui/initialize")
          send({ id: m.id, result: { hostContext: { theme: "dark" } } });
        if (m.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: {
              arguments: {
                request_id: "fixture-project",
                title: created.project.title,
              },
            },
          });
          send({
            method: "ui/notifications/tool-result",
            params: { structuredContent: created, isError: false },
          });
        }
        // This host deliberately keeps the card inline, exercising the bounded
        // fallback. Reply explicitly rather than racing the bridge timeout.
        if (m.method === "ui/request-display-mode")
          send({ id: m.id, result: { mode: "inline" } });
        if (m.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(m.params.name))
          m.params = {...m.params, name:m.params.arguments.operation, arguments:m.params.arguments.arguments};
        if (m.method === "tools/call" && ["view_snapshot","widget_pages"].includes(m.params.name)) {
          send({id:m.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (m.method === "tools/call")
          send({
            id: m.id,
            result: await (window as any).projectTool(
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
    { html, created },
  );
  const card = page.frameLocator("iframe");
  await expect(
    card.getByRole("heading", { name: created.project.title, exact: true }),
  ).toBeVisible();
  await expect(
    card.getByText("The desired outcome is ready for review.", { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: `Details: ${task.title}`, exact: true }),
  ).toBeVisible();
  expect(
    calls
      .filter((c) => c.name === "list_projects")
      .every((c) => c.args.project_id === created.project.id),
  ).toBe(true);
  expect(
    calls.some(
      (c) =>
        c.name === "list_items" &&
        c.args.project_id === created.project.id &&
        c.args.status === "blocked",
    ),
  ).toBe(true);
  expect(
    await card.locator("body").evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);

  const taskResult = await call(request, "show_tasks", { task_id: task.id });
  await page.locator("iframe").evaluate(
    (node, { taskResult, taskId }) => {
      const frame = node as HTMLIFrameElement;
      frame.contentWindow!.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { task_id: taskId } },
        },
        "*",
      );
      frame.contentWindow!.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { structuredContent: taskResult, isError: false },
        },
        "*",
      );
    },
    { taskResult, taskId: task.id },
  );
  // Later host results refresh records, but must not replace the user's route.
  await expect(
    card.getByRole("heading", { name: created.project.title, exact: true }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  await card
    .getByRole("menuitemradio", { name: "Blocked", exact: true })
    .click();
  await card
    .getByRole("button", { name: `Details: ${task.title}`, exact: true })
    .click();
  await card
    .getByRole("button", { name: created.project.title, exact: true })
    .click();
  await expect(
    card.getByRole("heading", { name: created.project.title, exact: true }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Project options", exact: true })
    .click();
  await card
    .getByRole("menuitem", { name: "Edit project", exact: true })
    .click();
  await card
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Keep this card project draft");
  await card
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  await card
    .getByRole("menuitemradio", { name: "All tasks", exact: true })
    .click();
  await card
    .getByRole("button", { name: "Back to previous view", exact: true })
    .click();
  await expect(
    card.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Keep this card project draft");
});

for (const nested of [false, true]) {
  test(`manual recovery finishes the ${nested ? "project action" : "project creation"} form once`, async ({
    page,
    request,
  }) => {
    const title = "Recovered outcome " + randomUUID().slice(0, 8);
    let projectId: string | undefined;
    if (nested) {
      const created = await createProject(request);
      projectId = created.project.id;
      await openProject(page, created.project.title);
      await page
        .getByRole("button", { name: "Add action", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Action", exact: true })
        .fill(title);
    } else {
      await isolateProjects(page, title);
      await page.goto("/");
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await page
        .getByRole("button", { name: "Create project", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Desired outcome", exact: true })
        .fill(title);
    }
    const writes: Args[] = [];
    await page.route(
      `**/api/tools/${nested ? "capture_item" : "create_project"}`,
      async (route) => {
        writes.push(route.request().postDataJSON());
        if (writes.length <= 3)
          return route.fulfill({
            status: 503,
            json: {
              code: "storage_error",
              message: "Synthetic interrupted acknowledgement",
            },
          });
        await route.continue();
      },
    );
    const form = page.locator(
      nested ? ".project-capture form" : "form.project-create",
    );
    if(nested){
      await form.getByRole("spinbutton",{name:"Remaining minutes"}).fill("30");
      await form.getByRole("combobox",{name:"Effort",exact:true}).selectOption("medium");
    }
    await form
      .getByRole("button", {
        name: nested ? "Add action" : "Create project",
        exact: true,
      })
      .click();
    const retry = form.getByRole("button", {
      name: "Retry original change",
      exact: true,
    });
    await expect(retry).toBeVisible();
    expect(writes).toHaveLength(3);
    await retry.click();
    await expect(form).toBeHidden();
    expect(writes).toHaveLength(4);
    expect(
      writes.every(
        (args) => JSON.stringify(args) === JSON.stringify(writes[0]),
      ),
    ).toBe(true);
    if (nested) {
      await expect(
        page.getByRole("button", { name: `Details: ${title}`, exact: true }),
      ).toBeVisible();
      expect(
        (
          await call(request, "list_items", {
            project_id: projectId,
            view: "all",
          })
        ).items,
      ).toHaveLength(1);
    } else {
      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
      expect(
        (await call(request, "list_projects", { limit:100 })).projects.filter((p:{title:string})=>p.title===title),
      ).toHaveLength(1);
    }
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
}

test("dismissing a rejected project capture never resubmits the form", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Desired outcome", exact: true })
    .fill("Rejected project draft");
  let writes = 0;
  await page.route("**/api/tools/create_project", async (route) => {
    writes++;
    await route.fulfill({
      status: 400,
      json: { code: "validation_error", message: "Synthetic rejection" },
    });
  });
  const form = page.locator("form.project-create");
  await form
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await form.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(
    form.getByRole("button", { name: "Create project", exact: true }),
  ).toBeEnabled();
  expect(writes).toBe(1);
  await expect(
    form.getByRole("textbox", { name: "Desired outcome", exact: true }),
  ).toHaveValue("Rejected project draft");
});
