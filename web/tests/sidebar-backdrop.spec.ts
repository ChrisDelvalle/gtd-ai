import { test, expect, type Page, type Locator } from "@playwright/test";
import { openWidget } from "./helpers/widget-host";

async function fixture(page: Page) {
  let reads = 0;
  await page.route("**/api/tools/list_items", (route) => {
    reads++;
    if (route.request().postDataJSON().blocked_by_id) return route.fulfill({ json: { items: [], next_cursor: null } });
    return route.fulfill({
      json: {
        items: Array.from({ length: 24 }, (_, i) => ({
          id: `browser-task-${i}`,
          title: `Task ${i + 1}`,
          notes: "Useful details. ".repeat(100),
          status: "next",
          archived: false,
          deleted: false,
          version: 1,
          last_change_id: i + 1,
          due_date: null,
          links: [],
        })),
        next_cursor: null,
      },
    });
  });
  await page.route("**/api/view", route => {
    reads++;
    const empty = { items: [], next_cursor: null };
    const items = Array.from({ length: 7 }, (_, i) => ({
      id: `browser-task-${i}`, title: `Task ${i + 1}`,
      notes: "Useful details. ".repeat(100), status: "next", archived: false,
      deleted: false, version: 1, last_change_id: i + 1, due_date: null, links: [],
    }));
    return route.fulfill({ json: { data: { next: { ...empty, items }, waiting: empty,
      someday: empty, reviewTasks: empty, reviewProjects: { projects: [] }, remaining: null } } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".compact-task:visible").first()).toBeVisible();
  return () => reads;
}
async function paint(target: Locator) {
  return target.evaluate((el) => {
    const c = getComputedStyle(el);
    return [
      c.backgroundColor,
      c.color,
      c.borderColor,
      c.opacity,
      c.boxShadow,
      c.backgroundImage,
    ];
  });
}
async function stableHover(target: Locator) {
  const before = await paint(target);
  await target.hover();
  // Let an existing color transition settle so an override cannot hide in the first frame.
  await expect.poll(() => paint(target)).toEqual(before);
  await target.page().waitForTimeout(180);
  expect(await paint(target)).toEqual(before);
}
for (const theme of ["light", "dark"] as const) {
  test(`website drawer and controls do not highlight on hover (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 900, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await fixture(page);
    await stableHover(page.locator(".featured-task"));
    await stableHover(
      page.getByRole("button", { name: "Open navigation", exact: true }),
    );
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    const scrim = page.locator(".nav-scrim");
    await expect(scrim).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.mouse.move(890, 400);
    const before = await paint(scrim);
    await page.mouse.move(890, 500);
    await page.waitForTimeout(180);
    expect(await paint(scrim)).toEqual(before);
    await stableHover(
      page
        .locator(".gtd-sidebar")
        .getByRole("button", { name: "Inbox", exact: true }),
    );
    expect(
      await page
        .locator(".gtd-shell:visible")
        .evaluate((el) => getComputedStyle(el, "::after").backgroundColor),
    ).toBe("rgba(0, 0, 0, 0.333)");
    await page.screenshot({ path: info.outputPath("website-drawer.png") });
    await scrim.click({ position: { x: 880, y: 400 } });
    await expect(scrim).toHaveCount(0);
  });
  test(`expanded ChatGPT drawer does not flash on hover (${theme})`, async ({
    page,
  }, info) => {
    const { frame, surface, scroll, changeMode } = await openWidget(page, {
      width: 800,
      theme,
      project: true,
    });
    await expect(
      frame.getByRole("button", { name: "Refresh projects", exact: true }),
    ).toBeVisible();
    await changeMode("fullscreen");
    await frame
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    const scrim = frame.locator(".nav-scrim");
    await expect(scrim).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    // Hover an exposed part of the scrim, not its center underneath the drawer.
    const before = await paint(scrim);
    await scrim.hover({ position: { x: 740, y: 300 } });
    await page.waitForTimeout(180);
    expect(await paint(scrim)).toEqual(before);
    expect(
      await frame
        .locator(".gtd-shell:visible")
        .evaluate((el) => getComputedStyle(el, "::after").backgroundColor),
    ).toBe("rgba(0, 0, 0, 0.333)");
    const dimHeight = await frame
      .locator(".gtd-shell:visible")
      .evaluate((el) => parseFloat(getComputedStyle(el, "::after").height));
    expect(dimHeight).toBeGreaterThanOrEqual(
      (await surface.boundingBox())!.height,
    );
    await page.screenshot({ path: info.outputPath("widget-drawer.png") });
    await scrim.click({ position: { x: 740, y: 300 } });
    await expect(scrim).toHaveCount(0);
    await expect(
      frame.getByRole("button", { name: "Refresh projects", exact: true }),
    ).toBeVisible();
    await surface.evaluate((el) => {
      const style = (el as HTMLElement).style;
      style.setProperty("--widget-safe-top", "20px");
      style.setProperty("--widget-safe-bottom", "30px");
    });
    expect(await scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  });
}

test.describe("mobile document scrolling", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  test("long pages keep content below the viewport; drawers and refresh preserve scrolling", async ({
    page,
    browserName,
  }, info) => {
    const reads = await fixture(page);
    await page
      .getByRole("button", { name: "Details: Task 1", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight))
      .toBeGreaterThan(1244);
    await page.touchscreen.tap(2, 200);
    await page.evaluate(() => window.scrollTo(0, 400));
    expect(await page.evaluate(() => window.scrollY)).toBe(400);
    expect(
      await page.locator(".gtd-main:visible").evaluate((el) => el.scrollTop),
    ).toBe(0);
    const previous = reads();
    await page.locator(".gtd-main:visible").evaluate(async (el) => {
      for (const [name, y] of [
        ["touchstart", 180],
        ["touchmove", 350],
        ["touchend", 350],
      ] as const) {
        const event = new Event(name, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", {
          value: name === "touchend" ? [] : [{ clientX: 180, clientY: y }],
        });
        el.dispatchEvent(event);
        await new Promise(requestAnimationFrame);
      }
    });
    expect(reads()).toBe(previous);
    await expect(
      page.getByRole("status", { name: "Refreshing", exact: true }),
    ).toHaveCount(0);
    // The sticky control is already visible. Locator.click's scrollIntoView
    // resets root scrolling in Chromium before dispatching input; use the
    // actual visible position to exercise a user's click and app behavior.
    const navigation = await page.getByRole("button", { name: "Open navigation", exact: true }).boundingBox();
    await page.mouse.click(navigation!.x + navigation!.width / 2, navigation!.y + navigation!.height / 2);
    expect(await page.evaluate(() => window.scrollY)).toBe(400);

    const scrim = page.locator(".nav-scrim");
    await expect(scrim).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(scrim).toHaveCSS("touch-action", "none");
    expect(
      await page
        .locator(".gtd-shell:visible")
        .evaluate((el) => getComputedStyle(el, "::after").backgroundColor),
    ).toBe("rgba(0, 0, 0, 0.333)");
    await page.mouse.move(375, 400);
    if (browserName !== "webkit") await page.mouse.wheel(0, 200);
    else
      expect(
        await scrim.evaluate((el) => {
          const wheel = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: 200,
          });
          el.dispatchEvent(wheel);
          return wheel.defaultPrevented;
        }),
      ).toBe(true);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.scrollY)).toBe(400);
    await page.screenshot({
      path: info.outputPath("mobile-document-drawer.png"),
    });
    await scrim.click({ position: { x: 375, y: 300 } });
    expect(await page.evaluate(() => window.scrollY)).toBe(400);
    await page.screenshot({ path: info.outputPath("mobile-document.png") });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  });
});

for (const installed of [false, true]) {
  test(`Projects drawer releases dimming and leaves native bands unchanged (${installed ? "installed" : "browser"})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (installed) {
      // Exercise the standalone CSS branch; this is not a physical Safari test.
      await page.route("**/assets/style-*.css", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: (await response.text()).replaceAll(
            "(display-mode: browser)",
            "(display-mode: fullscreen)",
          ),
        });
      });
    }
    await fixture(page);
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-top", "44px");
      document.documentElement.style.setProperty("--safe-bottom", "34px");
    });
    await expect(
      page.locator('meta[name="apple-mobile-web-app-status-bar-style"]'),
    ).toHaveAttribute("content", "black-translucent");
    const theme = page.locator('meta[name="theme-color"]');
    const color = await theme.getAttribute("content");
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page
      .locator(".gtd-sidebar:visible")
      .getByRole("button", { name: "Projects", exact: true })
      .click();
    await expect(page.locator(".project-browser:visible")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh projects", exact: true }),
    ).toHaveCount(0);
    for (const dismissal of ["close", "escape", "scrim", "escape", "close"]) {
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      const shell = page.locator(".gtd-shell:visible");
      await expect(shell).toHaveClass(/nav-open/);
      const drawer = page.locator(".gtd-sidebar:visible");
      const rect = (await drawer.boundingBox())!;
      const banner = (await page.locator(".test-mode").boundingBox())!;
      expect(rect.y).toBe(banner.height);
      expect(rect.y + rect.height).toBe(844);
      const brand = (await drawer.locator(".sidebar-brand").boundingBox())!;
      expect(brand.y).toBeGreaterThanOrEqual(rect.y + 44);
      const footer = (await drawer.locator(".nav-bottom").boundingBox())!;
      expect(footer.y + footer.height).toBeLessThanOrEqual(844 - 34);
      await expect(theme).toHaveAttribute("content", color!);
      expect(
        await shell.evaluate((el) => getComputedStyle(el, "::after").top),
      ).toBe("44px");
      if (dismissal === "escape") await page.keyboard.press("Escape");
      else if (dismissal === "close")
        await page
          .locator(".gtd-sidebar:visible")
          .getByRole("button", { name: "Close navigation", exact: true })
          .click();
      else
        await page
          .locator(".nav-scrim")
          .click({ position: { x: 375, y: 300 } });
      await expect(shell).not.toHaveClass(/nav-open|nav-dragging/);
      await expect(page.locator(".nav-scrim")).toHaveCount(0);
      expect(
        await shell.evaluate((el) => getComputedStyle(el, "::after").content),
      ).toBe("none");
      await expect(theme).toHaveAttribute("content", color!);
      await expect(page.locator(".gtd-main:visible")).not.toHaveAttribute(
        "inert",
      );
    }
    await page.screenshot({ path: info.outputPath("projects-closed.png") });
  });
}
