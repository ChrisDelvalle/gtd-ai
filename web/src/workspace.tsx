import { useDraftFields, useDraftRef } from "./use-record-draft";
import { useViewState } from "./view-state";
import { ImportanceField } from "./planning-fields";
import { Repeating } from "./lazy-recurrence";
import { SidebarContents } from "./sidebar";
import {
  Activity as RetainedView,
  useState,
  useId,
  useEffect,
  useRef,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
  type RefObject,
} from "react";
import { TaskExpansion } from "./task-expansion";
import { flushSync } from "react-dom";
import { useMobileGestures, useKeyboardInset, useDrawerFocus } from "./mobile";
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  RefreshCw,
  Menu,
  Folder,
  Plus,
  SquarePen,
  Search,
  X,
} from "lucide-react";
import {
  type Api,
  type Task,
  type List,
  type Projects,
  type Args,
  type Importance,
  errorText,
  scopeArgs,
  today,
} from "./api";
import {
  Inspector,
  usePolling,
  useActions,
  useTaskState,
  Recovery,
  SaveIcon,
} from "./shared";
import { IconButton, TaskRow } from "./task-row";
import { TaskList } from "./task-list";
import { Help } from "./help";
import { Charts } from "./charts";
import { Results } from "./results";
import { Home } from "./home";
import { ProjectBrowser, Review, Activity } from "./lazy-pages";
import { SecondaryPages } from "./secondary-pages";

