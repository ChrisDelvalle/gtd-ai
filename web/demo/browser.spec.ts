import { test, expect, type Page } from "@playwright/test";
const base = "/gtd-ai";
// Child-frame click stability does not include an animated parent iframe in
// WebKit. Verify the pane has reached its intended edge before interacting.
async function expandedAtRest(page: Page) {
  await expect(page.locator(".expanded-frame")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".expanded-frame")
        .evaluate((el) =>
          Math.abs(
            el.getBoundingClientRect().left -
              parseFloat(getComputedStyle(el).left),
          ),
        ),
    )
    .toBeLessThan(0.1);
}
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("close", () => expect(errors).toEqual([]));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    expect(url.origin).toBe("http://127.0.0.1:4175");
    expect(url.pathname).toMatch(
      /^\/gtd-ai\/(assets\/|website\/|chat\/|widget\/)/,
    );
    expect(route.request().method()).toBe("GET");
    await route.continue();
  });
});
for (const width of [390, 800, 1280, 1440])
  for (const dark of [false, true]) {
    test(`website grid and overlays ${width} ${dark ? "dark" : "light"}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${base}/website/`);
      if (dark)
        await page.getByRole("button", { name: "Use dark theme" }).click();
      const chart = page.getByRole("region", { name: "Priorities chart" });
      await expect(chart.locator(".priority-square")).toHaveCount(49);
      await expect(
        page.getByRole("button", {
          name: "Critical, Overdue: 1 task",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (width === 390)
        await expect(page.locator(".priority-importance-short")).toBeVisible();
      if (width >= 1280) {
        const geometry = await chart.evaluate((el) => {
          const cells = el.querySelectorAll(".priority-square");
          const a = cells[0].getBoundingClientRect(),
            b = cells[6].getBoundingClientRect(),
            pane = el.getBoundingClientRect();
          return {
            grid: (a.left + b.right) / 2,
            pane: (pane.left + pane.right) / 2,
          };
        });
        expect(Math.abs(geometry.grid - geometry.pane)).toBeLessThan(2);
      }
      await page.screenshot({ path: info.outputPath("website.png") });
      await page
        .getByRole("button", {
          name: "Normal, Within 7 days: 4 tasks",
          exact: true,
        })
        .click();
      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible();
      await expect(modal.locator(".priority-task")).toHaveCount(4);
      const before = await page.evaluate(() => window.scrollY);
      await page.mouse.move(width - 5, 400);
      await page.mouse.wheel(0, 600);
      expect(await page.evaluate(() => window.scrollY)).toBe(before);
      await page.screenshot({ path: info.outputPath("priority-modal.png") });
      await page.getByRole("button", { name: "Close task list" }).click();
      await expect(modal).not.toBeVisible();
      await page
        .getByRole("button", {
          name: "Details: Prepare the scrubbed exception replay for the release gate",
          exact: true,
        })
        .click();
      await expect(
        page.getByText(
          "Stage a safe copy of the failing case so Maya can run the gate check.",
          { exact: true },
        ),
      ).toBeVisible();
    });
  }
test("website edits, undo, history and reset remain local", async ({
  page,
}) => {
  await page.goto(`${base}/website/`);
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByLabel("Add to inbox", { exact: true })
    .fill("Try the local demo");
  await page.getByRole("button", { name: "Capture task", exact: true }).click();
  await expect(
    page.getByRole("region", {
      name: "Task information: Try the local demo",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "More options: Try the local demo",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const inspector = page.getByRole("region", { name: "Task details" });
  await inspector
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("A visitor can edit the real fields.");
  await inspector.getByRole("button", { name: "Save changes" }).click();
  await expect(
    inspector.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Undo last change" }).click();
  await expect(
    inspector.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Reset demo", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Priorities chart" }),
  ).toBeVisible();
  await page.goto(
    `${base}/website/#/tasks?query=Try%20the%20local%20demo&view=all`,
  );
  await expect(
    page.getByText("Try the local demo", { exact: true }),
  ).toHaveCount(0);
});
for (const width of [390, 1440]) {
  test(`scripted chats and retained expansion at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${base}/chat/`);
    await page.getByRole("button", { name: "Send prepared example" }).click();
    let frame = page.frameLocator(
      'iframe[title="GTD widget — Before school pickup"]',
    );
    await expect(
      frame.getByRole("region", { name: "Priorities chart" }),
    ).toBeVisible();
    if (width === 1440)
      await page
        .getByRole("button", { name: "Close sidebar", exact: true })
        .click();
    await page.screenshot({ path: info.outputPath("chat-inline.png") });
    await frame
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Close expanded view" }),
    ).toBeVisible();
    await expect(
      frame.getByRole("button", {
        name: "Critical, Overdue: 1 task",
        exact: true,
      }),
    ).toBeVisible();
    await expandedAtRest(page);
    await page.screenshot({ path: info.outputPath("chat-expanded.png") });
    await frame
      .getByRole("button", { name: "Critical, Overdue: 1 task", exact: true })
      .click();
    await expect(frame.getByRole("dialog")).toBeVisible();
    await frame.getByRole("button", { name: "Close task list" }).click();
    await page.getByRole("button", { name: "Close expanded view" }).click();
    await expect(
      frame.getByRole("button", { name: "Expand view", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "A few things before I forget",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Send prepared example" }).click();
    frame = page.frameLocator(
      'iframe[title="GTD widget — A few things before I forget"]',
    );
    await expect(
      frame.getByRole("button", {
        name: "Details: Ask Priya whether the refund test is still failing",
        exact: true,
      }),
    ).toBeVisible();
    if (width === 1440)
      await page
        .getByRole("button", { name: "Close sidebar", exact: true })
        .click();
    await frame
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expect(
      frame.getByRole("button", {
        name: "Details: Consider a hook by the door for the library bag",
        exact: true,
      }),
    ).toBeVisible();
    const resultTitle = frame.getByRole("button", {
      name: "Details: Ask Priya whether the refund test is still failing",
      exact: true,
    });
    expect(
      await resultTitle.evaluate((el) => getComputedStyle(el).borderTopWidth),
    ).toBe("0px");
    expect(
      await resultTitle.evaluate((el) => getComputedStyle(el).textAlign),
    ).toBe("left");
    await page.screenshot({ path: info.outputPath("capture-results.png") });
    await page.getByRole("button", { name: "Close expanded view" }).click();
    await page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Twenty minutes, low energy", exact: true })
      .click();
    await page.getByRole("button", { name: "Send prepared example" }).click();
    frame = page.frameLocator(
      'iframe[title="GTD widget — Twenty minutes, low energy"]',
    );
    await expect(
      frame.getByRole("button", {
        name: "Details: Refill the spare folder in Nico's bag",
        exact: true,
      }),
    ).toBeVisible();
    if (width === 1440)
      await page
        .getByRole("button", { name: "Close sidebar", exact: true })
        .click();
    await frame
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await page.screenshot({ path: info.outputPath("energy-results.png") });
    await page.getByRole("button", { name: "Close expanded view" }).click();
    await page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "A few things before I forget",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: "Send prepared example" }),
    ).toBeDisabled();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Send prepared example" }),
    ).toBeEnabled();
  });
}
test("initial state ignores host time and timezone", async ({ browser }) => {
  const outputs = [];
  for (const timezoneId of ["America/New_York", "Asia/Tokyo"]) {
    const context = await browser.newContext({ timezoneId });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date("2035-07-18T23:00:00Z"));
    await page.goto(`${base}/website/`);
    await expect(page.locator(".priority-square")).toHaveCount(49);
    outputs.push(
      await page
        .locator(".priority-square")
        .evaluateAll((cells) => cells.map((c) => c.getAttribute("aria-label"))),
    );
    await context.close();
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

test("charts, recurrence browsing, and keyboard expansion", async ({
  page,
}, info) => {
  await page.goto(`${base}/website/`);
  await page
    .getByRole("button", { name: "Chart: Priorities", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Heatmap", exact: true })
    .click();
  await expect(page.locator(".heat-grid button")).toHaveCount(364);
  await page.screenshot({ path: info.outputPath("heatmap.png") });
  await page
    .getByRole("button", { name: "Chart: Heatmap", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Bar Chart", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "30d", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("bars.png") });
  await page.goto(`${base}/website/#/repeating`);
  await expect(
    page.getByRole("button", {
      name: "Review commitments and the coming week Every Friday",
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(`${base}/chat/#energy`);
  await page.getByRole("button", { name: "Use light theme" }).click();
  await page.getByRole("button", { name: "Send prepared example" }).click();
  const frame = page.frameLocator(
    'iframe[title="GTD widget — Twenty minutes, low energy"]',
  );
  await frame
    .getByRole("button", { name: "Expand view", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("button", { name: "Close expanded view" }),
  ).toBeFocused();
  await page.screenshot({ path: info.outputPath("chat-light-expanded.png") });
  await page
    .getByRole("button", { name: "Close expanded view" })
    .press("Escape");
  await expect(
    frame.getByRole("button", { name: "Expand view", exact: true }),
  ).toBeFocused();
});

test("failed fixture load offers a working local retry", async ({ page }) => {
  page.removeAllListeners("console");
  let fail = true;
  await page.route("**/maya-*.json", (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 503, body: "Unavailable" });
    }
    return route.fallback();
  });
  await page.goto(`${base}/website/`);
  await expect(page.getByRole("alert")).toContainText("could not load");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Priorities chart" }),
  ).toBeVisible();
});

for (const width of [800, 801, 999, 1000]) {
  test(`viewer fits its pane at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/chat/#energy`);
    await page.getByRole("button", { name: "Send prepared example" }).click();
    const frame = page.frameLocator(
      'iframe[title="GTD widget — Twenty minutes, low energy"]',
    );
    await frame
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator(".expanded-frame")
          .evaluate((el) =>
            el.getAnimations().every((a) => a.playState === "finished"),
          ),
      )
      .toBe(true);
    const card = await page.locator(".expanded-frame").boundingBox();
    const toolbar = await page.locator(".viewer-toolbar").boundingBox();
    expect(
      Math.abs(card!.x + card!.width / 2 - toolbar!.x - toolbar!.width / 2),
    ).toBeLessThan(1);
    expect(card!.x).toBeGreaterThanOrEqual(toolbar!.x - 1);
    expect(card!.x + card!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: info.outputPath("viewer-pane.png") });
    await page.getByRole("button", { name: "Close expanded view" }).click();
    await expect(
      frame.getByRole("button", { name: "Expand view", exact: true }),
    ).toBeFocused();
  });
}

for (const width of [390, 1440]) {
  test(`card opens before the reply streams at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${base}/chat/`);
    if (width === 390)
      await page.getByRole("button", { name: "Use light theme" }).click();
    expect(await page.locator(".chat-composer").innerText()).toBe("");
    const typography = await page
      .getByLabel("Prepared example prompt")
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          family: s.fontFamily,
          size: s.fontSize,
          weight: s.fontWeight,
          line: s.lineHeight,
          features: s.fontFeatureSettings,
        };
      });
    expect(typography.family).toMatch(
      /^-apple-system-body, ui-sans-serif, -apple-system, system-ui/,
    );
    expect(typography.size).toBe("16px");
    expect(typography.weight).toBe("400");
    expect(typography.line).toBe("26px");
    expect(typography.features).toBe('"liga" 0');

    await page.getByRole("button", { name: "Send prepared example" }).click();
    const pickup = page.getByRole("region", {
      name: "Before school pickup",
      exact: true,
    });
    const reply = pickup.locator(".streamed-reply");
    await expect(reply).toHaveAttribute("aria-busy", "true");
    await expect(pickup.locator(".chat-result")).toHaveCount(2);
    await expect(pickup.locator(".chat-result").first()).toBeVisible();
    await expect(pickup.locator(".chat-result").last()).toBeVisible();
    expect(
      await pickup
        .locator(".chat-result")
        .last()
        .evaluate((el) => !!el.nextElementSibling?.matches(".streamed-reply")),
    ).toBe(true);
    const first = await reply.textContent();
    await expect
      .poll(async () => (await reply.textContent())!.length, {
        intervals: [20],
      })
      .toBeGreaterThan(first!.length);

    const partial = await reply.textContent();
    expect(partial!.length).toBeGreaterThan(first!.length);
    expect(partial).not.toContain("confirm they’ve received it.");
    expect(partial).not.toContain("**");
    await expect(reply.locator("strong").first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("streaming.png") });
    if (width === 390)
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
    await page
      .getByRole("button", { name: "Twenty minutes, low energy", exact: true })
      .click();
    await page.getByRole("button", { name: "Send prepared example" }).click();
    await expect(
      page.locator(".chat-scroll:not([hidden]) .streamed-reply"),
    ).toHaveAttribute("aria-busy", "true");
    if (width === 390)
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
    await page
      .getByRole("button", { name: "Before school pickup", exact: true })
      .click();
    await expect(reply).toHaveAttribute("aria-busy", "false");
    await expect(reply).toContainText("confirm they’ve received it.");
    await expect(reply.locator("ol > li")).toHaveCount(2);
    await expect(pickup.locator(".chat-result")).toHaveCount(2);
    await expect(pickup.locator(".chat-result").first()).toBeVisible();
    await expect(pickup.locator(".chat-result").last()).toBeVisible();
    expect(
      await pickup
        .locator(".chat-result")
        .first()
        .evaluate((el) => getComputedStyle(el).transitionDuration),
    ).toBe("0.38s, 0.24s");
    expect(await page.locator(".chat-composer").innerText()).toBe("");
    await page.screenshot({ path: info.outputPath("stream-complete.png") });
  });
}

