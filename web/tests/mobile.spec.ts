import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

test.afterEach(async ({page}) => { await page.unrouteAll({behavior: "wait"}); });
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
// Dispatch the same cancelable touch sequence in Chromium and WebKit; physical
// iOS status-bar/keyboard behavior remains a separate device check.
async function swipe(
  page: Page,
  selector: string,
  points: number[][],
  cancel = false,
) {
  await page.locator(selector).evaluate(
    (element, { points, cancel }) => {
      const send = (name: string, point: number[], end = false) => {
        const e = new Event(name, { bubbles: true, cancelable: true });
        Object.defineProperty(e, "touches", {
          value: end ? [] : [{ clientX: point[0], clientY: point[1] }],
        });
        element.dispatchEvent(e);
      };
      send("touchstart", points[0]);
      for (const p of points.slice(1)) send("touchmove", p);
      send(cancel ? "touchcancel" : "touchend", points.at(-1)!, true);
    },
    { points, cancel },
  );
}
async function isolate(page: Page, name: string) {
  await page.route("**/api/tools/list_items", async (route) => {
    await route.continue({
      postData: JSON.stringify({
        ...route.request().postDataJSON(),
        query: name,
      }),
    });
  });
}
test("phone capture is compact, retains a collapsed draft, and captures once", async ({
  page,
  request,
  baseURL,
}) => {
  const title = "Mobile capture " + randomUUID().slice(0, 8);
  await isolate(page, title);
  await page.goto("/");
  await expect(page.locator(".gtd-main:visible").getByLabel("Add to inbox", { exact: true })).toBeHidden();
  const add = page.getByRole("button", { name: "Add task", exact: true });
  const box = await add.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(56);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await add.click();
  const input = page.locator(".gtd-main:visible").getByLabel("Add to inbox", { exact: true });
  await expect(input).toBeFocused();
  await input.fill(title);
  await page.getByRole("button", { name: "Close capture" }).click();
  await expect(input).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Continue adding task" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Continue adding task" }).click();
  await expect(input).toHaveValue(title);
  const saved=page.waitForResponse(r=>r.url().endsWith("/api/tools/capture_item")&&r.request().method()==="POST");
  await input.press("Enter");
  await expect(input).toBeHidden();
  await expect(
    page.getByRole("region", { name: `Task information: ${title}` }),
  ).toBeVisible();
  const r = await request.post("/api/tools/list_items", {
    headers: { Origin: baseURL!, "X-GTD-Request": "1" },
    data: { task_id: (await (await saved).json()).task.id },
  });
  expect((await r.json()).items).toHaveLength(1);
});

