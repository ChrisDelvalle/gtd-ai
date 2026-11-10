import { test, expect, type Page } from "@playwright/test";

test.use({ isMobile: true, hasTouch: true });

async function bounded(page: Page) {
  await expect(page.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  const overflow = await page
    .locator(
      ".gtd-main:visible,.gtd-detail:visible,input:visible,select:visible,textarea:visible",
    )
    .evaluateAll((elements) =>
      elements
        .filter((el) => {
          if (el.closest("[inert]")) return false;
          const r = el.getBoundingClientRect();
          return (
            r.width &&
            (r.left < -1 ||
              r.right > innerWidth + 1 ||
              (el.matches(".gtd-main,.gtd-detail") &&
                el.scrollWidth > el.clientWidth + 1))
          );
        })
        .map((el) => ({
          tag: el.tagName,
          class: el.className,
          label: el.getAttribute("aria-label"),
          width: el.getBoundingClientRect().width,
          scroll: el.scrollWidth,
          client: el.clientWidth,
        })),
    );
  expect(
    overflow,
    "Mobile controls and their scrolling surfaces must fit the viewport",
  ).toEqual([]);
}

for (const width of [320, 390]) {
  test(`task inputs and repeat dates fit at ${width}px with long values`, async ({
    page,
    request,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const title = `Mobile width ${crypto.randomUUID()}`;
    const response = await request.post("/api/tools/capture_item", {
      headers: { Origin: baseURL!, "X-GTD-Request": "1" },
      data: {brief: "Complete this disposable interface fixture.", importance: "normal", estimated_minutes: 30, effort: "medium", 
        request_id: crypto.randomUUID(),
        title,
        status: "next",
        notes: "Description. " + "LongText".repeat(100),
        links: [
          {
            label: "Reference",
            url: "https://example.com/" + "path".repeat(300),
          },
        ],
        location: "A very long place name ".repeat(10),
        reason: "Disposable mobile width fixture",
      },
    });
    expect(response.ok()).toBe(true);
    await page.route("**/api/tools/list_projects", (route) =>
      route.fulfill({
        json: {
          projects: [
            {
              id: "long-project",
              title: "LongProjectName".repeat(25),
              status: "active",
              version: 1,
              deleted: false,
              archived: false,
            },
          ],
          next_cursor: null,
        },
      }),
    );
    const { task } = await response.json();
    await page.goto(`/tasks/${task.id}`);
    await page
      .getByRole("button", { name: `More options: ${title}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("region", {
      name: "Task details",
      exact: true,
    });
    await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
      title,
    );
    await bounded(page);
    await editor
      .getByRole("button", { name: "More details", exact: true })
      .click();
    await expect(
      editor.getByRole("combobox", { name: /^Project/ }),
    ).toBeVisible();
    await bounded(page);
    await editor.getByLabel("Deadline", { exact: true }).fill("2027-12-31");
    await editor.getByLabel("Review on", { exact: true }).fill("2027-12-30");
    await bounded(page);
    const dateBox = await editor
      .getByLabel("Deadline", { exact: true })
      .boundingBox();
    const titleBox = await editor
      .getByLabel("Title", { exact: true })
      .boundingBox();
    expect(dateBox!.width).toBeCloseTo(titleBox!.width, 0);
    await editor
      .getByLabel("Deadline", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("task-editor.png") });
    await editor.getByLabel("Deadline", { exact: true }).fill("");
    await editor.getByLabel("Review on", { exact: true }).fill("");
    await editor.getByRole("button", { name: "Repeat", exact: true }).click();
    await expect(page.getByLabel("Starts", { exact: true })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Ends", exact: true })
      .selectOption("date");
    await page.getByLabel("Last date", { exact: true }).fill("2027-12-31");
    await bounded(page);
    await page.screenshot({ path: info.outputPath("task-inputs.png") });
  });
  test(`log date and filter inputs fit at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "Logs", exact: true }).click();
    await expect(
      page.locator('input[type="datetime-local"]').first(),
    ).toBeVisible();
    await bounded(page);
    await page.screenshot({ path: info.outputPath("log-inputs.png") });
  });
}
