import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function paginatedCard(
  page: Page,
  {
    size = 7,
    count = 11,
    failNext = false,
    width = 390,
    longTitles = false,
  } = {},
) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `paged-${i + 1}`,
    title: `Review item ${i + 1}${longTitles ? " — Choose the next useful step from the supporting research and discuss it with the team".repeat(3) : ""}`,
    notes: `Context for item ${i + 1}.`,
    status: "next",
    archived: false,
    deleted: false,
    version: 1,
    last_change_id: i + 1,
    due_date: null,
  }));
  const reads: Record<string, any>[] = [];
  let fail = failNext;
  let current = items;
  const list = (args: Record<string, any>) => {
    const offset = args.cursor
      ? Number(String(args.cursor).slice("server-cursor-".length))
      : Number(args.offset || 0);
    const matching = current.filter(
      (task) => !args.status || task.status === args.status,
    );
    const limit = Number(args.limit || size);
    const end = offset + limit;
    return {
      items: matching.slice(offset, end),
      history: [],
      next_history_after: null,
      next_offset: end < matching.length ? end : null,
      next_cursor: end < matching.length ? `server-cursor-${end}` : null,
      group_recurrences: true,
      complete: end >= matching.length,
    };
  };
  const args = {
    status: "next",
    query: "review",
    limit: size,
    group_recurrences: true,
  };
  await page.exposeFunction(
    "pageTool",
    async (name: string, input: Record<string, any>) => {
      if (["widget_pages", "view_snapshot"].includes(name)) return {isError:true, structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}};
      if (name === "list_items") {
        // Opening details independently retrieves reverse dependency metadata.
        // It is not a page fetch and must not receive the pagination fixture.
        if (input.blocked_by_id)
          return { structuredContent: { items: [], complete: true, next_cursor: null } };
        reads.push(input);
        if (input.cursor && fail) {
          fail = false;
          return {
            isError: true,
            structuredContent: {
              code: "search_unavailable",
              message: "The next page is temporarily unavailable.",
            },
          };
        }
        return { structuredContent: list(input) };
      }
      if (name === "update_item") {
        const before = current.find((task) => task.id === input.task_id)!;
        const task = { ...before, ...input, version: before.version + 1 };
        current = current.map((old) => (old.id === task.id ? task : old));
        return {
          structuredContent: {
            task,
            change: { id: 80, task_id: task.id, before, after: task },
            replayed: false,
          },
        };
      }
      return { structuredContent: { changes: [], next_before_id: null } };
    },
  );
  await page.route("**/__compact-pagination", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><body style='margin:0'><div id='card'></div></body>",
    }),
  );
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/__compact-pagination");
  const html = await readFile(
    new URL("../dist/widget-adapter.html", import.meta.url),
    "utf8",
  );
  await page.evaluate(
    ({ html, initial, args, width }) => {
      const frame = document.createElement("iframe");
      frame.style.cssText = `width:${width}px;height:450px;border:0`;
      let mode = "inline";
      const send = (message: object) =>
        frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...message }, "*");
      const context = () => ({
        displayMode: mode,
        theme: "dark",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions:
          mode === "inline"
            ? { width, maxHeight: 450 }
            : { width, height: 800 },
      });
      (window as any).setCardMode = (value: string) => {
        mode = value;
        frame.style.height = mode === "inline" ? "450px" : "800px";
        send({
          method: "ui/notifications/host-context-changed",
          params: context(),
        });
      };
      window.addEventListener("message", async (event) => {
        if (event.source !== frame.contentWindow) return;
        const request = event.data;
        // Simulate the app-only facade used by the authenticated adapter.
        if (request.method === "tools/call" && ["gtd_ui_read", "gtd_ui_write"].includes(request.params.name)) {
          request.params = {...request.params, name: request.params.arguments.operation, arguments: request.params.arguments.arguments};
        }
        if (request.method === "ui/initialize")
          send({ id: request.id, result: { hostContext: context() } });
        if (request.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: { arguments: args },
          });
          send({
            method: "ui/notifications/tool-result",
            params: { structuredContent: initial },
          });
        }
        if (request.method === "tools/call")
          send({
            id: request.id,
            result: await (window as any).pageTool(
              request.params.name,
              request.params.arguments,
            ),
          });
        if (request.method === "ui/request-display-mode") {
          (window as any).setCardMode(request.params.mode);
          send({ id: request.id, result: { mode } });
        }
        if (
          request.method === "ui/notifications/size-changed" &&
          mode === "inline"
        )
          frame.style.height = `${request.params.height}px`;
      });
      frame.srcdoc = html;
      document.getElementById("card")!.append(frame);
    },
    { html, initial: list(args), args, width },
  );
  const frame = page.frameLocator("iframe");
  const titles = () =>
    frame
      .getByRole("button", { name: /^Details: Review item / })
      .allTextContents();
  await expect(
    frame.getByRole("button", {
      name: `Details: ${items[0].title}`,
      exact: true,
    }),
  ).toBeVisible();
  return { frame, reads, titles, items };
}

