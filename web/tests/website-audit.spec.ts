import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const fixture = {
  id: "website-audit",
  title: "Review the field notes",
  notes: "Original notes",
  status: "next",
  archived: false,
  deleted: false,
  version: 1,
  last_change_id: 1,
  due_date: null,
  links: [],
  location: null,
};
async function isolate(page: Page) {
  await page.route("**/api/view", route => route.fulfill({status:404,json:{message:"Legacy composition fixture"}}));
  await page.route("**/api/tools/list_items", (route) => {
    const args = route.request().postDataJSON();
    return route.fulfill({
      json: {
        items: args.status === "someday" ? [] : [fixture],
        next_offset: null,
        detail: "full",
        history: [],
        next_history_after: null,
      },
    });
  });
}
async function edit(page: Page) {
  await page
    .getByRole("button", {
      name: `More options: ${fixture.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue(fixture.title);
}
async function shot(page: Page, name: string) {
    await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    animations: "disabled",
  });
}
test("tablet draft survives drawer navigation; explicit closing still asks to discard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await isolate(page);
  await page.goto("/");
  await edit(page);
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Keep this draft");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await shot(page, "04-tablet-draft");
  await expect(
    page.getByRole("heading", { name: "Getting things done" }),
  ).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Close details" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Keep this edit?" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Keep editing" }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(
    page.getByRole("complementary", { name: "Task inspector" }),
  ).toHaveCount(0);
});
test("phone inspector moves keyboard focus into the editor and restores it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await isolate(page);
  await page.goto("/");
  await edit(page);
  await shot(page, "05-phone-inspector");
  await expect
    .poll(() =>
      page
        .locator(".gtd-detail")
        .evaluate((el) => el.contains(document.activeElement)),
    )
    .toBe(true);
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Mobile draft");
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("button", { name: "Keep editing" }).press("Escape");
  await expect(
    page.getByRole("button", { name: "Close details" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(
    page.getByRole("button", {
      name: `More options: ${fixture.title}`,
      exact: true,
    }),
  ).toBeFocused();
});
test("activity serializes older-page loading and retries a failed page", async ({
  page,
}) => {
  await isolate(page);
  let olderCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const change = (id: number) => ({
    id,
    task_id: fixture.id,
    operation: "update",
    reason: "Audit fixture",
    before: { ...fixture, version: id - 1 },
    after: { ...fixture, version: id },
    undoes_change_id: null,
    created_at: "2026-10-02T12:00:00Z",
    origin: "website",
  });
  await page.route("**/api/tools/list_changes", async (route) => {
    if (route.request().postDataJSON().before_id) {
      olderCalls++;
      await gate;
      if (olderCalls === 1)
        return route.fulfill({
          status: 503,
          json: { message: "Activity is temporarily unavailable." },
        });
      return route.fulfill({
        json: { changes: [change(1)], next_before_id: null },
      });
    }
    return route.fulfill({ json: { changes: [change(2)], next_before_id: 2 } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Activity", exact: true }).click();
  await page
    .getByRole("button", { name: "Load older changes", exact: true })
    .click();
  await shot(page, "06-activity-loading");
  await expect(
    page.getByRole("button", { name: /Loading older changes/ }),
  ).toBeDisabled();
  release!();
  await expect(page.getByRole("alert")).toContainText(
    "Activity is temporarily unavailable",
  );
  await expect(page.locator(".activity .change")).toHaveCount(1);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".activity .change")).toHaveCount(2);
  expect(olderCalls).toBe(2);
  await page.getByRole("button", { name: "Back to latest" }).click();
  await expect(page.locator(".activity .change")).toHaveCount(1);
});
test("phone help and logs fit narrow screens and log range feedback is actionable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await isolate(page);
  await page.route("**/api/logs?*", (route) =>
    route.fulfill({
      json: { events: [], next_before_id: null, expired_events: 0 },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Getting things done" }),
  ).toBeVisible();
  await shot(page, "07-phone-help");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Logs", exact: true }).click();
  await page.getByLabel("From (browser time)").fill("2026-10-02T12:00");
  await page.getByLabel("Through (browser time)").fill("2026-10-01T12:00");
  await shot(page, "08-phone-log-range");
  await expect(page.getByRole("alert")).toContainText("end time must be after");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
