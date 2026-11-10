import { test, expect } from "@playwright/test";
import { openWidget, title, projectTitle } from "./helpers/widget-host";
test.afterEach(async ({page}) => { await page.unrouteAll({behavior: "wait"}); });

test("card navigation connects projects and tasks without remounting a draft", async ({
  page,
}) => {
  const { frame, changeMode } = await openWidget(page, { project: true });
  await frame
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  await frame
    .getByRole("menuitemradio", { name: "All tasks", exact: true })
    .click();
  await frame
    .getByRole("button", { name: `More options: ${title}`, exact: true })
    .click();
  await frame.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const description = frame.getByRole("textbox", {
    name: "Notes",
    exact: true,
  });
  await description.fill("Keep this draft across application navigation.");
  await changeMode("inline");
  await frame
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  await frame
    .getByRole("menuitemradio", { name: "Projects", exact: true })
    .click();
  await expect(
    frame.getByRole("button", { name: new RegExp(projectTitle) }),
  ).toBeVisible();
  await frame
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  await frame
    .getByRole("menuitemradio", { name: "All tasks", exact: true })
    .click();
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(description).toHaveValue(
    "Keep this draft across application navigation.",
  );
});

test("navigation preserves task disclosure and hidden views do not poll", async ({
  page,
}) => {
  const { frame, requests } = await openWidget(page);
  await frame.getByRole("button", {name:"GTD navigation",exact:true}).click();
  await frame.getByRole("menuitemradio", {name:"All tasks",exact:true}).click();
  await frame
    .getByRole("button", { name: `Details: ${title}`, exact: true })
    .click();
  await frame
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  await frame
    .getByRole("menuitemradio", { name: "Projects", exact: true })
    .click();
  await expect(frame.getByText("No projects in this view.")).toBeVisible();
  const before = (await requests("tools/call")).length;
  await page.waitForTimeout(5500);
  expect((await requests("tools/call")).length).toBe(before);
  await frame
    .getByRole("button", { name: "GTD navigation", exact: true })
    .click();
  await frame
    .getByRole("menuitemradio", { name: "All tasks", exact: true })
    .click();
  await expect(
    frame.getByRole("button", { name: `Details: ${title}`, exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
});

test("shared website preserves disclosures when revisiting a task view", async ({
  page,
  request,
  baseURL,
}) => {
  const fixtureTitle = `Shared navigation fixture ${crypto.randomUUID()}`;
  const captured = await request.post("/api/tools/capture_item", {
    headers: { Origin: baseURL!, "X-GTD-Request": "1" },
    data: {brief: "Complete this disposable interface fixture.", importance: "normal", estimated_minutes: 30, effort: "medium", 
      request_id: crypto.randomUUID(),
      title: fixtureTitle,
      status: "next",
      notes: "A clear description.",
      reason: "Disposable navigation test",
    },
  });
  const task = (await captured.json()).task;
  const snapshot = await request.post("/api/tools/list_items", {
    headers: { Origin: baseURL!, "X-GTD-Request": "1" },
    data: {task_id: task.id, detail: "full"},
  });
  const fixture = await snapshot.json();
  // Navigation may cancel an inactive screen's request. Respond directly to
  // avoid a second fetch/fulfill race in the interception harness.
  await page.route("**/api/tools/list_items", route => route.fulfill({json: fixture}));
  await page.goto("/");
  await page.getByRole("button", { name: "All tasks", exact: true }).click();
  await page
    .getByRole("button", {
      name: `Details: ${fixtureTitle}`,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "All tasks", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: `Details: ${fixtureTitle}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-expanded", "true");
});

for (const width of [390, 900]) {
  test(`everyday destinations share bounded navigation at ${width}px`, async ({page}, info) => {
    const {frame, surface, requests} = await openWidget(page, {width, launch:"home"});
    const names = ["Home", "Next", "Inbox", "Waiting", "Blocked", "Projects", "Repeating", "Review", "Someday", "All tasks", "Done", "Archive", "Activity"];
    for (const name of names) {
      await frame.getByRole("button", {name:"GTD navigation", exact:true}).click();
      await frame.getByRole("menuitemradio", {name, exact:true}).click();
      await expect(frame.getByRole("button", {name:"GTD navigation"})).toContainText(name);
      await expect(surface).toHaveAttribute("data-display", "preview");
      await expect.poll(async () => (await surface.boundingBox())!.height).toBeLessThanOrEqual(451);
      await expect(frame.getByRole("button", {name:"Advanced",exact:true})).toHaveCount(0);
      await expect(frame.getByText("About this website")).toHaveCount(0);
      expect(await frame.getByRole("button", {name: "Expand view", exact: true}).evaluate(el => {
        const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2));
      })).toBe(true);
      if (["Home", "Repeating", "Activity"].includes(name)) await page.screenshot({path:info.outputPath(`${name}-${width}.png`)});
    }
    const calls = await requests("tools/call");
    expect(calls.every(m => ["list_items","list_projects","list_occurrences","list_changes","view_snapshot","widget_pages"].includes(m.params.name))).toBe(true);
    expect(calls.some(m => m.params.arguments.include_agent_notes)).toBe(false);
  });
}

test("late host results refresh data without replacing the user's destination", async ({page}) => {
  const {frame} = await openWidget(page);
  await frame.getByRole("button",{name:"GTD navigation"}).click();
  await frame.getByRole("menuitemradio",{name:"Repeating",exact:true}).click();
  await page.evaluate(() => (window as any).displayTest.sendResult({items:[],history:[],next_cursor:null}));
  await expect(frame.getByRole("button",{name:"GTD navigation"})).toHaveText("Repeating");
  await expect(frame.getByRole("button",{name:"GTD navigation"})).toBeVisible();
});

test("mobile expanded inspector has an opaque surface and inset controls", async ({page}) => {
  const {frame} = await openWidget(page);
  await frame.getByRole("button",{name:`More options: ${title}`,exact:true}).click();
  await frame.getByRole("menuitem",{name:"Edit",exact:true}).click();
  const panel=frame.getByRole("dialog",{name:"Task inspector"});
  await expect(panel).toBeVisible();
  const style=await panel.evaluate(e=>({background:getComputedStyle(e).backgroundColor,padding:parseFloat(getComputedStyle(e).paddingLeft)}));
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.padding).toBeGreaterThanOrEqual(16);
  const field=frame.getByRole("textbox",{name:"Brief",exact:true});
  const box=(await field.boundingBox())!, bounds=(await panel.boundingBox())!;
  expect(box.x).toBeGreaterThan(bounds.x);
  expect(box.x+box.width).toBeLessThan(bounds.x+bounds.width);
});

test('compact Home shows a short overview and View all opens the task list', async ({page})=> {
  const {frame,changeMode}=await openWidget(page,{launch:'home',long:true});
  const home=frame.getByRole('region',{name:'Home',exact:true});
  await expect(home).toBeVisible();
  await expect(home.getByRole('button',{name:/^Details:/})).toHaveCount(3);
  await changeMode('fullscreen');
  await expect(home.getByRole('button',{name:/^Details:/})).toHaveCount(5);
  await changeMode('inline');
  await expect(home.getByRole('button',{name:/^Details:/})).toHaveCount(3);
  await frame.getByRole('region',{name:'Next',exact:true}).getByRole('button',{name:'View all',exact:true}).click();
  await expect(frame.getByRole('button',{name:'GTD navigation',exact:true})).toHaveText('Next actions');
});

test('Help opened from the expanded sidebar does not reopen a closed viewer', async ({page}) => {
  const {frame,changeMode,requests,surface}=await openWidget(page,{width:1200});
  await frame.getByRole('button',{name:'Expand view',exact:true}).click();
  await frame.getByRole('button',{name:'Help',exact:true}).click();
  await expect(frame.getByRole('heading',{name:'Getting things done',exact:true})).toBeVisible();
  const before=(await requests('ui/request-display-mode')).length;
  await changeMode('inline');
  await expect(surface).toHaveAttribute('data-display','preview');
  await expect(frame.getByRole('button',{name:'Open full view',exact:true})).toBeVisible();
  await expect(frame.getByRole('heading',{name:'Getting things done',exact:true})).toBeVisible();
  await expect(frame.getByRole('button',{name:'GTD navigation',exact:true})).toBeVisible();
  expect((await requests('ui/request-display-mode')).length).toBe(before);
});

// Hold the host at an intermediate height instead of hoping an input happens
// during a 220 ms animation. A visible menu must not expose shifting targets.
test("navigation waits for reserved host space before accepting a click", async ({page}, info) => {
  const {frame, surface} = await openWidget(page, {launch: "home", empty: true});
  await expect(frame.getByRole("button", {name: "GTD navigation"})).toHaveText("Home");
  await expect.poll(() => surface.evaluate(el => Math.abs(
    el.getBoundingClientRect().height - parseFloat((el as HTMLElement).style.height)
  ))).toBeLessThan(1);
  await page.evaluate(() => {
    (window as any).displayTest.holdResize();
    document.querySelector("iframe")!.style.height = "300px";
  });
  await frame.getByRole("button", {name: "GTD navigation"}).click();
  const menu = frame.locator('.floating-panel[role="menu"]');
  await expect.poll(() => surface.evaluate(el =>
    parseFloat((el as HTMLElement).style.getPropertyValue("--overlay-min-height"))
  )).toBeGreaterThan(400);
  await expect(menu).toBeHidden();
  await page.evaluate(() => (window as any).displayTest.releaseResize());
  await expect(menu).toBeVisible();
  await page.screenshot({path: info.outputPath("settled-navigation.png")});
  await frame.getByRole("menuitemradio", {name: "Archive", exact: true}).click();
  await expect(frame.getByRole("button", {name: "GTD navigation"})).toHaveText("Archive");
  await expect(menu).toHaveCount(0);
});
