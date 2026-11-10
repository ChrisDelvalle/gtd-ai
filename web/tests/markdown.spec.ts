import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Task, Args } from "../src/api";

const description = `## Before you start
Read the **review brief** and confirm the *two examples*.
Keep the proposal to one page.

- Gather the evidence
- Write the outline
  - Include a concrete example

## Share the draft
1. Check the [review guide](https://example.com/guide_(reference)).
2. Send the draft for review.

> Keep the outcome clear and actionable.

Use \`proposal.md\` for the draft. Background: https://example.com/brief.

\`\`\`text
Draft → Review → Send
\`\`\``;
const original: Task = {
  id: "markdown-test",
  title: "Prepare the proposal",
  brief: "Draft a clear proposal for review.",
  notes: description,
  has_agent_notes: true,
  omitted_fields: ["agent_notes"],
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

async function website(page: Page, notes = description, project = false) {
  let record = {
    ...original,
    notes,
    ...(project ? { status: "active", entity_type: "project" } : {}),
  };
  const calls: { name: string; args: Args }[] = [];
  await page.route("**/api/view", route => {
    const empty={items:[],next_cursor:null};
    return route.fulfill({json:{data:{next:{...empty,items:project?[]:[record]},waiting:empty,someday:empty,reviewTasks:empty,reviewProjects:{projects:[]},remaining:null}}});
  });
  await page.route("**/api/tools/*", async (route) => {
    const name = route.request().url().split("/").at(-1)!;
    const args = route.request().postDataJSON();
    calls.push({ name, args });
    if (name === "list_items")
      return route.fulfill({
        json: {
          items:
            project || (args.status && args.status !== "next") ? [] : [record],
          history: [],
          next_cursor: null,
        },
      });
    if (name === "list_projects")
      return route.fulfill({
        json: {
          projects: project ? [record] : [],
          next_cursor: null,
          complete: true,
        },
      });
    if (name === "list_changes")
      return route.fulfill({ json: { changes: [], next_before_id: null } });
    if (name === "update_item") {
      record = {
        ...record,
        notes: String(args.notes),
        version: record.version + 1,
      };
      return route.fulfill({
        json: { task: record, change: { id: 2 }, replayed: false },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(project ? "/projects" : "/tasks?status=next");
  if (project) {
    await page.locator(".project-row").click();
  } else {
    await page
      .getByRole("button", { name: `Details: ${original.title}`, exact: true })
      .click();
  }
  const content = page.locator(".task-markdown").first();
  await expect(content).toBeVisible();
  await expect(page.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  return { content, calls };
}

async function checkFormatting(content: Locator) {
  await expect(
    content.getByRole("heading", { name: "Before you start" }),
  ).toBeVisible();
  await expect(content.locator("strong")).toHaveText("review brief");
  await expect(content.locator("em")).toHaveText("two examples");
  await expect(content.locator("ul ul li")).toHaveText(
    "Include a concrete example",
  );
  await expect(content.locator("ol > li")).toHaveCount(2);
  await expect(content.locator("blockquote")).toContainText(
    "Keep the outcome clear",
  );
  await expect(content.locator("pre code")).toHaveText(
    "Draft → Review → Send\n",
  );
  await expect(
    content.getByRole("link", { name: "review guide" }),
  ).toHaveAttribute("href", "https://example.com/guide_(reference)");
  await expect(
    content.getByRole("link", {
      name: "https://example.com/brief",
      exact: true,
    }),
  ).toHaveAttribute("href", "https://example.com/brief");
  await expect(content.locator("p").first()).toHaveCSS(
    "white-space",
    "pre-wrap",
  );
}

for (const mobile of [false, true]) {
  test(`website descriptions render compact Markdown (${mobile ? "phone dark" : "desktop light"})`, async ({
    page,
  }, info) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 },
    );
    await page.emulateMedia({ colorScheme: mobile ? "dark" : "light" });
    const { content } = await website(page);
    await checkFormatting(content);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("description.png"),
      fullPage: true,
    });
  });
}

test("project descriptions share the same Markdown rendering", async ({
  page,
}) => {
  const { content } = await website(page, description, true);
  await checkFormatting(content);
});

test("unsafe URLs, HTML, images, code and malformed syntax remain inert", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("untrusted.example"))
      requests.push(request.url());
  });
  const { content } = await website(
    page,
    [
      "<script>window.markdownExecuted = true</script>",
      '<img src="https://untrusted.example/raw.png" onerror="window.markdownExecuted=true">',
      "![Image label](https://untrusted.example/image.png)",
      "[Unsafe](javascript:alert%281%29) [Encoded](javascript&#x3A;alert%281%29)",
      "[Data](data:text/html,hello) [Relative](/api/tools/update_item) [Credentials](https://user:pass@example.com/)",
      "`https://example.com/not-a-link`",
      '```html\n<img src="https://untrusted.example/code.png">\n```',
      String.raw`\*literal emphasis\* and \[unfinished`,
      "[Reference][guide]\n\n[guide]: https://example.com/reference",
    ].join("\n\n"),
  );
  await expect(
    content.locator("script,img,iframe,object,embed,style,input"),
  ).toHaveCount(0);
  await expect(content.locator("a")).toHaveCount(1);
  await expect(
    content.getByRole("link", { name: "Reference" }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  await expect(content).toContainText("*literal emphasis*");
  await expect(content).toContainText(
    "<script>window.markdownExecuted = true</script>",
  );
  await expect(content).toContainText("Image label");
  expect(
    await page.evaluate(() => (window as any).markdownExecuted),
  ).toBeUndefined();
  expect(requests).toEqual([]);
});

