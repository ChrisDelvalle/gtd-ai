import { test, expect } from "@playwright/test";

test("website URLs restore destination and filters through reload and browser history", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator(".gtd-sidebar:visible")
    .getByRole("button", { name: "All tasks", exact: true })
    .click();
  await expect(page).toHaveURL(/\/tasks\?/);
  await page
    .getByRole("button", { name: "Sort and filter tasks", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Sort tasks", exact: true })
    .selectOption("importance");
  await expect(page).toHaveURL(/sort=importance/);
  await page.keyboard.press("Escape");
  await page
    .locator(".gtd-sidebar:visible")
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.goBack();
  await expect(page).toHaveURL(/sort=importance/);
  await expect(
    page.getByRole("heading", { name: "All tasks", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Sort and filter tasks", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Sort tasks", exact: true }),
  ).toHaveValue("importance");
  await page.keyboard.press("Escape");
  await page.goForward();
  await expect(page).toHaveURL(/\/projects$/);
});

test("focused links load without prior navigation", async ({
  page,
  request,
  baseURL,
}) => {
  const response = await request.post("/api/tools/capture_item", {
    headers: { Origin: baseURL!, "X-GTD-Request": "1" },
    data: {
      request_id: crypto.randomUUID(),
      title: "URL fixture action",
      importance: "normal",
      estimated_minutes: 15,
      effort: "low",
      notes: "A direct link preserves this description.",
      reason: "Disposable URL fixture",
    },
  });
  expect(response.ok()).toBeTruthy();
  const { task } = await response.json();
  const navigation = await page.goto(`/tasks/${task.id}`);
  expect(navigation?.status()).toBe(200);
  await expect(
    page.getByText("A direct link preserves this description.", {
      exact: true,
    }),
  ).toBeVisible();
  expect((await page.request.get("/not-an-application-route")).status()).toBe(
    404,
  );
  expect((await page.request.get("/missing.js")).status()).toBe(404);
  for (const prefix of ["tasks", "projects", "repeating"])
    expect((await page.request.get(`/${prefix}/not-an-id`)).status()).toBe(404);
});

test("project URLs preserve lifecycle filters, creation and nested drafts", async ({page, request, baseURL}) => {
  const title = `URL project ${crypto.randomUUID()}`;
  await page.goto("/projects?status=someday");
  await expect(page.getByRole("button", {name: "Someday projects", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Create project", exact: true}).click();
  await page.getByRole("textbox", {name: "Desired outcome", exact: true}).fill(title);
  await page.locator("form.project-create").getByRole("textbox", {name: "Brief", exact: true}).fill("Complete the URL navigation fixture project.");
  await page.locator("form.project-create").getByRole("button", {name: "Create project", exact: true}).click();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.reload();
  await expect(page.getByRole("heading", {name: title, exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Add action", exact: true}).click();
  const form = page.locator(".project-capture form");
  const actionTitle = `Action for ${title}`;
  await form.getByRole("textbox", {name: "Action", exact: true}).fill(actionTitle);
  await form.getByRole("textbox", {name: "Brief", exact: true}).fill("Complete the nested fixture action.");
  await form.getByRole("combobox", {name: "Status", exact: true}).selectOption("next");
  await form.getByRole("button", {name: "Add action", exact: true}).click();
  await expect(form.getByRole("spinbutton", {name: "Remaining minutes"})).toBeFocused();
  await form.getByRole("spinbutton", {name: "Remaining minutes"}).fill("25");
  await form.getByRole("combobox", {name: "Effort", exact: true}).selectOption("low");
  await page.locator(".gtd-sidebar:visible").getByRole("button", {name: "Home", exact: true}).click();
  await page.goBack();
  await expect(form.getByRole("textbox", {name: "Action", exact: true})).toHaveValue(actionTitle);
  await expect(form.getByRole("spinbutton", {name: "Remaining minutes"})).toHaveValue("25");
  await form.getByRole("button", {name: "Add action", exact: true}).click();
  await expect(page.getByRole("button", {name: `Details: ${actionTitle}`, exact: true})).toBeVisible();
  const response = await request.post("/api/tools/list_items", {headers:{Origin:baseURL!,"X-GTD-Request":"1"},data:{project_id:projectId,view:"all",detail:"full"}});
  expect(response.ok()).toBeTruthy();
  const {items} = await response.json();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({title:actionTitle,status:"next",estimated_minutes:25,effort:"low"});
});