import { Environment, useAppNavigation, useEnvironment } from "./app-context";
import { PageReads, usePageRefresh } from "./page-refresh";
import { useExpandedView } from "./expanded-view";
function useMedia(query: string) {
  return useSyncExternalStore(
    (changed) => {
      const media = matchMedia(query);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

export type Page =
  | "Repeating"
  | "Projects"
  | "Review"
  | "Home"
  | "Tasks"
  | "Activity"
  | "Charts"
  | "Results"
  | "Logs"
  | "Health"
  | "Users"
  | "Help";
export function Workspace({
  revision,
  refresh,
  poll = refresh,
  initialPage = "Home",
  initialScope = "active",
  input = {},
  initial,
  initialProjects,
  initialHome,
  hostError = "",
  hostCanRefresh = true,
  hostErrorIsWrite = false,
  recheck = false,
  admin,
  account,
  sidebarContent,
  retain,
}: {
  revision: number;
  refresh: () => void;
  poll?: () => void;
  initialPage?: Page;
  initialScope?: string;
  input?: Args;
  initial?: List | null;
  initialProjects?: import("./api").Projects | null;
  initialHome?: import("./api").HomeSnapshot | null;
  hostError?: string;
  hostCanRefresh?: boolean;
  hostErrorIsWrite?: boolean;
  recheck?: boolean;
  account?: ReactNode;
  sidebarContent?: ReactNode;
  retain?: (value: boolean) => void;
  admin?: (
    page: Page,
    revision: number,
    onSelect: (id: string) => void,
  ) => ReactNode;
}) {
  const environment = useEnvironment();
  const { compact, embedded } = environment;
  const {
    api,
    track,
    refreshing: pulling,
    refreshRevision,
    requestRefresh,
  } = usePageRefresh(environment.api, revision, refresh);
  const app = useAppNavigation();
  const { drafts: sessionDrafts } = useActions();
  const expanded = useExpandedView();
  const page = initialPage;
  const [scope, setScope] = useViewState("workspace:scope", initialScope),
    [sidebar, setSidebar] = useState(false);
  const desktop = useMedia("(min-width: 1041px)"),
    phone = useMedia("(max-width: 760px)"),
    [draftEpoch, setDraftEpoch] = useViewState("workspace:draftEpoch", 0),
    [expandedTaskId] = useState<string>();
  const shell = useRef<HTMLDivElement>(null),
    main = useRef<HTMLElement>(null),
    refreshContent = useRef<HTMLDivElement>(null),
    drawer = useRef<HTMLElement>(null),
    inspector = useRef<HTMLElement>(null),
    inspectorReturn = useRef<HTMLElement | null>(null),
    draftDialog = useRef<HTMLElement>(null),
    draftReturn = useRef<HTMLElement | null>(null);
  const captureKey = `capture:${page}:${initialScope}:${input.task_id || input.project_id || input.series_id || ""}`;
  const captureFields = useDraftFields(
    captureKey,
    () => ({ open: false, title: "" }),
    (v) => !!v.title.trim(),
  );
  const [captureOpen, setCaptureOpen] = captureFields("open");
  const [captureTitle, setCaptureTitle] = captureFields("title");
  const captureButton = useRef<HTMLButtonElement>(null);
  const captureId = useId();
  const captureAtTop = embedded && !compact;
  const taskPage = page === "Tasks" || page === "Home";
  const [projectId] = useState<string | null>(
    typeof input.project_id === "string" ? input.project_id : null,
  );
  const [selected, setSelected] = useViewState<Task | null>(
      "workspace:selected",
      null,
    ),
    [panel, setPanel] = useViewState<"edit" | "history" | "agent-notes">(
      "workspace:panel",
      "edit",
    ),
    [dirty, setDirty] = useState(false),
    [leave, setLeave] = useState<(() => void) | null>(null);
  const openedRoutePanel = useRef(false);
  useEffect(() => {
    if (
      openedRoutePanel.current ||
      page !== "Tasks" ||
      typeof input.task_id !== "string" ||
      !["edit", "history", "agent-notes"].includes(String(input.open_panel))
    )
      return;
    let active = true;
    api
      .call<List>("list_items", {
        task_id: input.task_id,
        include_deleted: true,
        detail: "full",
      })
      .then((result) => {
        if (!active || !result.items[0]) return;
        openedRoutePanel.current = true;
        setSelected(result.items[0]);
        setPanel(input.open_panel as "edit" | "history" | "agent-notes");
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [api, page, input.task_id, input.open_panel]);
  const [error, setError] = useState(""),
    [query, setQuery] = useViewState("workspace:query", ""),
    [search, setSearch] = useViewState(
      "workspace:search",
      input.open_search === true,
    );
  const [nestedDirty, setNestedDirty] = useState(false);
  useEffect(
    () => retain?.(dirty || nestedDirty || !!captureTitle),
    [dirty, nestedDirty, captureTitle, retain],
  );
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchRequest, setSearchRequest] = useState(0);
  useEffect(() => {
    if (input.open_search !== true) return;
    setSearch(true);
  }, [input.open_search, searchRequest]);
  useEffect(() => {
    if (!search || sidebar) return;
    const frame = requestAnimationFrame(() =>
      searchInput.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [search, sidebar, searchRequest]);
  const selectedId = selected?.id,
    generation = useRef(0);
  usePolling(
    poll,
    !embedded && page !== "Logs" && page !== "Help" && !pulling,
  );
  const { drag, pull, pullTracking } = useMobileGestures({
    shell,
    main,
    refreshContent,
    drawer,
    enabled: !embedded && phone && !selected && (!captureOpen || sidebar),
    sidebar,
    setSidebar,
    canRefresh: page !== "Help" && !dirty && !leave,
    refreshing: pulling,
    refresh: requestRefresh,
  });
  const pullVisible = pulling || (pullTracking && pull > 0);
  useDrawerFocus(drawer, !desktop && sidebar);
  useEffect(() => {
    if (!selectedId || !taskPage) return;
    const gen = ++generation.current;
    api
      .call<List>("list_items", {
        task_id: selectedId,
        include_deleted: true,
        detail: "full",
      })
      .then((r) => {
        if (gen === generation.current && r.items[0]) {
          setSelected((t) =>
            t && r.items[0].version >= t.version ? r.items[0] : t,
          );
          setError("");
        }
      })
      .catch((e) => {
        if (gen === generation.current) setError(errorText(e));
      });
    return () => {
      generation.current++;
    };
  }, [selectedId, revision, page]);
  useEffect(() => {
    if (!phone || !selectedId || !taskPage) return;
    const frame = requestAnimationFrame(() => {
      // A fast tap or keyboard interaction may already have entered the form.
      // Initial dialog focus must not steal that input on the next frame.
      if (inspector.current?.contains(document.activeElement)) return;
      inspector.current
        ?.querySelector<HTMLElement>('button[aria-label="Close details"]')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [phone, selectedId, taskPage]);
  useEffect(() => {
    if (!leave) return;
    // Wait for the drawer's inert state and focus cleanup to settle.
    const frame = requestAnimationFrame(() => {
      draftDialog.current
        ?.querySelector<HTMLElement>("button")
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [leave]);
  function navigate(
    fn: () => void,
    returnFocus = document.activeElement as HTMLElement | null,
  ) {
    if (dirty) {
      draftReturn.current = returnFocus;
      setSidebar(false);
      setLeave(() => fn);
    } else fn();
  }
  function keepEditing() {
    flushSync(() => setLeave(null));
    const previous = draftReturn.current;
    const target =
      previous?.isConnected && !previous.closest("[inert]")
        ? previous
        : inspector.current?.querySelector<HTMLElement>(
            "textarea, input, button",
          );
    target?.focus({ preventScroll: true });
  }
  function closeDetails() {
    navigate(
      () => {
        flushSync(() => setSelected(null));
        if (phone && inspectorReturn.current?.isConnected)
          inspectorReturn.current.focus({ preventScroll: true });
      },
      inspector.current?.querySelector<HTMLElement>(
        'button[aria-label="Close details"]',
      ) || null,
    );
  }
  function select(
    t: Task,
    view: "details" | "edit" | "history" | "agent-notes" = "edit",
  ) {
    expanded(() =>
      navigate(() => {
        inspectorReturn.current =
          [
            ...(shell.current?.querySelectorAll<HTMLButtonElement>("button") ||
              []),
          ].find(
            (button) =>
              button.getAttribute("aria-label") === `More options: ${t.title}`,
          ) || null;
        setSelected(t);
        setPanel(view === "details" ? "edit" : view);
      }),
    );
  }
  useEffect(() => {
    const open = (event: globalThis.Event) =>
      expanded(() =>
        app.go({
          page: "Projects",
          input: { project_id: (event as CustomEvent<string>).detail },
        }),
      );
    window.addEventListener("gtd:project", open);
    return () => window.removeEventListener("gtd:project", open);
  }, [app, expanded]);
  function showView(value: string) {
    app.go(
      value === "review" ? { page: "Review" } : { page: "Tasks", scope: value },
    );
    setSidebar(false);
  }
  function openTask(id: string) {
    app.go({
      page: "Tasks",
      input: { task_id: id, include_deleted: true, open_details: true },
    });
  }
  const navigation = compact ? (
    app.menu(() => expanded(() => setCaptureOpen(true)))
  ) : (
    <>
      {!desktop && (
        <IconButton
          className="icon-button sidebar-toggle"
          label="Open navigation"
          onClick={() => setSidebar(true)}
        >
          <Menu />
        </IconButton>
      )}
      {page === "Tasks" && scope === "selected" && app.back && (
        <IconButton
          className="icon-button workspace-back"
          label="Back to previous view"
          onClick={() => navigate(() => app.back?.())}
        >
          <ArrowLeft />
        </IconButton>
      )}
    </>
  );
  const toolbarActions = captureAtTop ? (
    <IconButton
      ref={captureButton}
      label={captureTitle ? "Continue adding task" : "Add task"}
      aria-expanded={captureOpen}
      aria-controls={captureId}
      onClick={() => flushSync(() => setCaptureOpen(!captureOpen))}
    >
      <SquarePen />
    </IconButton>
  ) : undefined;
  return (
    <PageReads.Provider value={{ track, refreshing: pulling, refreshRevision }}>
      <Environment.Provider value={{ ...environment, api }}>
        <div
          ref={shell}
          className={`${compact ? "compact-shell" : "gtd-shell"} ${sidebar ? "nav-open" : ""} ${drag !== null ? "nav-dragging" : ""}`}
          style={
            drag !== null
              ? ({ "--drawer-progress": drag } as CSSProperties)
              : undefined
          }
        >
          {!desktop && (sidebar || drag !== null) && (
            <button
              className="nav-scrim"
              aria-label="Close navigation"
              onClick={() => setSidebar(false)}
            />
          )}
          <aside
            ref={drawer}
            className="gtd-sidebar"
            aria-label="Navigation"
            inert={compact || !!leave || (!desktop && !sidebar)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSidebar(false);
            }}
          >
            {sidebarContent || (
              <SidebarContents
                current={{ page, ...(page === "Tasks" ? { scope } : {}) }}
                close={desktop ? undefined : () => setSidebar(false)}
                account={account}
                admin={!!admin}
                choose={(route) => {
                  // The search destination is retained like other views. Opening
                  // it again must reveal a search field the user previously closed.
                  if (route.input?.open_search && input.open_search) {
                    setSearchRequest((n) => n + 1);
                    setSidebar(false);
                    return;
                  }
                  const go = () => {
                    app.go(route);
                    setSidebar(false);
                  };
                  if (route.page === "Logs" || route.page === "Health" || route.page === "Users")
                    navigate(go);
                  else go();
                }}
              />
            )}
          </aside>
          <main ref={main} className="gtd-main" inert={!desktop && sidebar}>
            {phone && (
              <div
                className={`pull-indicator${pullTracking ? " pull-tracking" : ""}`}
                role="status"
                aria-hidden={!pullVisible}
                aria-label={
                  pulling
                    ? "Refreshing"
                    : pull >= 64
                      ? "Release to refresh"
                      : "Pull to refresh"
                }
                style={{
                  transform: `translateY(${Math.max(8, pull / 2 - 12)}px)`,
                  opacity: pullVisible ? 1 : 0,
                }}
              >
                <RefreshCw
                  className={
                    !pullTracking && (pulling || pull > 0) ? "spinning" : ""
                  }
                  style={{
                    transform: pullTracking
                      ? `rotate(${pull * 3}deg)`
                      : undefined,
                  }}
                />
              </div>
            )}
            <div
              ref={refreshContent}
              className={`mobile-refresh-content${pullTracking ? " pull-tracking" : ""}`}
              inert={!!leave}
              style={
                phone && pull > 0
                  ? { transform: `translateY(${pull}px)` }
                  : undefined
              }
            >
              {!taskPage && page !== "Projects" && (
                <header className="gtd-topbar">
                  <div>
                    {navigation}
                    {!compact && (
                      <span>{page === "Health" ? "Service health" : page}</span>
                    )}
                  </div>
                  {toolbarActions}
                </header>
              )}
              <div
                className={`gtd-content ${taskPage ? "workspace-tasks" : ""} ${selected && taskPage ? "with-inspector" : ""}`}
              >
                {page === "Repeating" && (
                  <Repeating
                    api={api}
                    revision={revision}
                    initialSeriesId={
                      typeof input.series_id === "string"
                        ? input.series_id
                        : undefined
                    }
                    onDirtyChange={setDirty}
                  />
                )}
                {taskPage && (
                  <>
                    <div
                      className="task-column"
                      inert={!compact && phone && !!selected}
                    >
                      <TaskExpansion open={search && page === "Tasks"}>
                        <form
                          className="workspace-search"
                          onSubmit={(e) => e.preventDefault()}
                        >
                          <Search />
                          <input
                            ref={searchInput}
                            autoFocus
                            type="search"
                            aria-label="Search all tasks in view"
                            placeholder="Search this view"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                          <IconButton
                            label="Close workspace search"
                            onClick={() => {
                              setSearch(false);
                              setQuery("");
                            }}
                          >
                            <X />
                          </IconButton>
                        </form>
                      </TaskExpansion>
                      {page === "Home" ? (
                        <Home
                          initial={initialHome}
                          api={api}
                          revision={revision}
                          onOpen={select}
                          onView={showView}
                          navigation={navigation}
                          toolbarActions={toolbarActions}
                          onDirtyChange={setNestedDirty}
                        />
                      ) : (
                        <TaskList
                          api={api}
                          input={{
                            ...(Object.keys(input).length || initial
                              ? {}
                              : scopeArgs(scope)),
                            ...Object.fromEntries(
                              Object.entries(input).filter(
                                ([key]) =>
                                  key !== "open_search" &&
                                  key !== "open_details" &&
                                  key !== "open_panel",
                              ),
                            ),
                            ...(query ? { query } : {}),
                          }}
                          compact={compact}
                          initial={initial}
                          hostError={hostError}
                          hostCanRefresh={hostCanRefresh}
                          hostErrorIsWrite={hostErrorIsWrite}
                          recheck={recheck}
                          revision={revision}
                          onOpen={select}
                          onScope={setScope}
                          editingTaskId={selected?.id}
                          expandedTaskId={
                            expandedTaskId ||
                            (input.open_details
                              ? String(input.task_id)
                              : undefined)
                          }
                          navigation={navigation}
                          toolbarActions={toolbarActions}
                          onDirtyChange={setNestedDirty}
                        />
                      )}
                    </div>
                    {selected && (
                      <aside
                        ref={inspector}
                        className="gtd-detail compact-widget"
                        aria-label="Task inspector"
                        role={phone ? "dialog" : undefined}
                        aria-modal={phone ? true : undefined}
                        onKeyDown={(e) => {
                          if (!phone) return;
                          if (e.key === "Escape") {
                            e.preventDefault();
                            closeDetails();
                          }
                          if (e.key !== "Tab") return;
                          const controls = [
                            ...e.currentTarget.querySelectorAll<HTMLElement>(
                              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]',
                            ),
                          ].filter(
                            (el) =>
                              el.offsetParent !== null &&
                              !el.closest("[inert]"),
                          );
                          const first = controls[0],
                            last = controls.at(-1);
                          if (e.shiftKey && document.activeElement === first) {
                            e.preventDefault();
                            last?.focus();
                          } else if (
                            !e.shiftKey &&
                            document.activeElement === last
                          ) {
                            e.preventDefault();
                            first?.focus();
                          }
                        }}
                      >
                        <div className="inspector-toolbar">
                          <div className="detail-tabs">
                            <button
                              className={panel === "edit" ? "selected" : ""}
                              disabled={dirty && panel === "agent-notes"}
                              onClick={() => setPanel("edit")}
                            >
                              Edit
                            </button>
                            <button
                              className={panel === "history" ? "selected" : ""}
                              disabled={dirty && panel === "agent-notes"}
                              onClick={() => setPanel("history")}
                            >
                              History
                            </button>
                          </div>
                          <IconButton
                            label="Close details"
                            onClick={closeDetails}
                          >
                            <X />
                          </IconButton>
                        </div>
                        <Detail
                          key={selected.id + draftEpoch}
                          task={selected}
                          panel={panel}
                          onTask={setSelected}
                          onDirty={setDirty}
                        />
                      </aside>
                    )}
                  </>
                )}
                {page === "Projects" && (
                  <ProjectBrowser
                    navigation={navigation}
                    toolbarActions={toolbarActions}
                    api={api}
                    revision={revision}
                    input={
                      projectId ? { ...input, project_id: projectId } : input
                    }
                    initial={initialProjects}
                    onDirtyChange={setDirty}
                  />
                )}
                {page === "Review" && (
                  <>
                    <RetainedView mode={compact ? "visible" : "hidden"}>
                      <CompactReview api={api} revision={revision} />
                    </RetainedView>
                    <RetainedView mode={compact ? "hidden" : "visible"}>
                      <Review
                        api={api}
                        revision={revision}
                        onDirtyChange={setDirty}
                      />
                    </RetainedView>
                  </>
                )}
                {page === "Charts" && <Charts revision={revision} />}
                {page === "Results" && <Results input={input} revision={revision} onDirtyChange={setNestedDirty} />}
                {page === "Activity" && (
                  <Activity
                    input={input}
                    revision={revision}
                    onSelect={(id, kind) =>
                      app.go(
                        kind === "project"
                          ? { page: "Projects", input: { project_id: id } }
                          : kind === "recurrence"
                            ? { page: "Repeating", input: { series_id: id } }
                            : {
                                page: "Tasks",
                                input: { task_id: id, include_deleted: true },
                              },
                      )
                    }
                  />
                )}
                {admin &&
                  (page === "Logs" || page === "Health" || page === "Users") &&
                  admin(page, revision, openTask)}
                {!admin && page === "Users" && <p role="alert">Administrator access is required.</p>}
                {page === "Help" && <Help embedded={embedded} />}
                {error && (
                  <details className="workspace-error">
                    <summary>Connection needs attention</summary>
                    {error}
                    <button onClick={refresh}>Retry</button>
                  </details>
                )}
              </div>
            </div>
            <QuickCapture
              draftKey={captureKey}
              captureId={captureId}
              title={captureTitle}
              setTitle={setCaptureTitle}
              atTop={captureAtTop}
              returnFocus={captureButton}
              open={captureOpen}
              setOpen={setCaptureOpen}
              hidden={
                (compact && !captureOpen) || !!selected || sidebar || !!leave
              }
              onTask={(t) =>
                app.go({
                  page: "Tasks",
                  input: { task_id: t.id, open_details: true },
                })
              }
            />
            {leave && (
              <div className="dialog-scrim">
                <section
                  ref={draftDialog}
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="draft-title"
                  className="draft-dialog"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      keepEditing();
                    }
                    if (e.key === "Tab") {
                      const buttons = [
                        ...e.currentTarget.querySelectorAll("button"),
                      ];
                      const i = buttons.indexOf(
                        document.activeElement as HTMLButtonElement,
                      );
                      e.preventDefault();
                      buttons[
                        (i + (e.shiftKey ? -1 : 1) + buttons.length) %
                          buttons.length
                      ]?.focus();
                    }
                  }}
                >
                  <h2 id="draft-title">Keep this edit?</h2>
                  <p>Your draft has not been saved.</p>
                  <div>
                    <button onClick={keepEditing}>Keep editing</button>
                    <button
                      onClick={() => {
                        const action = leave;
                        if (selected)
                          sessionDrafts.discard(`description:${selected.id}`);
                        flushSync(() => {
                          setDirty(false);
                          setDraftEpoch((n) => n + 1);
                          setLeave(null);
                        });
                        action();
                      }}
                    >
                      Discard draft
                    </button>
                  </div>
                </section>
              </div>
            )}
          </main>
        </div>
      </Environment.Provider>
    </PageReads.Provider>
  );
}
function Detail({
  task: source,
  panel,
  onTask,
  onDirty,
}: {
  task: Task;
  panel: "edit" | "history" | "agent-notes";
  onTask: (t: Task) => void;
  onDirty: (d: boolean) => void;
}) {
  const { api } = useEnvironment();
  const { task, intent } = useTaskState(source);
  // A polling summary can arrive before the full inspector read. Keep the
  // mounted editor and its draft until that richer version is available.
  const lastDetailed = useRef<Task | null>(null);
  if (typeof task.notes === "string") lastDetailed.current = task;
  const editorTask = lastDetailed.current;
  return (
    <>
      <div className="inspector-save" hidden={panel === "agent-notes"}>
        <SaveIcon taskId={task.id} />
        {panel !== "agent-notes" && intent?.phase === "error" && (
          <Recovery taskId={task.id} />
        )}
      </div>
      {editorTask || panel === "agent-notes" ? (
        <Inspector
          task={editorTask || task}
          api={api}
          embeddedView={panel}
          onTask={onTask}
          onDirtyChange={onDirty}
        />
      ) : (
        <div className="compact-empty">Loading…</div>
      )}
    </>
  );
}
function QuickCapture({
  draftKey,
  captureId,
  title,
  setTitle,
  atTop,
  returnFocus,
  onTask,
  open,
  setOpen,
  hidden,
}: {
  draftKey: string;
  captureId: string;
  title: string;
  setTitle: (value: string) => void;
  atTop: boolean;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onTask: (t: Task) => void;
  open: boolean;
  setOpen: (value: boolean) => void;
  hidden: boolean;
}) {
  const { api } = useEnvironment();
  const input = useRef<HTMLInputElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const keyboard = useKeyboardInset(open && !hidden);
  const close = () => {
    flushSync(() => setOpen(false));
    (atTop ? returnFocus.current : trigger.current)?.focus({
      preventScroll: true,
    });
  };
  useLayoutEffect(() => {
    if (open && !hidden) input.current?.focus({ preventScroll: true });
  }, [open, hidden]);
  const fields = useDraftFields(
    `${draftKey}:controls`,
    () => ({ recover: false, importance: "normal" as Importance }),
    (v) => v.recover || v.importance !== "normal",
  );
  const [recover, setRecover] = fields("recover"),
    [importance, setImportance] = fields("importance");
  const { run, controller } = useActions();
  const intent = controller.state.intents.get("capture");
  const receipt = controller.state.captureReceipt;
  const seenReceipt = useRef(receipt);
  const captureRequest = useDraftRef<string | null>(
    `${draftKey}:request`,
    null,
    Boolean,
  );
  const captureDestination = useRef(onTask);
  useEffect(() => {
    if (receipt && receipt !== seenReceipt.current) {
      seenReceipt.current = receipt;
      if (
        controller.state.receiptRequests.get("capture") !==
        captureRequest.current
      )
        return;
      captureRequest.current = null;
      captureDestination.current(receipt.task);
      setTitle("");
      setImportance("normal");
      setRecover(false);
      setOpen(false);
    }
  }, [receipt, onTask]);
  return (
    <div
      className={`capture-dock ${open ? "capture-open" : ""}`}
      data-placement={atTop ? "top" : undefined}
      hidden={hidden}
      style={!atTop && keyboard > 0 ? { bottom: keyboard + 12 } : undefined}
    >
      <button
        ref={trigger}
        hidden={atTop}
        className="capture-trigger"
        aria-label={title ? "Continue adding task" : "Add task"}
        aria-expanded={open}
        aria-controls={captureId}
        onClick={() => {
          flushSync(() => setOpen(true));
          input.current?.focus({ preventScroll: true });
        }}
      >
        <Plus />
        <span className="sr-only">Add to inbox</span>
        {!open && intent && (
          <span className="capture-save">
            <SaveIcon taskId="capture" />
          </span>
        )}
        {!open && title && !intent && <span className="draft-dot" />}
      </button>
      <div id={captureId} hidden={!open}>
        <form
          className="capture-composer"
          aria-label="Capture a task"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim() || intent) return;
            const submitted = title.trim();
            setTitle("");
            const preview: Task = {
              id: "capture",
              title: submitted,
              importance,
              status: "inbox",
              notes: "",
              due_date: null,
              version: 0,
              last_change_id: 0,
              deleted: false,
            };
            captureDestination.current = onTask;
            const pending = run(
              "capture_item",
              {
                title: submitted,
                importance,
                reason: "Captured using the task interface.",
              },
              undefined,
              preview,
            );
            captureRequest.current = String(
              controller.state.intents.get("capture")?.args.request_id || "",
            );
            const r = await pending;
            if (!r) {
              setTitle(submitted);
            } else {
              captureRequest.current = null;
              setTitle("");
              setImportance("normal");
              setRecover(false);
              setOpen(false);
            }
          }}
        >
          <input
            ref={input}
            aria-label="Add to inbox"
            placeholder="Add to inbox"
            maxLength={500}
            value={title}
            disabled={!!intent}
            onChange={(e) => setTitle(e.target.value)}
          />
          <ImportanceField
            compact
            value={importance}
            onChange={setImportance}
            disabled={!!intent}
          />
          {intent ? (
            <IconButton
              label={
                intent.phase === "error" ? "Resolve capture" : "Saving capture"
              }
              onClick={() => setRecover(!recover)}
            >
              <SaveIcon taskId="capture" />
            </IconButton>
          ) : (
            <IconButton
              label="Capture task"
              type="submit"
              disabled={!title.trim()}
            >
              <ArrowUp />
            </IconButton>
          )}
          <IconButton label="Close capture" onClick={close}>
            <X />
          </IconButton>
        </form>
        {recover && <Recovery taskId="capture" />}
      </div>
    </div>
  );
}
function CompactReview({ api, revision }: { api: Api; revision: number }) {
  const app = useAppNavigation(),
    expand = useExpandedView();
  const { controller } = useActions();
  const [rows, setRows] = useState<Task[]>([]);
  const [cursors, setCursors] = useState<{
    tasks: string | null;
    projects: string | null;
  }>({ tasks: null, projects: null });
  const [page, setPage] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const generation = useRef(0),
    inFlight = useRef(false);
  const retained = useRef({ tasks: 0, projects: 0 });
  const size = 4;
  async function feed(
    kind: "tasks" | "projects",
    cursor?: string | null,
    count = 30,
  ): Promise<{ rows: Task[]; cursor: string | null }> {
    const records: Task[] = [];
    let next = cursor;
    do {
      const result = await api.call<List & Projects>(
        kind === "tasks" ? "list_items" : "list_projects",
        {
          review_on: today(),
          detail: "summary",
          limit: 30,
          ...(next ? { cursor: next } : {}),
        },
      );
      records.push(...(kind === "tasks" ? result.items : result.projects));
      next = result.next_cursor;
      if ((result as { widget_bundled?: boolean }).widget_bundled) break;
    } while (next && records.length < count);
    return { rows: records, cursor: next || null };
  }
  async function load(more = false) {
    if (more && inFlight.current) return false;
    const current = ++generation.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const [tasks, projects] = await Promise.all([
        !more || cursors.tasks
          ? feed(
              "tasks",
              more ? cursors.tasks : null,
              more ? 30 : Math.max(30, retained.current.tasks),
            )
          : { rows: [], cursor: null },
        !more || cursors.projects
          ? feed(
              "projects",
              more ? cursors.projects : null,
              more ? 30 : Math.max(30, retained.current.projects),
            )
          : { rows: [], cursor: null },
      ]);
      if (current !== generation.current) return false;
      const fresh = [...tasks.rows, ...projects.rows].sort(
        (a, b) =>
          (a.review_date || "").localeCompare(b.review_date || "") ||
          a.title.localeCompare(b.title),
      );
      controller.observe(fresh);
      retained.current = {
        tasks: tasks.rows.length + (more ? retained.current.tasks : 0),
        projects: projects.rows.length + (more ? retained.current.projects : 0),
      };
      setRows((previous) =>
        more
          ? [
              ...previous,
              ...fresh.filter(
                (row) => !previous.some((old) => old.id === row.id),
              ),
            ]
          : fresh,
      );
      setCursors({ tasks: tasks.cursor, projects: projects.cursor });
      return true;
    } catch (e) {
      if (current === generation.current) setError(errorText(e));
      return false;
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
      inFlight.current = false;
    };
  }, [api, revision, attempt]);
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / size) - 1),
  );
  const more =
    (currentPage + 1) * size < rows.length ||
    !!cursors.tasks ||
    !!cursors.projects;
  async function next() {
    if ((currentPage + 1) * size < rows.length || (await load(true)))
      setPage(currentPage + 1);
  }
  return (
    <section
      className="compact-widget compact-secondary compact-review"
      aria-label="Items to review"
      aria-busy={busy}
    >
      {error && (
        <div className="secondary-error" role="alert">
          {error}
          <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      )}
      {!rows.length && !error && (
        <div className="compact-empty">
          {busy ? "Loading…" : "Nothing to review."}
        </div>
      )}
      <div className="secondary-rows">
        {rows.slice(currentPage * size, (currentPage + 1) * size).map((row) =>
          row.entity_type === "project" ? (
            <button
              className="secondary-record"
              key={row.id}
              onClick={() =>
                app.go({ page: "Projects", input: { project_id: row.id } })
              }
            >
              <Folder aria-hidden="true" />
              <span>
                <strong>{row.title}</strong>
                <small>Project</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          ) : (
            <TaskRow
              key={row.id}
              task={row}
              api={api}
              inlineDetails
              onDraft={() => {}}
              update={(task) =>
                setRows((old) =>
                  old.map((row) => (row.id === task.id ? task : row)),
                )
              }
              onOpen={(task, view) =>
                expand(() =>
                  app.go({
                    page: "Tasks",
                    input: {
                      task_id: task.id,
                      include_deleted: true,
                      open_panel: view,
                    },
                  }),
                )
              }
            />
          ),
        )}
      </div>
      <SecondaryPages
        page={currentPage}
        more={more}
        busy={busy}
        previous={() => setPage(currentPage - 1)}
        next={() => void next()}
      />
    </section>
  );
}
