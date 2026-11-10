import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  PanelLeft,
  PanelTop,
  Sun,
  Moon,
  RotateCcw,
  X,
  ExternalLink,
} from "lucide-react";
import { scenarios, type ScenarioId } from "./scenarios";
type Progress = {
  sent: boolean;
  response: string;
  height: number;
  error?: string;
};
const initial = () =>
  Object.fromEntries(
    scenarios.map((s) => [s.id, { sent: false, response: "", height: 450 }]),
  ) as Record<ScenarioId, Progress>;
const selected = (): ScenarioId =>
  scenarios.find((s) => s.id === location.hash.slice(1))?.id || "pickup";
function Chat() {
  const [current, setCurrent] = useState(selected),
    [progress, setProgress] = useState(initial),
    [theme, setTheme] = useState("dark");
  const [sidebar, setSidebar] = useState(() => innerWidth >= 1000),
    [expanded, setExpanded] = useState<ScenarioId | null>(null);
  const frames = useRef(new Map<ScenarioId, HTMLIFrameElement>()),
    closeButton = useRef<HTMLButtonElement>(null),
    sidebarButton = useRef<HTMLButtonElement>(null);
  const context = useRef({ theme, expanded });
  context.current = { theme, expanded };
  function post(
    id: ScenarioId,
    type: string,
    data: Record<string, unknown> = {},
  ) {
    frames.current
      .get(id)
      ?.contentWindow?.postMessage(
        { demo: "gtd-ai", id, type, ...data },
        location.origin,
      );
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    for (const id of frames.current.keys())
      post(id, "context", {
        theme,
        mode: expanded === id ? "fullscreen" : "inline",
      });
    if (expanded) closeButton.current?.focus();
  }, [theme, expanded]);
  useEffect(() => {
    const hash = () => {
      setCurrent(selected());
      setExpanded(null);
    };
    const message = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.demo !== "gtd-ai")
        return;
      const id = event.data.id as ScenarioId;
      if (
        !scenarios.some((s) => s.id === id) ||
        event.source !== frames.current.get(id)?.contentWindow
      )
        return;
      if (event.data.type === "ready") {
        post(id, "context", {
          theme: context.current.theme,
          mode: context.current.expanded === id ? "fullscreen" : "inline",
        });
        post(id, "run");
      }
      if (event.data.type === "response")
        setProgress((p) => ({
          ...p,
          [id]: { ...p[id], response: String(event.data.text) },
        }));
      if (event.data.type === "height" && Number.isFinite(event.data.height))
        setProgress((p) => ({
          ...p,
          [id]: {
            ...p[id],
            height: Math.max(80, Math.min(450, event.data.height)),
          },
        }));
      if (event.data.type === "dismiss") {
        setExpanded(null);
        post(id, "restore-focus");
      }
      if (event.data.type === "expand") {
        setCurrent(id);
        setExpanded(id);
        setSidebar(false);
      }
      if (event.data.type === "error")
        setProgress((p) => ({
          ...p,
          [id]: { ...p[id], error: String(event.data.text) },
        }));
    };
    addEventListener("hashchange", hash);
    addEventListener("message", message);
    return () => {
      removeEventListener("hashchange", hash);
      removeEventListener("message", message);
    };
  }, []);
  function choose(id: ScenarioId) {
    location.hash = id;
    setCurrent(id);
    setExpanded(null);
    if (innerWidth < 1000) setSidebar(false);
  }
  function dismiss() {
    setExpanded(null);
    post(current, "restore-focus");
  }
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && expanded) {
        e.preventDefault();
        dismiss();
      }
    };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, [expanded, current]);
  function send() {
    if (progress[current].sent) return;
    setProgress((p) => ({ ...p, [current]: { ...p[current], sent: true } }));
  }
  const script = scenarios.find((s) => s.id === current)!;
  return (
    <div
      className={`chat-demo${sidebar ? " sidebar-open" : ""}${expanded ? " has-viewer" : ""}`}
    >
      <nav className="chat-rail" aria-label="Demo navigation">
        <button
          ref={sidebarButton}
          aria-label={sidebar ? "Close sidebar" : "Open sidebar"}
          aria-expanded={sidebar}
          onClick={() => setSidebar(!sidebar)}
        >
          <PanelLeft size={20} />
        </button>
        <a href="../website/" aria-label="Website demo">
          <PanelTop size={20} />
        </a>
      </nav>
      {sidebar && (
        <button
          className="chat-scrim"
          aria-label="Close sidebar"
          onClick={() => {
            setSidebar(false);
            sidebarButton.current?.focus();
          }}
        />
      )}
      <aside
        className="chat-sidebar"
        aria-label="Conversations"
        inert={!sidebar}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setSidebar(false);
            sidebarButton.current?.focus();
          }
        }}
      >
        <div className="chat-brand">
          GTD AI <span>demo</span>
        </div>
        <div className="chat-sidebar-heading">Chats</div>
        {scenarios.map((s) => (
          <button
            key={s.id}
            className="chat-history-row"
            aria-current={s.id === current ? "page" : undefined}
            onClick={() => choose(s.id)}
          >
            {s.title}
          </button>
        ))}
        <div className="chat-sidebar-footer">
          <a href="../website/">
            Explore the website <ExternalLink size={15} />
          </a>
          <button onClick={() => location.reload()}>
            <RotateCcw size={16} />
            Reset demo
          </button>
        </div>
      </aside>
      <div className="conversation-area">
        <header className="chat-topbar">
          <span>
            GTD AI <small>demo</small>
          </span>
          <div>
            <button
              aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <button aria-label="Reset demo" onClick={() => location.reload()}>
              <RotateCcw size={18} />
            </button>
          </div>
        </header>
        {scenarios.map((s) => {
          const p = progress[s.id];
          return (
            <section
              className="chat-scroll"
              key={s.id}
              hidden={current !== s.id}
              aria-label={s.title}
            >
              <div className={`chat-thread${p.sent ? "" : " unsent"}`}>
                {!p.sent && <h1>{s.title}</h1>}
                {p.sent && (
                  <>
                    <div className="user-message">{s.prompt}</div>
                    <div className="assistant-message">
                      {p.response ? (
                        p.response
                          .split("\n\n")
                          .map((text, i) => <p key={i}>{text}</p>)
                      ) : (
                        <p role="status">Opening GTD…</p>
                      )}
                      {p.error && (
                        <p role="alert">
                          {p.error}{" "}
                          <button onClick={() => location.reload()}>
                            Reset demo
                          </button>
                        </p>
                      )}
                      <div className="tool-caption">
                        <PanelTop size={17} />
                        <span>Opened GTD</span>
                      </div>
                      <div
                        className="inline-card-slot"
                        style={{ height: p.height }}
                      >
                        <iframe
                          className={
                            expanded === s.id
                              ? "demo-frame expanded-frame"
                              : "demo-frame"
                          }
                          title={`GTD widget — ${s.title}`}
                          src={`../widget/#${s.id}`}
                          ref={(node) => {
                            if (node) frames.current.set(s.id, node);
                            else frames.current.delete(s.id);
                          }}
                          style={{
                            height: expanded === s.id ? undefined : p.height,
                          }}
                          allow="clipboard-write"
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </section>
          );
        })}
        <div className="composer-dock" inert={!!expanded}>
          <form
            className="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label className="composer-label" htmlFor="prepared-prompt">
              {progress[current].sent
                ? "Explore the card, or choose another chat"
                : "Prepared example"}
            </label>
            <textarea
              id="prepared-prompt"
              aria-label="Prepared example prompt"
              readOnly
              value={progress[current].sent ? "" : script.prompt}
              rows={progress[current].sent ? 1 : 3}
              placeholder="The card is yours to explore"
            />
            <div className="composer-actions">
              <span>Browser-local demo</span>
              <button
                type="submit"
                aria-label="Send prepared example"
                disabled={progress[current].sent}
              >
                <ArrowUp size={22} />
              </button>
            </div>
          </form>
        </div>
      </div>
      {expanded && (
        <header className="viewer-toolbar">
          <span>
            <PanelTop size={16} />
            GTD
          </span>
          <div>
            <button
              aria-label="Close expanded view"
              ref={closeButton}
              onClick={dismiss}
            >
              <X size={21} />
            </button>
          </div>
        </header>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Chat />);
