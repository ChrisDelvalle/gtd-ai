import "./input-modality";
import { uiCall } from "./ui-call";
import { EnvironmentBoundary } from "./environment-boundary";
import { widgetIdentity, type HostResult } from "./widget-identity";
import { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";
import {
  type Api,
  type Args,
  type List,
  type Task,
  ApiError,
  errorText,
  time,
} from "./api";
import { Mutations, TaskLine, Inspector } from "./shared";

type ChatGPTHost = {
  toolInput?: Args | null;
  toolOutput?: unknown;
  toolResponseMetadata?: Record<string, unknown>;
  theme?: string;
  openExternal?(args: { href: string }): void;
  callTool(name: string, args: Args): Promise<HostResult>;
  notifyIntrinsicHeight?(height: number): void;
};
const compatibilityMode = document.documentElement.dataset.bridge === "chatgpt";
const chatgptHost = () => (window as Window & { openai?: ChatGPTHost }).openai;

// Set handlers before connecting: the host may deliver input/results during connect.
const bridge = new App(
  { name: "private-gtd-cards", version: "0.2.0" },
  { availableDisplayModes: ["inline"] },
  { autoResize: true },
);
let initial: List | null = null;
let input: Args = {};
let connectionError = "";
const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((fn) => fn());
}
bridge.ontoolinput = (params) => {
  input = params.arguments || {};
  notify();
};
bridge.ontoolresult = (params) => {
  try { widgetIdentity.observe(params); } catch { return; }
  if (params.isError) {
    connectionError = "The task view could not be loaded.";
  } else if (
    params.structuredContent &&
    Array.isArray((params.structuredContent as Record<string, unknown>).items)
  ) {
    initial = params.structuredContent as unknown as List;
    connectionError = "";
  }
  notify();
};
bridge.ontoolcancelled = () => {
  connectionError = "The host canceled this request.";
  notify();
};
bridge.onhostcontextchanged = (ctx) => {
  document.documentElement.dataset.theme = ctx.theme || "light";
};
async function connectChatGPT() {
  const apply = (globals: Partial<ChatGPTHost>) => {
    if (globals.toolInput) input = globals.toolInput;
    const output = globals.toolOutput as List | undefined;
    // The legacy two-argument bridge cannot carry account equality metadata.
    // Authenticated deployments use the standard bridge; old cards must reopen.
    if (output && (document.documentElement.dataset.accountRequired === "true" || globals.toolResponseMetadata?.["gtd/accountId"])) {
      try { widgetIdentity.reject(); } catch { return; }
    }
    if (output && Array.isArray(output.items)) {
      initial = output;
      connectionError = "";
    }
    if (globals.theme) document.documentElement.dataset.theme = globals.theme;
    notify();
  };
  // ChatGPT injects the bridge before the app, but data may arrive later.
  window.addEventListener("openai:set_globals", (event) => {
    const globals = (event as CustomEvent<{ globals?: Partial<ChatGPTHost> }>)
      .detail?.globals;
    apply(globals || chatgptHost() || {});
  });
  const host = await new Promise<ChatGPTHost>((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const host = chatgptHost();
      if (typeof host?.callTool === "function") resolve(host);
      else if (Date.now() - started > 15000)
        reject(new Error("ChatGPT did not provide its app bridge."));
      else setTimeout(check, 50);
    };
    check();
  });
  apply(host);
  let resizePending = false;
  const observer = new ResizeObserver(() => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      host.notifyIntrinsicHeight?.(
        Math.ceil(document.body.getBoundingClientRect().height),
      );
    });
  });
  observer.observe(document.body);
}
const connected = (compatibilityMode ? connectChatGPT() : bridge.connect())
  .then(() => {
    if (!compatibilityMode) {
      document.documentElement.dataset.theme =
        bridge.getHostContext()?.theme || "light";
    }
  })
  .catch((e) => {
    connectionError = errorText(e);
    notify();
    throw e;
  });
