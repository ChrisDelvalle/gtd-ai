import { uiCall } from "./ui-call";
import { environmentGuard } from "./environment-guard";
import { widgetIdentity, type HostResult } from "./widget-identity";
import { widgetReads } from "./widget-reads";
import { defaultZone } from "./calendar-context";
export { widgetIdentity } from "./widget-identity";
// Preserve the working reference's JSON-RPC postMessage transport.
import { observeHostHeight } from "./host-height";
import {
  ApiError,
  type Api,
  type Args,
  type List,
  type HomeSnapshot,
  type Mutation,
  type Projects,
} from "./api";

export type HostContext = {
  theme?: string;
  styles?: { variables?: Record<string, string> };
  displayMode?: "inline" | "fullscreen" | "pip";
  availableDisplayModes?: ("inline" | "fullscreen" | "pip")[];
  containerDimensions?: {
    height?: number;
    maxHeight?: number;
    width?: number;
    maxWidth?: number;
  };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
};
export const widgetEnvironment = environmentGuard();
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
export const hostState: {
  input: Args;
  launch: {view: string; series_id?: string; from_request_ids?: string[]; resultLimit?: number; results?: import("./results").RequestResults; home?: HomeSnapshot} | null;
  result: List | null;
  projects: Projects | null;
  error: string;
  notice: string;
  canRefresh: boolean;
  errorIsWrite: boolean;
  environment: string;
  canMessage: boolean;
  context: HostContext;
} = {
  input: {},
  launch: null,
  result: null,
  projects: null,
  error: "",
  notice: "",
  canRefresh: false,
  errorIsWrite: false,
  environment: "unknown",
  canMessage: false,
  context: {},
};
let mutationInput = false;
const listeners = new Set<() => void>();
export function subscribeHost(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const notifyListeners = () => listeners.forEach((fn) => fn());
function notify(method: string, params: unknown) {
  parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
}
function request(
  method: string,
  params: unknown,
  timeout = 20000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new ApiError(
          "The host did not confirm the result. Retry an uncertain write with the same request.",
          "bridge_timeout",
          true,
        ),
      );
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}
function applyContext(context?: HostContext) {
  if (!context) return;
  hostState.context = { ...hostState.context, ...context };
  if (context.theme === "dark" || context.theme === "light")
    document.documentElement.dataset.theme = context.theme;
  const variables = context.styles?.variables;
  if (variables)
    for (const [key, value] of Object.entries(variables)) {
      // Host theme tokens only; never inject arbitrary CSS rules or external font URLs.
      if (
        /^--(color|font|border|shadow)-[a-z0-9-]+$/.test(key) &&
        typeof value === "string" &&
        value.length < 256 &&
        !/[;{}]|url\s*\(/i.test(value)
      )
        document.documentElement.style.setProperty(key, value);
    }
}
let acceptedLaunchId: string | undefined;
function acceptResult(result: HostResult) {
  hostState.notice = "";
  const data = result.structuredContent as
    | (List &
        Mutation &
        Projects & { code?: string; message?: string; environment?: string; app?: string; view?: string; series_id?: string; from_request_ids?: string[] })
    | undefined;
  try {
    widgetIdentity.observe(result);
    if (data?.code === "environment_changed") widgetEnvironment.reject();
    widgetEnvironment.observe(data?.environment);
  } catch { return; }
  if (data?.environment) hostState.environment = data.environment;
  const requestId = result._meta?.["gtd/requestId"];
  if (typeof requestId === "string" && requestId === acceptedLaunchId) return;
  const bundle = !result.isError ? reads.seedBundle(result._meta?.["gtd/widgetBundle"]) : undefined;
  const requested = bundle?.pages[0];
  if (bundle) {
    if (typeof requestId === "string") acceptedLaunchId = requestId;
    performance.mark("gtd:launch-result", { detail: { requestId } });
  }
  hostState.launch = null;
  if (result.isError) {
    hostState.result = null;
    hostState.projects = null;
    const uncertain =
      data?.code === "storage_error" || data?.code === "internal_error";
    hostState.error = mutationInput
      ? uncertain
        ? "Change not confirmed. It may have been saved; retry only with the same request."
        : `Change was rejected. ${data?.message || "No change was saved."}`
      : "The task view could not be loaded. Try Refresh.";
  } else if (data?.app === "gtd" && ["home", "repeating", "review", "activity", "charts", "help", "results"].includes(data.view || "")) {
    hostState.launch = {
      view: data.view!,
      series_id: data.series_id,
      from_request_ids: data.from_request_ids,
      resultLimit: typeof requested?.arguments.limit === "number" ? requested.arguments.limit : undefined,
      results: data.view === "results" ? (requested?.operation === "request_results" ? requested.data : data) as unknown as import("./results").RequestResults : undefined,
      home: data.view === "home" ? (requested?.operation === "home" ? requested.data as unknown as HomeSnapshot : reads.seed(result._meta?.["gtd/homeSnapshot"])) : undefined,
    };
    hostState.result = null;
    hostState.projects = null;
    hostState.error = "";
  } else if (data?.project || Array.isArray(data?.projects)) {
    if (requested?.operation === "list_projects") hostState.input = requested.arguments;
    hostState.projects = requested?.operation === "list_projects" ? requested.data as unknown as Projects : data.project
      ? { projects: [data.project], next_cursor: null }
      : (data as Projects);
    hostState.result = null;
    if (data.project)
      hostState.input = {
        project_id: data.project.id,
        include_deleted: true,
      };
    hostState.canRefresh = true;
    hostState.error = "";
  } else if (data?.task && data?.change) {
    hostState.projects = null;
    hostState.input = { task_id: data.task.id, include_deleted: true };
    hostState.canRefresh = true;
    hostState.result = {
      items: [data.task],
      history: [data.change],
      next_offset: null,
      next_history_after: null,
    };
    hostState.error = "";
    // Persistent retries return the original committed snapshot, not necessarily the current version.
    if (data.replayed)
      hostState.notice = "Previously saved result. Checking the latest task…";
  } else if (Array.isArray(data?.items)) {
    hostState.projects = null;
    if (requested?.operation === "list_items") hostState.input = requested.arguments;
    hostState.result = (requested?.operation === "list_items" ? requested.data : result.structuredContent) as List;
    hostState.error = "";
  } else {
    hostState.projects = null;
    hostState.result = null;
    hostState.error =
      "The host returned an incomplete result. The operation is not confirmed.";
  }
  notifyListeners();
}

window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.jsonrpc !== "2.0") return;
  const message = event.data;
  const call = pending.get(message.id);
  if (call && ("result" in message || "error" in message)) {
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) {
      const messageText = String(message.error.message || "");
      // Permission/cancellation responses must never trigger an automatic resubmission.
      const rejected = /denied|not allowed|permission|declin|reject/i.test(
        messageText,
      );
      const canceled = /cancel|abort/i.test(messageText);
      const invalid = [-32600, -32601, -32602].includes(message.error.code);
      call.reject(
        new ApiError(
          rejected
            ? "The host declined this change."
            : invalid
              ? "The host rejected this request."
              : "The host did not confirm the operation. It may have reached the server.",
          rejected
            ? "permission_denied"
            : canceled
              ? "cancelled"
              : invalid
                ? "validation_error"
                : message.error.code === -32603
                  ? "internal_error"
                  : "bridge",
          !rejected && !invalid,
        ),
      );
    } else call.resolve(message.result);
  } else if (message.method === "ui/notifications/tool-input") {
    const args: Args = message.params?.arguments || {};
    mutationInput = "request_id" in args;
    hostState.errorIsWrite = mutationInput;
    hostState.error = "";
    // Write arguments are never list filters. A capture/undo gets its task ID from the result.
    hostState.input = mutationInput
      ? typeof args.task_id === "string"
        ? { task_id: args.task_id, include_deleted: true }
        : {}
      : args;
    hostState.canRefresh = !mutationInput || typeof args.task_id === "string";
    notifyListeners();
  } else if (message.method === "ui/notifications/tool-result") {
    acceptResult(message.params || {});
  } else if (message.method === "ui/notifications/tool-cancelled") {
    hostState.error = mutationInput
      ? "Request canceled before confirmation. A change may have been saved."
      : "The host canceled this request.";
    notifyListeners();
  } else if (message.method === "ui/notifications/host-context-changed")
    applyContext(message.params);
  else if (message.method === "ping")
    parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
  if (message.method === "ui/notifications/host-context-changed")
    notifyListeners();
});
export const ready = request("ui/initialize", {
  appInfo: { name: "private-gtd-cards", version: "0.11.0" },
  appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  protocolVersion: "2026-01-26",
})
  .then((value) => {
    applyContext((value as { hostContext?: HostContext }).hostContext);
    hostState.canMessage = !!(value as {hostCapabilities?: {message?: {text?: {}}}}).hostCapabilities?.message?.text;
    notifyListeners();
    notify("ui/notifications/initialized", {});
  })
  .catch((error) => {
    hostState.error = error.message;
    notifyListeners();
    throw error;
  });
