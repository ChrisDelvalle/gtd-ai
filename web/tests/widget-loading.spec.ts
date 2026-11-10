import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

type Profile = { delay: number; bytesPerSecond: number };
type Options = {
  profile: Profile; descriptions: number; seed?: boolean; legacy?: boolean; empty?: boolean;
  reuseNotes?: boolean; gzip?: boolean; longNotes?: boolean;
  chartGaps?: boolean; sparseChart?: boolean; rejectSparse?: boolean;
  bundle?: "requested" | "full" | "deferred" | "nearby" | "summaries";
  launch?: "home" | "tasks" | "charts";
  backgroundFails?: boolean;
};
const title = (n: number) => `Benchmark task ${n}`;

async function card(page: Page, html: string, options: Options) {
  await page.route("**/__widget_loading", (r) => r.fulfill({
    contentType: "text/html", body: "<main></main>",
  }));
  await page.goto("/__widget_loading");
  await page.evaluate(({ html, options }) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.style.cssText = "width:900px;height:750px;border:0";
    const account = {
      "gtd/accountId": "00000000-0000-4000-8000-000000000042",
      "gtd/timezone": "America/New_York", "gtd/environment": "staging",
    };
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const wire: { name: string; view?: string; kind?: string; sent: number; received: number; delta?: number; delivered?: boolean }[] = [];
    const bases = new Map<string, any>();
    const noteBases = new Map<string, Map<string, string>>();
    let revision = 0;
    let failNext = false;
    let held: (() => void)[] | null = null;
    const tasks = Array.from({ length: options.empty ? 0 : 7 }, (_, i) => ({
      id: `loading-task-${i + 1}`, entity_type: "task", title: `Benchmark task ${i + 1}`,
      brief: "Inspect and organize the fixture record.", status: "next",
      version: 1, importance: "normal", estimated_minutes: 30, effort: "low",
      archived: false, deleted: false, has_notes: true, last_change_id: i + 1,
      notes: `Fixture description ${i + 1}\n\n` + (options.longNotes
        ? Array.from({ length: 40 }, (_, line) => `Checkpoint ${i + line}. Confirm the booking and verify the expected arrival window. Track ${(i + line + 3) * 2654435761 % 1000003} with the coordinator.`).join("\n\n")
        : "Supporting detail. ".repeat(130)),
    }));
    const list = (items: unknown[]) => ({
      items, history: [], next_cursor: null, next_offset: null, complete: true,
    });
    const summaries = (descriptionCount: number, optimized = true) => tasks.filter((task) => task.status === "next").map((task, i) => {
      const displayed = optimized ? { ...task, blocking_count: 0 } : task;
      if (i < descriptionCount) return displayed;
      const { notes: _, ...summary } = displayed;
      return summary;
    });
    const home = () => ({
      next: list(summaries(options.descriptions)), waiting: list([]), someday: list([]),
      reviewTasks: list([]), reviewProjects: { projects: [], next_cursor: null }, remaining: null,
    });
    const summary = (args: { from: string; through: string; metric: string }) => {
      const days = [];
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      for (const day = new Date(`${args.from}T12:00:00Z`);
        day.toISOString().slice(0, 10) <= args.through;
        day.setUTCDate(day.getUTCDate() + 1)) {
        const date = day.toISOString().slice(0, 10);
        const future = options.chartGaps && date > today;
        const event = !options.chartGaps || (!future && day.getUTCDate() === 15);
        days.push({ date, count: future ? null : event ? 8 : 0, categories: event ? { completed: 4, added: 4 } : {},
          future: !!future, partial: !!options.chartGaps && date === today });
      }
      return {
        days, categories: { completed: 4 * days.length, added: 4 * days.length },
        snapshot: `fixture:${args.from}:${args.through}`, has_history: true, automatic_count: 0,
        metric: args.metric, window: { timezone: "America/New_York" },
      };
    };
    const launchBundle = (includeHome: boolean, includeTabs: boolean, deferred: boolean,
        coverage: "full" | "nearby" | "summaries" = "full") => {
      const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const evaluatedAt = new Date().toISOString();
      const records = tasks.map((task, i) => ({
        ...task,
        ...(i === 0 ? { project_id: "fixture-project", blocked_by: ["fixture-blocker"], blocking_count: 1 } : {}),
        widget_preview: i === 0 ? {
          project_title: "Bundled project", more: false,
          prerequisites: [{ id: "fixture-blocker", title: "Bundled prerequisite", status: "done" }],
          dependents: [{ id: "fixture-dependent", title: "Bundled dependent", status: "blocked" }],
        } : { project_title: null, more: false, prerequisites: [], dependents: [] },
      }));
      const refs = records.map((_, i) => ({ref:i,context:{blocking_count:i === 0 ? 1 : 0}}));
      const launchArgs = { status: "next", group_recurrences: true };
      const pages = [];
      if (includeHome && options.launch !== "tasks" && options.launch !== "charts")
        pages.push({ operation: "home", arguments: {view: "home", review_on: day, loading: "top-three"},
          data: {...home(), next: list(refs)} });
      if (includeTabs || options.launch === "tasks")
        pages.push({ operation: "list_items", arguments: launchArgs, data: list(refs) });
      if (options.launch === "charts") {
        const through = new Date(day + "T12:00:00Z");
        through.setUTCDate(through.getUTCDate() + 6 - through.getUTCDay());
        const from = new Date(through);
        from.setUTCDate(from.getUTCDate() - 363);
        const args = {from:from.toISOString().slice(0,10),through:through.toISOString().slice(0,10),metric:"changes"};
        pages.push({operation:"activity_summary", arguments:args, data:summary(args)});
      }
      if (includeTabs) {
        for (const status of coverage === "nearby" ? ["blocked"] : ["blocked","waiting","inbox","someday","done"]) {
          const rows = Array.from({length: 20}, (_, i) => ({
            ...records[0], id: `${status}-${i}`, title: `Bundled ${status} task ${i+1}`,
            status, notes: `${status === "blocked" ? "Blocked" : status} details ${i+1}.`.repeat(100),
            project_id: null, blocked_by: [], blocking_count: 0,
            widget_preview: {project_title: null, more: false, prerequisites: [], dependents: []},
          }));
          const summaries = coverage === "summaries";
          pages.push({operation:"list_items", arguments:{status,group_recurrences:true}, summaries,
            data:list(summaries ? rows.map(({notes:_,widget_preview:__,...row})=>row)
              : rows.map((_,i)=>records.length+i))});
          if (!summaries) records.push(...rows);
        }
      }
      return {version: 1, account: account["gtd/accountId"], environment: "staging", timezone: "America/New_York",
        revision, evaluated_at: evaluatedAt, deferred, revalidate: false, pages, records};
    };
    const send = (value: object) =>
      frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...value }, "*");
    (window as any).gtdLoading = {
      wire,
      hold() { held = []; },
      releaseNewest() { held?.pop()?.(); },
      release() { const callbacks = held || []; held = null; callbacks.forEach((cb) => cb()); },
      fail() { failNext = true; },
      update(count: number) {
        revision++;
        tasks.slice(0, count).forEach((task) => {
          task.title += " updated";
          task.version++;
        });
        if (count > 1) tasks.reverse();
      },
      clearNotes() {
        revision++;
        tasks[0].version++;
        tasks[0].title += " cleared";
        tasks[0].notes = "";
      },
    };
    const hostContext = { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { width: 900, maxHeight: 750 }, theme: "light" };
    window.addEventListener("message", async (event) => {
      if (event.source !== frame.contentWindow) return;
      const m = event.data;
        // Simulate the app-only facade used by the authenticated adapter.
        if (m.method === "tools/call" && ["gtd_ui_read", "gtd_ui_write"].includes(m.params.name)) {
          m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
        }
      if (m.method === "ui/initialize") send({ id: m.id, result: { hostContext } });
      if (m.method === "ui/notifications/initialized") {
        const seed = options.seed ? { "gtd/homeSnapshot": {
          kind: "full", token: "fixture-home-0", data: home(),
          review_on: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
        } } : {};
        const result = { method: "ui/notifications/tool-result", params: {
          structuredContent: options.launch === "tasks" ? {...list(tasks), environment: "staging"}
            : { app: "gtd", view: options.launch || "home", environment: "staging" },
          _meta: { ...account, ...seed, ...(options.bundle ? {"gtd/widgetBundle":
            launchBundle(true, options.bundle !== "requested" && options.bundle !== "deferred",
              options.bundle !== "requested" && options.bundle !== "full",
              options.bundle === "nearby" || options.bundle === "summaries" ? options.bundle : "full")} : {}) },
        } };
        if (options.bundle) (window as any).gtdLoading.launchBytes = encode(result);
        setTimeout(() => send(result), (options.bundle ? options.profile.delay : 0) + encode(result) / options.profile.bytesPerSecond * 1000);
      }
      if (m.method !== "tools/call") return;
      const { operation: name, arguments: args } = m.params.arguments;
      const view = args.query?.view;
      let data: any;
      let isError = failNext;
      failNext = false;
      if (isError) data = { code: "storage_error", message: "Fixture refresh failed." };
      else if (name === "widget_pages") {
        if (options.backgroundFails && !args.target) {
          isError = true;
          data = {code: "storage_error", message: "Disposable background failure"};
        } else {
          data = launchBundle(!args.exclude, !args.target, false);
          if (args.target?.operation === "list_items") {
            data = launchBundle(false, true, false);
            if (args.target.arguments.task_id) {
              const index = data.records.findIndex((row: any) => row.id === args.target.arguments.task_id);
              data.pages = [{operation:"list_items",arguments:args.target.arguments,data:list(index === -1 ? [] : [index])}];
            } else {
              data.pages = data.pages.filter((page: any) => page.arguments.status === args.target.arguments.status);
            }
          }
        }
      }
      else if (name === "view_snapshot") {
        if (options.legacy) {
          isError = true;
          data = { code: "invalid_arguments", message: "Unsupported UI operation" };
        } else if (options.rejectSparse && args.sparse_chart) {
          isError = true;
          data = { code: "invalid_arguments", message: "Arguments do not match this operation's schema; check fields and types" };
        } else {
          const token = `fixture-${view}-${revision}`;
          data = args.token === token ? { kind: "unchanged", token } : {
            kind: "full", token,
            data: view === "home" ? home() : view === "charts" ? summary(args.query.arguments) : list(summaries(0)),
          };
          if (options.reuseNotes && view === "home" && data.kind === "full") {
            data.home_notes_reusable = true;
            const previous = args.reuse_home_notes ? noteBases.get(args.token) : undefined;
            const current = new Map<string, string>();
            const reused = [];
            for (const row of data.data.next.items.slice(0, 3)) {
              if (typeof row.notes !== "string" || row.notes.length < 256) continue;
              current.set(row.id, row.notes);
              if (previous?.get(row.id) === row.notes) {
                reused.push(row.id);
                delete row.notes;
              }
            }
            noteBases.set(token, current);
            if (reused.length) data.reused_home_notes = reused;
          }
          if (options.sparseChart && args.sparse_chart && data.kind === "full" && view === "charts") {
            data.data.days = data.data.days.filter((day: any) => day.count > 0 || day.partial);
            data.chart_today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
          }
        }
      } else if (name === "list_items") {
        data = args.task_id ? list(tasks.filter((task) => task.id === args.task_id))
          : list(!args.review_on && !args.blocked_by_id && (!args.status || args.status === "next") ? summaries(0, false) : []);
      } else if (name === "list_projects") data = { projects: [], next_cursor: null };
      else if (name === "activity_summary") data = summary(args);
      else if (name === "update_item") {
        const before = tasks.find((task) => task.id === args.task_id)!;
        const after = { ...before, ...args, version: before.version + 1, last_change_id: 30 };
        Object.assign(before, after);
        revision++;
        data = { task: after, change: { id: 30, task_id: after.id, operation: "update", reason: args.reason, after }, replayed: false };
      } else data = { changes: [], next_cursor: null };
      const result = structuredClone({ structuredContent: { ...data, environment: "staging" }, _meta: account, isError });
      // Measure a lossless projection delta without adding a second production
      // protocol. New order and cursors are always supplied by the server.
      let delta: number | undefined;
      if (data.kind === "full" && (view === "home" || view === "tasks")) {
        const key = JSON.stringify(args.query);
        const previous = bases.get(key);
        if (previous) {
          const sections = view === "home" ? ["next", "waiting", "someday", "reviewTasks", "reviewProjects"] : ["tasks"];
          const changes: Record<string, unknown> = {};
          for (const section of sections) {
            const field = section === "reviewProjects" ? "projects" : "items";
            const { [field]: current, ...meta } = section === "tasks" ? data.data : data.data[section];
            const old = section === "tasks" ? previous[field] : previous[section][field];
            const byId = new Map(old.map((record: any) => [record.id, record]));
            const upserts = current.filter((record: any) => JSON.stringify(record) !== JSON.stringify(byId.get(record.id)));
            const order = current.map((record: any) => record.id);
            for (const record of upserts) byId.set(record.id, record);
            if (JSON.stringify(order.map((id: string) => byId.get(id))) !== JSON.stringify(current))
              throw Error("Fixture delta did not reconstruct the full list");
            changes[section] = { meta, order, upserts };
          }
          delta = encode({ ...result, structuredContent: {
            kind: "delta", token: data.token, remaining: data.data.remaining, changes,
          } });
        }
        bases.set(key, structuredClone(data.data));
      }
      const compressedSize = async (value: unknown) => new Response(
        new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer().then((buffer) => buffer.byteLength);
      const sample = { name, view, kind: data.kind, sent: encode(m), received: encode(result), delta, delivered: false,
        reused: data.reused_home_notes?.length ?? 0,
        transfer: options.gzip ? (await compressedSize(m)) + (await compressedSize(result)) : encode(m) + encode(result),
      };
      wire.push(sample);
      const sendResponse = () => setTimeout(() => {
        send({ id: m.id, result });
        sample.delivered = true;
      },
        options.profile.delay + sample.transfer / options.profile.bytesPerSecond * 1000);
      if (held) held.push(sendResponse);
      else sendResponse();
    });
    frame.srcdoc = html.replace("<html", '<html data-account-required="true"');
    document.querySelector("main")!.append(frame);
  }, { html, options });
  const frame = page.frameLocator("iframe");
  return {
    frame,
    wire: () => page.evaluate(() => (window as any).gtdLoading.wire as {
      name: string; view?: string; kind?: string; sent: number; received: number; delta?: number; delivered?: boolean;
      reused: number; transfer: number;
    }[]),
    refresh: () => frame.locator("body").evaluate(() => { window.dispatchEvent(new Event("gtd:changed")); }),
  };
}

