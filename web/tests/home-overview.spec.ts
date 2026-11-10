import { fixtureContent } from "./helpers/content";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

for (const width of [390, 1280]) {
  test(`Home has ranked, bounded sections and remembers collapse at ${width}px`, async ({
    page,
    request,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({
      colorScheme: width === 390 ? "dark" : "light",
      reducedMotion: "reduce",
    });
    const headers = { Origin: baseURL!, "X-GTD-Request": "1" };
    const call = async (name: string, args: object) => {
      const response = await request.post(`/api/tools/${name}`, {
        headers,
        data: fixtureContent(name, args),
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    const fixtures = [
      {
        title: "Send the final proposal",
        status: "next",
        importance: "very_high", estimated_minutes: 30, effort: "medium",
        notes:
          "Send the reviewed proposal to the team.\n\n" +
          "Check the scope and confirm the next step. ".repeat(30),
      },
      ...Array.from({ length: 7 }, (_, i) => ({
        title: `Ready action ${i + 1}`,
        status: "next",
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        title: `Waiting for a reply ${i + 1}`,
        status: "waiting",
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        title: `A future idea ${i + 1}`,
        status: "someday",
      })),
      { title: "Clarify an idea", status: "inbox" },
      {
        title: "Blocked critical work",
        status: "planned",
        importance: "critical", estimated_minutes: 30, effort: "medium",
      },
      {
        title: "Reconsider this commitment",
        status: "planned",
        review_date: "2020-01-02",
      },
      {
        title: "Review the next step",
        status: "planned",
        review_date: "2020-01-03",
      },
      {
        title: "Review a later decision",
        status: "planned",
        review_date: "2020-01-04",
      },
      { title: "Future review", status: "planned", review_date: "2099-01-01" },
      { title: "Completed review", status: "done", review_date: "2020-01-01" },
      {
        title: "Archived review",
        status: "archived",
        review_date: "2020-01-01",
      },
    ];
    const result = await call("apply_changes", {
      request_id: randomUUID(),
      operations: fixtures.map((f) => ({importance: "normal", estimated_minutes: 30, effort: "medium", 
        operation: "capture",
        brief: "Complete this disposable Home fixture.",
        ...f,
        reason: "Isolated Home overview fixture",
      })),
    });
    const ids = result.results.map((r: any) => r.entity_id);
    const { project } = await call("create_project", {
      title: "Review the project outcome",
      review_date: "2020-01-01",
      request_id: randomUUID(),
      reason: "Isolated Home review project",
    });
    await page.route("**/api/tools/list_items", async (route) => {
      const args = route.request().postDataJSON();
      const response = await route.fetch({
        postData: JSON.stringify(
          args.task_id ? args : { ...args, task_ids: ids },
        ),
      });
      await route.fulfill({ response });
    });
    await page.route("**/api/tools/list_projects", async (route) => {
      const args = route.request().postDataJSON();
      const response = await route.fetch({
        postData: JSON.stringify({ ...args, project_id: project.id }),
      });
      await route.fulfill({ response });
    });
    await page.route("**/api/view", async route => {
      const review_on = route.request().postDataJSON().review_on;
      const [next,waiting,someday,reviewTasks,reviewProjects] = await Promise.all([
        call('list_items',{task_ids:ids,status:'next',limit:7,group_recurrences:true}),
        call('list_items',{task_ids:ids,status:'waiting',limit:4,group_recurrences:true}),
        call('list_items',{task_ids:ids,status:'someday',limit:4,group_recurrences:true}),
        call('list_items',{task_ids:ids,review_on,limit:4,group_recurrences:true}),
        call('list_projects',{project_id:project.id,review_on,limit:4}),
      ]);
      await route.fulfill({json:{data:{next,waiting,someday,reviewTasks,reviewProjects,remaining:null}}});
    });
    await page.goto("/");
    const home = page.getByRole("region", { name: "Home", exact: true });
    const featured = home.getByRole("region", {
      name: "Next action",
      exact: true,
    });
    await expect(
      featured.getByText("Send the final proposal", { exact: true }),
    ).toBeVisible();
    await expect(featured.locator(".task-information")).toHaveCount(0);
    await expect(home.locator(".home-section h2")).toHaveText([
      "Next",
      "Review",
      "Waiting",
      "Someday",
    ]);
    const section = (name: string) =>
      home.getByRole("region", { name, exact: true });
    await expect(section("Next").locator(".compact-task")).toHaveCount(5);
    await expect(
      section("Review").locator(".compact-task, .home-project-row"),
    ).toHaveCount(3);
    for (const name of ["Waiting", "Someday"])
      await expect(section(name).locator(".compact-task")).toHaveCount(3);
    await expect(
      home.getByText("Send the final proposal", { exact: true }),
    ).toHaveCount(1);
    for (const title of [
      "Clarify an idea",
      "Blocked critical work",
      "Future review",
      "Completed review",
      "Archived review",
    ])
      await expect(home.getByText(title, { exact: true })).toHaveCount(0);
    await expect(section("Review").locator(".home-project-row")).toContainText(
      "Review the project outcome",
    );
    const reviewToggle = section("Review").getByRole("button", {
      name: "Review",
      exact: true,
    });
    await reviewToggle.focus();
    await reviewToggle.press("Enter");
    await expect(reviewToggle).toHaveAttribute("aria-expanded", "false");
    await expect(
      section("Review").getByText("Review the project outcome", {
        exact: true,
      }),
    ).not.toBeVisible();
    await section("Next").getByRole("button", { name: "View all" }).click();
    await expect(
      page.getByRole("heading", { name: "Next actions", exact: true }),
    ).toBeVisible();
    if (width < 768)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(reviewToggle).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(reviewToggle).toHaveAttribute("aria-expanded", "false");
    await reviewToggle.click();
    await expect(section("Review").locator(".home-project-row")).toBeVisible();
    await expect(home.locator(".task-expansion[data-resizing]")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("home-overview.png"),
      fullPage: true,
    });
    await section("Review").locator(".home-project-row").click();
    await expect(
      page.getByRole("heading", {
        name: "Review the project outcome",
        exact: true,
      }),
    ).toBeVisible();
  });
}

test("Home hides empty sections and never features blocked work", async ({
  page,
}) => {
  let waiting = true;
  await page.route("**/api/view", route => {
    const empty={items:[],next_cursor:null};
    const wait={id:'wait',title:'Waiting for approval',status:'waiting',importance:'critical',estimated_minutes:30,effort:'medium',version:1,deleted:false,notes:'',created_at:'2026-10-01T00:00:00Z'};
    return route.fulfill({json:{data:{next:empty,waiting:{...empty,items:waiting?[wait]:[]},someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}}});
  });
  await page.route("**/api/tools/list_projects", (route) =>
    route.fulfill({ json: { projects: [], next_cursor: null } }),
  );
  await page.route("**/api/tools/list_items", (route) => {
    const args = route.request().postDataJSON();
    return route.fulfill({
      json: {
        items:
          waiting && args.status === "waiting"
            ? [
                {
                  id: "wait",
                  title: "Waiting for approval",
                  status: "waiting",
                  importance: "critical", estimated_minutes: 30, effort: "medium",
                  version: 1,
                  deleted: false,
                  notes: "",
                  created_at: "2026-10-01T00:00:00Z",
                },
              ]
            : [],
        next_cursor: null,
      },
    });
  });
  await page.goto("/");
  const home = page.getByRole("region", { name: "Home", exact: true });
  await expect(home.locator(".home-section h2")).toHaveText(["Waiting"]);
  await expect(
    home.getByRole("region", { name: "Next action", exact: true }),
  ).toHaveCount(0);
  await expect(home.getByRole("button", { name: "View all" })).toHaveCount(0);
  waiting = false;
  await page.reload();
  await expect(
    home.getByText("No tasks to show.", { exact: true }),
  ).toBeVisible();
  await expect(home.locator(".home-section")).toHaveCount(0);
  await expect(home.getByRole("button", { name: "Open Inbox" })).toHaveCount(0);
});
