import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Application } from "../application";
import { WidgetSurface } from "../widget-display";
import { DemoStore } from "./store";
import { loadDemo, localLinks, preparePreferences } from "./bootstrap";
import { runScenario, scenarios, type ScenarioId } from "./scenarios";
const id = location.hash.slice(1) as ScenarioId;
if (!scenarios.some((s) => s.id === id))
  throw new Error("Unknown demo conversation.");
localLinks();
preparePreferences(id, "widget");
const send = (type: string, data: Record<string, unknown> = {}) =>
  parent.postMessage({ demo: "gtd-ai", type, id, ...data }, location.origin);
const root = createRoot(document.getElementById("root")!);
function Card({ store }: { store: DemoStore }) {
  const [mode, setMode] = useState<"inline" | "fullscreen">("inline");
  const [height, setHeight] = useState(innerHeight);
  const [theme, setTheme] = useState("dark");
  const [script, setScript] = useState<ReturnType<typeof runScenario> | null>(
    null,
  );
  useEffect(() => {
    let ran = false;
    const message = (e: MessageEvent) => {
      if (
        e.origin !== location.origin ||
        e.source !== parent ||
        e.data?.demo !== "gtd-ai" ||
        e.data.id !== id
      )
        return;
      if (e.data.type === "context") {
        setMode(e.data.mode === "fullscreen" ? "fullscreen" : "inline");
        setTheme(e.data.theme === "light" ? "light" : "dark");
      }
      if (e.data.type === "restore-focus")
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLButtonElement>(".widget-expand")
            ?.focus({ preventScroll: true }),
        );
      if (e.data.type === "run" && !ran) {
        ran = true;
        try {
          const result = runScenario(store, id);
          setScript(result);
          send("response", { text: result.response });
        } catch (error) {
          send("error", { text: String(error) });
        }
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
  }, [store]);
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
  }, [theme]);
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
  }, [mode, script]);
  if (!script) return null;
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
        api={store.api}
        embedded
        compact={mode === "inline"}
        launch={script.launch}
      />
    </WidgetSurface>
  );
}
loadDemo()
  .then((fixture) => root.render(<Card store={new DemoStore(fixture, id)} />))
  .catch((error) => send("error", { text: error.message }));