async function navigate(frame: FrameLocator, label: string) {
  await frame.getByRole("button", { name: "GTD navigation" }).click();
  await frame.getByRole("menuitemradio", { name: label, exact: true }).click();
}

async function switchChart(frame: FrameLocator, label: string) {
  await frame.getByRole("button", { name: /^Chart: / }).click();
  await frame.getByRole("menuitemradio", { name: label, exact: true }).click();
}

const currentHtml = () => readFile("dist/widget-adapter.html", "utf8");

test("one Home read and quiet unchanged, changed, and failed refreshes", async ({ page }) => {
  const { frame, wire, refresh } = await card(page, await currentHtml(), {
    profile: { delay: 5, bytesPerSecond: 625_000 }, descriptions: 3,
  });
  const first = frame.getByRole("button", { name: `Details: ${title(1)}`, exact: true });
  await expect(first).toBeVisible();
  expect((await wire()).map(({ name, view }) => [name, view])).toEqual([["view_snapshot", "home"]]);
  await first.click();
  await expect(frame.getByText("Fixture description 1", { exact: true })).toBeVisible();
  expect(await wire()).toHaveLength(1);
  await page.evaluate(() => (window as any).gtdLoading.hold());
  await refresh();
  await expect.poll(async () => (await wire()).at(-1)?.kind).toBe("unchanged");
  await expect(frame.getByText("Fixture description 1", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).gtdLoading.update(1));
  await refresh();
  await expect.poll(async () => (await wire()).at(-1)?.kind).toBe("full");
  await page.evaluate(() => (window as any).gtdLoading.releaseNewest());
  await expect(frame.getByRole("button", { name: `Details: ${title(1)} updated`, exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).gtdLoading.release());
  await expect.poll(async () => (await wire()).every(r => r.delivered)).toBe(true);
  await expect(first).toHaveCount(0);
  await page.evaluate(() => (window as any).gtdLoading.fail());
  await refresh();
  await expect(frame.getByRole("button", { name: "View connection problem" })).toBeVisible();
  await expect(frame.getByText("Fixture description 1", { exact: true })).toBeVisible();
});

test("Home seed, chart switches and warm return reuse the mounted widget", async ({ page }) => {
  const { frame, wire } = await card(page, await currentHtml(), {
    profile: { delay: 5, bytesPerSecond: 625_000 }, descriptions: 1, seed: true,
  });
  await expect(frame.getByRole("button", { name: `Details: ${title(1)}`, exact: true })).toBeVisible();
  expect(await wire()).toHaveLength(0);
  await navigate(frame, "Charts");
  await expect(frame.locator(".heat-grid")).toBeVisible();
  await switchChart(frame, "Bar Chart");
  await expect(frame.locator(".bar-column")).toHaveCount(30);
  await frame.getByRole("button", { name: "7d", exact: true }).click();
  await expect(frame.locator(".bar-column")).toHaveCount(7);
  await switchChart(frame, "Heatmap");
  await navigate(frame, "Home");
  await expect(frame.getByRole("button", { name: `Details: ${title(1)}`, exact: true })).toBeVisible();
  expect((await wire()).map(({ name, view }) => [name, view])).toEqual([["view_snapshot", "charts"]]);
  expect(await page.locator("iframe").count()).toBe(1);
});

test("empty Home takes one call and older servers can still load Home", async ({ page }) => {
  const html = await currentHtml();
  const profile = { delay: 5, bytesPerSecond: 625_000 };
  const empty = await card(page, html, { profile, descriptions: 3, empty: true });
  await expect(empty.frame.getByText("No tasks to show.", { exact: true })).toBeVisible();
  expect(await empty.wire()).toHaveLength(1);
  const legacy = await card(page, html, { profile, descriptions: 0, legacy: true });
  await expect(legacy.frame.getByRole("button", { name: `Details: ${title(1)}`, exact: true })).toBeVisible();
  expect((await legacy.wire()).map(x => x.name)).toEqual([
    "view_snapshot", "list_items", "list_items", "list_items", "list_items", "list_projects",
  ]);
});

test("warm Next reuses its first page and the delta pilot preserves order", async ({ page }) => {
  const { frame, wire, refresh } = await card(page, await currentHtml(), {
    profile: { delay: 5, bytesPerSecond: 625_000 }, descriptions: 3, seed: true,
  });
  const row = (n: number, suffix = "") =>
    frame.getByRole("button", { name: `Details: ${title(n)}${suffix}`, exact: true });
  await expect(row(1)).toBeVisible();
  await navigate(frame, "Next");
  await expect(row(1)).toBeVisible();
  await navigate(frame, "Home");
  await navigate(frame, "Next");
  await expect(row(1)).toBeVisible();
  expect((await wire()).map(({ view, kind }) => [view, kind])).toEqual([["tasks", "full"]]);
  await refresh();
  await expect.poll(async () => (await wire()).at(-1)?.kind).toBe("unchanged");
  await page.evaluate(() => (window as any).gtdLoading.update(1));
  await refresh();
  await expect(row(1, " updated")).toBeVisible();
  const edited = (await wire()).at(-1)!;
  expect(edited.view).toBe("tasks");
  expect(edited.delta).toBeDefined();
  expect(edited.received - edited.delta!).toBeLessThan(10 * 1024);
  await page.evaluate(() => (window as any).gtdLoading.update(7));
  await refresh();
  await expect(row(7, " updated")).toBeVisible();
  const reordered = (await wire()).at(-1)!;
  expect(reordered.view).toBe("tasks");
  expect(reordered.delta).toBeDefined();
  expect(reordered.received - reordered.delta!).toBeLessThan(10 * 1024);
});

test("Home reuses identical notes across versions and honors a later clear", async ({ page }) => {
  const { frame, wire, refresh } = await card(page, await currentHtml(), {
    profile: { delay: 5, bytesPerSecond: 625_000 }, descriptions: 3, reuseNotes: true,
  });
  const row = (suffix = "") => frame.getByRole("button", { name: `Details: ${title(1)}${suffix}`, exact: true });
  await expect(row()).toBeVisible();
  await page.evaluate(() => (window as any).gtdLoading.update(1));
  await refresh();
  await row(" updated").click();
  await expect(frame.getByText("Fixture description 1", { exact: true })).toBeVisible();
  expect((await wire()).map((x) => [x.view, x.reused])).toEqual([["home", 0], ["home", 3]]);
  await page.evaluate(() => (window as any).gtdLoading.clearNotes());
  await refresh();
  await expect(row(" updated cleared")).toBeVisible();
  await expect(frame.getByText("Fixture description 1", { exact: true })).toHaveCount(0);
  expect((await wire()).at(-1)?.reused).toBe(2);
});

test("chart gaps restore the calendar and old schemas get a full chart", async ({ page }) => {
  const html = await currentHtml();
  const profile = { delay: 5, bytesPerSecond: 625_000 };
  const expected = [];
  for (const sparseChart of [true, false]) {
    const { frame, wire } = await card(page, html, {
      profile, descriptions: 3, seed: true, chartGaps: true, sparseChart, rejectSparse: !sparseChart,
    });
    await navigate(frame, "Charts");
    const days = frame.locator(".heat-grid button");
    await expect(days).toHaveCount(364);
    expected.push(await days.evaluateAll((rows) => rows.map((row) => [
      row.getAttribute("aria-label"), row.hasAttribute("disabled"),
    ])));
    await switchChart(frame, "Bar Chart");
    await expect(frame.locator(".bar-column")).toHaveCount(30);
    expect((await wire()).filter((call) => call.view === "charts")).toHaveLength(sparseChart ? 1 : 2);
  }
  expect(expected[0]).toEqual(expected[1]);
});

test("manual compact year chart comparison", async ({ browser }) => {
  test.skip(process.env.GTD_CHART_SPARSE_BENCH !== "1", "Manual browser timing on disposable data.");
  test.setTimeout(180_000);
  const html = await currentHtml();
  const samples = [];
  for (const gzip of [false, true]) for (let pair = 0; pair < 12; pair++) {
    for (const sparseChart of pair % 2 ? [true, false] : [false, true]) {
      const page = await browser.newPage();
      try {
        const { frame, wire } = await card(page, html, {
          profile: { delay: 250, bytesPerSecond: 125_000 }, descriptions: 3, seed: true, chartGaps: true, sparseChart, gzip,
        });
        await frame.getByRole("button", { name: "GTD navigation" }).click();
        const elapsed = await frame.getByRole("menuitemradio", { name: "Charts", exact: true }).evaluate(async (item) => {
          const start = performance.now();
          (item as HTMLButtonElement).click();
          while (document.querySelectorAll(".heat-grid button").length !== 364) {
            if (performance.now() - start > 5000) throw Error("Chart fixture did not render");
            await new Promise(requestAnimationFrame);
          }
          return performance.now() - start;
        });
        const response = (await wire()).at(-1)!;
        expect(response.view).toBe("charts");
        samples.push({pair,gzip,sparseChart,elapsed,transfer:response.transfer});
      } finally { await page.close(); }
    }
  }
  console.log("GTD_SPARSE_CHART=" + JSON.stringify(samples));
});

for (const gzip of [false, true]) {
  test(`manual Home note reuse comparison ${gzip ? "gzip" : "raw"}`, async ({ browser }) => {
    test.skip(process.env.GTD_HOME_NOTES_BENCH !== "1", "Manual browser timing on disposable data.");
    test.setTimeout(180_000);
    const html = await currentHtml();
    const samples = [];
    for (let pair = 0; pair < 20; pair++) {
      for (const reuseNotes of pair % 2 ? [true, false] : [false, true]) {
        const page = await browser.newPage();
        try {
          const { frame, wire } = await card(page, html, {
            profile: { delay: 250, bytesPerSecond: 125_000 }, descriptions: 3, reuseNotes, longNotes: true, gzip,
          });
          await expect(frame.getByRole("button", { name: `Details: ${title(1)}`, exact: true })).toBeVisible();
          await page.evaluate(() => (window as any).gtdLoading.update(1));
          const elapsed = await frame.locator("body").evaluate(async () => {
            const start = performance.now();
            window.dispatchEvent(new Event("gtd:changed"));
            while (!document.querySelector('button[aria-label="Details: Benchmark task 1 updated"]')) {
              if (performance.now() - start > 5000) throw Error("Home fixture did not refresh");
              await new Promise(requestAnimationFrame);
            }
            return performance.now() - start;
          });
          const response = (await wire()).at(-1)!;
          expect(response.reused).toBe(reuseNotes ? 3 : 0);
          samples.push({pair,reuseNotes,elapsed,transfer:response.transfer});
        } finally { await page.close(); }
      }
    }
    console.log("GTD_HOME_NOTES=" + JSON.stringify({gzip,samples}));
  });
}

async function measureInteractions(frame: FrameLocator) {
  // Measure inside the browser so locator polling and auto-scrolling do not
  // dominate the elapsed time of a local chart switch.
  return frame.locator("body").evaluate(async () => {
    async function until<T>(read: () => T | null | false): Promise<T> {
      const deadline = performance.now() + 12_000;
      for (;;) {
        const value = read();
        if (value !== null && value !== false) return value;
        if (performance.now() >= deadline) throw Error("Fixture interaction did not settle");
        await new Promise(requestAnimationFrame);
      }
    }
    function button(label: string) {
      return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    }
    async function choose(label: string) {
      const item = await until(() => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        .find(element => element.textContent?.trim() === label) || null);
      item.click();
    }
    let details = 0;
    for (const n of [1, 2, 3, 1]) {
      const row = await until(() => button(`Details: Benchmark task ${n}`));
      const started = performance.now();
      row.click();
      await until(() => [...document.querySelectorAll(".task-context-content p")]
        .some(element => element.textContent === `Fixture description ${n}`));
      details += performance.now() - started;
      row.click();
    }
    (await until(() => button("GTD navigation"))).click();
    await choose("Charts");
    await until(() => document.querySelector(".heat-grid"));
    const switchStart = performance.now();
    (await until(() => document.querySelector<HTMLButtonElement>('button[aria-label^="Chart: "]'))).click();
    await choose("Bar Chart");
    await until(() => document.querySelectorAll(".bar-column").length === 30);
    const chartSwitch = performance.now() - switchStart;
    (await until(() => button("GTD navigation"))).click();
    await choose("Home");
    const complete = await until(() => button("Mark complete: Benchmark task 1"));
    const beforeSave = performance.now();
    complete.click();
    await until(() => !button("Details: Benchmark task 1"));
    return { details, chartSwitch, save: performance.now() - beforeSave };
  });
}

const profiles: Profile[] = [
  { delay: 0, bytesPerSecond: 625_000 },
  { delay: 250, bytesPerSecond: 625_000 },
  { delay: 750, bytesPerSecond: 625_000 },
  { delay: 750, bytesPerSecond: 125_000 },
];
for (const profile of profiles) {
  test(`manual packaged widget measurement ${profile.delay}ms ${profile.bytesPerSecond} B/s`, async ({ browser }) => {
    test.skip(process.env.GTD_WIDGET_LOADING_BENCH !== "1", "Manual, disposable performance measurements.");
    test.setTimeout(1_200_000);
    const baseline = await readFile(process.env.GTD_WIDGET_BASELINE!, "utf8");
    const candidate = process.env.GTD_WIDGET_CANDIDATE
      ? await readFile(process.env.GTD_WIDGET_CANDIDATE, "utf8")
      : await currentHtml();
    const samples = [];
    const pairs = Number(process.env.GTD_WIDGET_BENCH_PAIRS || 20);
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw new Error("Expected 1–20 benchmark pairs");
    for (let pair = 0; pair < pairs; pair++) {
      for (const optimized of pair % 2 ? [true, false] : [false, true]) {
        const page = await browser.newPage({ viewport: { width: 1120, height: 950 } });
        try {
          const start = performance.now();
          const { frame, wire, refresh } = await card(page, optimized ? candidate : baseline, {
            profile, descriptions: optimized ? [0, 1, 3][pair % 3] : 0,
            seed: optimized && pair % 2 === 0,
          });
          const row = (n: number) => frame.getByRole("button", { name: `Details: ${title(n)}`, exact: true });
          await row(1).waitFor();
          const home = performance.now() - start;
          const homeWire = await wire();
          const { details, chartSwitch, save } = await measureInteractions(frame);
          // Let the mutation's own revalidation finish before measuring a
          // separate refresh. Otherwise the published card can join that
          // request and legitimately produce no new wire call.
          await expect.poll(async () => {
            const requests = await wire();
            const write = requests.findIndex(request => request.name === "update_item");
            const reads = write < 0 ? [] : requests.slice(write + 1);
            return reads.length > 0 && reads.every(request => request.delivered);
          }, { intervals: [10, 20, 30], timeout: 15_000 }).toBe(true);
          const refreshes: number[] = [];
          for (const count of [0, 1, 7]) {
            if (count) await page.evaluate(n => (window as any).gtdLoading.update(n), count);
            const before = (await wire()).length;
            const began = performance.now();
            await refresh();
            await expect.poll(async () => {
              const requests = (await wire()).slice(before);
              return requests.length > 0 && requests.every(request => request.delivered);
            }, { intervals: [10, 20, 30], timeout: 15_000 }).toBe(true);
            refreshes.push(performance.now() - began);
          }
          const calls = await wire();
          samples.push({ optimized, pair, home, details, chartSwitch, homeWire, calls, refreshes, save,
            heap: await frame.locator("body").evaluate(() =>
              (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null) });
        } finally { await page.close(); }
      }
    }
    console.log("GTD_WIDGET_LOADING=" + JSON.stringify({ profile, samples }));
  });
}

test("requested Home shows human detail and both dependency previews with no additional call", async ({page}) => {
  const {frame, wire} = await card(page, await currentHtml(), {
    bundle: "requested", descriptions: 0, profile: {delay: 10, bytesPerSecond: 10_000_000},
  });
  const open = frame.getByRole("button", {name: `Details: ${title(1)}`, exact: true});
  await open.click();
  await expect(frame.getByText(/Fixture description 1/)).toBeVisible();
  await expect(frame.locator(".dependency-link").filter({hasText: "Bundled prerequisite"})).toBeVisible();
  await expect(frame.locator(".dependency-link").filter({hasText: "Bundled dependent"})).toBeVisible();
  await expect(frame.getByRole("button", {name: "Bundled project", exact: true}).first()).toBeVisible();
  await open.click();
  expect(await wire()).toEqual([]);
});

test("requested list and a fully bundled Blocked view open task bodies without reads", async ({page}) => {
  const {frame, wire} = await card(page, await currentHtml(), {
    bundle: "full", launch: "tasks", descriptions: 0, profile: {delay: 10, bytesPerSecond: 10_000_000},
  });
  await frame.getByRole("button", {name: `Details: ${title(2)}`, exact: true}).click();
  await expect(frame.getByText(/Fixture description 2/)).toBeVisible();
  await navigate(frame, "Blocked");
  await frame.getByRole("button", {name: "Details: Bundled blocked task 1", exact: true}).click();
  await expect(frame.getByText(/Blocked details 1/)).toBeVisible();
  expect(await wire()).toEqual([]);
});

test("deferred bundle shares a pending tab read and leaves the requested page usable", async ({page}) => {
  const {frame, wire} = await card(page, await currentHtml(), {
    bundle: "deferred", descriptions: 0, profile: {delay: 200, bytesPerSecond: 10_000_000},
  });
  await frame.getByRole("button", {name: `Details: ${title(1)}`, exact: true}).click();
  await expect(frame.getByText(/Fixture description 1/)).toBeVisible();
  await navigate(frame, "Blocked");
  await frame.getByRole("button", {name: "Details: Bundled blocked task 1", exact: true}).click();
  await expect(frame.getByText(/Blocked details 1/)).toBeVisible();
  expect((await wire()).map(call => call.name)).toEqual(["widget_pages"]);
});

for (const rollover of [false, true]) test(`a deferred card refreshes its saved tabs quietly after ${rollover ? "the local date changes" : "idle expiry"}`, async ({page}) => {
  const now = new Date(rollover ? "2026-11-05T04:59:45Z" : "2026-11-04T20:00:00Z");
  await page.clock.setFixedTime(now);
  const {frame, wire} = await card(page, await currentHtml(), {
    bundle: "deferred", descriptions: 0, profile: {delay: 10, bytesPerSecond: 10_000_000},
  });
  const original = frame.getByRole("button", {name: `Details: ${title(1)}`, exact: true});
  await expect(original).toBeVisible();
  await expect.poll(async () => (await wire()).at(0)?.delivered).toBe(true);
  await page.evaluate(() => {
    (window as any).gtdLoading.hold();
    (window as any).gtdLoading.update(1);
  });
  await page.clock.setFixedTime(new Date(now.getTime() + 31_000));
  await frame.locator("body").evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(async () => (await wire()).length).toBe(2);
  await expect(original).toBeVisible();

  // Even a tab the user hasn't opened can render and expand saved rows.
  await navigate(frame, "Blocked");
  await frame.getByRole("button", {name: "Details: Bundled blocked task 1", exact: true}).click();
  await expect(frame.getByText(/Blocked details 1/)).toBeVisible();
  await navigate(frame, "Next");
  await expect(original).toBeVisible();
  expect((await wire()).map(call => [call.name, call.delivered])).toEqual([
    ["widget_pages", true], ["widget_pages", false],
  ]);
  await page.evaluate(() => (window as any).gtdLoading.release());
  await expect(frame.getByRole("button", {name: `Details: ${title(1)} updated`, exact: true})).toBeVisible();
  await navigate(frame, "Waiting");
  await expect(frame.getByRole("button", {name: "Details: Bundled waiting task 1", exact: true})).toBeVisible();
  expect(await wire()).toHaveLength(2);
});

test("a failed idle bundle leaves saved tabs usable while a page refreshes on demand", async ({page}) => {
  const now = new Date("2026-11-04T20:00:00Z");
  await page.clock.setFixedTime(now);
  const {frame, wire} = await card(page, await currentHtml(), {
    bundle: "full", descriptions: 0, profile: {delay: 10, bytesPerSecond: 10_000_000},
  });
  const original = frame.getByRole("button", {name: `Details: ${title(1)}`, exact: true});
  await expect(original).toBeVisible();
  await page.evaluate(() => {
    (window as any).gtdLoading.update(1);
    (window as any).gtdLoading.fail();
  });
  await page.clock.setFixedTime(new Date(now.getTime() + 31_000));
  await frame.locator("body").evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(async () => (await wire()).at(0)?.delivered).toBe(true);
  await page.evaluate(() => (window as any).gtdLoading.hold());
  await navigate(frame, "Next");
  await expect(original).toBeVisible();
  await expect.poll(async () => (await wire()).length).toBe(2);
  expect((await wire()).at(1)?.delivered).toBe(false);
  await page.evaluate(() => (window as any).gtdLoading.release());
  await expect(frame.getByRole("button", {name: `Details: ${title(1)} updated`, exact: true})).toBeVisible();
});

test("nearby and summary modes differ when the user expands a second tab immediately", async ({browser}) => {
  for (const bundle of ["nearby","summaries"] as const) {
    const page = await browser.newPage();
    try {
      const {frame,wire} = await card(page, await currentHtml(), {
        bundle,descriptions:0,profile:{delay:100,bytesPerSecond:625_000},
      });
      await page.evaluate(() => (window as any).gtdLoading.hold());
      await navigate(frame,"Blocked");
      await frame.getByRole("button",{name:"Details: Bundled blocked task 1",exact:true}).click();
      if (bundle === "nearby") {
        await expect(frame.getByText(/Blocked details 1/)).toBeVisible();
        expect((await wire()).map(call=>call.name)).toEqual(["widget_pages"]);
      } else {
        await expect.poll(async()=>(await wire()).length).toBe(2);
        await expect(frame.getByText(/Blocked details 1/)).toHaveCount(0);
        await page.evaluate(() => (window as any).gtdLoading.releaseNewest());
        await expect(frame.getByText(/Blocked details 1/)).toBeVisible();
      }
    } finally { await page.close(); }
  }
});

test("requested Charts renders the bundled window and switches to bars without a read", async ({page}) => {
  const {frame,wire} = await card(page,await currentHtml(),{
    bundle:"requested",launch:"charts",descriptions:0,profile:{delay:10,bytesPerSecond:10_000_000},
  });
  await expect(frame.locator(".heat-grid")).toBeVisible();
  await switchChart(frame,"Bar Chart");
  await expect(frame.locator(".bar-column")).toHaveCount(30);
  expect(await wire()).toEqual([]);
});

test("measure full and deferred launch modes under simulated host delay", async ({browser}) => {
  const output = process.env.GTD_WIDGET_LAUNCH_REPORT;
  test.skip(!output, "Manual synthetic host comparison.");
  test.setTimeout(600_000);
  const html = (await currentHtml()).replace("</body>", `<script>
    window.gtdBenchmarkPaints = {};
    let opened, navigated;
    document.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (button?.ariaLabel === "Details: Benchmark task 1") opened = performance.now();
      if (button?.role === "menuitemradio" && button.textContent.trim() === "Blocked") navigated = performance.now();
    }, true);
    const marks = window.gtdBenchmarkPaints;
    function read() {
      const time = performance.now();
      if (marks.first == null && document.querySelector('button[aria-label="Details: Benchmark task 1"]')) marks.first = time;
      if (opened != null && marks.detail == null && Array.from(document.querySelectorAll(".task-context-content p")).some(p => p.textContent === "Fixture description 1")) marks.detail = time - opened;
      if (navigated != null && marks.tab == null && document.querySelector('button[aria-label="Details: Bundled blocked task 1"]')) marks.tab = time - navigated;
      if (marks.tab == null) requestAnimationFrame(read);
    }
    requestAnimationFrame(read);
  </script></body>`);
  const report = [];
  const pairs = Number(process.env.GTD_WIDGET_LAUNCH_PAIRS || 10);
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw Error("Expected 1–20 repetitions");
  for (const profile of profiles) {
    for (let pair = 0; pair < pairs; pair++) {
      const modes = ["full", "deferred", "nearby", "summaries"] as const;
      for (const mode of pair % 2 ? [...modes].reverse() : modes) {
        const page = await browser.newPage({viewport:{width:1120,height:950}});
        try {
          const start = performance.now();
          const {frame, wire} = await card(page, html, {profile, descriptions:0,bundle:mode});
          await frame.getByRole("button",{name:`Details: ${title(1)}`,exact:true}).waitFor();
          const initial = performance.now() - start;
          await frame.getByRole("button",{name:`Details: ${title(1)}`,exact:true}).click();
          await frame.getByText(/Fixture description 1/).waitFor();
          const dwell = pair % 2 ? 750 : 0;
          if (dwell) await page.waitForTimeout(dwell);
          await navigate(frame, "Blocked");
          await frame.getByRole("button",{name:"Details: Bundled blocked task 1",exact:true}).waitFor();
          const {shellToUsable, detail, tab} = await frame.locator("body").evaluate(async () => {
            const marks = (window as any).gtdBenchmarkPaints;
            for (let i=0; i<10 && marks.tab == null; i++)
              await new Promise(resolve => requestAnimationFrame(resolve));
            return {shellToUsable:Math.max(0,marks.first -
              (performance.getEntriesByName("gtd:shell-ready")[0]?.startTime ?? 0)),
              detail:marks.detail,tab:marks.tab};
          });
          expect(Number.isFinite(tab) && Number.isFinite(detail) && Number.isFinite(shellToUsable)).toBe(true);
          const calls = await wire();
          const launchBytes = await page.evaluate(() => (window as any).gtdLoading.launchBytes);
          report.push({profile,pair,mode,dwell,initial,shellToUsable,detail,tab,
            workflowWait:initial+detail+tab,launchBytes,
            calls:calls.length,additionalBytes:calls.reduce((sum,call)=>sum+call.received,0)});
        } finally { await page.close(); }
      }
    }
  }
  await writeFile(output!, JSON.stringify({kind:"synthetic widget host",samples:report}, null, 2));
});
