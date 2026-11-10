import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Args, Task } from "../src/api";

import { openWidget, title, projectTitle } from "./helpers/widget-host";

async function waitForExpansion(surface: Locator) {
  await expect(surface.locator(".task-expansion[data-resizing]")).toHaveCount(
    0,
  );
}

async function hitTest(control: Locator) {
  return control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = el.ownerDocument.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    return hit === el || el.contains(hit);
  });
}

for (const width of [390, 760]) {
  test(`long preview is capped, non-scrolling, and has no clipped focus targets at ${width}px`, async ({
    page,
  }, info) => {
    const { frame, surface, scroll, requests } = await openWidget(page, {
      width,
    });
    await frame
      .getByRole("button", { name: `Details: ${title}`, exact: true })
      .click();
    await expect(
      frame.getByRole("button", { name: "Open full view", exact: true }),
    ).toBeVisible();
    await waitForExpansion(surface);
    const bounds = (await surface.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(451);
    expect(bounds.height).toBeGreaterThan(400);
    expect(
      await scroll.evaluate((el) => getComputedStyle(el).overflowY),
    ).not.toMatch(/auto|scroll/);
    expect((await requests("ui/request-display-mode")).length).toBe(0);
    const inactive = await frame
      .locator("button,a,input,select,textarea,[tabindex]")
      .evaluateAll((elements) => {
        const surface = document
          .querySelector(".widget-surface")!
          .getBoundingClientRect();
        const fade = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Open full view"]',
        );
        const cutoff = fade?.getBoundingClientRect().top || surface.bottom;
        return elements
          .filter((el) => {
            const html = el as HTMLElement;
            const rect = html.getBoundingClientRect();
            if (
              !rect.width ||
              !rect.height ||
              rect.bottom <= cutoff ||
              el === fade ||
              el.closest(".widget-controls")
            )
              return false;
            const inactive =
              html.inert ||
              !!html.closest("[inert]") ||
              html.tabIndex < 0 ||
              (html as HTMLButtonElement).disabled;
            return !inactive;
          })
          .map(
            (el) =>
              el.getAttribute("aria-label") || el.textContent?.slice(0, 60),
          );
      });
    expect(inactive).toEqual([]);
    // Tabbing through the card must never scroll the clipped preview to reveal
    // hidden controls, nor focus a control that the user cannot see.
    await frame
      .getByRole("button", { name: "Expand view", exact: true })
      .focus();
    for (let n = 0; n < 12; n++) {
      await page.keyboard.press("Tab");
      expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
      const focusIsVisible = await frame.locator("body").evaluate((body) => {
        const el = body.ownerDocument.activeElement as HTMLElement | null;
        if (!el || el === body) return true;
        const surface = body
          .querySelector(".widget-surface")!
          .getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return (
          !el.closest("[inert]") &&
          r.top >= surface.top - 1 &&
          r.bottom <= surface.bottom + 1
        );
      });
      expect(focusIsVisible).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`preview-${width}.png`) });
    // A wheel over the preview scrolls the surrounding conversation.
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 150);
    await page.mouse.wheel(0, 450);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(100);
    expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
  });
}

test("short and empty previews shrink instead of reserving the maximum height", async ({
  page,
}) => {
  for (const empty of [false, true]) {
    const { frame, surface } = await openWidget(page, { long: false, empty });
    expect((await surface.boundingBox())!.height).toBeLessThan(220);
    await expect(
      frame.getByRole("button", { name: "Open full view", exact: true }),
    ).toHaveCount(0);
  }
});

