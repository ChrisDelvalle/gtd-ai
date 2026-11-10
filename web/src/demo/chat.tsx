import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
  Maximize2,
} from "lucide-react";
import { cardCount, scenarios, type ScenarioId } from "./scenarios";
import { StreamedReply } from "./streamed-reply";
import { InboxPreview } from "./inbox";
import { DemoConversations } from "./conversations";
import { loadDemo } from "./bootstrap";
import { useViewerPane } from "./viewer-pane";
import { CopyMessage } from "./copy-message";
import { useDemoTheme } from "./theme";
type Progress = {
  sent: boolean;
  stage: number;
  response: string;
  cards: Record<number, { height: number; ready: boolean }>;
  error?: string;
};
const initial = () =>
  Object.fromEntries(
    scenarios.map((s) => [
      s.id,
      {
        sent: false,
        stage: 0,
        response: "",
        cards: Object.fromEntries(
          Array.from({ length: cardCount(s.id) }, (_, i) => [
            i,
            { height: 450, ready: false },
          ]),
        ),
      },
    ]),
  ) as Record<ScenarioId, Progress>;
const selected = (): ScenarioId =>
  scenarios.find((s) => s.id === location.hash.slice(1))?.id || "pickup";
function Chat() {
  const [current, setCurrent] = useState(selected),
    [progress, setProgress] = useState(initial);
  const [theme, toggleTheme] = useDemoTheme();
  const [sidebar, setSidebar] = useState(() => innerWidth >= 1000),
    [expanded, setExpanded] = useState<string | null>(null);
  const [sessions] = useState(() => new DemoConversations(loadDemo));
  const [closing, setClosing] = useState(false);
  const viewer = useViewerPane();
  const stages = useRef(new Set<ReturnType<typeof setTimeout>>());
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frames = useRef(new Map<string, HTMLIFrameElement>()),
    closeButton = useRef<HTMLButtonElement>(null),
    sidebarButton = useRef<HTMLButtonElement>(null);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  function preserveCaption(key: string) {
    const element = frames.current
      .get(key)
      ?.closest(".chat-result-body")
      ?.querySelector<HTMLElement>(".tool-caption");
    if (element)
      anchor.current = { element, top: element.getBoundingClientRect().top };
  }
  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = null;
    if (saved?.element.isConnected) {
      const scroll = saved.element.closest(".chat-scroll");
      if (scroll)
        scroll.scrollTop +=
          saved.element.getBoundingClientRect().top - saved.top;
    }
  }, [expanded]);
  const context = useRef({ theme, expanded });
  context.current = { theme, expanded };
  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setClosing(false);
  }
  function dismissCard(key: string) {
    if (closeTimer.current) return;
    const finish = () => {
      closeTimer.current = null;
      preserveCaption(key);
      setExpanded(null);
      setClosing(false);
      viewer.reset();
      post(key, "restore-focus");
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else {
      setClosing(true);
      closeTimer.current = setTimeout(finish, 260);
    }
  }
  function post(key: string, type: string, data: Record<string, unknown> = {}) {
    const [id, card] = key.split(":");
    frames.current
      .get(key)
      ?.contentWindow?.postMessage(
        { demo: "gtd-ai", id, card: Number(card), type, ...data },
        location.origin,
      );
  }
  useEffect(() => {
    for (const id of frames.current.keys())
      post(id, "context", {
        theme,
        mode: expanded === id ? "fullscreen" : "inline",
      });
  }, [theme, expanded]);
  useEffect(() => {
    if (expanded) closeButton.current?.focus({ preventScroll: true });
  }, [expanded]);
  useEffect(() => {
    const hash = () => {
      cancelClose();
      viewer.reset();
      setCurrent(selected());
      setExpanded(null);
    };
    const message = async (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.demo !== "gtd-ai")
        return;
      const id = event.data.id as ScenarioId;
      const card = event.data.card;
      const key = `${id}:${card}`;
      if (
        !scenarios.some((s) => s.id === id) ||
        !Number.isInteger(card) ||
        card < 0 ||
        card >= cardCount(id) ||
        event.source !== frames.current.get(key)?.contentWindow
      )
        return;
      if (["ready", "rendered", "call"].includes(event.data.type)) {
        try {
          const { store, script } = await sessions.get(id);
          if (event.source !== frames.current.get(key)?.contentWindow) return;
          if (event.data.type === "ready") {
            post(key, "context", {
              theme: context.current.theme,
              mode: context.current.expanded === key ? "fullscreen" : "inline",
            });
            post(key, "launch", {
              launch:
                card === 0
                  ? script.launch
                  : script.additionalLaunches?.[card - 1],
            });
          }
          if (event.data.type === "rendered")
            setProgress((p) => {
              const cards = {
                ...p[id].cards,
                [card]: { ...p[id].cards[card], ready: true },
              };
              return {
                ...p,
                [id]: {
                  ...p[id],
                  cards,
                  response: Object.values(cards).every((c) => c.ready)
                    ? script.response
                    : "",
                },
              };
            });
          if (event.data.type === "call") {
            const revision = store.changes.length;
            const result = store.execute(event.data.name, event.data.args);
            post(key, "result", { request: event.data.request, result });
            if (store.changes.length !== revision) {
              for (let i = 0; i < cardCount(id); i++)
                if (i !== card) post(`${id}:${i}`, "changed");
            }
          }
        } catch (error) {
          const failure = error as Error & { code?: string };
          if (event.data.type === "call")
            post(key, "result", {
              request: event.data.request,
              error: { message: failure.message, code: failure.code },
            });
          else
            setProgress((p) => ({
              ...p,
              [id]: { ...p[id], error: failure.message },
            }));
        }
      }
      if (
        event.data.type === "height" &&
        context.current.expanded !== key &&
        Number.isFinite(event.data.height)
      )
        setProgress((p) => ({
          ...p,
          [id]: {
            ...p[id],
            cards: {
              ...p[id].cards,
              [card]: {
                ...p[id].cards[card],
                height: Math.max(80, Math.min(450, event.data.height)),
              },
            },
          },
        }));
      if (event.data.type === "dismiss") {
        dismissCard(key);
      }
      if (event.data.type === "expand") {
        cancelClose();
        preserveCaption(key);
        setCurrent(id);
        setExpanded(key);
        setSidebar(false);
      }
    };
    addEventListener("hashchange", hash);
    addEventListener("message", message);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      for (const timer of stages.current) clearTimeout(timer);
      removeEventListener("hashchange", hash);
      removeEventListener("message", message);
    };
  }, []);
  function choose(id: ScenarioId) {
    cancelClose();
    viewer.reset();
    location.hash = id;
    setCurrent(id);
    setExpanded(null);
    if (innerWidth < 1000) setSidebar(false);
  }
  function dismiss() {
    if (expanded) dismissCard(expanded);
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
    const id = current;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setProgress((p) => ({
      ...p,
      [id]: { ...p[id], sent: true, stage: reduce ? 3 : 1 },
    }));
    if (!reduce)
      for (const [delay, stage] of [
        [400, 2],
        [850, 3],
      ]) {
        const timer = setTimeout(() => {
          stages.current.delete(timer);
          setProgress((p) => ({ ...p, [id]: { ...p[id], stage } }));
        }, delay);
        stages.current.add(timer);
      }
  }
  const script = scenarios.find((s) => s.id === current)!;
  return (
    <div
      className={`chat-demo${sidebar ? " sidebar-open" : ""}${expanded ? " has-viewer" : ""}${closing ? " viewer-closing" : ""}${viewer.full ? " viewer-full" : ""}${viewer.dragging ? " viewer-resizing" : ""}`}
      style={{ "--viewer-left": `${viewer.left}px` } as CSSProperties}
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
      <div className="conversation-area" inert={sidebar && viewer.width < 1000}>
        <header className="chat-topbar">
          <span>
            GTD AI <small>demo</small>
          </span>
          <div>
            <button
              aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={toggleTheme}
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
                    <div className="user-turn">
                      <div className="user-message">{s.prompt}</div>
                      <CopyMessage text={s.prompt} label="Copy message" />
                    </div>
                    <div className="assistant-message">
                      {!p.error && (
                        <div
                          className="work-status"
                          role="status"
                          aria-live="polite"
                        >
                          {p.stage === 1
                            ? "Working…"
                            : p.stage < 3 || !p.response
                              ? "Opening GTD…"
                              : "Worked for a few seconds"}
                        </div>
                      )}
                      {s.id === "inbox" && p.response && <InboxPreview />}
                      {p.error && (
                        <p role="alert">
                          {p.error}{" "}
                          <button onClick={() => location.reload()}>
                            Reset demo
                          </button>
                        </p>
                      )}
                      {p.stage >= 2 &&
                        Object.entries(p.cards).map(([index, card]) => {
                          const key = `${s.id}:${index}`;
                          return (
                            <div
                              key={key}
                              className="chat-result"
                              data-ready={
                                (card.ready && p.stage >= 3) || undefined
                              }
                              inert={!card.ready}
                            >
                              <div className="chat-result-body">
                                <div className="tool-caption">
                                  <PanelTop size={17} />
                                  <span>Opened GTD</span>
                                  {expanded !== key && (
                                    <button
                                      className="caption-expand"
                                      aria-label={`Expand ${index === "0" ? "GTD" : "recommended task"} card`}
                                      onClick={() => {
                                        preserveCaption(key);
                                        cancelClose();
                                        setExpanded(key);
                                        setSidebar(false);
                                      }}
                                    >
                                      <Maximize2 size={14} />
                                    </button>
                                  )}
                                </div>
                                <div
                                  className="inline-card-slot"
                                  style={{
                                    height: expanded === key ? 0 : card.height,
                                  }}
                                >
                                  <iframe
                                    className={
                                      expanded === key
                                        ? "demo-frame expanded-frame"
                                        : "demo-frame"
                                    }
                                    title={`GTD widget — ${s.title}${index === "0" ? "" : " — Recommended tasks"}`}
                                    src={`../widget/#${s.id}:${index}`}
                                    ref={(node) => {
                                      if (node) frames.current.set(key, node);
                                      else frames.current.delete(key);
                                    }}
                                    style={{
                                      height:
                                        expanded === key
                                          ? undefined
                                          : card.height,
                                    }}
                                    allow="clipboard-write"
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      {p.response && p.stage >= 3 && (
                        <StreamedReply text={p.response} />
                      )}
                    </div>
                  </>
                )}
              </div>
            </section>
          );
        })}
        <div className="composer-dock" inert={!!expanded}>
          <form
            className={`chat-composer${progress[current].sent ? " is-empty" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              id="prepared-prompt"
              aria-label="Prepared example prompt"
              readOnly
              value={progress[current].sent ? "" : script.prompt}
              rows={progress[current].sent ? 1 : 3}
            />
            <div className="composer-actions">
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
        <>
          {viewer.divider}
          <header className="viewer-toolbar">
            <span>
              <PanelTop size={16} />
              GTD
            </span>
            <div>
              {viewer.toggle}
              <button
                aria-label="Close expanded view"
                ref={closeButton}
                onClick={dismiss}
              >
                <X size={21} />
              </button>
            </div>
          </header>
        </>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Chat />);
