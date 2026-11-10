import { test, expect } from "@playwright/test";
import { openWidget } from "./helpers/widget-host";

for (const width of [320, 390]) {
  for (const view of ["active", "home", "project", "review", "repeating", "activity", "help"] as const) {
    test(`expanded ${view} header and capture stay accessible at ${width}px`, async ({ page }, info) => {
      const { frame, surface, scroll, changeMode, requests } = await openWidget(page, {
        width, theme: "light", environment: "test", project: view === "project",
        launch: view === "active" || view === "project" ? undefined : view,
      });
      await frame.getByRole("button", { name: "Expand view", exact: true }).click();
      await expect(surface).toHaveAttribute("data-display", "fullscreen");
      const toolbar = view === "project" ? frame.locator(".project-toolbar").first()
        : view === "active" || view === "home" ? frame.locator(".browse-toolbar").first()
        : frame.locator(".gtd-topbar");
      const area = (await surface.boundingBox())!;
      const bar = (await toolbar.boundingBox())!;
      expect(Math.abs(bar.x - area.x)).toBeLessThan(1);
      expect(Math.abs(bar.width - area.width)).toBeLessThan(1);
      // Simulate a host composer obscuring the lower part of the embedded app.
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.id = "host-composer";
        overlay.style.cssText = "position:fixed;bottom:0;height:250px;left:0;right:0;background:#ddd;z-index:100";
        overlay.textContent = "Host chat composer";
        document.body.append(overlay);
      });
      const add = toolbar.getByRole("button", { name: "Add task", exact: true });
      const addBox = (await add.boundingBox())!;
      expect(addBox.x).toBeGreaterThanOrEqual(bar.x);
      expect(addBox.x + addBox.width).toBeLessThanOrEqual(bar.x + bar.width);
      expect(addBox.width).toBeGreaterThanOrEqual(44);
      await add.click();
      const input = frame.getByRole("textbox", { name: "Add to inbox", exact: true });
      await expect(input).toBeFocused();
      await input.fill("Keep this task draft");
      const form = frame.getByRole("form", { name: "Capture a task" });
      const formBox = (await form.boundingBox())!;
      expect(formBox.y).toBeGreaterThanOrEqual(bar.y + bar.height);
      expect(formBox.y + formBox.height).toBeLessThan(400);
      await page.screenshot({ path: info.outputPath("capture-open.png") });
      await frame.getByRole("button", { name: "Close capture", exact: true }).click();
      await expect(toolbar.getByRole("button", { name: "Continue adding task", exact: true })).toBeFocused();
      await toolbar.getByRole("button", { name: "Continue adding task", exact: true }).click();
      await expect(input).toHaveValue("Keep this task draft");
      await changeMode("inline");
      await expect(input).toBeHidden();
      await changeMode("fullscreen");
      await expect(input).toHaveValue("Keep this task draft");
      await input.press("Escape");
      await expect(input).toBeHidden();
      expect((await requests("tools/call")).filter(m => m.params.name === "capture_item")).toHaveLength(0);
      expect(await scroll.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath("expanded-header.png") });
    });
  }
}
