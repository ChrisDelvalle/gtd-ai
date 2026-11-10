import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Args, Task } from "../../src/api";
// All bridge calls are synthetic. The Playwright global setup additionally
// refuses any server that does not identify itself as a disposable test server.
export type HostOptions = {
  theme?: "light" | "dark";
  environment?: "demo" | "test" | "production" | "staging";
  account?: { id: string; timezone: string };
  omitAccountMetadata?: boolean;
  messageSupport?: "accepted" | "rejected";
  launch?: "home" | "repeating" | "review" | "activity" | "help";
  width?: number;
  maxHeight?: number;
  modeReply?: "fullscreen" | "inline" | "reject" | "denied" | "timeout";
  availableModes?: string[];
  long?: boolean;
  empty?: boolean;
  uncertainWrite?: boolean;
  project?: boolean;
  taskProject?: boolean;
  projectName?: string;
};
type Rpc = { method: string; params?: any };
export const title = "Review the supporting material";
export const projectTitle = "Prepare the weekly review";

export async function openWidget(page: Page, options: HostOptions = {}) {
  const width = options.width || 390;
  await page.setViewportSize({ width: Math.max(width, 390), height: 900 });
  let html = await readFile(
    process.env.GTD_TEST_WIDGET_FILE || new URL("../../dist/widget-adapter.html", import.meta.url),
    "utf8",
  );
  if (options.account) {
    expect(html).toContain('data-account-binding="1"');
    html = html.replace("<html", '<html data-account-required="true"');
    options.environment ??= "staging";
  }
  const tasks: Task[] = options.empty
    ? []
    : Array.from({ length: options.long === false ? 1 : 5 }, (_, i) => ({
        id: `display-task-${i + 1}`,
        title: i === 0 ? title : `Supporting task ${i + 1}`,
        brief: "Review the material and choose a next action.",
        notes:
          options.long === false
            ? "Review the material and choose the next action."
            : Array.from(
                { length: 24 },
                (_, n) =>
                  `### Step ${n + 1}\n\nRead the supporting material and choose the next action. [Supporting resource ${n + 1}](https://example.com/review/${n + 1}).`,
              ).join("\n\n"),
        importance: "normal", estimated_minutes: 30, effort: "medium",
        status: "next",
        archived: false,
        due_date: null,
        ...(options.launch === "review" ? { review_date: "2026-01-01" } : {}),
        version: 1,
        last_change_id: i + 1,
        deleted: false,
        ...(options.project || options.taskProject ? { project_id: "display-project" } : {}),
      }));
  const project: Task & { task_counts: { next: number } } = {
    id: "display-project",
    title: options.projectName ?? projectTitle,
    notes: "Review open commitments and choose what to do next.",
    entity_type: "project",
    status: "active",
    due_date: null,
    version: 1,
    last_change_id: 20,
    deleted: false,
    archived: false,
    task_counts: { next: tasks.length },
    has_agent_notes: true,
  };
  await page.route("**/__display-card", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#eee"><p style="height:60px;margin:0">Conversation above</p><div id="card"></div><p style="height:1200px">Conversation below</p></body></html>`,
    }),
  );
  await page.goto("/__display-card");
  await page.evaluate(
    ({ html, options, tasks, width, project }) => {
      const frame = document.createElement("iframe");
      frame.title = "GTD test card";
      frame.style.cssText = `width:${width}px;height:100px;border:0;display:block`;
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      const messages: Rpc[] = [];
      let mode = "inline";
      let maxHeight = options.maxHeight || 450;
      let items = tasks;
      const receipts = new Map<string, object>();
      let uncertain = options.uncertainWrite || false;
      const metadata = () => options.account && !options.omitAccountMetadata ? {
        "gtd/accountId": options.account.id, "gtd/environment": options.environment, "gtd/timezone": options.account.timezone,
      } : undefined;
      let holdWrite = false;
      const held: (() => void)[] = [];
      const send = (v: any) => {
        if (v.result?.structuredContent) v.result._meta ??= metadata();
        if (v.method === "ui/notifications/tool-result") v.params._meta ??= metadata();
        frame.contentWindow!.postMessage({ jsonrpc: "2.0", ...v }, "*");
      };
      const context = (nextMode: string, height?: number) => {
        mode = nextMode;
        maxHeight =
          height || (mode === "fullscreen" ? 760 : options.maxHeight || 450);
        if (mode === "fullscreen") frame.style.height = `${maxHeight}px`;
        return {
          theme: options.theme || (width < 500 ? "dark" : "light"),
          displayMode: mode,
          availableDisplayModes: options.availableModes || [
            "inline",
            "fullscreen",
          ],
          containerDimensions:
            mode === "fullscreen"
              ? { width, height: maxHeight }
              : { width, maxHeight },
        };
      };
      (window as any).displayTest = {
        messages,
        holdNextWrite() { holdWrite = true; },
        releaseWrites() { held.splice(0).forEach(send => send()); },
        changeAccount(account: {id: string; timezone: string}) {
          options.account = account;
          send({method: "ui/notifications/tool-result", params: {structuredContent: {...list({}), environment: options.environment}}});
        },
        sendResult(data: object) { send({method: "ui/notifications/tool-result", params: {structuredContent: data}}); },
        changeMode(nextMode: string, height?: number) {
          send({
            method: "ui/notifications/host-context-changed",
            params: context(nextMode, height),
          });
        },
      };
      const list = (args: Args) => ({
        items: items.filter(
          (t) =>
            (!args.task_id || t.id === args.task_id) &&
            (!Array.isArray(args.task_ids) || args.task_ids.includes(t.id)) &&
            (!args.blocked_by_id || t.blocked_by?.includes(String(args.blocked_by_id))) &&
            (!args.status || t.status === args.status),
        ),
        history: [],
        next_cursor: null,
        next_offset: null,
        next_history_after: null,
      });
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data;
        if (m.method === "tools/call" && ["gtd_ui_read","gtd_ui_write"].includes(m.params.name)) {
          // Preserve the real transport name for contract assertions, and expose
          // underlying operations to existing interaction assertions.
          (window as any).__wireCalls ||= [];
          (window as any).__wireCalls.push(structuredClone(m));
          m.params = {...m.params, name: m.params.arguments.operation, arguments: m.params.arguments.arguments};
        }
        messages.push({ method: m.method, params: m.params });
        if (m.method === "ui/initialize")
          send({ id: m.id, result: { hostContext: context("inline"), hostCapabilities: options.messageSupport ? {message: {text: {}}} : {} } });
        if (m.method === "ui/message") send({id: m.id, result: {isError: options.messageSupport === "rejected"}});
        if (m.method === "ui/notifications/initialized") {
          send({
            method: "ui/notifications/tool-input",
            params: { arguments: {} },
          });
          send({
            method: "ui/notifications/tool-result",
            params: {
              structuredContent: {...(options.launch ? {app:"gtd", view:options.launch} : options.project
                ? { projects: [project], next_cursor: null }
                : list({})), ...(options.environment ? {environment: options.environment} : {})},
            },
          });
        }
        if (m.method === "ui/request-display-mode") {
          if (options.modeReply === "timeout") return;
          if (options.modeReply === "denied") {
            send({
              id: m.id,
              error: { code: -32000, message: "Display request denied" },
            });
            return;
          }
          if (options.modeReply === "reject")
            send({
              id: m.id,
              error: { code: -32601, message: "Display modes unavailable" },
            });
          else {
            const granted = options.modeReply || m.params.mode;
            send({
              method: "ui/notifications/host-context-changed",
              params: context(granted),
            });
            send({ id: m.id, result: { mode: granted } });
          }
        }
        if (m.method === "tools/call") {
          const { name, arguments: args } = m.params;
          if (name === "view_snapshot") {
            send({ id: m.id, result: { isError: true,
              structuredContent: { code: "invalid_arguments", message: "Unsupported UI operation" } } });
            return;
          }
          let result: any = list(args);
          if (name === "list_occurrences") result = {series_list: [], next_cursor: null};
          if (name === "list_projects")
            result = {
              projects: options.project || options.taskProject
                ? [
                    {
                      ...project,
                      ...(args.include_agent_notes
                        ? {
                            agent_notes:
                              "Keep the review focused on current commitments.",
                          }
                        : {}),
                    },
                  ]
                : [],
              next_cursor: null,
            };
          if (name === "list_changes")
            result = {
              changes: options.project
                ? [
                    {
                      id: 20,
                      task_id: project.id,
                      project_id: project.id,
                      entity_id: project.id,
                      entity_type: "project",
                      operation: "capture",
                      reason: "Created a review outcome.",
                      before: null,
                      after: project,
                      created_at: "2026-10-04T12:00:00Z",
                      origin: "mcp",
                      undoes_change_id: null,
                    },
                  ]
                : [],
              next_before_id: null,
            };
          if (name === "update_item") {
            if (receipts.has(args.request_id))
              result = receipts.get(args.request_id);
            else {
              const before = items.find((t) => t.id === args.task_id)!;
              const after = {
                ...before,
                ...args,
                version: before.version + 1,
                last_change_id: 99,
              };
              items = items.map((t) => (t.id === before.id ? after : t));
              result = {
                task: after,
                change: {
                  id: 99,
                  task_id: before.id,
                  before,
                  after,
                  operation: "update",
                  reason: args.reason,
                },
                replayed: false,
              };
              receipts.set(args.request_id, { ...result, replayed: true });
            }
            if (uncertain) {
              uncertain = false;
              send({
                id: m.id,
                result: {
                  isError: true,
                  structuredContent: {
                    code: "storage_error",
                    message: "Result was not confirmed.",
                  },
                },
              });
              return;
            }
          }
          const reply = { id: m.id, result: { structuredContent: {...result, ...(options.environment ? {environment:options.environment} : {})}, _meta: metadata() } };
          if (holdWrite && m.params.arguments.request_id) { holdWrite = false; held.push(() => send(reply)); }
          else send(reply);
        }
        if (
          m.method === "ui/notifications/size-changed" &&
          mode !== "fullscreen"
        )
          frame.style.height = `${m.params.height}px`;
      });
      frame.srcdoc = html;
      document.getElementById("card")!.append(frame);
    },
    { html, options, tasks, width, project },
  );
  const frame = page.frameLocator('iframe[title="GTD test card"]');
  const surface = frame.locator(".widget-surface");
  await expect(surface).toHaveAttribute("data-display", "preview");
  const requests = (method: string) =>
    page.evaluate(
      (method) =>
        (window as any).displayTest.messages.filter(
          (m: Rpc) => m.method === method,
        ),
      method,
    ) as Promise<Rpc[]>;
  const changeMode = (mode: string, height?: number) =>
    page.evaluate(
      ({ mode, height }) =>
        (window as any).displayTest.changeMode(mode, height),
      { mode, height },
    );
  return {
    frame,
    surface,
    scroll: frame.locator(".widget-scroll"),
    requests,
    changeMode,
  };
}