void ready.catch(() => {});
export async function reopenGtd() {
  await ready;
  // Ask for a new card; never unlock this instance or replay its pending work.
  const result = await request("ui/message", {
    role: "user",
    content: [{type: "text", text: "Open a fresh GTD Home card with show_gtd in the current environment. Do not resume or retry any changes from the ended card."}],
  }) as {isError?: boolean};
  if (result.isError) throw new Error("The host could not reopen GTD.");
}
export async function requestDisplayMode() {
  await ready;
  if (
    hostState.context.availableDisplayModes &&
    !hostState.context.availableDisplayModes.includes("fullscreen")
  )
    return "inline";
  const result = (await request(
    "ui/request-display-mode",
    { mode: "fullscreen" },
    4000,
  )) as { mode?: string };
  // An acknowledgement may precede the host-context notification.
  if (result.mode === "fullscreen") {
    applyContext({ displayMode: "fullscreen" });
    notifyListeners();
  }
  return result.mode;
}
const stopHeight = observeHostHeight((height) => {
  notify("ui/notifications/size-changed", { height });
});
window.addEventListener("pagehide", () => {
  stopHeight();
  for (const call of pending.values()) {
    clearTimeout(call.timer);
    call.reject(
      new ApiError(
        "The card closed before confirmation.",
        "bridge_closed",
        true,
      ),
    );
  }
  pending.clear();
});
const transport: Api = {
  identityScope: () => widgetIdentity.expected ? `${widgetEnvironment.expected}:${widgetIdentity.expected}` : undefined,
  async openLink(url) {
    await ready;
    const result = (await request("ui/open-link", { url })) as {
      isError?: boolean;
    };
    if (result?.isError) throw new Error("Could not open link");
  },
  async call<T>(name: string, args: Args): Promise<T> {
    await ready;
    widgetEnvironment.assert();
    widgetIdentity.assert();
    const result = (await request("tools/call", {
      ...uiCall(name, args),
      _meta: { ...(widgetEnvironment.expected ? {"gtd/expectedEnvironment": widgetEnvironment.expected} : {}), ...widgetIdentity.metadata() },
    })) as HostResult;
    if (result.isError && Array.isArray(result._meta?.["mcp/www_authenticate"])) widgetIdentity.reject();
    widgetIdentity.observe(result);
    const data = result.structuredContent as {environment?: string; code?: string} | undefined;
    if (data?.code === "environment_changed") widgetEnvironment.reject();
    widgetEnvironment.observe(data?.environment);
    if (result.isError) {
      const error = result.structuredContent as
        { code?: string; message?: string } | undefined;
      throw new ApiError(
        error?.message || "The operation was rejected.",
        error?.code || "tool_error",
        error?.code === "storage_error" || error?.code === "internal_error",
      );
    }
    if (!result.structuredContent)
      throw new ApiError(
        "The host returned an incomplete response.",
        "response",
        true,
      );
    return result.structuredContent as T;
  },
};
const reads = widgetReads({
  ...transport,
  identityScope: () => `${transport.identityScope?.() || "legacy"}:${defaultZone}`,
}, () => {
  widgetEnvironment.assert();
  widgetIdentity.assert();
}, () => ({ account: widgetIdentity.expected, environment: widgetEnvironment.expected }),
() => window.dispatchEvent(new Event("gtd:views-refreshed")));
widgetIdentity.subscribe(reads.clear);
widgetEnvironment.subscribe(reads.clear);
function revalidateVisibleWidget() {
  if (!document.hidden) reads.revalidate();
}
document.addEventListener("visibilitychange", revalidateVisibleWidget);
window.addEventListener("focus", revalidateVisibleWidget);
window.addEventListener("pointerdown", revalidateVisibleWidget, true);
window.addEventListener("keydown", revalidateVisibleWidget, true);
export const adapterApi: Api = { ...reads.api, identityScope: transport.identityScope };

// Some ChatGPT hosts deliver the launch result through globals as well as
// postMessage. Only the authenticated envelope is eligible. Subsequent calls
// still use the bridge that carries GTD's account equality binding.
let receivedLegacy: unknown;
function acceptLegacyLaunch() {
  if (hostState.launch || hostState.result || hostState.projects || widgetIdentity.blocked) return;
  const globals = (window as Window & { openai?: {
    toolInput?: Args;
    toolResponseMetadata?: { mcp_tool_result?: HostResult; call_tool_result?: HostResult };
  } }).openai;
  const metadata = globals?.toolResponseMetadata;
  const result = metadata?.mcp_tool_result ?? metadata?.call_tool_result;
  if (!result?.structuredContent || !result._meta?.["gtd/accountId"] || result === receivedLegacy) return;
  receivedLegacy = result;
  if (globals?.toolInput) hostState.input = globals.toolInput;
  acceptResult(result);
}
window.addEventListener("openai:set_globals", acceptLegacyLaunch);
queueMicrotask(acceptLegacyLaunch);