test("reduced motion skips streaming and card transitions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${base}/chat/#capture`);
  await page.getByRole("button", { name: "Send prepared example" }).click();
  await expect(page.locator(".streamed-reply")).toBeVisible();
  expect(await page.locator(".streamed-reply").getAttribute("aria-busy")).toBe(
    "false",
  );
  await expect(page.locator(".streamed-reply")).toContainText(
    "No messages sent.",
  );
  await expect(page.locator(".chat-result")).toBeVisible();
  expect(
    await page
      .locator(".chat-result")
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
  const frame = page.frameLocator(
    'iframe[title="GTD widget — A few things before I forget"]',
  );
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  expect(
    await page
      .locator(".expanded-frame")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  await page.getByRole("button", { name: "Close expanded view" }).click();
  await expect(
    frame.getByRole("button", { name: "Expand view", exact: true }),
  ).toBeFocused();
});

for (const width of [390, 1440]) {
  test(`priority and recommendation cards share changes at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${base}/chat/#pickup`);
    const sidebarType = await page
      .locator(".chat-history-row")
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          size: s.fontSize,
          weight: s.fontWeight,
          line: s.lineHeight,
          features: s.fontFeatureSettings,
        };
      });
    expect(sidebarType).toEqual({
      size: "14px",
      weight: "400",
      line: "20px",
      features: "normal",
    });
    await page.getByRole("button", { name: "Send prepared example" }).click();
    const chart = page.frameLocator(
      'iframe[title="GTD widget — Before school pickup"]',
    );
    const task = page.frameLocator(
      'iframe[title="GTD widget — Before school pickup — Recommended task"]',
    );
    const title = "Prepare the scrubbed exception replay for the release gate";
    await expect(
      task.getByRole("button", { name: `Details: ${title}`, exact: true }),
    ).toBeVisible();
    await expect(
      chart.getByRole("region", { name: "Priorities chart" }),
    ).toBeVisible();
    await page
      .locator(".chat-scroll:not([hidden]) .chat-result")
      .last()
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("priority-two-cards.png") });
    await task
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expect(page.locator('iframe[title$="Recommended task"]')).toHaveClass(
      /expanded-frame/,
    );
    const slide = await page
      .locator('iframe[title$="Recommended task"]')
      .evaluate((el) => {
        const animation = el
          .getAnimations()
          .find((a) => (a as CSSAnimation).animationName === "viewer-enter")!;
        animation.pause();
        animation.currentTime = 0;
        const start = el.getBoundingClientRect().left;
        animation.currentTime = 130;
        const middle = el.getBoundingClientRect().left;
        animation.currentTime = 260;
        const end = el.getBoundingClientRect().left;
        animation.play();
        return { start, middle, end };
      });
    expect(slide.start).toBeGreaterThanOrEqual(width - 1);
    expect(slide.middle).toBeGreaterThan(slide.end);
    expect(slide.middle).toBeLessThan(slide.start);
    await expandedAtRest(page);
    await task
      .getByRole("button", { name: `Details: ${title}`, exact: true })
      .click();
    await expect(
      task.getByText(
        "Stage a safe copy of the failing case so Maya can run the gate check.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close expanded view" }).click();
    await expect(
      task.getByRole("button", { name: "Expand view", exact: true }),
    ).toBeFocused();
    await task
      .getByRole("button", { name: `Mark complete: ${title}`, exact: true })
      .click();
    await chart
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expandedAtRest(page);
    await chart
      .getByRole("button", { name: "Critical, Overdue: 1 task", exact: true })
      .click();
    await expect(
      chart.getByRole("dialog").getByRole("button", {
        name: "Verify refund exceptions before the merchant window",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      chart
        .getByRole("dialog")
        .getByRole("button", { name: title, exact: true }),
    ).toHaveCount(0);
    await chart.getByRole("button", { name: "Close task list" }).click();
    await page.getByRole("button", { name: "Close expanded view" }).click();
    await task
      .getByRole("button", { name: "Undo last change", exact: true })
      .click();
    await chart
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expandedAtRest(page);
    await chart
      .getByRole("button", { name: "Critical, Overdue: 1 task", exact: true })
      .click();
    await expect(
      chart
        .getByRole("dialog")
        .getByRole("button", { name: title, exact: true }),
    ).toBeVisible();
  });

  test(`email sources and structured replies at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${base}/chat/#inbox`);
    if (width === 390)
      await page.getByRole("button", { name: "Use light theme" }).click();
    await page.getByRole("button", { name: "Send prepared example" }).click();
    const thread = page.getByRole("region", {
      name: "From my inbox",
      exact: true,
    });
    const reply = thread.locator(".streamed-reply");
    await expect(reply).toHaveAttribute("aria-busy", "false");
    await expect(reply.locator("ul > li")).toHaveCount(2);
    await expect(reply.locator("strong").first()).toHaveText(
      "Two emails need a response.",
    );
    await expect(reply).toContainText("I haven’t replied to either email.");
    await expect(thread.locator(".inbox-messages")).not.toBeVisible();
    await thread.locator(".inbox-preview > summary").click();
    await expect(thread.locator(".inbox-message")).toHaveCount(3);
    await thread
      .locator(".inbox-message")
      .filter({ hasText: "Priya Shah" })
      .locator("summary")
      .click();
    await expect(thread.getByText(/Just the two names is fine/)).toBeVisible();
    const frame = page.frameLocator(
      'iframe[title="GTD widget — From my inbox"]',
    );
    await expect(frame.getByRole("button", { name: /^Details:/ })).toHaveCount(
      2,
    );
    await expect(
      frame.getByRole("button", {
        name: "Details: Send Priya the owner and backup for Monday's retry rehearsal",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await thread.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("email-sources.png") });
    await thread.locator(".inbox-preview > summary").click();
    await reply.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("email-summary.png") });
    await frame
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await frame
      .getByRole("button", {
        name: "Details: Confirm Tuesday's pickup adult with the school office",
        exact: true,
      })
      .click();
    await expect(
      frame.getByText(
        "Check the plan with Daniel, then tell the school who will collect Nico on November 10.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close expanded view" }).click();
    await page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Twenty minutes, low energy", exact: true })
      .click();
    if (width === 390)
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
    await page
      .getByRole("button", { name: "From my inbox", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Send prepared example" }),
    ).toBeDisabled();
    await expect(frame.getByRole("button", { name: /^Details:/ })).toHaveCount(
      2,
    );
    await page
      .getByRole("banner")
      .getByRole("button", { name: "Reset demo", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Send prepared example" }),
    ).toBeEnabled();
    await expect(page.locator(".inbox-preview")).toHaveCount(0);
  });
}

