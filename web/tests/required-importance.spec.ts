import { test, expect } from "@playwright/test";
import { openWidget } from "./helpers/widget-host";
for (const width of [390, 1280]) {
  test(`capture has explicit importance and responsive navigation at ${width}`, async ({ page, request, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light", reducedMotion: "reduce" });
    await page.goto("/");
    const nav = page.getByRole("button", { name: "Open navigation", exact: true });
    if (width > 1040) {
      await expect(nav).toBeHidden();
      await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toBeHidden();
    } else await expect(nav).toBeVisible();
    await page.getByRole("button", { name: "Add task", exact: true }).click();
    const form = page.getByRole("form", { name: "Capture a task" });
    const level = form.getByRole("combobox", { name: "Importance", exact: true });
    await expect(level).toHaveValue("normal");
    await expect(level.locator("option")).toHaveCount(7);
    const title = `Importance ${crypto.randomUUID()}`;
    await form.getByRole("textbox", { name: "Add to inbox" }).fill(title);
    await level.selectOption("high");
    await page.screenshot({ path: info.outputPath("capture.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    const saved = page.waitForResponse(r => r.url().endsWith("/api/tools/capture_item") && r.request().method() === "POST");
    await form.getByRole("button", { name: "Capture task", exact: true }).click();
    const response = await saved; expect(response.ok()).toBeTruthy();
    const receipt = await response.json();
    expect(receipt.task.importance).toBe("high");
    const read = await request.post("/api/tools/list_items", { headers: { Origin: baseURL!, "X-GTD-Request": "1" }, data: { task_id: receipt.task.id } });
    expect((await read.json()).items[0].importance).toBe("high");
    // Crossing the layout boundary should reveal exactly one drawer opener.
    await page.setViewportSize({ width: 1040, height: 900 }); await expect(nav).toBeVisible();
    await page.setViewportSize({ width: 1041, height: 900 }); await expect(nav).toBeHidden();
  });
}
for (const width of [390, 1280]) {
  test(`widget capture choice survives expansion and navigation layout at ${width}`, async ({ page }, info) => {
    const { frame } = await openWidget(page, { width, long: false });
    await frame.getByRole("button", { name: "Expand view", exact: true }).first().click();
    const toggle = frame.getByRole("button", { name: "Open navigation", exact: true });
    if (width > 1040) await expect(toggle).toBeHidden(); else await expect(toggle).toBeVisible();
    await frame.getByRole("button", { name: "Add task", exact: true }).first().click();
    const form = frame.getByRole("form", { name: "Capture a task" });
    await form.getByRole("textbox", { name: "Add to inbox" }).fill("Draft with required importance");
    const level = form.getByRole("combobox", { name: "Importance", exact: true });
    await expect(level).toHaveValue("normal"); await level.selectOption("very_high");
    await form.getByRole("button", { name: "Close capture" }).click();
    await frame.getByRole("button", { name: "Continue adding task", exact: true }).first().click();
    await expect(level).toHaveValue("very_high");
    await expect(level.locator("option")).toHaveCount(7);
    await page.screenshot({ path: info.outputPath("widget-capture.png") });
  });
}
