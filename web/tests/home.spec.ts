import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("Home leads with one ready action; expansion is read-only and editing is explicit", async ({
  page,
  request,
  baseURL,
}) => {
  const prefix = "Home " + randomUUID().slice(0, 8);
  const fixtures = [
    [
      "Prepare the final proposal",
      "next",
      "2026-10-03",
      "Open the proposal.\nConfirm the scope before sending. <script>unsafe()</script>",
    ],
    ["Later step", "next", "2026-10-04", "The second next action."],
    ["Clarify this", "inbox", null, "Needs a decision."],
    ["Waiting on a reply", "waiting", null, "Follow up Friday."],
    ["A future idea", "someday", null, "Try this next year."],
    ["Finished work", "done", null, ""],
    ["Old work", "archived", null, ""],
  ];
  const headers = { Origin: baseURL!, "X-GTD-Request": "1" };
  const seeded = await request.post("/api/tools/apply_changes", {
    headers,
    data: {
      request_id: randomUUID(),
      operations: fixtures.map(([title, status, due_date, notes]) => ({importance: "normal", estimated_minutes: 30, effort: "medium", 
        operation: "capture",
        brief: "Complete this disposable Home fixture.",
        title: `${prefix} ${title}`,
        status,
        due_date,
        notes,
        reason: "Synthetic home test",
      })),
    },
  });
  expect(seeded.ok()).toBeTruthy();
  const ids = (await seeded.json()).results.map((r: any) => r.entity_id);
  const full = await request.post("/api/tools/list_items", {
    headers,
    data: { task_ids: ids, detail: "full" },
  });
  expect(full.ok()).toBeTruthy();
  const all = (await full.json()).items;
  const records = ids.map((id: string) => all.find((t: any) => t.id === id));
  let writes = 0,
    readsFail = false;
  await page.route("**/api/view", async route => {
    if (readsFail) return route.fulfill({ status: 503, json: { message: "Synthetic offline" } });
    const review_on=route.request().postDataJSON().review_on;
    const list=async (args:object)=>(await request.post('/api/tools/list_items',{headers,data:{task_ids:ids,...args}})).json();
    const [next,waiting,someday,reviewTasks]=await Promise.all([
      list({status:'next',limit:7}),list({status:'waiting',limit:4}),list({status:'someday',limit:4}),list({review_on,limit:4}),
    ]);
    await route.fulfill({json:{data:{next,waiting,someday,reviewTasks,reviewProjects:{projects:[]},remaining:null}}});
  });
  await page.route("**/api/tools/list_items", async (route) => {
    if (readsFail)
      return route.fulfill({
        status: 503,
        json: { message: "Synthetic offline" },
      });
    const args = route.request().postDataJSON();
    const response = await route.fetch({
      postData: JSON.stringify(args.task_id ? args : { ...args, task_ids: ids, view: args.status ? undefined : (args.view || "active") }),
    });
    await route.fulfill({ response });
  });
  page.on("request", (r) => {
    if (
      /\/api\/tools\/(capture_item|update_item|undo_change|apply_changes)$/.test(
        r.url(),
      )
    )
      writes++;
  });
  await page.goto("/");
  const focus = page.getByRole("region", { name: "Next action", exact: true });
  await expect(focus.locator(".compact-task")).toHaveCount(1);
  await expect(
    focus.getByText(records[0].title, { exact: true }),
  ).toBeVisible();
  const centerlineOffset = () => focus.evaluate(card => {
    const center = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    const row = card.querySelector(".task-swipe-front")!;
    return Math.max(...[row, ...row.children].map(element => Math.abs(center(element) - center(card))));
  });
  const titleLines = () => focus.locator(".task-title > span").evaluate(title => {
    const text = document.createRange();
    text.selectNodeContents(title);
    return text.getClientRects().length;
  });
  expect(await titleLines()).toBe(1);
  await expect.poll(centerlineOffset).toBeLessThan(1);
  await page.setViewportSize({width: 390, height: 844});
  await expect(focus.locator(".date-chip")).toBeVisible();
  expect(await titleLines()).toBeGreaterThan(1);
  await expect.poll(centerlineOffset).toBeLessThan(1);
  await page.setViewportSize({width: 1440, height: 1000});
  await expect(
    focus.getByText(records[0].notes, { exact: true }),
  ).not.toBeVisible();
  const featuredTitle = focus.getByRole("button", {
    name: `Details: ${records[0].title}`,
    exact: true,
  });
  await featuredTitle.click();
  await expect(
    focus.getByText(records[0].notes, { exact: true }),
  ).toBeVisible();
  await featuredTitle.click();
  await expect(
    focus.getByText(records[0].notes, { exact: true }),
  ).not.toBeVisible();
  await expect(page.getByText(records[0].title, { exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByText(records[4].title, { exact: true })).toBeVisible();
  await expect(page.getByText(records[5].title, { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(records[6].title, { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(records[2].title, { exact: true })).toHaveCount(0);
  const titleButton = page.getByRole("button", {
    name: `Details: ${records[3].title}`,
    exact: true,
  });
  await titleButton.focus();
  await titleButton.press("Enter");
  const information = page.getByRole("region", {
    name: `Task information: ${records[3].title}`,
    exact: true,
  });
  await expect(information.getByText("Follow up Friday.")).toBeVisible();
  await expect(information.locator("input,textarea,select")).toHaveCount(0);
  await expect(page.locator(".gtd-detail:visible")).toHaveCount(0);
  await titleButton.press("Space");
  await expect(information).toHaveCount(0);
  expect(writes).toBe(0);

  await page
    .getByRole("button", {
      name: `More options: ${records[3].title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const inspector = page.getByRole("region", {
    name: "Task details",
    exact: true,
  });
  await inspector
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Keep this unsaved draft");
  const changed = await request.post("/api/tools/update_item", {
    headers,
    data: {
      task_id: records[3].id,
      expected_version: records[3].version,
      notes: "Changed elsewhere",
      request_id: randomUUID(),
      reason: "Concurrent home test",
    },
  });
  expect(changed.ok()).toBeTruthy();
  await expect(
    inspector.getByText("This task changed on the server.", { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    inspector.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Keep this unsaved draft");
  await page.getByRole("button", { name: "All tasks", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", {name: "Home", exact: true}).click();
  await expect(inspector.getByRole("textbox", {name: "Notes", exact: true})).toHaveValue("Keep this unsaved draft");
  await page.getByRole("button", {name: "Close details", exact: true}).click();
  await page.getByRole("alertdialog").getByRole("button", {name: "Discard draft", exact: true}).click();
  await page.getByRole("button", {name: "All tasks", exact: true}).click();
  await expect(
    page.getByRole("heading", { name: "All tasks", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Details: ${records[3].title}`, exact: true })
    .click();
  await expect(
    page
      .getByRole("region", {
        name: `Task information: ${records[3].title}`,
        exact: true,
      })
      .getByText("Changed elsewhere"),
  ).toBeVisible();
  await expect(page.locator(".gtd-detail:visible")).toHaveCount(0);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("button", {
      name: `Mark complete: ${records[0].title}`,
      exact: true,
    })
    .click();
  await expect(
    focus.getByText(records[1].title, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Undo last change", exact: true })
    .click();
  await expect(
    focus.getByText(records[0].title, { exact: true }),
  ).toBeVisible();
  readsFail = true;
  await expect(
    page.getByRole("button", { name: "View connection problem", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    focus.getByText(records[0].title, { exact: true }),
  ).toBeVisible();
  readsFail = false;
  await page
    .getByRole("button", { name: "View connection problem", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry refresh", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "View connection problem", exact: true }),
  ).toHaveCount(0);
});

test("Home never promotes a waiting or someday task into the next action; health uses the website font", async ({
  page,
}) => {
  await page.route("**/api/view", route => {
    const empty = {items: [], next_cursor: null};
    return route.fulfill({json:{data:{next:empty,waiting:empty,someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}}});
  });
  await page.route("**/api/tools/list_projects", (route) =>
    route.fulfill({ json: { projects: [], next_cursor: null } }),
  );
  await page.route("**/api/tools/list_items", (route) =>
    route.fulfill({
      json: {
        items: route.request().postDataJSON().status === "inbox" ? [{id:"inbox-only",title:"Clarify this",status:"inbox",version:1,deleted:false}] : [],
        history: [],
        next_offset: null,
        next_history_after: null,
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("No tasks to show.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inbox", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Service health", exact: true })
    .click();
  await expect(page.locator(".health-card > strong").first()).toBeVisible();
  const fonts = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    status: getComputedStyle(document.querySelector(".health-card > strong")!)
      .fontFamily,
  }));
  expect(fonts.status).toBe(fonts.body);
});
