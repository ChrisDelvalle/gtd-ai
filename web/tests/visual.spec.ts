import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
test("workspace visual states: desktop, reference width, phone, light and dark", async ({
  page,
  request,
  baseURL,
}) => {
  const fixtures = [
    [
      "Send the revised proposal",
      "next",
      "2026-10-03",
      "Confirm the final scope and send a short follow-up.",
    ],
    ["Pick up groceries", "next", "2026-10-04", "Coffee, apples, oat milk."],
    ["Book a table for Saturday", "next", null, ""],
    ["Outline the next chapter", "next", null, "Start with three points."],
    ["Plan a weekend walk", "inbox", null, ""],
    [
      "Waiting for the print proof",
      "waiting",
      "2026-10-06",
      "Follow up if it has not arrived by Tuesday.",
    ],
    ["Learn to make sourdough", "someday", null, ""],
    ["Renew the library card", "done", "2026-10-01", ""],
    ["Old packing checklist", "archived", null, ""],
  ];
  const seeded = await request.post("/api/tools/apply_changes", {
    headers: { Origin: baseURL!, "X-GTD-Request": "1" },
    data: {
      request_id: crypto.randomUUID(),
      operations: fixtures.map(([title, status, due_date, notes]) => ({importance: "normal", estimated_minutes: 30, effort: "medium", 
        operation: "capture",
        title,
        status,
        due_date,
        notes,
        reason: "Synthetic polish preview fixture",
      })),
    },
  });
  expect(seeded.ok()).toBe(true);
  const ids = (await seeded.json()).results.map((r: any) => r.entity_id);
  await page.route("**/api/tools/list_items", async (route) => {
    const args = route.request().postDataJSON();
    const response = await route.fetch({
      postData: JSON.stringify({
        ...args,
        ...(args.task_id ? {} : { task_ids: ids }),
      }),
    });
    await route.fulfill({ response });
  });
  const dir = test.info().outputPath("screenshots");
  await mkdir(dir, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // An old manual setting must not override the current system appearance.
  await page.addInitScript(() => localStorage.setItem("gtd-theme", "light"));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("button", {
      name: "Details: Send the revised proposal",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".test-mode")).toBeVisible();
  const sidebar = (await page.locator(".gtd-sidebar:visible").boundingBox())!;
  expect(sidebar.y + sidebar.height).toBeLessThanOrEqual(1000);
  await expect(
    page
      .locator(".gtd-sidebar:visible")
      .getByRole("button", { name: "Help", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    animations: "disabled",
    path: dir + "/desktop-dark.png",
  });
  await expect(
    page.getByRole("region", {
      name: "Task information: Send the revised proposal",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "All tasks", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Details: Send the revised proposal",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", {
      name: "Task information: Send the revised proposal",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".gtd-detail:visible")).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: dir + "/desktop-expanded.png",
  });
  await page
    .getByRole("button", {
      name: "More options: Send the revised proposal",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Task details" }).getByLabel("Title"),
  ).toHaveValue("Send the revised proposal");
  await expect(page.locator(".gtd-detail:visible")).toHaveCSS(
    "margin-top",
    "0px",
  );
  await page.screenshot({
    animations: "disabled",
    path: dir + "/desktop-inspector.png",
  });
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.setViewportSize({ width: 764, height: 988 });
  await page.screenshot({
    animations: "disabled",
    path: dir + "/narrow-dark.png",
  });
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.screenshot({
    animations: "disabled",
    path: dir + "/narrow-navigation.png",
  });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page
    .locator(".gtd-sidebar:visible")
    .getByRole("button", { name: "Close navigation", exact: true })
    .click();
  await page.screenshot({
    animations: "disabled",
    path: dir + "/narrow-light.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    animations: "disabled",
    path: dir + "/phone-light.png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page
    .locator(".gtd-sidebar:visible")
    .getByRole("button", { name: "Close navigation", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "More options: Send the revised proposal",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Task details" })
      .getByRole("textbox", { name: "Notes", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".task-column:visible")).toHaveAttribute(
    "inert",
    "",
  );
  await page.screenshot({
    animations: "disabled",
    path: dir + "/phone-inspector-dark.png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.unrouteAll({ behavior: "wait" });
  expect(errors).toEqual([]);
});
