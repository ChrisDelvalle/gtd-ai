import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("login, mobile polish, remembered sessions, logout and reauthentication retain drafts", async ({ page, context, baseURL, browserName }, testInfo) => {
  const headers = { Origin: baseURL!, "X-GTD-Request": "1", "X-GTD-Environment": "test" };
  expect((await page.request.get("/api/auth/session")).ok()).toBeTruthy();
  expect((await (await page.request.get("/api/auth/session")).json()).environment).toBe("test");
  expect((await page.request.get("/api/health")).status()).toBe(401);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1727, height: 995 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "GTD", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: testInfo.outputPath(`${browserName}-desktop-light.png`) });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    for (const element of await page.locator("input,button").all()) {
      const box = await element.boundingBox(); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath(`${browserName}-mobile-light.png`) });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: testInfo.outputPath(`${browserName}-mobile-dark.png`) });
  await page.getByLabel("Password", { exact: true }).fill("incorrect");
  await page.getByRole("button", { name: "Show password", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Incorrect username or password.");
  await page.getByLabel("Password", { exact: true }).fill("password");
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  const cookie = (await context.cookies()).find(c => c.name === "gtd_test_session")!;
  expect(cookie.httpOnly).toBeTruthy(); expect(cookie.sameSite).toBe("Lax");
  expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(29 * 86400);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect((await page.request.get("/api/health", { headers: { Cookie: `${cookie.name}=${cookie.value}` } })).status()).toBe(401);
  await page.getByLabel("Password", { exact: true }).fill("password");
  await page.getByLabel("Stay signed in").uncheck();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await context.cookies()).find(c => c.name === "gtd_test_session")!.expires).toBe(-1);
  const response = await page.request.post("/api/tools/capture_item", { headers, data: { title: "Private login fixture", brief: "Check the disposable login fixture.", notes: "Description before editing", status: "next", importance: "normal", estimated_minutes: 15, effort: "low", reason: "Disposable authentication test", request_id: randomUUID() } });
  expect(response.ok()).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole("button", { name: "More options: Private login fixture", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const description = page.getByRole("textbox", { name: "Notes", exact: true });
  await description.fill("Unsaved draft survives signing in again");
  let writes = 0;
  page.on("request", request => { if (request.url().endsWith("/api/tools/update_item")) writes++; });
  await context.clearCookies();
  // A normal API request detects expiry. This is not a fake DOM login state.
  await page.evaluate(async () => {
    const response = await fetch("/api/health");
    if (response.status !== 401) throw new Error("Expected expired session");
  });
  // Trigger an ordinary read using the sidebar without discarding the editor.
  await page.evaluate(() => window.dispatchEvent(new Event("gtd:changed")));
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "GTD", exact: true })).toBeVisible();
  await page.getByRole("dialog").screenshot({ path: testInfo.outputPath(`${browserName}-reauthentication.png`) });
  await page.getByRole("dialog").press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(description).toHaveValue("Unsaved draft survives signing in again");
  expect(writes).toBe(0);
});
