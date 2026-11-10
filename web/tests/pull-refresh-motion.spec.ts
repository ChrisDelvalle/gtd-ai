import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

// Deliver separate rendered touch frames: a synchronous swipe cannot expose a
// jump between the finger position, the loading position, and the resting page.
async function touch(page: Page, name: string, y: number) {
  await page.locator(".gtd-main:visible").evaluate(
    async (element, { name, y }) => {
      const event = new Event(name, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value:
          name === "touchend" || name === "touchcancel"
            ? []
            : [{ clientX: 180, clientY: y }],
      });
      element.dispatchEvent(event);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    },
    { name, y },
  );
}

async function offset(page: Page) {
  return page
    .locator(".mobile-refresh-content:visible")
    .evaluate(
      (element) =>
        new DOMMatrixReadOnly(getComputedStyle(element).transform).m42,
    );
}

async function sampleReturn(page: Page, action: () => Promise<unknown>) {
  await page.locator(".mobile-refresh-content:visible").evaluate((element) => {
    const state = window as any;
    state.pullFrames = [];
    const sample = (time: number) => {
      state.pullFrames.push({
        time,
        y: new DOMMatrixReadOnly(getComputedStyle(element).transform).m42,
      });
      state.pullFrame = requestAnimationFrame(sample);
    };
    state.pullFrame = requestAnimationFrame(sample);
  });
  await action();
  await expect.poll(() => offset(page)).toBe(0);
  return page.evaluate(() => {
    cancelAnimationFrame((window as any).pullFrame);
    return (window as any).pullFrames as { time: number; y: number }[];
  });
}

function expectSmoothReturn(
  frames: { time: number; y: number }[],
  from: number,
) {
  expect(
    frames.filter((frame) => frame.y > 1 && frame.y < from - 1).length,
  ).toBeGreaterThan(2);
  for (let i = 1; i < frames.length; i++) {
    expect(frames[i].y).toBeLessThanOrEqual(frames[i - 1].y + 0.5);
    // Do not mistake a stalled test process for a skipped animation frame.
    if (frames[i].time - frames[i - 1].time < 40)
      expect(frames[i - 1].y - frames[i].y).toBeLessThan(from * 0.65);
  }
}

