import {
  Activity,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  Plus,
  X,
} from "lucide-react";
import {
  type Api,
  type List,
  type Projects,
  errorText,
  views,
  scopeOf,
} from "./api";
import { Mutations, useRefresh, useActions } from "./shared";
import { Workspace, type Page } from "./workspace";
import { SwipeActionsProvider } from "./swipe-actions";
import {
  AppNavigation,
  Environment,
  coalescedApi,
  type Destination,
  type Launch,
} from "./app-context";
import { Menu } from "./floating-panel";
import { navigationGroups, isDestination } from "./navigation";
import { IconButton } from "./task-row";
import { destinationUrl, urlDestination } from "./routes";
import { ViewStore } from "./view-store";
import { ViewState } from "./view-state";
import { retainedViews } from "./retained-views";
import {restorePosition, scrollPosition} from "./scroll-restoration";

function routeKey(route: Destination) {
  return JSON.stringify([route.page, route.scope || "", route.input || {}]);
}
function label(route: Destination) {
  return route.page === "Tasks"
    ? views.find(([value]) => value === route.scope)?.[1] || "Selected tasks"
    : route.page;
}
function NavigationMenu({
  current,
  go,
  capture,
  back,
}: {
  current: Destination;
  go: (route: Destination) => void;
  capture: () => void;
  back: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const choose = (route: Destination) => {
    setOpen(false);
    go(route);
  };
  return (
    <div className="app-navigation">
      {back && (
        <IconButton label="Back to previous view" onClick={back}>
          <ArrowLeft />
        </IconButton>
      )}
      <button
        ref={anchor}
        className="scope-button"
        aria-label="GTD navigation"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) anchor.current?.focus({ preventScroll: true });
          setOpen(!open);
        }}
      >
        {label(current)}
        <ChevronDown />
      </button>
      {open && (
        <Menu label="GTD views" anchor={anchor} close={() => setOpen(false)}>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              capture();
            }}
          >
            <Plus />
            Add task
          </button>
          <div role="separator" />
          <button
            role="menuitemradio"
            aria-checked={current.page === "Home"}
            onClick={() => choose({ page: "Home" })}
          >
            Home
          </button>
          <div role="separator" />
          <button role="menuitemradio" aria-checked={current.page === "Charts"} onClick={() => choose({page: "Charts"})}>Charts</button>
          {navigationGroups.map((group, i) => (
            <div key={i}>
              {i > 0 && <div role="separator" />}
              {group.map(({ label, route }) => (
                <button
                  key={label}
                  role="menuitemradio"
                  aria-checked={isDestination(current, route)}
                  onClick={() => choose(route)}
                >
                  <span>{label}</span>
                  {isDestination(current, route) && <Check />}
                </button>
              ))}
            </div>
          ))}
          <div role="separator" />
          <button
            role="menuitemradio"
            aria-checked={current.page === "Activity"}
            onClick={() => choose({ page: "Activity" })}
          >
            Activity
          </button>
        </Menu>
      )}
    </div>
  );
}

function IncomingResults({
  launch,
  refresh,
}: {
  launch?: Launch | null;
  refresh: () => void;
}) {
  const { controller } = useActions();
  const previous = useRef<unknown>(null);
  useEffect(() => {
    const data = launch?.initial || launch?.projects;
    if (!data || data === previous.current) return;
    const hadResult = previous.current !== null;
    previous.current = data;
    controller.observe("items" in data ? data.items : data.projects);
    // A late host result can update authoritative records, never the route or drafts.
    if (hadResult) refresh();
  }, [launch?.initial, launch?.projects, controller, refresh]);
  return null;
}

