import { test, expect, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Task, Args } from "../src/api";

const original: Task = {
  id: "notes-test",
  title: "Prepare the proposal",
  brief: "Draft a clear proposal for review.",
  notes: "Draft the proposal and send it for review.",
  agent_notes: "The reviewer requested two examples. Confirm the reviewer.",
  has_agent_notes: true,
  status: "next",
  importance: "normal",
  estimated_minutes: 30,
  effort: "medium",
  archived: false,
  due_date: null,
  version: 1,
  last_change_id: 1,
  deleted: false,
};
type Call = { name: string; args: Args };
async function fixture(
  page: Page,
  kind: "task" | "project" | "recurrence" = "task",
) {
  let record: Task = structuredClone({
    ...original,
    entity_type: kind,
    status: kind === "task" ? "next" : "active",
  });
  if (kind === "recurrence")
    record.recurrence = {
      segments: [
        {
          from: "2026-10-03",
          rule: {
            start_date: "2026-10-03",
            frequency: "daily",
            interval: 1,
            weekdays: [],
            month_day: null,
            ordinal: null,
            until: null,
            count: null,
          },
          template: {
            title: record.title,
            brief: record.brief,
            notes: record.notes!,
            agent_notes: record.agent_notes,
            links: [],
            location: null,
            project_id: null,
            status: "next",
            importance: "normal",
            estimated_minutes: 30,
            effort: "medium",
            due_offset_days: null,
            review_offset_days: null,
          },
        },
      ],
      pauses: [],
      ended_on: null,
    };
  const calls: Call[] = [];
  const control = {
    intercept: null as
      null | ((call: Call, route: Route) => Promise<boolean | void>),
    set: (patch: Partial<Task>) => {
      record = { ...record, ...patch };
    },
    get: () => record,
  };
  function visible(include = false) {
    const value = structuredClone(record);
    if (!include) {
      delete value.agent_notes;
      value.omitted_fields = ["agent_notes"];
      for (const segment of value.recurrence?.segments || [])
        delete segment.template.agent_notes;
    }
    return value;
  }
  await page.route("**/api/tools/*", async (route) => {
    const name = route.request().url().split("/").at(-1)!,
      args = route.request().postDataJSON();
    const call = { name, args };
    calls.push(call);
    if (await control.intercept?.(call, route)) return;
    const shown = visible(args.include_agent_notes === true);
    if (name === "list_items")
      return route.fulfill({
        json: {
          items:
            kind === "task" &&
            (!args.status || args.status === "next") &&
            !args.project_id
              ? [shown]
              : [],
          history: [],
          next_cursor: null,
          next_offset: null,
          next_history_after: null,
        },
      });
    if (name === "list_projects")
      return route.fulfill({
        json: {
          projects: kind === "project" ? [shown] : [],
          next_cursor: null,
          complete: true,
        },
      });
    if (name === "list_occurrences")
      return route.fulfill({
        json: {
          series: args.series_id ? shown : null,
          series_list: args.series_id ? undefined : [shown],
          occurrences: [],
          next_cursor: null,
          complete: true,
        },
      });
    if (name === "list_changes")
      return route.fulfill({ json: { changes: [], next_before_id: null } });
    if (name.startsWith("update_")) {
      const before = record;
      record = {
        ...record,
        ...("agent_notes" in args
          ? {
              agent_notes: String(args.agent_notes),
              has_agent_notes: !!args.agent_notes,
            }
          : {}),
        ...("notes" in args ? { notes: String(args.notes) } : {}),
        version: record.version + 1,
        last_change_id: record.last_change_id + 1,
      };
      return route.fulfill({
        json: {
          [kind === "project"
            ? "project"
            : kind === "recurrence"
              ? "series"
              : "task"]: visible(),
          change: { id: record.last_change_id, before, after: visible() },
          replayed: false,
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(kind === "task" ? "/tasks?status=next" : kind === "project" ? "/projects" : "/repeating");
  if (kind !== "task") {
    await page
      .locator(kind === "project" ? ".project-row" : ".repeat-series")
      .click();
  }
  async function open() {
    await page
      .getByRole("button", {
        name:
          kind === "project"
            ? "Project options"
            : kind === "recurrence"
              ? "More options for repeat"
              : `More options: ${record.title}`,
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Agent notes", exact: true })
      .click();
    return page.getByRole("region", { name: "Agent notes", exact: true });
  }
  return { calls, control, open };
}

for (const kind of ["task", "project", "recurrence"] as const) {
  test(`${kind} notes are lazy, separate, and save only the working document`, async ({
    page,
  }, info) => {
    const { calls, open } = await fixture(page, kind);
    expect(calls.some((call) => call.args.include_agent_notes)).toBe(false);
    await expect(
      page.getByText(original.agent_notes!, { exact: true }),
    ).toHaveCount(0);
    const panel = await open();
    await expect(
      panel.getByText(original.agent_notes!, { exact: true }),
    ).toBeVisible();
    expect(
      calls.some(
        (call) =>
          call.args.include_agent_notes === true &&
          (kind === "recurrence"
            ? call.args.detail === undefined
            : call.args.detail === "full"),
      ),
    ).toBe(true);
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    await panel.getByRole("button", { name: "Edit agent notes" }).click();
    await panel
      .getByRole("textbox", { name: "Agent notes", exact: true })
      .fill(
        "Decision: retain the two examples.\nNext review: confirm the reviewer.",
      );
    await expect(page.locator(".task-expansion[data-resizing]")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${kind}-agent-notes.png`) });
    await panel.getByRole("button", { name: "Save agent notes" }).click();
    if (kind === "recurrence")
      await page.getByRole("menuitem", { name: "Entire series" }).click();
    await expect(panel.locator(".agent-notes-body")).toHaveText(
      "Decision: retain the two examples.\nNext review: confirm the reviewer.",
    );
    const write = calls.find((call) => call.name.startsWith("update_"))!;
    expect(write.args.agent_notes).toContain("Decision:");
    expect(write.args.notes).toBeUndefined();
    expect(write.args.template).toBeUndefined();
    expect(write.args.rule).toBeUndefined();
    expect(write.args.expected_version).toBe(1);
    if (kind === "recurrence") expect(write.args.scope).toBe("all");
  });
}

test("phone agent notes keep a long draft, expose conflicts and clear explicitly", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { control, open, calls } = await fixture(page);
  const panel = await open();
  await panel.getByRole("button", { name: "Edit agent notes" }).click();
  const draft = "Working context <script>alert(1)</script> résumé ".repeat(100);
  await panel
    .getByRole("textbox", { name: "Agent notes", exact: true })
    .fill(draft);
  let failed = false;
  control.intercept = async ({ name }, route) => {
    if (name === "update_item" && !failed) {
      failed = true;
      control.set({ version: 2, agent_notes: "Newer server decision." });
      await route.fulfill({
        status: 409,
        json: { code: "conflict", message: "The record changed." },
      });
      return true;
    }
  };
  await panel.getByRole("button", { name: "Save agent notes" }).click();
  await expect(
    panel.getByText("This record changed. Your draft is preserved.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    panel.getByRole("textbox", { name: "Agent notes", exact: true }),
  ).toHaveValue(draft);
  await panel.getByText("Current agent notes", { exact: true }).click();
  await expect(
    panel.getByText("Newer server decision.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("phone-agent-notes-conflict.png"),
  });
  await panel
    .getByRole("button", { name: "Use latest version with my draft" })
    .click();
  await panel
    .getByRole("textbox", { name: "Agent notes", exact: true })
    .fill("");
  await panel.getByRole("button", { name: "Save agent notes" }).click();
  await expect(
    panel.getByText("No agent notes.", { exact: true }),
  ).toBeVisible();
  const writes = calls.filter((call) => call.name === "update_item");
  expect(writes.at(-1)!.args.agent_notes).toBe("");
  expect(writes.at(-1)!.args.expected_version).toBe(2);
});

test("ordinary description edits never transmit hidden agent notes", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await page
    .getByRole("button", {
      name: `More options: ${original.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Send the revised proposal.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => calls.filter((call) => call.name === "update_item").length)
    .toBe(1);
  expect(
    calls.find((call) => call.name === "update_item")!.args.agent_notes,
  ).toBeUndefined();
  expect(calls.some((call) => call.args.include_agent_notes)).toBe(false);
});

test("repeating description edits preserve hidden defaults", async ({
  page,
}) => {
  const { calls } = await fixture(page, "recurrence");
  await page
    .getByRole("button", { name: "Edit task details", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Prepare the examples.");
  await page
    .getByRole("button", { name: "Save task details", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Entire series", exact: true })
    .click();
  await expect
    .poll(
      () => calls.filter((call) => call.name === "update_recurrence").length,
    )
    .toBe(1);
  const args = calls.find((call) => call.name === "update_recurrence")!.args;
  expect(args.agent_notes).toBeUndefined();
  expect((args.template as Args).agent_notes).toBeUndefined();
  expect((args.template as Args).notes).toBe("Prepare the examples.");
  expect(calls.some((call) => call.args.include_agent_notes)).toBe(false);
});

test("agent-note read failures are recoverable and never expose an empty editor", async ({
  page,
}) => {
  const { control, open } = await fixture(page);
  let failed = false;
  control.intercept = async ({ args }, route) => {
    if (args.include_agent_notes && !failed) {
      failed = true;
      await route.fulfill({
        status: 503,
        json: { code: "503", message: "Temporarily offline." },
      });
      return true;
    }
  };
  const panel = await open();
  await expect(
    panel.getByText("Temporarily offline.", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Edit agent notes" }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Retry agent notes" }).click();
  await expect(panel.locator(".agent-notes-body")).toHaveText(
    original.agent_notes!,
  );
});

test("agent-note uncertain saves retry the same request ID", async ({
  page,
}) => {
  const { control, open, calls } = await fixture(page);
  const panel = await open();
  await panel.getByRole("button", { name: "Edit agent notes" }).click();
  await panel
    .getByRole("textbox", { name: "Agent notes", exact: true })
    .fill("A safe retry.");
  let failures = 0;
  control.intercept = async ({ name }, route) => {
    if (name === "update_item" && failures++ === 0) {
      await route.abort();
      return true;
    }
  };
  await panel.getByRole("button", { name: "Save agent notes" }).click();
  await expect(panel.locator(".agent-notes-body")).toHaveText("A safe retry.");
  const writes = calls.filter((call) => call.name === "update_item");
  expect(writes).toHaveLength(2);
  expect(writes[1].args).toEqual(writes[0].args);
});

test("card agent notes use the bridge and retain drafts when collapsed", async ({
  page,
}, info) => {
  const html = await readFile(
    new URL("../dist/widget-adapter.html", import.meta.url),
    "utf8",
  );
  await page.route("**/__notes-card", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body style='margin:0'></body>",
    }),
  );
  await page.goto("/__notes-card");
  await page.evaluate(
    ({ html, original }) => {
      let task = { ...original };
      const plain = () => {
        const { agent_notes, ...value } = task;
        return value;
      };
      const frame = document.createElement("iframe");
      frame.style.cssText = "width:360px;height:100px;border:0;display:block";
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      (window as any).notesCalls = [];
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data,
          send = (v: any) =>
            frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
        if (m.method === "ui/initialize")
          send({ id: m.id, result: { hostContext: { theme: "light" } } });
        if (m.method === "ui/notifications/initialized")
          send({
            method: "ui/notifications/tool-result",
            params: {
              structuredContent: {
                items: [plain()],
                history: [],
                next_cursor: null,
              },
            },
          });
        if (m.method === "tools/call") {
          if (["gtd_ui_read","gtd_ui_write"].includes(m.params.name)) m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
          const { name, arguments: args } = m.params;
          (window as any).notesCalls.push({ name, args });
          let result: any = {
            items: [args.include_agent_notes ? task : plain()],
            history: [],
            next_cursor: null,
          };
          if (name === "update_item") {
            task = {
              ...task,
              agent_notes: args.agent_notes,
              version: task.version + 1,
            };
            result = { task: plain(), change: { id: 2 }, replayed: false };
          }
          send({ id: m.id, result: { structuredContent: result } });
        }
        if (m.method === "ui/notifications/size-changed")
          frame.style.height = `${m.params.height}px`;
      });
      frame.srcdoc = html;
      document.body.append(frame);
    },
    { html, original },
  );
  const frame = page.frameLocator("iframe");
  await frame
    .getByRole("button", {
      name: `More options: ${original.title}`,
      exact: true,
    })
    .click();
  await frame
    .getByRole("menuitem", { name: "Agent notes", exact: true })
    .click();
  const panel = frame.getByRole("region", { name: "Agent notes", exact: true });
  await panel.getByRole("button", { name: "Edit agent notes" }).click();
  await panel
    .getByRole("textbox", { name: "Agent notes", exact: true })
    .fill("Keep this card draft.");
  await expect(frame.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  await panel.getByRole("button", {name:"Save agent notes"}).scrollIntoViewIfNeeded();
  await expect(panel.getByRole("button", {name:"Save agent notes"})).toBeInViewport();
  await page.screenshot({ path: info.outputPath("card-agent-notes.png") });
  await frame.getByRole("button", { name: "Return to preview", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await frame.getByRole("button", { name: "Expand view", exact: true }).click();
  await expect(panel.getByRole("textbox", {name:"Agent notes",exact:true})).toHaveValue("Keep this card draft.");
  await panel.getByRole("button", { name: "Save agent notes" }).click();
  await expect(panel.locator(".agent-notes-body")).toHaveText(
    "Keep this card draft.",
  );
  const calls = await page.evaluate(() => (window as any).notesCalls);
  expect(
    calls.some((call: Call) => call.name === "list_items" && call.args.include_agent_notes),
  ).toBe(true);
});
