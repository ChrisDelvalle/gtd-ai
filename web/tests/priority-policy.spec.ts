import {test, expect} from "@playwright/test";
import {randomUUID} from "node:crypto";

// Intended result: the displayed order is global and honestly labeled; changing
// a cell sort retains its count/revision, with controls inside the content pane.
for (const width of [320, 390, 1280]) test(`project fallback and sorted frozen cells at ${width}px`, async ({page, request, baseURL}, info) => {
  const call = async (name:string, data:any) => {
    const response = await request.post(`/api/tools/${name}`, {data, headers:{Origin:baseURL!,"X-GTD-Request":"1"}});
    expect(response.ok(), await response.text()).toBeTruthy(); return response.json();
  };
  const project = (await call("create_project", {request_id:randomUUID(), title:`Ordering ${width}`, brief:"Deliver the fixture.", due_date:"2020-01-01",reason:"Disposable ordering check"})).project;
  const add = async (title:string, extra:any={}) => (await call("capture_item", {request_id:randomUUID(),title,brief:"Check the ordering.",status:"next",importance:"high",estimated_minutes:10,effort:"low",project_id:project.id,reason:"Disposable ordering check",...extra})).task;
  const first = await add("Earlier fixture"), second = await add("Later fixture"), explicit = await add("Own deadline fixture",{due_date:"2099-01-01"});
  const before = await call("priority_grid",{project:project.id});
  expect(before.counts[4][6].next).toBe(2);
  await page.setViewportSize({width,height:900});
  await page.emulateMedia({colorScheme:width===390?"dark":"light",reducedMotion:"reduce"});
  await page.goto("/");
  await page.getByRole("button",{name:/^Chart:/}).click();
  await page.getByRole("menuitemradio",{name:"Priorities",exact:true}).click();
  await page.getByRole("button",{name:"Project: Any project"}).click();
  await page.getByRole("menuitemradio",{name:project.title,exact:true}).click();
  await page.getByRole("button",{name:"Timing: All timing"}).click();
  await page.getByRole("menuitemradio",{name:"Deadlines",exact:true}).click();
  await page.getByRole("button",{name:"High, Overdue: 2 tasks",exact:true}).click();
  const dialog=page.getByRole("dialog"), rows=dialog.locator(".priority-task");
  await expect(rows).toHaveText([first.title, second.title]);
  await dialog.getByRole("button",{name:"Sort: Recommended"}).click();
  await page.getByRole("menuitemradio",{name:"Newest first",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"Sort: Newest first"})).toBeVisible();
  await expect(rows).toHaveText([second.title, first.title]);
  await expect(dialog.getByText(`Project: ${project.title}`,{exact:true})).toHaveCount(2);
  const panel=(await dialog.locator(".priority-sheet-panel").boundingBox())!;
  for(const control of await dialog.locator("header button").all()) {
    const box=(await control.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(panel.x); expect(box.x+box.width).toBeLessThanOrEqual(panel.x+panel.width+1);
  }
  await page.screenshot({path:info.outputPath(`sorted-cell-${width}.png`)});
  await dialog.getByRole("button",{name:"Close task list"}).click();
  await page.goto(`/tasks?status=next&project_id=${project.id}`);
  await page.getByRole("button",{name:"Sort: Recommended"}).click();
  await page.getByRole("menuitemradio",{name:"Deadline",exact:true}).click();
  await expect(page.getByRole("button",{name:"Sort: Deadline",exact:true})).toBeVisible();
  await expect(page.locator(".task-title > span:first-child")).toHaveText([first.title,second.title,explicit.title]);
  await expect(page.locator(".date-chip-source")).toHaveCount(2);
  await expect(page.locator(".date-chip-source").first()).toBeVisible();
  const sort=page.getByRole("button",{name:"Sort: Deadline",exact:true});
  const text=(await sort.locator("span").boundingBox())!, arrow=(await sort.locator("svg").boundingBox())!;
  expect(Math.abs(text.y+text.height/2-arrow.y-arrow.height/2)).toBeLessThan(1);
  expect(arrow.x).toBeGreaterThan(text.x+text.width);
  const heading=(await page.locator(".workspace-list-heading").boundingBox())!;
  const order=(await sort.boundingBox())!;
  expect(order.y >= heading.y + heading.height || order.x >= heading.x + heading.width + 8).toBeTruthy();
  expect(await page.locator(".browse-toolbar").evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  await page.screenshot({path:info.outputPath(`deadline-list-${width}.png`)});
});

test("Planned today follows the account day with the filter panel closed", async ({page}) => {
  await page.clock.install({time:new Date("2026-11-10T04:59:30Z")});
  const planned: any[] = [];
  page.on("request", request => {
    if(request.url().endsWith("/api/tools/list_items")) {
      const args = request.postDataJSON();
      if(args?.planned_from) planned.push(args);
    }
  });
  await page.goto("/tasks?status=next");
  await page.getByRole("button",{name:"Sort and filter tasks",exact:true}).click();
  await page.getByRole("button",{name:"Planned today",exact:true}).click();
  await expect.poll(() => planned.at(-1)?.planned_from).toBe("2026-11-09");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog",{name:"Sort and filter tasks",exact:true})).toHaveCount(0);
  await page.clock.fastForward(61_000);
  await expect.poll(() => planned.at(-1)?.planned_from).toBe("2026-11-10");
  expect(planned.at(-1)?.exclude_statuses).toContain("done");
  expect(planned.at(-1)?.archived).toBe(false);
});

test("expired priority snapshots recover once and preserve the visible list on repeated failure", async ({page, request, baseURL}) => {
  const response = await request.post("/api/tools/capture_item", {data:{request_id:randomUUID(), title:"Snapshot recovery fixture", brief:"Keep this row visible.", status:"next", importance:"critical", estimated_minutes:10, effort:"low", due_date:"2000-01-01", reason:"Disposable recovery check"}, headers:{Origin:baseURL!,"X-GTD-Request":"1"}});
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.goto("/");
  await page.getByRole("button",{name:/^Chart:/}).click();
  await page.getByRole("menuitemradio",{name:"Priorities",exact:true}).click();
  await page.getByRole("button",{name:/^Critical, Overdue:/}).click();
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByRole("button",{name:"Snapshot recovery fixture",exact:true})).toBeVisible();
  let failures=0, summaryReads=0;
  await page.route("**/api/tools/priority_grid", async route => {
    if(route.request().postDataJSON().cell) {
      failures++;
      return route.fulfill({status:409,json:{code:"reset_required",message:"Snapshot expired"}});
    }
    summaryReads++;
    return route.continue();
  });
  await dialog.getByRole("button",{name:"Sort: Recommended"}).click();
  await page.getByRole("menuitemradio",{name:"Newest first",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
  await expect.poll(()=>summaryReads).toBe(1);
  await expect.poll(()=>failures).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(300);
  expect(summaryReads).toBe(1);
  expect(failures).toBeLessThanOrEqual(3);
  await expect(dialog.getByRole("button",{name:"Snapshot recovery fixture",exact:true})).toBeVisible();
  await page.unroute("**/api/tools/priority_grid");
  await dialog.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"Sort: Newest first",exact:true})).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Retry",exact:true})).toHaveCount(0);
});
