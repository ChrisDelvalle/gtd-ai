import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdir } from "node:fs/promises";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

async function setup(page: Page, safeTop: number) {
  const tasks=Array.from({length:24},(_,i)=>({id:`header-${i}`,title:`Task ${i+1}`,
    brief:"Read the supporting information.",notes:"The information needed to get started.\n\n".repeat(40),
    status:"next",archived:false,deleted:false,version:1,last_change_id:i+1,due_date:null,links:[],location:null}));
  await page.route("**/api/tools/list_items",route=>{
    const args=route.request().postDataJSON();
    return route.fulfill({json:{items:args.blocked_by_id||["waiting","someday"].includes(args.status)?[]:args.task_id?tasks.filter(t=>t.id===args.task_id):tasks,next_cursor:null}});
  });
  await page.route("**/api/view",route=>{
    const empty={items:[],next_cursor:null};
    return route.fulfill({json:{data:{next:{items:tasks.slice(0,7),next_cursor:null},waiting:empty,someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}}});
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".compact-task:visible")).toHaveCount(6);
  await page
    .getByRole("region", { name: "Next action", exact: true })
    .getByRole("button", { name: "Details: Task 1", exact: true })
    .click();
  await expect(page.locator(".task-markdown:visible")).toContainText(
    "The information needed to get started.",
  );
  await expect(page.locator("[data-resizing=true]")).toHaveCount(0);
  await expect(page.locator(".test-mode")).toBeVisible();
  await page.evaluate((safeTop) => {
    document.documentElement.style.setProperty("--safe-top", `${safeTop}px`);
    document.documentElement.style.setProperty("--safe-bottom", "34px");
  }, safeTop);
}

async function navigate(page: Page, name: string) {
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .locator(".gtd-sidebar:visible")
    .getByRole("button", { name, exact: true })
    .click();
  await expect
    .poll(async () => {
      const drawer = (await page
        .locator(".gtd-sidebar:visible")
        .boundingBox())!;
      return drawer.x + drawer.width;
    })
    .toBeLessThan(1);
}

async function pinned(page: Page, header: Locator, safeTop: number) {
  const main = page.locator(".gtd-main:visible");
  const bannerHeight = (await page.locator(".test-mode").boundingBox())!.height;
  // Browser pages use the document scrollport so content paints behind Safari's
  // floating controls. Installed apps and ChatGPT keep bounded scrollports.
  await expect
    .poll(async () => (await main.boundingBox())!.height)
    .toBeGreaterThan(page.viewportSize()!.height);
  // A user scroll cancels pending route restoration before choosing a position.
  await page.touchscreen.tap(2, 200);
  for (const top of [480, 100000]) {
    await page.evaluate(
      (top) => window.scrollTo({ top, behavior: "instant" }),
      top,
    );
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(100);
    expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
    await expect
      .poll(async () => (await header.boundingBox())!.y)
      .toBe(safeTop + bannerHeight);
    const nav = header.getByRole("button", {
      name: "Open navigation",
      exact: true,
    });
    // A visible bounding box alone is insufficient: task text must not cover the controls.
    expect(
      await nav.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        );
      }),
    ).toBe(true);
  }
  expect(
    await header.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  if (safeTop) {
    expect(
      await header.evaluate((el) => getComputedStyle(el, "::before").height),
    ).toBe(`${safeTop}px`);
  }
}

for (const { width, safeTop, theme } of [
  { width: 390, safeTop: 44, theme: "dark" as const },
  { width: 320, safeTop: 0, theme: "light" as const },
]) {
  test(`mobile headers remain reachable at mid-scroll and the bottom (${width}, ${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, safeTop);
    await pinned(page, page.locator(".browse-toolbar:visible"), safeTop);
    await navigate(page, "All tasks");
    await expect(
      page.getByRole("heading", { name: "All tasks", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".compact-task:visible")).toHaveCount(20);
    await pinned(page, page.locator(".browse-toolbar:visible"), safeTop);
    const scrollTop = await page.evaluate(() => window.scrollY);
    await page.screenshot({
      path: test
        .info()
        .outputPath(
          `active-${theme}-${test.info().project.name || "chromium"}.png`,
        ),
    });
    const filter = page.getByRole("button", {
      name: "Sort and filter tasks",
      exact: true,
    });
    const button = (await filter.boundingBox())!;
    await page.touchscreen.tap(
      button.x + button.width / 2,
      button.y + button.height / 2,
    );
    await expect(
      page.getByRole("dialog", { name: "Sort and filter tasks" }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollTop);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Sort and filter tasks", exact: true }),
    ).toBeFocused();
    await navigate(page, "Help");
    await pinned(page, page.locator(".gtd-topbar:visible"), safeTop);
    await navigate(page, "Home");
    await expect(
      page.getByRole("heading", { name: "Home", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(100);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  });
}
