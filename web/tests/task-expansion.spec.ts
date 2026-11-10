import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

// The real host observes the DOM as well as processing explicit size hints.
// Test both together: hints alone missed the final-height/rewind flash.
for (const reduced of [false, true]) {
  test(`task details do not rewind at the conversation bottom (${reduced ? "reduced motion" : "animated"})`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    const html = await readFile(
      process.env.GTD_EXPANSION_FIXTURE || "dist/widget-adapter.html",
      "utf8",
    );
    await page.route("**/__task-expansion", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body style='margin:0'><div style='height:1200px'>Conversation</div></body>",
      }),
    );
    await page.goto("/__task-expansion");
    await page.evaluate(
      ({ html }) => {
        const frame = document.createElement("iframe");
        frame.style.cssText = "display:block;width:400px;height:60px;border:0";
        frame.setAttribute("sandbox", "allow-scripts");
        const task = {
          id: "expansion",
          title: "Prepare the workshop",
          status: "next",
          version: 1,
          archived: false,
          deleted: false,
          due_date: null,
          last_change_id: 1,
        };
        const result = (full: boolean) => ({
          items: [
            {
              ...task,
              ...(full
                ? {
                    notes:
                      "Review the brief, confirm the room and prepare the equipment.\nBring the checklist and leave time to test the presentation.\nCheck that the team has the latest agenda before beginning.",
                    links: [],
                    location: null,
                  }
                : {}),
            },
          ],
          history: [],
          next_offset: null,
          next_history_after: null,
        });
        (window as any).heights = [];
        (window as any).sample = true;
        const sample = () => {
          if (!(window as any).sample) return;
          const b = frame.getBoundingClientRect();
          (window as any).heights.push({ height: b.height, y: b.y });
          requestAnimationFrame(sample);
        };
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow) return;
          const m = event.data;
        // Simulate the app-only facade used by the authenticated adapter.
        if (m.method === "tools/call" && ["gtd_ui_read", "gtd_ui_write"].includes(m.params.name)) {
          m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
        }
          const send = (message: any) =>
            frame.contentWindow!.postMessage(
              { jsonrpc: "2.0", ...message },
              "*",
            );
          if (m.method === "ui/initialize")
            send({ id: m.id, result: { hostContext: { theme: "dark" } } });
          if (m.method === "ui/notifications/initialized") {
            send({
              method: "ui/notifications/tool-input",
              params: { arguments: { task_id: task.id } },
            });
            send({
              method: "ui/notifications/tool-result",
              params: { structuredContent: result(false) },
            });
          }
          if (m.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(m.params.name))
          m.params = {...m.params, name:m.params.arguments.operation, arguments:m.params.arguments.arguments};
        if (m.method === "tools/call" && ["view_snapshot","widget_pages"].includes(m.params.name)) {
          send({id:m.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (m.method === "tools/call")
            setTimeout(
              () =>
                send({ id: m.id, result: { structuredContent: result(true) } }),
              250,
            );
          if (
            m.method === "ui/notifications/size-changed" ||
            m.method === "fixture/auto-size"
          ) {
            frame.style.height = `${m.params.height}px`;
            window.scrollTo(0, document.body.scrollHeight);
          }
        });
        // Simulate the independent sandbox resize observer, before the app loads.
        const automatic =
          '<script>const surface=document.getElementById("root");new ResizeObserver(()=>parent.postMessage({method:"fixture/auto-size",params:{height:Math.ceil(surface.getBoundingClientRect().height)}},"*")).observe(surface);</script>';
        frame.srcdoc = html.replace(
          '<div id="root"></div>',
          '<div id="root"></div>' + automatic,
        );
        document.body.append(frame);
        requestAnimationFrame(sample);
      },
      { html },
    );
    // A conversation starts this card in view; offscreen cross-origin frames
    // can defer ResizeObserver delivery before their first visible frame.
    await page.locator("iframe").scrollIntoViewIfNeeded();
    const frame = page.frameLocator("iframe");
    const title = frame.getByRole("button", {
      name: "Details: Prepare the workshop",
      exact: true,
    });
    await expect(title).toBeVisible();
    const initial = Math.ceil(
      await frame
        .locator("#root")
        .evaluate((e) => e.getBoundingClientRect().height),
    );
    // Begin after the host accepts the initial surface measurement, rather than
    // including its placeholder iframe height in the user interaction trace.
    await expect
      .poll(() =>
        page
          .locator("iframe")
          .evaluate((e) => e.getBoundingClientRect().height),
      )
      .toBe(initial);
    async function start() {
      await page.evaluate(() => {
        (window as any).heights = [];
      });
    }
    async function verify(growing: boolean) {
      await page.waitForTimeout(700);
      const samples: { height: number; y: number }[] = await page.evaluate(
        () => (window as any).heights,
      );
      const heights = samples.map((s) => s.height);
      for (let i = 1; i < heights.length; i++)
        expect(
          growing ? heights[i] - heights[i - 1] : heights[i - 1] - heights[i],
          JSON.stringify(heights),
        ).toBeGreaterThanOrEqual(-1);
      const unique = [...new Set(heights)];
      if (!reduced) expect(unique.length).toBeGreaterThan(4);
      expect(
        samples.every((s) => Math.abs(s.y + s.height - 1000) < 2),
      ).toBeTruthy();
    }
    // First open includes delayed full data; then close and reopen cached data.
    await start();
    await title.click();
    await verify(true);
    await expect(frame.getByText(/Review the brief, confirm/)).toBeVisible();
    await start();
    await title.click();
    await verify(false);
    expect(
      await page
        .locator("iframe")
        .evaluate((e) => e.getBoundingClientRect().height),
    ).toBe(initial);
    await expect(
      frame.getByRole("button", { name: "Edit", exact: true }),
    ).toBeHidden();
    await start();
    await title.click();
    await verify(true);
    // Reversing an unfinished disclosure must settle without a stale callback.
    await title.click();
    await page.waitForTimeout(40);
    await title.click();
    await page.waitForTimeout(400);
    await expect(title).toHaveAttribute("aria-expanded", "true");
    expect(
      await frame.locator(".compact-task > .task-expansion").getAttribute("data-resizing"),
    ).toBeNull();
    const height = await page
      .locator("iframe")
      .evaluate((e) => e.getBoundingClientRect().height);
    expect(height).toBe(
      Math.ceil(
        await frame
          .locator("body")
          .evaluate((e) => e.getBoundingClientRect().height),
      ),
    );
  });
}
