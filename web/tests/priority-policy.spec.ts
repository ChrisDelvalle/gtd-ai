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