test("host inline limits and later dimension updates bound the preview", async ({
  page,
}) => {
  const { frame, surface, changeMode } = await openWidget(page, {
    maxHeight: 330,
  });
  await frame
    .getByRole("button", { name: `Details: ${title}`, exact: true })
    .click();
  await expect(
    frame.getByRole("button", { name: "Open full view", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await surface.boundingBox())!.height)
    .toBeLessThanOrEqual(331);
  await changeMode("inline", 280);
  await expect
    .poll(async () => (await surface.boundingBox())!.height)
    .toBeLessThanOrEqual(281);
});

test("expand and fade use the standard display bridge and preserve task disclosure", async ({
  page,
}, info) => {
  const { frame, surface, scroll, requests, changeMode } =
    await openWidget(page);
  const details = frame.getByRole("button", {
    name: `Details: ${title}`,
    exact: true,
  });
  await details.click();
  await frame
    .getByRole("button", { name: "Open full view", exact: true })
    .click();
  await expect(surface).toHaveAttribute("data-display", "fullscreen");
  expect((await requests("ui/request-display-mode"))[0].params).toEqual({
    mode: "fullscreen",
  });
  const initialize = (await requests("ui/initialize"))[0].params;
  expect(initialize.appCapabilities.availableDisplayModes).toEqual([
    "inline",
    "fullscreen",
  ]);
  expect(await scroll.evaluate((el) => getComputedStyle(el).overflowY)).toMatch(
    /auto|scroll/,
  );
  await scroll.evaluate((el) => el.scrollTo({ top: 800, behavior: "instant" }));
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(500);
  const scrollAreas = await surface.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("*")]
      .filter(
        (node) =>
          /auto|scroll/.test(getComputedStyle(node).overflowY) &&
          node.scrollHeight > node.clientHeight + 1,
      )
      .map((node) => node.className),
  );
  expect(scrollAreas).toHaveLength(1);
  expect(scrollAreas[0]).toContain("widget-scroll");
  await page.screenshot({ path: info.outputPath("expanded-mobile.png") });
  await changeMode("inline");
  await expect(surface).toHaveAttribute("data-display", "preview");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(surface).toHaveAttribute("data-display", "fullscreen");
  await expect(details).toHaveAttribute("aria-expanded", "true");
});

for (const modeReply of ["reject", "inline"] as const) {
  test(`an explicit expansion enters a bounded fallback when the host replies ${modeReply}`, async ({
    page,
  }) => {
    const { frame, surface, scroll, requests } = await openWidget(page, {
      modeReply,
    });
    await frame
      .getByRole("button", { name: `Details: ${title}`, exact: true })
      .click();
    await expect(surface).toHaveAttribute("data-display", "preview");
    expect(await requests("ui/request-display-mode")).toHaveLength(0);
    await frame
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expect(surface).toHaveAttribute("data-display", "fallback");
    expect((await surface.boundingBox())!.height).toBeLessThanOrEqual(451);
    await scroll.evaluate((el) =>
      el.scrollTo({ top: 500, behavior: "instant" }),
    );
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(100);
    await frame
      .getByRole("button", { name: "Return to preview", exact: true })
      .click();
    await expect(surface).toHaveAttribute("data-display", "preview");
    expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
  });
}

test("a host without fullscreen support still requires an explicit expansion before fallback", async ({
  page,
}) => {
  const { frame, surface } = await openWidget(page, {
    availableModes: ["inline"],
  });
  await frame
    .getByRole("button", { name: `Details: ${title}`, exact: true })
    .click();
  await expect(surface).toHaveAttribute("data-display", "preview");
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(surface).toHaveAttribute("data-display", "fallback");
});

test("task menus stay within the preview without moving the task or growing the surface", async ({
  page,
}) => {
  const { frame, surface } = await openWidget(page);
  const details = frame.getByRole("button", {
    name: `Details: ${title}`,
    exact: true,
  });
  await details.click();
  await waitForExpansion(surface);
  const before = (await details.boundingBox())!;
  await frame
    .getByRole("button", { name: `More options: ${title}`, exact: true })
    .click();
  const menu = frame.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBounds = (await menu.boundingBox())!;
  const surfaceBounds = (await surface.boundingBox())!;
  expect(menuBounds.y).toBeGreaterThanOrEqual(surfaceBounds.y - 1);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(
    surfaceBounds.y + surfaceBounds.height + 1,
  );
  expect(surfaceBounds.height).toBeLessThanOrEqual(451);
  expect((await details.boundingBox())!.y).toBeCloseTo(before.y, 1);
  expect(
    await hitTest(frame.getByRole("menuitem", { name: "Edit", exact: true })),
  ).toBe(true);
  await menu.press("Escape");
  await expect(
    frame.getByRole("button", { name: `More options: ${title}`, exact: true }),
  ).toBeFocused();
});