test("long Markdown stays inside narrow cards; editing preserves source and hidden notes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const source = `## ${"Heading".repeat(20)}\n\n${"word".repeat(200)}\n\n\`\`\`\n${"code".repeat(200)}\n\`\`\``;
  const { content, calls } = await website(page, source);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await content
      .locator("pre")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  await page
    .getByRole("button", {
      name: `More options: ${original.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue(source);
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill(description);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => calls.filter((call) => call.name === "update_item").length)
    .toBe(1);
  const write = calls.find((call) => call.name === "update_item")!.args;
  expect(write.notes).toBe(description);
  expect(write.agent_notes).toBeUndefined();
  expect(calls.some((call) => call.args.include_agent_notes)).toBe(false);
});

test("ChatGPT card renders Markdown and opens links through the host bridge", async ({
  page,
}, info) => {
  const html = await readFile(
    new URL("../dist/widget-adapter.html", import.meta.url),
    "utf8",
  );
  await page.route("**/__markdown-card", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body style='margin:0'></body>",
    }),
  );
  await page.goto("/__markdown-card");
  await page.evaluate(
    ({ html, original }) => {
      const frame = document.createElement("iframe");
      frame.style.cssText = "width:360px;height:100px;border:0;display:block";
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      (window as any).openedLinks = [];
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data;
        // Simulate the app-only facade used by the authenticated adapter.
        if (m.method === "tools/call" && ["gtd_ui_read", "gtd_ui_write"].includes(m.params.name)) {
          m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
        }
        const send = (v: any) =>
          frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
        const result = { items: [original], history: [], next_cursor: null };
        if (m.method === "ui/initialize")
          send({ id: m.id, result: { hostContext: { theme: "light" } } });
        if (m.method === "ui/notifications/initialized")
          send({
            method: "ui/notifications/tool-result",
            params: { structuredContent: result },
          });
        if (m.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(m.params.name))
          m.params = {...m.params, name:m.params.arguments.operation, arguments:m.params.arguments.arguments};
        if (m.method === "tools/call" && ["view_snapshot","widget_pages"].includes(m.params.name)) {
          send({id:m.id,result:{isError:true,structuredContent:{code:"invalid_arguments",message:"Unsupported UI operation"}}});return;
        }
        if (m.method === "tools/call")
          send({ id: m.id, result: { structuredContent: result } });
        if (m.method === "ui/open-link") {
          (window as any).openedLinks.push(m.params.url);
          send({ id: m.id, result: {} });
        }
        if (m.method === "ui/notifications/size-changed")
          frame.style.height = `${m.params.height}px`;
      });
      frame.srcdoc = html;
      document.body.append(frame);
    },
    { html, original },
  );
  const card = page.frameLocator("iframe");
  await card
    .getByRole("button", { name: `Details: ${original.title}`, exact: true })
    .click();
  await card.getByRole("button", {name: "Expand view", exact: true}).click();
  const content = card.locator(".task-markdown");
  await checkFormatting(content);
  await expect(card.locator(".task-expansion[data-resizing]")).toHaveCount(0);
  expect(
    await card
      .locator("body")
      .evaluate((el) => el.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await content.getByRole("link", { name: "review guide" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).openedLinks))
    .toEqual(["https://example.com/guide_(reference)"]);
  await page
    .locator("iframe")
    .screenshot({ path: info.outputPath("card.png") });
});