async function fixture(page: Page) {
  let reads = 0;
  let release = () => {};
  let gate = Promise.resolve();
  await page.route("**/api/tools/list_items", async (route) => {
    reads++;
    await gate;
    const args = route.request().postDataJSON();
    await route.fulfill({
      json: {
        items:
          args.status === "someday"
            ? []
            : [
                {
                  id: "pull-motion",
                  title: "Pick up the library book",
                  status: "next",
                  notes: "Bring your library card.",
                  version: 1,
                  deleted: false,
                  due_date: null,
                  links: [],
                  last_change_id: 1,
                },
              ],
        next_offset: null,
        detail: "full",
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByText("Pick up the library book", { exact: true }),
  ).toBeVisible();
  return {
    reads: () => reads,
    hold: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
}

test("release holds the finger position, then returns in one continuous motion", async ({
  page,
  browserName,
}) => {
  const requests = await fixture(page);
  await page
    .getByRole("button", {
      name: "Details: Pick up the library book",
      exact: true,
    })
    .click();
  requests.hold();
  try {
    await touch(page, "touchstart", 160);
    await touch(page, "touchmove", 336);
    expect(await offset(page)).toBe(88);
    await touch(page, "touchend", 336);
    await expect(
      page.getByRole("status", { name: "Refreshing" }),
    ).toBeVisible();
    expect(await offset(page)).toBe(88);
        await page.screenshot({
      path: test.info().outputPath(`${browserName}-loading.png`),
    });
    const reads = requests.reads();
    // A second touch while loading must neither collapse the page nor refresh twice.
    await touch(page, "touchstart", 160);
    await touch(page, "touchmove", 320);
    await touch(page, "touchend", 320);
    await touch(page, "touchcancel", 320);
    expect(await offset(page)).toBe(88);
    expect(requests.reads()).toBe(reads);
    const frames = await sampleReturn(page, async () => requests.release());
    expectSmoothReturn(frames, 88);
    await writeFile(
      test.info().outputPath(`${browserName}-return-frames.json`),
      JSON.stringify(frames, null, 2) + "\n",
    );
    await expect(page.locator(".mobile-refresh-content:visible")).toHaveCSS(
      "transform",
      "none",
    );
    await page.screenshot({
      path: test.info().outputPath(`${browserName}-resting.png`),
    });
  } finally {
    requests.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const cancel of [false, true]) {
  test(`${cancel ? "cancelled" : "short"} pulls ease back without refreshing`, async ({
    page,
  }) => {
    const requests = await fixture(page);
    const reads = requests.reads();
    const distance = cancel ? 80 : 40;
    await touch(page, "touchstart", 160);
    await touch(page, "touchmove", 160 + distance * 2);
    expect(await offset(page)).toBe(distance);
    expectSmoothReturn(
      await sampleReturn(page, () =>
        touch(page, cancel ? "touchcancel" : "touchend", 160 + distance * 2),
      ),
      distance,
    );
    expect(requests.reads()).toBe(reads);
  });
}

test("a fast refresh still eases back; reduced motion returns immediately", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .locator(".gtd-sidebar")
    .getByRole("button", { name: "All tasks", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "All tasks", exact: true }),
  ).toBeVisible();
  await touch(page, "touchstart", 160);
  await touch(page, "touchmove", 320);
  expectSmoothReturn(
    await sampleReturn(page, () => touch(page, "touchend", 320)),
    80,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await touch(page, "touchstart", 160);
  await touch(page, "touchmove", 240);
  await touch(page, "touchend", 240);
  expect(await offset(page)).toBe(0);
  await expect(page.locator(".mobile-refresh-content:visible")).toHaveCSS(
    "transition-duration",
    "0s",
  );
});

test("another pull during the return does not interrupt it or start a refresh", async ({
  page,
}) => {
  const requests = await fixture(page);
  const reads = requests.reads();
  await touch(page, "touchstart", 160);
  await touch(page, "touchmove", 260);
  const frames = await sampleReturn(page, async () => {
    await touch(page, "touchend", 260);
    await touch(page, "touchstart", 160);
    await touch(page, "touchmove", 336);
    await touch(page, "touchend", 336);
  });
  expectSmoothReturn(frames, 50);
  expect(requests.reads()).toBe(reads);
});

test("retracting a pull follows the finger and hides the indicator at rest", async ({ page }) => {
  const requests = await fixture(page);
  const reads = requests.reads();
  await touch(page, "touchstart", 160);
  await touch(page, "touchmove", 320);
  expect(await offset(page)).toBe(80);
  await touch(page, "touchmove", 160);
  expect(await offset(page)).toBe(0);
  await expect(page.getByRole("status", { name: "Pull to refresh" })).toHaveCount(0);
  await expect(page.locator(".pull-indicator:visible")).toHaveCSS("opacity", "0");
  await touch(page, "touchend", 160);
  expect(requests.reads()).toBe(reads);
});


test("long pulls keep stretching with increasing resistance and hold until refreshed",async({page})=>{
  const requests=await fixture(page);
  requests.hold();
  try {
    await touch(page,"touchstart",160);
    const distances:number[]=[];
    for(const y of [336,436,536,636]) {
      await touch(page,"touchmove",y);
      distances.push(await offset(page));
    }
    expect(distances[0]).toBe(88);
    for(let i=1;i<distances.length;i++) {
      expect(distances[i]).toBeGreaterThan(distances[i-1]);
      expect(distances[i]-distances[i-1]).toBeLessThan(i===1 ? 50 : distances[i-1]-distances[i-2]);
    }
    await expect(page.getByRole("status",{name:"Release to refresh",exact:true})).toBeVisible();
    await touch(page,"touchend",636);
    await expect(page.getByRole("status",{name:"Refreshing",exact:true})).toBeVisible();
    expect(await offset(page)).toBe(distances.at(-1));
    expectSmoothReturn(await sampleReturn(page,async()=>requests.release()),distances.at(-1)!);
  } finally {
    requests.release();
    await page.unrouteAll({behavior:"wait"});
  }
});
