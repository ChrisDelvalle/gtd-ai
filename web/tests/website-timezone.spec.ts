import { test, expect, type Page } from "@playwright/test";
import { fixtureContent } from "./helpers/content";
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
function session(timezone: string, id = owner) {
  return { authenticated: true, enabled: true, method: "oidc", environment: "test", csrf: "a".repeat(64),
    account: { id, username: "fixture", display_name: null, timezone, administrator: false } };
}
async function open(page: Page, mobile = false) {
  if (mobile) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Timezone", exact: true }).click();
  return page.getByRole("dialog", { name: "Timezone", exact: true });
}
for (const mobile of [false, true]) test(`ordinary account timezone (${mobile ? "mobile dark" : "desktop"})`, async ({ page }, info) => {
  if (mobile) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
  }
  let zone = "America/New_York", writes = 0;
  await page.route("**/api/auth/session", route => route.fulfill({ json: session(zone) }));
  await page.route("**/api/account/timezone", route => {
    writes++;
    expect(route.request().headers()["x-gtd-account"]).toBe(owner);
    expect(route.request().headers()["x-gtd-csrf"]).toBe("a".repeat(64));
    expect(route.request().postDataJSON()).toEqual({ expected_timezone: "America/New_York", timezone: "Asia/Tokyo" });
    zone = "Asia/Tokyo";
    return route.fulfill({ json: { timezone: zone } });
  });
  await page.goto("/");
  const dialog = await open(page, mobile);
  await expect(dialog.getByLabel("Timezone", { exact: true })).toHaveValue("America/New_York");
  await dialog.getByLabel("Timezone", { exact: true }).fill("Asia/Tokyo");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath("timezone.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  // A reopened setting uses the saved preference rather than the device zone.
  // Mobile navigation remains open below the modal.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Timezone", exact: true }).click();
  await expect(dialog.getByLabel("Timezone", { exact: true })).toHaveValue("Asia/Tokyo");
  expect(writes).toBe(1);
});
for (const lost of [false, true]) test(`timezone ${lost ? "lost response" : "conflict"} requires inspection without automatic retries`, async ({ page }) => {
  let zone = "America/New_York", writes = 0;
  await page.route("**/api/auth/session", route => route.fulfill({ json: session(zone) }));
  await page.route("**/api/account/timezone", route => {
    writes++;
    zone = lost ? "Asia/Tokyo" : "Europe/Paris";
    return route.fulfill({ status: lost ? 504 : 409,
      json: { code: lost ? "response_unconfirmed" : "settings_conflict", message: "Check the current setting." } });
  });
  await page.goto("/");
  const dialog = await open(page);
  await dialog.getByLabel("Timezone", { exact: true }).fill("Asia/Tokyo");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Check setting", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Timezone", { exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Check setting", exact: true }).click();
  if (lost) await expect(dialog).not.toBeVisible();
  else {
    await expect(dialog.getByLabel("Timezone", { exact: true })).toHaveValue("Asia/Tokyo");
    await expect(dialog.getByRole("alert")).toContainText("Europe/Paris");
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  }
  expect(writes).toBe(1);
});
test("account change during timezone confirmation conceals the old draft", async ({ page }) => {
  let id = owner, writes = 0;
  await page.route("**/api/auth/session", route => route.fulfill({ json: session("America/New_York", id) }));
  await page.route("**/api/account/timezone", route => {
    writes++; id = other;
    return route.fulfill({ json: { timezone: "Asia/Tokyo" } });
  });
  await page.goto("/");
  const dialog = await open(page);
  await dialog.getByLabel("Timezone", { exact: true }).fill("Asia/Tokyo");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("This session has ended.", { exact: true })).toBeVisible();
  await expect(dialog).not.toBeVisible();
  expect(writes).toBe(1);
});
test("new timing uses the account default while stored timing keeps its own zone", async ({ page, request, baseURL }) => {
  const title = `Timezone fixture ${crypto.randomUUID()}`;
  const result = await request.post("/api/tools/capture_item", {
    headers: { Origin: baseURL!, "X-GTD-Request": "1" },
    data: fixtureContent("capture_item", { title, status: "next", importance: "normal", estimated_minutes: 15, effort: "low",
      due_date: "2027-04-15", start_by: { date: "2027-04-14", time: "12:00", timezone: "Europe/Paris" },
      request_id: crypto.randomUUID(), reason: "Disposable timezone UI fixture" }),
  });
  expect(result.ok()).toBeTruthy();
  const { task } = await result.json();
  await page.route("**/api/auth/session", route => route.fulfill({ json: session("Asia/Tokyo") }));
  await page.route("**/api/tools/list_items", route => route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), task_id: task.id }) }));
  await page.goto("/");
  await page.getByRole("button", { name: `More options: ${title}`, exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("region", { name: "Task details", exact: true });
  const timing = editor.getByRole("button", { name: "Timing", exact: true });
  if (await timing.getAttribute("aria-expanded") !== "true") await timing.click();
  await editor.getByRole("button", { name: "Add time to deadline", exact: true }).click();
  await expect(editor.getByLabel("Deadline timezone", { exact: true })).toHaveValue("Asia/Tokyo");
  await expect(editor.getByLabel("Start by timezone", { exact: true })).toHaveValue("Europe/Paris");
});