for (const width of [390, 880, 1440]) {
  test(`expanded card leaves no conversation gap at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${base}/chat/#energy`);
    await expect(
      page
        .getByRole("navigation", { name: "Demo navigation" })
        .getByRole("link"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Send prepared example" }).click();
    const iframe = page.locator(
      'iframe[title="GTD widget — Twenty minutes, low energy"]',
    );
    const frame = page.frameLocator(
      'iframe[title="GTD widget — Twenty minutes, low energy"]',
    );
    await expect(
      page.locator(".chat-scroll:not([hidden]) .streamed-reply"),
    ).toHaveAttribute("aria-busy", "false");
    const savedFrame = await iframe.elementHandle();
    await frame
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expect(page.locator(".expanded-frame")).toBeVisible();
    await expect(
      page.locator(".inline-card-slot:has(.expanded-frame)"),
    ).toHaveCSS("height", "0px");
    await expect(
      page.locator(".inline-card-slot:has(.expanded-frame)"),
    ).toHaveCSS("margin-bottom", "0px");
    expect(await savedFrame!.evaluate((el) => el.isConnected)).toBe(true);
    await page.screenshot({ path: info.outputPath("expanded-reflow.png") });
    await page.getByRole("button", { name: "Close expanded view" }).click();
    await expect(
      frame.getByRole("button", { name: "Expand view", exact: true }),
    ).toBeFocused();
    expect(await savedFrame!.evaluate((el) => el.isConnected)).toBe(true);
    expect(
      (await page
        .locator(".chat-scroll:not([hidden]) .inline-card-slot")
        .boundingBox())!.height,
    ).toBeGreaterThan(80);
    await page.screenshot({ path: info.outputPath("restored-inline.png") });
  });
}

