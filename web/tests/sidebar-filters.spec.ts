import { test, expect } from "@playwright/test";
import { openWidget } from "./helpers/widget-host";
const names = [
  "Home",
  "Next",
  "Inbox",
  "Waiting",
  "Blocked",
  "Projects",
  "Repeating",
  "Review",
  "Someday",
  "All tasks",
  "Done",
  "Archive",
];
for (const width of [320, 390, 1280])
  test(`sidebar groups, initial fade and task filters at ${width}`, async ({
    page,
    request,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: width < 500 ? 640 : 740 });
    await page.emulateMedia({
      colorScheme: width === 390 ? "dark" : "light",
      reducedMotion: "reduce",
    });
    const ids: string[] = [];
    const headers = { Origin: baseURL!, "X-GTD-Request": "1" };
    for (const status of [
      "next",
      "inbox",
      "waiting",
      "blocked",
      "someday",
      "done",
    ]) {
      const response = await request.post("/api/tools/capture_item", {
        headers,
        data: {brief: "Complete this disposable interface fixture.", importance: "normal", estimated_minutes: 30, effort: "medium", 
          request_id: crypto.randomUUID(),
          title: `Navigation ${status}`,
          status,
          reason: "Disposable sidebar fixture",
        },
      });
      expect(response.ok()).toBeTruthy();
      ids.push((await response.json()).task.id);
    }
    const archive = await request.post("/api/tools/capture_item", {
      headers,
      data: {brief: "Complete this disposable interface fixture.", importance: "normal", estimated_minutes: 30, effort: "medium", 
        request_id: crypto.randomUUID(),
        title: "Navigation archived",
        status: "next",
        archived: true,
        reason: "Disposable sidebar fixture",
      },
    });
    ids.push((await archive.json()).task.id);
    await page.route("**/api/tools/list_items", (route) =>
      route.continue({
        postData: JSON.stringify({
          ...route.request().postDataJSON(),
          task_ids: ids,
        }),
      }),
    );
    await page.goto("/");
    const open = async () => {
      if (width < 1041)
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
    };
    await open();
    const sidebar = page.getByRole("complementary", { name: "Navigation" });
    const nav = sidebar.getByRole("navigation", { name: "Task views" });
    await expect(nav.getByRole("button")).toHaveText(names);
    await expect(
      sidebar.getByRole("button", { name: "Active", exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", { name: "Help", exact: true }),
    ).toHaveText("");
    await expect(
      sidebar.getByRole("button", { name: "Settings", exact: true }),
    ).toHaveText("");
    const overflow = await nav.evaluate(
      (el) => el.scrollHeight > el.clientHeight + 1,
    );
    if (width < 500) expect(overflow).toBe(true);
    if (overflow)
      await expect(sidebar.locator(".sidebar-scroll")).toHaveAttribute(
        "data-more",
        "true",
      );
    else
      await expect(sidebar.locator(".sidebar-scroll")).not.toHaveAttribute(
        "data-more",
        "true",
      );
    await page.screenshot({ path: info.outputPath("sidebar.png") });
    await nav.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(sidebar.locator(".sidebar-scroll")).not.toHaveAttribute(
      "data-more",
      "true",
    );
    const settings = sidebar.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    await settings.click();
    const menu = page.getByRole("menu", { name: "Settings", exact: true });
    await expect(
      menu.getByRole("menuitem", { name: "Activity", exact: true }),
    ).toBeVisible();
    expect(
      (await menu.boundingBox())!.y + (await menu.boundingBox())!.height,
    ).toBeLessThan((await settings.boundingBox())!.y);
    await page.screenshot({ path: info.outputPath("settings.png") });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await settings.click();
    await settings.click();
    await expect(menu).toHaveCount(0);
    await nav.getByRole("button", { name: "All tasks", exact: true }).click();
    const filters = page.getByRole("button", {
      name: /^Sort and filter tasks/,
    });
    await expect(
      page.getByRole("button", {
        name: "Details: Navigation done",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Details: Navigation archived",
        exact: true,
      }),
    ).toHaveCount(0);
    await filters.click();
    const panel = page.getByRole("dialog", {
      name: "Sort and filter tasks",
      exact: true,
    });
    await expect(
      panel.getByLabel("Include archived", { exact: true }),
    ).not.toBeChecked();
    await panel.getByLabel("Done", { exact: true }).uncheck();
    await panel.getByLabel("Someday", { exact: true }).uncheck();
    await expect(
      page.getByRole("button", {
        name: "Details: Navigation done",
        exact: true,
      }),
    ).toHaveCount(0);
    await panel.getByLabel("Include archived", { exact: true }).check();
    await expect(
      page.getByRole("button", {
        name: "Details: Navigation archived",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("filters.png") });
    await page.keyboard.press("Escape");
    await open();
    await nav.getByRole("button", { name: "Projects", exact: true }).click();
    await open();
    await nav.getByRole("button", { name: "All tasks", exact: true }).click();
    await filters.click();
    await expect(panel.getByLabel("Done", { exact: true })).not.toBeChecked();
    await expect(
      panel.getByLabel("Include archived", { exact: true }),
    ).toBeChecked();
    await panel
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expect(panel.getByLabel("Done", { exact: true })).toBeChecked();
    await expect(
      panel.getByLabel("Include archived", { exact: true }),
    ).not.toBeChecked();
    for (const name of [
      "Next",
      "Inbox",
      "Waiting",
      "Blocked",
      "Someday",
      "Done",
    ])
      await panel.getByLabel(name, { exact: true }).uncheck();
    await expect(
      page.getByRole("button", { name: /^Details: Navigation / }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  });

test("compact navigation shares groups, then expanded sidebar keeps state", async ({
  page,
}, info) => {
  // Website-only releases preserve the separately published widget resource.
  const publishedNames = names.map(name => name === "Next" ? "Next actions" : name);
  const { frame, changeMode } = await openWidget(page, {
    width: 390,
    long: false,
  });
  await frame
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  const menu = frame.getByRole("menu", { name: "GTD views", exact: true });
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    ...publishedNames,
    "Activity",
  ]);
  await menu
    .getByRole("menuitemradio", { name: "All tasks", exact: true })
    .click();
  await changeMode("fullscreen");
  await frame
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(
    frame.getByRole("navigation", { name: "Task views" }).getByRole("button"),
  ).toHaveText(publishedNames);
  await frame.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    frame.getByRole("menuitem", { name: "Activity", exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByRole("menuitem", { name: "Service health", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("widget-sidebar.png") });
});