void connected.catch(() => {});
const api: Api = {
  async openLink(url) {
    await connected;
    if (compatibilityMode) {
      const host = chatgptHost();
      if (!host?.openExternal) throw new Error("Links unavailable");
      host.openExternal({ href: url });
    } else {
      const result = await bridge.openLink({ url });
      if (result.isError) throw new Error("Could not open link");
    }
  },
  async call<T>(name: string, args: Args): Promise<T> {
    await connected;
    widgetIdentity.assert();
    let result;
    try {
      const call = uiCall(name, args);
      result = compatibilityMode
        ? await chatgptHost()!.callTool(call.name, call.arguments)
        : await bridge.callServerTool({ ...call, _meta: widgetIdentity.metadata() });
    } catch {
      throw new ApiError(
        "The host did not confirm the result. Check your connection and retry the same request.",
        "bridge",
        true,
      );
    }
    widgetIdentity.observe(result);
    if (result.isError) {
      const e = result.structuredContent as
        { code?: string; message?: string } | undefined;
      throw new ApiError(
        e?.message || "The operation was rejected.",
        e?.code || "tool_error",
        e?.code === "internal_error" || e?.code === "storage_error",
      );
    }
    return result.structuredContent as T;
  },
};
function Widget() {
  const [result, setResult] = useState<List | null>(initial),
    [selected, setSelected] = useState<Task | null>(null),
    [error, setError] = useState(connectionError),
    [checked, setChecked] = useState(""),
    [busy, setBusy] = useState(false);
  const filters = useRef<Args>(input);
  useEffect(() => {
    const update = () => {
      filters.current = input;
      if (initial) {
        setResult(initial);
        setChecked(new Date().toISOString());
      }
      setError(connectionError);
    };
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  async function refresh(offset?: number) {
    setBusy(true);
    try {
      const r = await api.call<List>("list_items", {
        ...filters.current,
        detail: "full",
        offset: offset ?? filters.current.offset ?? 0,
      });
      setResult(r);
      filters.current = {
        ...filters.current,
        detail: "full",
        offset: offset ?? filters.current.offset ?? 0,
      };
      if (selected) {
        const s = await api.call<List>("list_items", {
          task_id: selected.id,
          include_deleted: true,
        });
        if (s.items[0]) setSelected(s.items[0]);
      }
      setChecked(new Date().toISOString());
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="widget-shell">
      <header className="widget-header">
        <div>
          <div className="eyebrow">PRIVATE GTD</div>
          <h2>Your next steps.</h2>
        </div>
        <button disabled={busy || !result} onClick={() => refresh()}>
          ↻ Refresh
        </button>
      </header>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <Mutations api={api} onChange={() => void refresh()}>
        {!result ? (
          <p className="empty">Waiting for the host to deliver your tasks…</p>
        ) : selected ? (
          <>
            <button className="link" onClick={() => setSelected(null)}>
              ← Back to tasks
            </button>
            <Inspector
              key={selected.id}
              task={selected}
              api={api}
              compact
              onTask={setSelected}
            />
          </>
        ) : (
          <>
            <div>
              {result.items.map((task) => (
                <TaskLine
                  key={task.id}
                  task={task}
                  selected={false}
                  onSelect={() => {
                    void api
                      .call<List>("list_items", {
                        task_id: task.id,
                        include_deleted: true,
                      })
                      .then((r) => setSelected(r.items[0] || null))
                      .catch((e) => setError(errorText(e)));
                  }}
                />
              ))}
            </div>
            {!result.items.length && (
              <p className="empty">No tasks match this view.</p>
            )}
            <div className="pagination">
              <button
                disabled={!filters.current.offset || busy}
                onClick={() => refresh(0)}
              >
                First page
              </button>
              {result.next_offset !== null && (
                <button
                  disabled={busy}
                  onClick={() => refresh(result.next_offset!)}
                >
                  More tasks →
                </button>
              )}
            </div>
          </>
        )}
      </Mutations>
      {checked && (
        <small className="refresh-note">
          Loaded {time(checked)} · Select a task for quick actions.
        </small>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<EnvironmentBoundary guard={widgetIdentity} conceal><Widget /></EnvironmentBoundary>);