function HostResultNotice({
  launch,
  api,
  refresh,
}: {
  launch?: Launch | null;
  api: Api;
  refresh: () => void;
}) {
  const { controller } = useActions();
  const first = useRef(true);
  const [fault, setFault] = useState<Launch | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState("");
  useEffect(() => {
    if (!launch) return;
    if (first.current) {
      first.current = false;
      return;
    }
    if (launch.error) {
      setFault(launch);
      setOpen(false);
      setRetryError("");
    }
  }, [launch?.error]);
  if (!fault) return null;
  async function retry() {
    if (!fault || busy) return;
    setBusy(true);
    try {
      const result = await api.call<List & Projects>(
        fault.page === "Projects" ? "list_projects" : "list_items",
        fault.input || {},
      );
      controller.observe(result.items || result.projects || []);
      setFault(null);
      refresh();
    } catch (error) {
      setRetryError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="host-notice">
      <IconButton
        label="View connection problem"
        onClick={() => setOpen(!open)}
      >
        <AlertCircle />
      </IconButton>
      {open && (
        <div role="alert">
          <p>{retryError || fault.error}</p>
          <div>
            {fault.canRefresh && (
              <button disabled={busy} onClick={() => void retry()}>
                {busy ? "Retrying…" : "Retry refresh"}
              </button>
            )}
            <IconButton
              label="Dismiss connection problem"
              onClick={() => setFault(null)}
            >
              <X />
            </IconButton>
          </div>
        </div>
      )}
    </div>
  );
}

export function Application({
  api: source,
  embedded = false,
  compact = false,
  launch,
  test = false,
  admin,
  account,
  retainedScreenLimit = Infinity,
}: {
  api: Api;
  embedded?: boolean;
  compact?: boolean;
  launch?: Launch | null;
  test?: boolean | "demo";
  account?: ReactNode;
  retainedScreenLimit?: number;
  admin?: (
    page: Page,
    revision: number,
    onSelect: (id: string) => void,
  ) => ReactNode;
}) {
  const api = useMemo(() => coalescedApi(source), [source]);
  const [revision, advanceRevision] = useRefresh();
  const [refreshGeneration, advanceRefreshGeneration] = useRefresh();
  const refresh = useCallback(() => {
    api.invalidateReads?.();
    advanceRefreshGeneration();
    advanceRevision();
  }, [api, advanceRevision, advanceRefreshGeneration]);
  const [entries, setEntries] = useState<Record<string, Launch>>(() =>
    launch ? { [routeKey(launch)]: launch } : {},
  );
  const [current, setCurrent] = useState<string | null>(() =>
    launch ? routeKey(launch) : null,
  );
  const [history, setHistory] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const [viewStore] = useState(()=>new ViewStore());
  useLayoutEffect(()=>{
    if(current) setRecent(previous=>[current,...previous.filter(key=>key!==current)]);
  },[current]);
  const browserIndex = useRef(0);
  const browserSession = useRef(crypto.randomUUID());
  const savedUrls = useRef(new Map<string, string>());
  const sectionRoutes = useRef(new Map<string, Destination>());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const started = useRef(false),
    positions = useRef(new Map<string, number>());
  const remember = () => {
    if (current)
      positions.current.set(current, scrollPosition());
  };
  const enter = (route: Launch, mode: "push" | "replace" | "pop" = "push") => {
    const normalized = {
      ...route,
      ...(route.page === "Tasks"
        ? {
            scope:
              route.scope === "planned"
                ? "blocked"
                : route.scope || scopeOf(route.input || {}),
          }
        : {}),
    };
    const key = routeKey(normalized);
    sectionRoutes.current.set(normalized.page, normalized);
    remember();
    setEntries((old) => (old[key] ? old : { ...old, [key]: normalized }));
    setCurrent(key);
    if (!embedded && mode !== "pop") {
      const url = savedUrls.current.get(key) || destinationUrl(normalized);
      savedUrls.current.set(key, url);
      if (mode === "push") browserIndex.current++;
      window.history[mode === "push" ? "pushState" : "replaceState"](
        {
          gtdSession: browserSession.current,
          key,
          index: browserIndex.current,
        },
        "",
        url,
      );
    }
  };
  useEffect(() => {
    if (started.current || (embedded && !launch)) return;
    started.current = true;
    enter(
      (!embedded && urlDestination(window.location)) ||
        launch || { page: "Home" },
      "replace",
    );
  }, [launch, embedded]);
  const enterRef = useRef(enter);
  enterRef.current = enter;
  const rememberRef = useRef(remember);
  rememberRef.current = remember;
  useEffect(() => {
    if (embedded) return;
    const restoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const pop = (event: PopStateEvent) => {
      const route = urlDestination(window.location);
      if (!route) return;
      rememberRef.current();
      const state = event.state;
      browserIndex.current =
        state?.gtdSession === browserSession.current ? state.index : 0;
      if (
        state?.gtdSession === browserSession.current &&
        entriesRef.current[state.key]
      ) {
        const entry = entriesRef.current[state.key];
        sectionRoutes.current.set(entry.page, entry);
        setCurrent(state.key);
      } else enterRef.current(route, "pop");
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      window.history.scrollRestoration = restoration;
    };
  }, [embedded]);
  useEffect(() => {
    window.addEventListener("gtd:changed", refresh);
    const visible = () => {
      if (embedded && !document.hidden) advanceRevision();
    };
    const viewsRefreshed = () => {
      advanceRefreshGeneration();
      advanceRevision();
    };
    if (embedded) window.addEventListener("gtd:views-refreshed", viewsRefreshed);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("gtd:changed", refresh);
      if (embedded) window.removeEventListener("gtd:views-refreshed", viewsRefreshed);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, embedded, advanceRevision, advanceRefreshGeneration]);
  const previousCompact = useRef(compact);
  useEffect(() => {
    if (!embedded && previousCompact.current && !compact) refresh();
    previousCompact.current = compact;
  }, [compact, embedded, refresh]);
  const previousRoute = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!current) return;
    const restoreFocus = previousRoute.current !== null;
    previousRoute.current = current;
    const focusSelector = pendingFocus.current;
    pendingFocus.current = null;
    const restore = restorePosition(positions.current.get(current) || 0, focusSelector || undefined);
    const frame = requestAnimationFrame(() => {
      if (restoreFocus && embedded && compact) {
        const trigger = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="GTD navigation"]')]
          .find(element => element.getBoundingClientRect().height > 0);
        trigger?.focus({preventScroll:true});
      }
    });
    return () => {cancelAnimationFrame(frame);restore();};
  }, [current]);
  const firstEntry = useRef<string | null>(null);
  useEffect(() => {
    if (current && !firstEntry.current) firstEntry.current = current;
    if (launch?.error || (!launch?.initial && !launch?.projects)) return;
    const key = firstEntry.current;
    if (!key) return;
    setEntries((old) => {
      const entry = old[key];
      if (
        !entry?.error ||
        JSON.stringify(entry.input || {}) !== JSON.stringify(launch.input || {})
      )
        return old;
      return {
        ...old,
        [key]: {
          ...entry,
          error: "",
          canRefresh: true,
          initial: launch.initial,
          projects: launch.projects,
        },
      };
    });
  }, [launch?.initial, launch?.projects, launch?.error, current]);
  const currentRef = useRef(current);
  currentRef.current = current;
  function go(route: Destination, focusSelector?: string) {
    if (currentRef.current !== current) return;
    // Returning to a section resumes its focused record and editor. Explicit
    // nested links and the section's own Back action still choose a destination.
    if (
      !embedded &&
      !route.input &&
      entries[current || ""]?.page !== route.page &&
      (route.page === "Projects" || route.page === "Repeating")
    ) {
      route = sectionRoutes.current.get(route.page) || route;
    }
    const key = routeKey({
      ...route,
      ...(route.page === "Tasks"
        ? {
            scope:
              route.scope === "planned"
                ? "blocked"
                : route.scope || scopeOf(route.input || {}),
          }
        : {}),
    });
    if (key === current) return;
    pendingFocus.current = focusSelector || null;
    if (current) setHistory((old) => [...old, current]);
    enter(route);
  }
  const back = !embedded
    ? browserIndex.current > 0
      ? () => window.history.back()
      : null
    : history.length
      ? () => {
          remember();
          setCurrent(history.at(-1)!);
          setHistory((old) => old.slice(0, -1));
        }
      : null;
  const route = current ? entries[current] : null;
  return (
    <Environment.Provider value={{ api, embedded, compact, revision, refreshGeneration }}>
      <SwipeActionsProvider resetKey={`${current}:${compact}`}>
        <Mutations api={api} onChange={refresh} quiet>
          <IncomingResults launch={launch} refresh={refresh} />
          <HostResultNotice launch={launch} api={api} refresh={refresh} />
          {test && (
            <div className="test-mode" role="status">
              {test === "demo" ? "Demo Mode" : "Test mode · Disposable data"}
            </div>
          )}
          {!route && (
            <div className="compact-empty" role="status">
              Loading…
            </div>
          )}
          {route && (
            <AppNavigation.Provider
              value={{
                current: route,
                go,
                back,
                updateUrl: embedded
                  ? undefined
                  : (destination) => {
                      if (!current || currentRef.current !== current) return;
                      const url = destinationUrl(destination);
                      savedUrls.current.set(current, url);
                      window.history.replaceState(
                        {
                          gtdSession: browserSession.current,
                          key: current,
                          index: browserIndex.current,
                        },
                        "",
                        url,
                      );
                    },
                menu: (capture) => (
                  <NavigationMenu
                    current={route}
                    go={go}
                    back={back}
                    capture={capture}
                  />
                ),
              }}
            >
              {(Number.isFinite(retainedScreenLimit)
                ? retainedViews(current!, recent, pinned, retainedScreenLimit).flatMap(key=>entries[key] ? [[key,entries[key]] as const] : [])
                : Object.entries(entries)).map(([key, entry]) => (
                <Activity
                  key={key}
                  mode={key === current ? "visible" : "hidden"}
                >
                  <ViewState store={viewStore} id={key}>
                  <Workspace
                    initialPage={entry.page}
                    initialScope={entry.scope}
                    input={entry.input}
                    initial={entry.initial}
                    initialProjects={entry.projects}
                    initialHome={entry.home}
                    hostError={entry.error}
                    hostCanRefresh={entry.canRefresh}
                    hostErrorIsWrite={entry.errorIsWrite}
                    recheck={entry.recheck}
                    revision={revision}
                    refresh={refresh}
                    poll={advanceRevision}
                    admin={admin}
                    account={account}
                    retain={(value)=>setPinned(previous=>{
                      if(previous.has(key) === value) return previous;
                      const next=new Set(previous);if(value)next.add(key);else next.delete(key);return next;
                    })}
                  />
                  </ViewState>
                </Activity>
              ))}
            </AppNavigation.Provider>
          )}
        </Mutations>
      </SwipeActionsProvider>
    </Environment.Provider>
  );
}
