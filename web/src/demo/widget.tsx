import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Application } from "../application";
import { WidgetSurface } from "../widget-display";
import { ApiError, type Api } from "../api";
import type { Launch } from "../app-context";
import { ZONE } from "./domain";
import { prepareClock, localLinks, preparePreferences } from "./bootstrap";
import { cardCount, scenarios, type ScenarioId } from "./scenarios";
import { systemTheme } from "./theme";
const [scenario, index] = location.hash.slice(1).split(":");
const id = scenario as ScenarioId,
  card = Number(index || 0);
if (
  !scenarios.some((s) => s.id === id) ||
  !Number.isInteger(card) ||
  card < 0 ||
  card >= cardCount(id)
)
  throw new Error("Unknown demo conversation.");
localLinks();
prepareClock();
preparePreferences(id, "widget");
const send = (type: string, data: Record<string, unknown> = {}) =>
  parent.postMessage(
    { demo: "gtd-ai", type, id, card, ...data },
    location.origin,
  );
const root = createRoot(document.getElementById("root")!);
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const api: Api = {
  identityScope: () => `demo:${id}:${ZONE}`,
  taskPreparation: "intent",
  call: (name, args) =>
    new Promise((resolve, reject) => {
      const request = ++sequence;
      pending.set(request, { resolve, reject });
      send("call", { name, args, request });
    }),
  openLink: async () => {
    throw new ApiError(
      "External links and calendar actions are unavailable in this demo.",
      "demo_limitation",
    );
  },
};
function Card() {
  const [mode, setMode] = useState<"inline" | "fullscreen">("inline");
  const [height, setHeight] = useState(innerHeight);
  const [theme, setTheme] = useState(systemTheme);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const [launch, setLaunch] = useState<Launch | null>(null);
  useEffect(() => {
    const message = (e: MessageEvent) => {
      if (
        e.origin !== location.origin ||
        e.source !== parent ||
        e.data?.demo !== "gtd-ai" ||
        e.data.id !== id ||
        e.data.card !== card
      )
        return;
      if (e.data.type === "context") {
        setMode(e.data.mode === "fullscreen" ? "fullscreen" : "inline");
        setTheme(e.data.theme === "light" ? "light" : "dark");
      }
      if (e.data.type === "restore-focus") setRestoreFocus(true);
      if (e.data.type === "launch")
        setLaunch((current) => current || e.data.launch);
      if (e.data.type === "changed")
        window.dispatchEvent(new Event("gtd:changed"));
      if (e.data.type === "result") {
        const request = pending.get(e.data.request);
        if (!request) return;
        pending.delete(e.data.request);
        if (e.data.error)
          request.reject(new ApiError(e.data.error.message, e.data.error.code));
        else request.resolve(e.data.result);
      }
    };
    const resize = () => setHeight(innerHeight);
    addEventListener("message", message);
    addEventListener("resize", resize);
    send("ready");
    return () => {
      removeEventListener("message", message);
      removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    if (launch) send("rendered");
  }, [launch]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        mode === "fullscreen" &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"], [role="menu"]')
      ) {
        event.preventDefault();
        send("dismiss");
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [mode]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  useEffect(() => {
    if (!restoreFocus || mode !== "inline") return;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(".widget-expand")
        ?.focus({ preventScroll: true });
      setRestoreFocus(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, restoreFocus]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (mode === "inline") {
        const h = document
          .querySelector(".widget-surface")
          ?.getBoundingClientRect().height;
        if (h) send("height", { height: h });
      }
    });
    observer.observe(document.getElementById("root")!);
    return () => observer.disconnect();
  }, [mode, launch]);
  if (!launch) return null;
  return (
    <WidgetSurface
      context={{
        displayMode: mode,
        theme,
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: {
          height,
          maxHeight: mode === "inline" ? 450 : height,
        },
      }}
      requestExpansion={async () => {
        setMode("fullscreen");
        send("expand");
        return "fullscreen";
      }}
    >
      <Application
        api={api}
        embedded
        compact={mode === "inline"}
        launch={launch}
      />
    </WidgetSurface>
  );
}
root.render(<Card />);
