import { test, expect } from "@playwright/test";

for (const width of [390, 1280]) {
  test.describe(`sidebar search at ${width}`, () => {
    test.use({
      viewport: { width, height: 844 },
      isMobile: width < 500,
      hasTouch: width < 500,
    });
    test("search icon opens, reopens and restores the search view", async ({
      page,
    }, info) => {
      const reads: Record<string, unknown>[] = [];
      await page.route("**/api/tools/list_items", (route) => {
        reads.push(route.request().postDataJSON());
        return route.fulfill({
          json: { items: [], next_cursor: null, history: [] },
        });
      });
      await page.emulateMedia({ colorScheme: width < 500 ? "dark" : "light" });
      await page.goto("/");
      const openDrawer = async () => {
        if (width < 1041)
          await page
            .getByRole("button", { name: "Open navigation", exact: true })
            .click();
      };
      const sidebar = page.getByRole("complementary", { name: "Navigation" });
      const icon = sidebar.getByRole("button", {
        name: "Search tasks",
        exact: true,
      });
      await openDrawer();
      await expect(icon).toHaveText("");
      await expect(sidebar.locator(":scope > .sidebar-search")).toHaveCount(0);
      const brand = await sidebar.locator(".sidebar-brand").boundingBox();
      const button = await icon.boundingBox();
      expect(button!.y).toBeGreaterThanOrEqual(brand!.y);
      expect(button!.y + button!.height).toBeLessThanOrEqual(
        brand!.y + brand!.height,
      );
      await page.screenshot({
        path: info.outputPath("sidebar.png"),
        animations: "disabled",
      });
      await icon.click();
      const input = page.getByRole("searchbox", {
        name: "Search all tasks in view",
      });
      await expect(input).toBeFocused();
      await input.fill("travel");
      await expect.poll(() => reads.at(-1)?.query).toBe("travel");
      await page.screenshot({
        path: info.outputPath("search.png"),
        animations: "disabled",
      });
      await page
        .getByRole("button", { name: "Close workspace search" })
        .click();
      await expect(input).not.toBeVisible();
      await openDrawer();
      await icon.click();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("");
      await input.fill("retained query");
      await openDrawer();
      await sidebar.getByRole("button", { name: "Home", exact: true }).click();
      await openDrawer();
      await icon.click();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("retained query");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  });
}