test("opening an editor expands first and the unsaved draft survives host return and reopening", async ({
  page,
}) => {
  const { frame, surface, changeMode } = await openWidget(page);
  await frame
    .getByRole("button", { name: `More options: ${title}`, exact: true })
    .click();
  await frame.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(surface).toHaveAttribute("data-display", "fullscreen");
  const description = frame.getByRole("textbox", {
    name: "Notes",
    exact: true,
  });
  await description.fill(
    "Keep this working draft when the host returns to the conversation.",
  );
  await changeMode("inline");
  await expect(surface).toHaveAttribute("data-display", "preview");
  await expect(description).not.toBeVisible();
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(surface).toHaveAttribute("data-display", "fullscreen");
  await expect(description).toHaveValue(
    "Keep this working draft when the host returns to the conversation.",
  );
});

test("mode changes do not replay an uncertain write with a fresh request ID", async ({
  page,
}) => {
  const { frame, surface, changeMode, requests } = await openWidget(page, {
    uncertainWrite: true,
  });
  await frame
    .getByRole("button", { name: `Mark complete: ${title}`, exact: true })
    .click();
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(surface).toHaveAttribute("data-display", "fullscreen");
  await changeMode("inline");
  await expect
    .poll(
      async () =>
        (await requests("tools/call")).filter(
          (m) => m.params.name === "update_item",
        ).length,
    )
    .toBe(2);
  const writes = (await requests("tools/call")).filter(
    (m) => m.params.name === "update_item",
  );
  expect(writes[0].params.arguments.request_id).toBeTruthy();
  expect(writes[1].params.arguments).toEqual(writes[0].params.arguments);
});

for (const modeReply of ["denied", "timeout"] as const) {
  test(`a ${modeReply} expansion is bounded and does not lose the intended editor`, async ({
    page,
  }) => {
    const { frame, surface, requests } = await openWidget(page, { modeReply });
    await frame
      .getByRole("button", { name: `More options: ${title}`, exact: true })
      .click();
    await frame.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(surface).toHaveAttribute("data-display", "fallback", {
      timeout: 7000,
    });
    expect((await surface.boundingBox())!.height).toBeLessThanOrEqual(451);
    await expect(
      frame.getByRole("textbox", { name: "Notes", exact: true }),
    ).toHaveValue(/Step 1/);
    expect(await requests("ui/request-display-mode")).toHaveLength(1);
    expect(
      (await requests("tools/call")).filter((m) =>
        m.params.name.startsWith("update_"),
      ),
    ).toHaveLength(0);
  });
}