test("compact task pages use cached rows and server cursors; expansion preserves page and disclosure", async ({
  page,
}) => {
  const { frame, reads, titles } = await paginatedCard(page);
  await expect(
    frame.getByRole("button", { name: "Show more", exact: true }),
  ).toHaveCount(0);
  await expect.poll(titles).toHaveLength(4);
  await page.screenshot({
    path: test.info().outputPath("compact-pagination.png"),
  });
  await expect(
    frame.getByRole("button", { name: "Previous task page" }),
  ).toBeDisabled();
  await frame.getByRole("button", { name: "Next task page" }).click();
  await expect.poll(titles).toEqual([
    "Review item 5",
    "Review item 6",
    "Review item 7",
  ]);
  expect(reads).toHaveLength(0);
  await frame
    .getByRole("button", { name: "Details: Review item 6", exact: true })
    .click();
  await expect(
    frame.getByRole("region", { name: "Task information: Review item 6" }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Next task page" }).click();
  await expect(
    frame.getByRole("button", { name: "Details: Review item 8", exact: true }),
  ).toBeVisible();
  await expect.poll(titles).toHaveLength(4);
  await expect(
    frame.getByRole("button", { name: "Next task page" }),
  ).toBeDisabled();
  expect(reads).toEqual([
    {
      status: "next",
      query: "review",
      limit: 7,
      group_recurrences: true,
      cursor: "server-cursor-7",
    },
  ]);
  await frame.getByRole("button", { name: "Previous task page" }).click();
  await expect(
    frame.getByRole("region", { name: "Task information: Review item 6" }),
  ).toBeVisible();
  expect(reads).toHaveLength(1);
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(frame.locator(".widget-surface")).toHaveAttribute(
    "data-display",
    "fullscreen",
  );
  await expect.poll(async () => (await titles()).length).toBe(11);
  await page.evaluate(() => (window as any).setCardMode("inline"));
  await expect(frame.locator(".widget-surface")).toHaveAttribute(
    "data-display",
    "preview",
  );
  await expect.poll(titles).toEqual([
    "Review item 5",
    "Review item 6",
    "Review item 7",
  ]);
  await expect(
    frame.getByRole("region", { name: "Task information: Review item 6" }),
  ).toBeVisible();
  expect(
    await frame
      .locator("html")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  const controls = frame.locator(".compact-pagination");
  const box = await controls.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(48);
});

test("a failed next page keeps the current rows; retry repeats the exact cursor request", async ({
  page,
}) => {
  const { frame, reads, titles } = await paginatedCard(page, {
    size: 4,
    count: 5,
    failNext: true,
  });
  await frame.getByRole("button", { name: "Next task page" }).click();
  await expect(frame.getByRole("alert")).toContainText(
    "next page is temporarily unavailable",
  );
  await expect.poll(titles).toHaveLength(4);
  await expect(
    frame.getByRole("button", { name: "Previous task page" }),
  ).toBeDisabled();
  await frame
    .getByRole("button", { name: "Retry refresh", exact: true })
    .click();
  await expect(
    frame.getByRole("button", { name: "Details: Review item 5", exact: true }),
  ).toBeVisible();
  await expect.poll(titles).toEqual(["Review item 5"]);
  expect(reads).toHaveLength(2);
  expect(reads[0]).toEqual(reads[1]);
  await expect(
    frame.getByRole("button", { name: "Next task page" }),
  ).toBeDisabled();
  await frame
    .getByRole("button", { name: "Mark complete: Review item 5", exact: true })
    .click();
  await expect(
    frame.getByRole("button", { name: "Details: Review item 1", exact: true }),
  ).toBeVisible();
  await expect.poll(titles).toHaveLength(4);
  await expect(frame.getByRole("group", { name: "Task pages" })).toHaveCount(0);
});

test("small host pages retain their exact page size and terminate without an invented offset", async ({
  page,
}) => {
  const { frame, reads, titles } = await paginatedCard(page, {
    size: 1,
    count: 3,
  });
  await frame.getByRole("button", { name: "Next task page" }).click();
  await expect(
    frame.getByRole("button", { name: "Details: Review item 2", exact: true }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Next task page" }).click();
  await expect(
    frame.getByRole("button", { name: "Details: Review item 3", exact: true }),
  ).toBeVisible();
  expect(await titles()).toHaveLength(1);
  expect(reads.map((read) => read.cursor)).toEqual([
    "server-cursor-1",
    "server-cursor-2",
  ]);
  expect(
    reads.every((read) => read.offset === undefined && read.limit === 1),
  ).toBe(true);
  await expect(
    frame.getByRole("button", { name: "Next task page" }),
  ).toBeDisabled();
  await frame.getByRole("button", { name: "Previous task page" }).click();
  await expect(
    frame.getByRole("button", { name: "Details: Review item 2", exact: true }),
  ).toBeVisible();
  expect(reads).toHaveLength(2);
});

test.describe("narrow touch pagination", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const width of [320, 390])
    test(`four wrapped titles keep the footer reachable at ${width}px`, async ({
      page,
    }) => {
      const { frame } = await paginatedCard(page, { width, longTitles: true });
      await frame
        .getByRole("button", { name: "GTD navigation", exact: true })
        .click();
      await frame
        .getByRole("menuitemradio", { name: "All tasks", exact: true })
        .click();
      await expect(
        frame.getByRole("button", {
          name: "Back to previous view",
          exact: true,
        }),
      ).toBeVisible();
      await expect(frame.locator(".compact-row:visible")).toHaveCount(4);
      const footer = frame.getByRole("group", { name: "Task pages" });
      await expect(footer).toBeVisible();
      // Navigation now animates the card boundary; inspect final geometry.
      await expect.poll(() => frame.locator('.widget-surface').evaluate(el => ({
        animations: el.getAnimations().length,
        delta: Math.round(el.getBoundingClientRect().height - Math.min(450,
          el.querySelector('.widget-content')!.getBoundingClientRect().height + 2)),
      }))).toEqual({animations: 0, delta: 0}).catch(async error => {
        console.log('Unsettled surface', await frame.locator('.widget-surface').evaluate(el => ({
          height: el.getBoundingClientRect().height,
          natural: el.querySelector('.widget-content')!.getBoundingClientRect().height,
          style: el.getAttribute('style'),
          animations: el.getAnimations().map(a=>({state:a.playState,time:a.currentTime})),
        })));
        throw error;
      });
      const surface = (await frame.locator(".widget-surface").boundingBox())!;
      const footerBox = (await footer.boundingBox())!;
      expect(surface.height).toBeLessThanOrEqual(450);
      expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(
        surface.y + surface.height - 1,
      );
      await expect(
        frame.getByRole("button", { name: "Open full view", exact: true }),
      ).toHaveCount(0);
      for (const name of ["Previous task page", "Next task page"]) {
        const box = (await frame
          .getByRole("button", { name, exact: true })
          .boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(43.9);
        expect(box.height).toBeGreaterThanOrEqual(43.9);
      }
      expect(
        await frame
          .locator("html")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`touch-pagination-${width}.png`),
      });
      await frame.getByRole("button", { name: "Next task page" }).click();
      await expect(frame.locator(".compact-row:visible")).toHaveCount(3);
    });
});
