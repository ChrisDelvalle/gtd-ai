import { test, expect } from "@playwright/test";
import { openWidget, title, projectTitle } from "./helpers/widget-host";

// Hit testing alone misses transparent sticky surfaces: the controls still
// work even when the description paints through them. Check the actual pixels
// with and without the scrolled content underneath, as well as placement.
for (const width of [390, 1200]) {
  for (const theme of ["light", "dark"] as const) {
    for (const view of ["active", "home", "project", "review"] as const) {
      test(`${view} sticky surface at ${width}px in ${theme}`, async ({ page }, info) => {
        const { frame, surface, scroll } = await openWidget(page, {
          width, theme,
          environment: theme === "dark" ? "test" : undefined,
          project: view === "project",
          launch: view === "home" || view === "review" ? view : undefined,
        });
        if (view === "project") {
          await frame.getByRole("button", { name: new RegExp(projectTitle) }).click();
        } else {
          await frame.getByRole("button", { name: "Expand view", exact: true }).click();
        }
        await expect(surface).toHaveAttribute("data-display", "fullscreen");
        const details = frame.getByRole("button", { name: `Details: ${title}`, exact: true }).first();
        const task = frame.locator(".compact-task").filter({ has: details }).first();
        await details.click();
        await expect(task.locator(".task-expansion[data-resizing]")).toHaveCount(0);
        const row = task.locator(":scope > .compact-row");
        for (const distance of [350, 700]) {
          await scroll.evaluate((el, y) => el.scrollTo({ top: y, behavior: "instant" }), distance);
          await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(distance);
          await page.mouse.move(width - 1, 1);
          const box = (await row.boundingBox())!;
          expect(box.y).toBeGreaterThanOrEqual((await scroll.boundingBox())!.y + 48);
          const toolbar = view === "project" ? frame.locator(".project-toolbar").first()
            : view === "review" ? frame.locator(".gtd-topbar") : frame.locator(".browse-toolbar").first();
          const bar = (await toolbar.boundingBox())!;
          expect(Math.abs(box.y - bar.y - bar.height), "Task controls sit below the page header").toBeLessThan(1);
          expect(await row.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return [...el.querySelectorAll("button")].filter(button => !button.closest("[inert]")).every(button => {
              const r = button.getBoundingClientRect();
              const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              return r.top >= rect.top && r.bottom <= rect.bottom && (hit === button || button.contains(hit));
            });
          })).toBe(true);
          // Screenshot the same rectangle without scrollIntoView side effects.
          const visible = await page.screenshot({ clip: box, animations: "disabled" });
          await task.locator(".task-expansion").evaluate(el => { (el as HTMLElement).style.visibility = "hidden"; });
          const obscured = await page.screenshot({ clip: box, animations: "disabled" });
          await task.locator(".task-expansion").evaluate(el => { (el as HTMLElement).style.removeProperty("visibility"); });
          await info.attach(`scrolled-header-${distance}`, { body: visible, contentType: "image/png" });
          expect(visible.equals(obscured), "Description must not paint through the sticky task heading").toBe(true);
        }
        await page.screenshot({ path: info.outputPath("scrolled-fullscreen.png") });
      });
    }
  }
}