test("project drilldown expands, groups tasks, and keeps one scroll area with sticky controls", async ({
  page,
}, info) => {
  const { frame, surface, scroll, changeMode } = await openWidget(page, {
    project: true,
    width: 760,
  });
  await frame.getByRole("button", { name: new RegExp(projectTitle) }).click();
  await expect(surface).toHaveAttribute("data-display", "fullscreen");
  await expect(
    frame.getByRole("heading", { name: projectTitle, exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Next actions 5", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  const details = frame.getByRole("button", {
    name: `Details: ${title}`,
    exact: true,
  });
  await details.click();
  await expect(
    frame.getByRole("heading", { name: "Step 24", exact: true }),
  ).toBeVisible();
  await waitForExpansion(surface);
  await scroll.evaluate((el) => el.scrollTo({ top: 650, behavior: "instant" }));
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(500);
  const toolbar = frame.locator(".project-toolbar");
  expect(
    Math.abs(
      (await toolbar.boundingBox())!.y - (await scroll.boundingBox())!.y,
    ),
  ).toBeLessThan(1);
  const areas = await surface.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("*")]
      .filter(
        (node) =>
          /auto|scroll/.test(getComputedStyle(node).overflowY) &&
          node.scrollHeight > node.clientHeight + 1,
      )
      .map((node) => node.className),
  );
  expect(areas).toHaveLength(1);
  expect(areas[0]).toContain("widget-scroll");
  expect(
    await hitTest(
      toolbar.getByRole("button", { name: "Project options", exact: true }),
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("project-fullscreen-desktop.png"),
  });
  await changeMode("inline");
  await expect(surface).toHaveAttribute("data-display", "preview");
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(
    frame.getByRole("button", { name: "Next actions 5", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
});

for (const route of ["Edit project", "History", "Agent notes"] as const) {
  test(`project ${route.toLowerCase()} opens from preview in the full view`, async ({
    page,
  }) => {
    const { frame, surface, changeMode, requests } = await openWidget(page, {
      project: true,
    });
    await frame.getByRole("button", { name: new RegExp(projectTitle) }).click();
    await expect(
      frame.getByRole("heading", { name: projectTitle, exact: true }),
    ).toBeVisible();
    await changeMode("inline");
    await expect(surface).toHaveAttribute("data-display", "preview");
    await frame
      .getByRole("button", { name: "Project options", exact: true })
      .click();
    await frame.getByRole("menuitem", { name: route, exact: true }).click();
    await expect(surface).toHaveAttribute("data-display", "fullscreen");
    expect(await requests("ui/request-display-mode")).toHaveLength(2);
    if (route === "Edit project") {
      const description = frame.getByRole("textbox", {
        name: "Notes",
        exact: true,
      });
      await description.fill("Preserve this project draft.");
      await changeMode("inline");
      await expect(surface).toHaveAttribute("data-display", "preview");
      await expect(description).not.toBeVisible();
      await frame
        .getByRole("button", { name: "Expand view", exact: true })
        .click();
      await expect(description).toHaveValue("Preserve this project draft.");
    } else if (route === "History") {
      await expect(
        frame.getByText("Created a review outcome.", { exact: true }),
      ).toBeVisible();
    } else {
      const panel = frame.getByRole("region", {
        name: "Agent notes",
        exact: true,
      });
      await expect(panel).toContainText(
        "Keep the review focused on current commitments.",
      );
    }
  });
}

test("reduced-motion disclosure stays bounded without a running layout animation", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { frame, surface } = await openWidget(page, { width: 390 });
  await frame
    .getByRole("button", { name: `Details: ${title}`, exact: true })
    .click();
  await expect(
    frame.getByRole("button", { name: "Open full view", exact: true }),
  ).toBeVisible();
  await waitForExpansion(surface);
  const layoutMotion = await surface.evaluate(
    (el) =>
      [...el.querySelectorAll(".animated-size,.task-expansion")]
        .flatMap((node) => node.getAnimations())
        .filter((animation) => animation.playState === "running").length,
  );
  expect(layoutMotion).toBe(0);
  expect((await surface.boundingBox())!.height).toBeLessThanOrEqual(451);
  await page.screenshot({
    path: info.outputPath("reduced-motion-preview.png"),
  });
});

test.describe("touch preview", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("narrow touch controls remain reachable and the fade opens the full view", async ({
    page,
  }) => {
    const { frame, surface } = await openWidget(page, { width: 320 });
    const expand = frame.getByRole("button", {
      name: "Expand view",
      exact: true,
    });
    expect((await expand.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await frame
      .getByRole("button", { name: `Details: ${title}`, exact: true })
      .click();
    const fade = frame.getByRole("button", {
      name: "Open full view",
      exact: true,
    });
    await expect(fade).toBeVisible();
    expect(await hitTest(expand)).toBe(true);
    expect((await surface.boundingBox())!.height).toBeLessThanOrEqual(450.1);
    await expect(frame.locator(".task-expansion[data-resizing]")).toHaveCount(
      0,
    );
    expect(await hitTest(fade)).toBe(true);
    const b = (await fade.boundingBox())!;
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await expect(surface).toHaveAttribute("data-display", "fullscreen");
  });
});

for (const width of [390, 900]) test(`preview fade keeps its gradient on hover and offers Expand at ${width}px`, async ({page}, info) => {
  const {frame,surface}=await openWidget(page,{width,long:true});
  await frame.getByRole('button',{name:`Details: ${title}`,exact:true}).click();
  const fade=frame.getByRole('button',{name:'Open full view',exact:true});
  await expect(fade).toBeVisible();
  await expect(fade).toHaveText('Expand');
  const before=await fade.evaluate(e=>({background:getComputedStyle(e).backgroundImage,height:e.getBoundingClientRect().height}));
  expect(before.background).toContain('linear-gradient');
  await fade.hover();
  const after=await fade.evaluate(e=>({background:getComputedStyle(e).backgroundImage,height:e.getBoundingClientRect().height}));
  expect(after).toEqual(before);
  await page.screenshot({path:info.outputPath(`expand-fade-${width}.png`)});
  await fade.click();
  await expect(surface).toHaveAttribute('data-display','fullscreen');
});
