import { test, expect, type Page } from "@playwright/test";

async function navigate(page: Page, name: string) {
  const toggle = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (page.viewportSize()!.width < 1041) await toggle.click();
  await page
    .getByRole("complementary", { name: "Navigation" })
    .getByRole("button", { name, exact: true })
    .click();
}
test("pointer focus is quiet while keyboard focus remains visible in shared filters", async ({page}) => {
  await page.goto("/tasks?view=all&archived=false");
  const trigger = page.getByRole("button", {name: /^Sort and filter tasks/});
  await trigger.click();
  const panel = page.getByRole("dialog", {name: "Sort and filter tasks"});
  const sort = panel.getByRole("combobox", {name: "Maximum effort"});
  await sort.click();
  expect(await sort.evaluate(e => getComputedStyle(e).outlineStyle)).toBe("none");
  await page.keyboard.press("Escape");
  // Reopen if Escape dismissed the shared popover as well as the native menu.
  if (!await panel.isVisible()) await trigger.click();
  await sort.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(sort).toBeFocused();
  expect(await sort.evaluate(e => getComputedStyle(e).outlineStyle)).not.toBe("none");
  const checkbox = panel.getByLabel("Done", {exact: true});
  await checkbox.click();
  expect(await checkbox.evaluate(e => getComputedStyle(e).outlineStyle)).toBe("none");
  // WebKit's default focus traversal skips checkboxes. Exercise keyboard
  // activation after focusing it, without overriding the native tab order.
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeFocused();
  expect(await checkbox.evaluate(e => getComputedStyle(e).outlineStyle)).not.toBe("none");
});
for (const width of [320, 390, 1280])
  test.describe(`filters ${width}`, () => {
    test.use({ isMobile: width < 500, hasTouch: width < 500 });
    test(`compact filters and independent date clearing at ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({
        colorScheme: width === 390 ? "dark" : "light",
      });
      const reads: any[] = [];
      await page.route("**/api/tools/list_items", (route) => {
        reads.push(route.request().postDataJSON());
        return route.fulfill({
          json: { items: [], next_cursor: null, history: [] },
        });
      });
      await page.goto("/");
      await navigate(page, "All tasks");
      await page.getByRole("button", {name: "Sort: Recommended", exact: true}).click();
      await page.getByRole("menuitemradio", {name: "Importance", exact: true}).click();
      await page
        .getByRole("button", { name: /^Sort and filter tasks/ })
        .click();
      const panel = page.getByRole("dialog", { name: "Sort and filter tasks" });
      for (const label of [
        "Task deadline from",
        "Task deadline through",
        "Planned from",
        "Planned through",
      ]) {
        await expect(panel.getByLabel(label, { exact: true })).toHaveValue("");
      }
      await expect(panel.getByText("Any date", { exact: true })).toHaveCount(4);
      await panel.getByLabel("Task deadline from", { exact: true }).fill("2026-10-01");
      await panel.getByLabel("Task deadline through", { exact: true }).fill("2026-10-31");
      await panel
        .getByLabel("Planned from", { exact: true })
        .fill("2026-10-02");
      await panel
        .getByLabel("Planned through", { exact: true })
        .fill("2026-10-30");
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath("filters-populated.png"),
      });
      for (const [field, label] of [
        ["due_from", "Task deadline from"],
        ["due_through", "Task deadline through"],
        ["planned_from", "Planned from"],
        ["planned_through", "Planned through"],
      ]) {
        await panel
          .getByRole("button", {
            name: `Clear ${label.toLowerCase()}`,
            exact: true,
          })
          .click();
        await expect(panel.getByLabel(label, { exact: true })).toHaveValue("");
        await expect.poll(() => reads.at(-1)[field]).toBeUndefined();
        await expect(
          panel.getByRole("button", {
            name: `Clear ${label.toLowerCase()}`,
            exact: true,
          }),
        ).toHaveCount(0);
        if (field === "due_from")
          await expect(
            panel.getByLabel("Task deadline through", { exact: true }),
          ).toHaveValue("2026-10-31");
      }
      await panel.getByLabel("Task deadline from", { exact: true }).fill("2026-10-01");
      await panel.getByLabel("Done", { exact: true }).uncheck();
      await panel
        .getByRole("button", { name: "Clear filters", exact: true })
        .click();
      await expect(panel.getByLabel("Task deadline from", { exact: true })).toHaveValue(
        "",
      );
      await expect(panel.getByLabel("Done", { exact: true })).toBeChecked();
      await expect(page.getByRole("button", {name: "Sort: Importance", exact: true})).toBeVisible();
      const fields = await panel
        .locator(".filter-date-control")
        .evaluateAll((es) =>
          es.map((el) => el.getBoundingClientRect().toJSON()),
        );
      if (width >= 360) {
        expect(fields[0].y).toBe(fields[1].y);
        expect(fields[2].y).toBe(fields[3].y);
        expect(fields[0].width).toBe(fields[1].width);
      }
      expect(
        await page
          .getByRole("button", {name: "Sort: Importance", exact: true})
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ).toBeLessThanOrEqual(14);
      expect(
        await panel.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath("filters-cleared.png"),
      });
    });
  });

for (const width of [390, 1280])
  test.describe(`Review ${width}`, () => {
    test.use({ isMobile: width < 500, hasTouch: width < 500 });
    test(`Review hides empty sections and recovers refreshed content at ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      let tasks = false,
        projects = false,
        failure = false;
      const task = {
        id: "review-task",
        title: "Review the travel plan",
        status: "next",
        notes: "Choose the dates.",
        version: 1,
        last_change_id: 1,
        archived: false,
        deleted: false,
        due_date: null,
        review_date: "2020-01-01",
      };
      const project = {
        id: "review-project",
        title: "Plan the autumn trip",
        status: "active",
        notes: "",
        version: 1,
        last_change_id: 2,
        task_counts: {},
        archived: false,
        deleted: false,
      };
      await page.route("**/api/tools/list_items", (route) =>
        route.fulfill({
          json: { items: tasks ? [task] : [], history: [], next_cursor: null },
        }),
      );
      await page.route("**/api/tools/list_projects", (route) =>
        failure
          ? route.fulfill({
              status: 503,
              json: { error: "Temporary project read failure" },
            })
          : route.fulfill({
              json: { projects: projects ? [project] : [], next_cursor: null },
            }),
      );
      await page.goto("/");
      await navigate(page, "Review");
      const review = page.locator(".review-browser:visible");
      await expect(
        review.getByText("Nothing to review.", { exact: true }),
      ).toBeVisible();
      await expect(
        review.getByRole("region", { name: "Projects", exact: true }),
      ).toHaveCount(0);
      await expect(
        review.getByRole("region", { name: "Task list", exact: true }),
      ).toHaveCount(0);
      await expect(
        review.getByText("Reconsider these items.", { exact: false }),
      ).toHaveCount(0);
      const refresh = async () => {
        await navigate(page, "Help");
        await navigate(page, "Review");
      };
      tasks = true;
      await refresh();
      await expect(
        review.getByRole("button", {
          name: "Details: Review the travel plan",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        review.getByText("No projects in this view.", { exact: true }),
      ).toHaveCount(0);
      await expect(
        review.getByRole("button", { name: "Create project", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath("review-tasks.png"),
      });
      tasks = false;
      projects = true;
      await refresh();
      await expect(
        review.getByRole("button", { name: /Plan the autumn trip/ }),
      ).toBeVisible();
      await expect(
        review.getByRole("region", { name: "Task list", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath("review-projects.png"),
      });
      tasks = true;
      await refresh();
      await expect(
        review.getByRole("button", {
          name: "Details: Review the travel plan",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        review.getByRole("button", { name: /Plan the autumn trip/ }),
      ).toBeVisible();
      projects = false;
      tasks = false;
      await refresh();
      await expect(
        review.getByText("Nothing to review.", { exact: true }),
      ).toBeVisible();
      failure = true;
      await refresh();
      await expect(review.getByRole("alert")).toBeVisible();
      await expect(
        review.getByText("Nothing to review.", { exact: true }),
      ).toHaveCount(0);
      failure = false;
      tasks = true;
      await refresh();
      await expect(
        review.getByRole("button", {
          name: "Details: Review the travel plan",
          exact: true,
        }),
      ).toBeVisible();
      await expect(review.getByRole("alert")).toHaveCount(0);
    });
  });