test("phone drawer tracks edge swipes, protects scroll and focus, fills safe areas", async ({
  page,
}) => {
  await page.route("**/api/tools/list_items", route => route.fulfill({json:{items:[],next_cursor:null}}));
  await page.route("**/api/tools/list_projects", route => route.fulfill({json:{projects:[],next_cursor:null}}));
  await page.route("**/api/view",route=>{const empty={items:[],next_cursor:null};return route.fulfill({json:{data:{next:empty,waiting:empty,someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}}});});
  await page.goto("/");
  await expect(page.getByText("No tasks to show.")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-top", "44px");
    document.documentElement.style.setProperty("--safe-bottom", "34px");
  });
  await swipe(page, ".gtd-main", [
    [14, 200],
    [17, 240],
    [19, 310],
  ]);
  await expect(page.locator(".gtd-sidebar")).toHaveAttribute("inert", "");
  await swipe(
    page,
    ".gtd-main",
    [
      [14, 200],
      [130, 203],
    ],
    true,
  );
  await expect(page.locator(".gtd-sidebar")).toHaveAttribute("inert", "");
  await swipe(page, ".gtd-main", [
    [14, 200],
    [40, 204],
    [160, 204],
  ]);
  await expect(page.locator(".gtd-main")).toHaveAttribute("inert", "");
  await expect(
    page
      .locator(".gtd-sidebar")
      .getByRole("button", { name: "Close navigation" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeFocused();
  const b = await page.locator(".gtd-sidebar").boundingBox();
  const bannerHeight = (await page.locator(".test-mode").boundingBox())!.height;
  expect(b!.y).toBe(bannerHeight);
  expect(b!.height).toBe(844 - bannerHeight);
  const brand = await page.locator(".sidebar-brand").boundingBox();
  expect(brand!.y).toBeGreaterThanOrEqual(44);
  const help = await page
    .getByRole("button", { name: "Help", exact: true })
    .boundingBox();
  expect(help!.y + help!.height).toBeLessThanOrEqual(810);
    await page.screenshot({
    path: test.info().outputPath("drawer-light.png"),
    animations: "disabled",
  });
  await swipe(page, ".gtd-sidebar nav button[aria-current=page]", [
    [240, 100],
    [210, 104],
    [85, 105],
  ]);
  await expect(page.locator(".gtd-sidebar")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});

test("pull refresh waits for real reads, ignores short pulls, and retains data on failure", async ({
  page,
}) => {
  const fixture = {
    id: "mobile-refresh",
    title: "Pick up the library book",
    status: "next",
    notes: "Bring your library card.\nThe book is ready at the front desk.",
    links: [
      { label: "Library catalogue", url: "https://example.com/catalogue" },
    ],
    location: "New York Public Library, 476 Fifth Avenue, New York",
    version: 1,
    last_change_id: 1,
    deleted: false,
    due_date: null,
  };
  let mode: "normal" | "held" | "error" = "normal",
    reads = 0,
    release: (() => void) | undefined;
  let gate: Promise<void> = Promise.resolve();
  await page.route("**/api/tools/list_items", async (route) => {
    reads++;
    const args = route.request().postDataJSON();
    if (mode === "held") await gate;
    if (mode === "error")
      return route.fulfill({
        status: 503,
        json: { message: "Could not refresh. Try again." },
      });
    await route.fulfill({
      json: {
        items: args.status === "someday" || args.blocked_by_id ? [] : [fixture],
        next_offset: null,
        detail: "full",
      },
    });
  });
  await page.route("**/api/view",async route=>{
    reads++;if(mode==="held")await gate;
    if(mode==="error")return route.fulfill({status:503,json:{message:"Could not refresh. Try again."}});
    const empty={items:[],next_cursor:null};
    return route.fulfill({json:{data:{next:{items:[fixture],next_cursor:null},waiting:empty,someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}}});
  });
  await page.goto("/");
  await expect(page.getByText(fixture.title, { exact: true })).toBeVisible();
  await page.getByRole("button", {name:`Details: ${fixture.title}`,exact:true}).click();
  const header = page.locator(".browse-toolbar");
  const restingHeaderY = (await header.boundingBox())!.y;
  const before = reads;
  await swipe(page, ".home-focus .task-title", [
    [170, 100],
    [170, 120],
    [170, 150],
  ]);
  expect(reads).toBe(before);
  mode = "held";
  gate = new Promise((resolve) => {
    release = resolve;
  });
  await swipe(page, ".home-focus .task-title", [
    [170, 100],
    [172, 125],
    [170, 260],
  ]);
  await expect(
    page.getByRole("status", { name: "Refreshing" }),
  ).toBeVisible();
  await expect.poll(async () => (await header.boundingBox())!.y).toBe(restingHeaderY + 80);
  fixture.notes = "Updated at the desk.";
  fixture.version++;
  release!();
  mode = "normal";
  await expect(
    page.getByRole("status", { name: "Refreshing" }),
  ).toHaveCount(0);
  await expect.poll(async () => (await header.boundingBox())!.y).toBe(restingHeaderY);
  await expect(
    page.getByText("Updated at the desk.", { exact: true }),
  ).toBeVisible();
  mode = "error";
  await swipe(page, ".home-focus .task-title", [
    [170, 100],
    [170, 130],
    [170, 260],
  ]);
  await expect(
    page.getByRole("button", { name: "View connection problem" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Refreshing" }),
  ).toHaveCount(0);
  await expect(page.getByText(fixture.title, { exact: true })).toBeVisible();
  await expect.poll(async () => (await header.boundingBox())!.y).toBe(restingHeaderY);
  mode = "normal";
  await swipe(page, ".home-focus .task-title", [
    [170, 100],
    [170, 130],
    [170, 260],
  ]);
  await expect(
    page.getByRole("button", { name: "View connection problem" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-top", "44px");
    document.documentElement.style.setProperty("--safe-bottom", "34px");
  });
    await page.screenshot({
    path: test.info().outputPath("home-light.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByLabel("Add to inbox", { exact: true })
    .fill("Return the library book");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: test.info().outputPath("capture-dark.png"),
    animations: "disabled",
  });
});

test("install metadata is same-origin and does not disable zoom", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/,
  );
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute(
    "content",
    /maximum-scale|user-scalable=no/,
  );
  const r = await request.get("/manifest.webmanifest");
  expect(r.headers()["content-security-policy"]).toContain(
    "manifest-src 'self'",
  );
  const m = await r.json();
  expect(m.display).toBe("standalone");
  expect(m.start_url).toBe("/");
  expect(
    (await request.get(m.icons[0].src)).headers()["content-type"],
  ).toContain("image/png");
});

test("touch expansion never leaves a hover highlight; task notes remain selectable", async ({
  page,
}) => {
  await page.route("**/api/tools/list_items", (route) =>
    route.fulfill({
      json: {
        items:
          route.request().postDataJSON().status === "someday"
            ? []
            : [
                {
                  id: "touch",
                  title: "Check the entry and team setup",
                  status: "next",
                  notes: "Bring the confirmation and check the venue.",
                  due_date: null,
                  version: 1,
                  last_change_id: 1,
                  deleted: false,
                },
              ],
        next_offset: null,
      },
    }),
  );
  await page.goto("/tasks?status=next");
  const title = page.getByRole("button", {
    name: "Details: Check the entry and team setup",
  });
  await expect(title).toBeVisible();
  const transparent = () =>
    title.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await transparent()).toBe("rgba(0, 0, 0, 0)");
  const box = (await title.boundingBox())!;
  await page.touchscreen.tap(box.x + 30, box.y + 20);
  await expect(title).toHaveAttribute("aria-expanded", "true");
  expect(await transparent()).toBe("rgba(0, 0, 0, 0)");
  await page.touchscreen.tap(box.x + 30, box.y + 20);
  await expect(title).toHaveAttribute("aria-expanded", "false");
  await page.touchscreen.tap(box.x + 30, box.y + 20);
  await expect(title).toHaveAttribute("aria-expanded", "true");
  expect(await transparent()).toBe("rgba(0, 0, 0, 0)");
  const notes = page.getByText("Bring the confirmation and check the venue.", {
    exact: true,
  });
  expect(
    await notes.evaluate((el) => getComputedStyle(el).userSelect),
  ).not.toBe("none");
  await title.focus();
  await title.press("ArrowDown");
  expect(await title.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "solid",
  );
});

test("initial task dialog focus never steals a field the user already entered", async ({page,request,baseURL}) => {
  const title = `Focus handoff ${randomUUID()}`;
  const response = await request.post('/api/tools/capture_item', {
    headers:{Origin:baseURL!, 'X-GTD-Request':'1'},
    data:{brief:'Complete the disposable focus check.',request_id:randomUUID(),title,importance:'normal',status:'next',estimated_minutes:15,effort:'low',reason:'Disposable focus regression fixture'},
  });
  expect(response.ok(),await response.text()).toBeTruthy();
  const {task}=await response.json();
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole('button',{name:`More options: ${title}`,exact:true}).click();
  // Hold frame callbacks during the handoff, then simulate entering the form
  // before the browser gets its next frame. No arbitrary timing sleeps.
  await page.getByRole('menuitem',{name:'Edit',exact:true}).evaluate(element=>{
    const original=window.requestAnimationFrame.bind(window);
    const callbacks:FrameRequestCallback[]=[];
    window.requestAnimationFrame=callback=>{callbacks.push(callback);return 1000000+callbacks.length;};
    (window as any).__releaseDialogFrames=()=>new Promise<void>(resolve=>{
      window.requestAnimationFrame=original;
      for(const callback of callbacks) original(callback);
      original(()=>original(()=>resolve()));
    });
    (element as HTMLElement).click();
  });
  const input=page.getByRole('textbox',{name:'Notes',exact:true});
  await input.waitFor();
  await input.evaluate(async element=>{
    (element as HTMLElement).focus();
    await (window as any).__releaseDialogFrames();
    delete (window as any).__releaseDialogFrames;
  });
  await expect(input).toBeFocused();
  await input.fill('Keep the input entered during the dialog handoff.');
  await expect(input).toHaveValue('Keep the input entered during the dialog handoff.');
});