for (const width of [360, 768, 1280, 1920])
  for (const theme of ["light", "dark"]) {
    test(`chat fidelity matrix ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width < 801 ? 844 : 1000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${base}/chat/#energy`);
      if (theme === "light")
        await page.getByRole("button", { name: "Use light theme" }).click();
      if (width >= 1000)
        await page
          .getByRole("button", { name: "Close sidebar", exact: true })
          .click();
      await page.getByRole("button", { name: "Send prepared example" }).click();
      const frame = page.frameLocator(
        'iframe[title="GTD widget — Twenty minutes, low energy"]',
      );
      await expect(
        frame.getByRole("button", { name: /^Details:/ }),
      ).toHaveCount(2);
      await expect(
        frame.getByRole("button", {
          name: "Details: File the extra closet screws with the rest of the hardware",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Copy response", exact: true }),
      ).toBeVisible();
      const bubble = await page.locator(".user-message").evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          size: s.fontSize,
          line: s.lineHeight,
          radius: s.borderRadius,
          padding: s.padding,
        };
      });
      expect(bubble).toEqual({
        size: "16px",
        line: "26px",
        radius: "22px",
        padding: "10px 16px",
      });
      if (width > 800)
        await expect(page.locator(".chat-composer")).toHaveCSS(
          "height",
          "52px",
        );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath("chat-inline.png") });
      await page
        .getByRole("button", { name: "Expand GTD card", exact: true })
        .click();
      await expect(page.locator(".expanded-frame")).toBeVisible();
      await page.screenshot({ path: info.outputPath("chat-split.png") });
      if (width > 800) {
        await expect(page.locator(".user-message")).toHaveCSS(
          "max-width",
          "70%",
        );
        await expect(
          page.locator(".has-viewer .chat-scroll").filter({ visible: true }),
        ).toHaveCSS("padding", "20px");
        const divider = page.getByRole("separator", {
          name: "Resize chat and widget",
        });
        const start = Number(await divider.getAttribute("aria-valuenow"));
        await divider.press("ArrowRight");
        expect(Number(await divider.getAttribute("aria-valuenow"))).toBe(
          start + 32,
        );
        const handle = (await divider.boundingBox())!;
        await page.mouse.move(handle.x + 4, 200);
        await page.mouse.down();
        await page.mouse.move(handle.x + 100, 200);
        await page.mouse.up();
        expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
        expect(
          Number(await divider.getAttribute("aria-valuenow")),
        ).toBeGreaterThan(start + 100);
        await page
          .getByRole("button", { name: "Enter full view", exact: true })
          .click();
        await expect(page.locator(".expanded-frame")).toHaveCSS("left", "52px");
        await expect(
          page.getByRole("button", { name: "Exit full view" }),
        ).toHaveAttribute("aria-pressed", "true");
        await page.screenshot({ path: info.outputPath("chat-full.png") });
        await page.getByRole("button", { name: "Exit full view" }).click();
      }
      await page.getByRole("button", { name: "Close expanded view" }).click();
      await expect(
        frame.getByRole("button", { name: "Expand view", exact: true }),
      ).toBeFocused();
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Explore the website" }),
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath("chat-sidebar.png") });
    });
  }

test("local working sequence and copy actions", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    });
  });
  await page.goto(`${base}/chat/#energy`);
  await page.getByRole("button", { name: "Send prepared example" }).click();
  await expect(page.locator(".work-status")).toHaveText("Working…");
  await expect(page.locator(".work-status")).toHaveText("Opening GTD…");
  await expect(page.locator(".work-status")).toHaveText(
    "Worked for a few seconds",
  );
  await page.getByRole("button", { name: "Copy message", exact: true }).click();
  expect(await page.locator("html").getAttribute("data-copied")).toContain(
    "I'm home, pretty wiped",
  );
  await page
    .getByRole("button", { name: "Copy response", exact: true })
    .click();
  expect(await page.locator("html").getAttribute("data-copied")).toContain(
    "**I’d refill Nico’s folder.**",
  );
});
