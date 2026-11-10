import { SortControl, defaultTaskSort } from "./sort-control";
import {ViewScope, useViewState, useViewRef, useRestoredView} from "./view-state";
import { TaskFilters } from "./task-filters";
import { taskPreparation } from "./task-preparation";
import { interactionInProgress } from "./interaction-order";
import { useTaskScrollAnchor } from "./scroll-restoration";
import {
  Activity,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Check,
  ChevronDown,
  RefreshCw,
  Search,
  SlidersHorizontal,
  List as ListIcon,
  X,
} from "lucide-react";
import {
  today,
  type Api,
  type Args,
  type List,
  type Task,
  errorText,
  inScope,
  scopeArgs,
  scopeOf,
  views,
} from "./api";
import { useActions, UndoButton } from "./actions";
import { IconButton, TaskRow } from "./task-row";

import { FloatingPanel, Menu } from "./floating-panel";
import { useEnvironment, useAppNavigation } from "./app-context";

const COMPACT_PAGE_SIZE = 4;
type LoadedPage = { args: Args; data: List };
function continuation(page: LoadedPage): Args | null {
  if (!page.data.next_cursor && page.data.next_offset == null) return null;
  return {
    ...page.args,
    group_recurrences:
      page.data.group_recurrences ?? page.args.group_recurrences ?? false,
    cursor: page.data.next_cursor || undefined,
    offset: page.data.next_cursor ? undefined : page.data.next_offset,
  };
}
function combined(pages: LoadedPage[]): List {
  const items = new Map<string, Task>();
  for (const page of pages)
    for (const task of page.data.items) {
      const previous = items.get(task.id);
      if (!previous || task.version >= previous.version)
        items.set(task.id, task);
    }
  return { ...pages[pages.length - 1].data, items: [...items.values()] };
}

export const BUILD = "workflow-v1";
export function TaskList({
  api,
  input = {},
  initial,
  revision = 0,
  compact = false,
  bare = false,
  hostError = "",
  hostCanRefresh = false,
  hostErrorIsWrite = false,
  onOpen,
  onScope,
  onLoaded,
  hideWhenEmpty = false,
  onEmptyChange,
  navigation,
  toolbarActions,
  recheck = false,
  expandedTaskId,
  editingTaskId,
  onDirtyChange,
}: {
  api: Api;
  input?: Args;
  initial?: List | null;
  revision?: number;
  compact?: boolean;
  bare?: boolean;
  hostError?: string;
  hostCanRefresh?: boolean;
  hostErrorIsWrite?: boolean;
  recheck?: boolean;
  onOpen?: (
    t: Task,
    view: "details" | "edit" | "history" | "agent-notes",
  ) => void;
  onScope?: (scope: string) => void;
  onLoaded?: () => void;
  hideWhenEmpty?: boolean;
  onEmptyChange?: (empty: boolean | null) => void;
  navigation?: ReactNode;
  toolbarActions?: ReactNode;
  expandedTaskId?: string;
  editingTaskId?: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const cacheKey = `list:${JSON.stringify([input.project_id,input.status,input.review_on,input.task_id,input.task_ids,bare])}`;
  const restored = useRestoredView();
  const restoreInput = useRef(restored);
  const mountInitial = useRef(initial);
  const environment = useEnvironment();
  const appNavigation = useAppNavigation();
  // Only the unified application's top-level task views paginate in preview.
  // Keep this enabled in fullscreen so the same cache and mounted rows survive.
  const paged = environment.embedded && !bare;
  const previewPaging = paged && compact;
  const pages = useViewRef<LoadedPage[]>(cacheKey+":pages",
    initial ? [{ args: input, data: initial }] : [],
  );
  const [previewPage, setPreviewPage] = useViewState(cacheKey+":previewPage",0);
  const failedNext = useRef<Args | null>(null);
  const paging = useRef(false);
  const [result, setResult] = useViewState<List | null>(cacheKey+":result", initial || null),
    [args, setArgs] = useViewState(cacheKey+":args", input);
  const [plannedToday, setPlannedToday] = useViewState(cacheKey+":plannedToday", false);
  const nonSearchSort = useViewRef<string | undefined>(cacheKey+":nonSearchSort", input.sort as string | undefined);
  const scrollAnchor = useTaskScrollAnchor();
  useLayoutEffect(() => {
    const root = scrollAnchor.root.current;
    if (!environment.embedded || bare || !root) return;
    const toolbar = root.querySelector<HTMLElement>(":scope > .browse-toolbar, :scope > .compact-toolbar");
    if (!toolbar) return;
    const measure = () => {
      const style = getComputedStyle(toolbar);
      if (style.position !== "sticky") {
        root.style.removeProperty("--card-controls-offset");
        return;
      }
      // Wrapped controls must not cover the pinned task header. Nested project
      // lists retain their enclosing project's offset instead.
      root.style.setProperty("--card-controls-offset", `${toolbar.getBoundingClientRect().height + (parseFloat(style.top) || 0)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--card-controls-offset");
    };
  });
  const preparation = useMemo(
    () => api.taskPreparation ? taskPreparation(api) : undefined,
    [api, revision, result],
  );
  useEffect(() => () => preparation?.dispose(), [preparation]);
  const [error, setError] = useState(hostError),
    [busy, setBusy] = useState(false);
  const searchHeight = useRef(0);
  const [search, setSearch] = useState(false),
    [filters, setFilters] = useState(false),
    [controlsOpened, setControlsOpened] = useState(false);
  const [query, setQuery] = useState(String(input.query || "")),
    [visible, setVisible] = useViewState(cacheKey+":visible", compact ? 5 : 20);
  const filterAnchor = useRef<HTMLButtonElement>(null);
  const scopeAnchor = useRef<HTMLButtonElement>(null);
  const searchAnchor = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [scopeMenu, setScopeMenu] = useState(false);
  const controlsId = useId();
  const restoreSearchFocus = useRef(false);
  useEffect(() => {
    if (search) searchInput.current?.focus({ preventScroll: true });
    else if (restoreSearchFocus.current) {
      const target = searchAnchor.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
      restoreSearchFocus.current = false;
    }
  }, [search]);
  function closeSearch() {
    restoreSearchFocus.current = true;
    setSearch(false);
    setQuery("");
    if (args.query) change({ ...args, query: undefined, sort: nonSearchSort.current });
  }
  const readError = useRef<HTMLDivElement>(null);
  const [recover, setRecover] = useState(false);
  // Host write failures retain their compact recovery control. Read failures
  // must be visible without opening it.
  const hostWriteError = !!hostError && error === hostError && hostErrorIsWrite;
  function revealError() {
    if (hostWriteError || environment.embedded && result && !failedNext.current) setRecover(!recover);
    else readError.current?.focus({ preventScroll: true });
  }
  const { controller, state: saves } = useActions();
  const pageOffset = useViewRef(cacheKey+":pageOffset", 0);
  const generation = useRef(0),
    latestArgs = useRef(args),
    drafts = useRef(new Map<string, Task>());
  const deferred = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(deferred.current), []);
  latestArgs.current = args;
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  const skipHostRead = useRef<string | null>(null);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  useEffect(() => () => dirtyCallback.current?.(false), []);
  const inputKey = JSON.stringify(input);
  const appliedInput = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (restoreInput.current) { restoreInput.current = false; appliedInput.current = inputKey; return; }
    if (appliedInput.current === inputKey) return;
    const mounting = appliedInput.current === undefined;
    appliedInput.current = inputKey;
    pageOffset.current = Number(input.offset || 0);
    pages.current = initial ? [{ args: input, data: initial }] : [];
    setPreviewPage(0);
    failedNext.current = null;
    if (initial || hostError) skipHostRead.current = inputKey;
    setArgs((previous) =>
      // State already contains the launch arguments on mount. Adding defaults
      // here changes the read key and repeats a result supplied by SSR/the host.
      compact || mounting
        ? input
        : {
            ...previous,
            ...input,
            status: input.status,
            exclude_statuses: input.exclude_statuses,
            archived: input.archived,
            view: input.view,
            query: input.query,
            offset: 0,
            cursor: undefined,
          },
    );
    setQuery(String(input.query || ""));
    setSearch(false);
    setFilters(false);
    setScopeMenu(false);
    setControlsOpened(false);
    setVisible(compact ? 5 : 20);
  }, [inputKey]);
  const appliedInitial = useRef<List | null>(null);
  useEffect(() => {
    if (restored && initial === mountInitial.current) return;
    if (initial && appliedInitial.current !== initial) {
      appliedInitial.current = initial;
      ++generation.current;
      controller.observe(initial.items);
      pages.current = [{ args: input, data: initial }];
      setResult(initial);
      setBusy(false);
      setError("");
    }
  }, [initial]);
  useEffect(() => {
    setError(hostError);
    setRecover(false);
  }, [hostError]);
  const argsKey = JSON.stringify(args);
  const explicitChange = useRef(false);
  // The host already provided the first card result. Subsequent discovery/refresh uses identical filters.
  const first = useRef(true),
    previousRevision = useRef(revision);
  useEffect(() => {
    const forced = revision !== previousRevision.current;
    previousRevision.current = revision;
    if (!forced && skipHostRead.current === argsKey) {
      skipHostRead.current = null;
      first.current = false;
      return;
    }
    if (first.current && (initial || hostError)) {
      first.current = false;
      return;
    }
    first.current = false;
    if (hostError && (!hostCanRefresh || !result)) return;
    void refresh(undefined, forced);
    return () => {
      ++generation.current;
    };
  }, [argsKey, revision]);
  useEffect(() => {
    if (recheck && initial) void refresh(input);
  }, [recheck, initial]);
  async function refresh(requested = latestArgs.current, fresh = false) {
    const deferReorder = !explicitChange.current;
    explicitChange.current = false;
    if (fresh)
      requested = {
        ...requested,
        cursor: undefined,
        offset: pageOffset.current,
      };
    const gen = ++generation.current;
    failedNext.current = null;
    setBusy(true);
    try {
      const firstArgs = {
        ...(!requested.cursor && !requested.task_id && !requested.task_ids
          ? {
              group_recurrences: paged
                ? (pages.current[0]?.data.group_recurrences ?? true)
                : true,
            }
          : {}),
        ...requested,
      };
      const firstData = await api.call<List>("list_items", firstArgs);
      if (gen !== generation.current) return;
      if (paged && firstData === pages.current[0]?.data) {
        setError("");
        loaded.current?.();
        return;
      }
      const refreshed: LoadedPage[] = [{ args: firstArgs, data: firstData }];
      // Rebuild a coherent snapshot through the number of pages already read.
      // Never combine the first page of a new snapshot with old cursor pages.
      if (paged)
        while (refreshed.length < pages.current.length) {
          const next = continuation(refreshed[refreshed.length - 1]);
          if (!next) break;
          const data = await api.call<List>("list_items", next);
          if (gen !== generation.current) return;
          refreshed.push({ args: next, data });
        }
      const data = paged ? combined(refreshed) : firstData;
      // Editors need current full records even when a changed status removes a
      // task from this page. Refresh them without moving the surrounding rows.
      const edited = new Set(drafts.current.keys());
      if (editingTaskId) edited.add(editingTaskId);
      const currentEditors: Task[] = [];
      for (const id of edited) {
        let current = data.items.find((t) => t.id === id);
        if (typeof current?.notes !== "string") {
          const detail = await api.call<List>("list_items", {
            task_id: id,
            include_deleted: true,
            detail: "full",
          });
          if (gen !== generation.current) return;
          current = detail.items[0];
        }
        if (current) {
          if (drafts.current.has(id)) drafts.current.set(id, current);
          currentEditors.push(current);
        }
      }
      // Publish edited records before deferring row movement. Otherwise the
      // editor itself keeps this refresh pending and never sees a conflict.
      // Draft rows stay pinned, and their unsaved fields remain in DraftStore.
      controller.observe(currentEditors);
      const commit = () => {
        if (gen !== generation.current) return;
        if (result && (fresh || environment.embedded) &&
            (controller.snapshot().intents.size || (deferReorder && interactionInProgress()))) {
          deferred.current = setTimeout(commit, 150);
          return;
        }
        if (result && (environment.embedded || fresh)) scrollAnchor.remember();
        controller.observe(data.items);
        pages.current = refreshed;
        setResult(data);
      };
      clearTimeout(deferred.current);
      commit();
      setError("");
      loaded.current?.();
    } catch (e) {
      if (gen === generation.current) setError(errorText(e));
    } finally {
      if (gen === generation.current) {
        setBusy(false);
      }
    }
  }
  async function loadNext(requested: Args, advance = true) {
    if (paging.current || busy) return;
    paging.current = true;
    const gen = ++generation.current;
    setBusy(true);
    try {
      const data = await api.call<List>("list_items", requested);
      if (gen !== generation.current) return;
      const base = pages.current.length
        ? pages.current
        : result
          ? [{ args, data: result }]
          : [];
      pages.current = [...base, { args: requested, data }];
      controller.observe(data.items);
      setResult(combined(pages.current));
      if (advance) setPreviewPage((value) => value + 1);
      failedNext.current = null;
      setError("");
    } catch (error) {
      if (gen === generation.current) {
        failedNext.current = requested;
        setError(errorText(error));
      }
    } finally {
      paging.current = false;
      if (gen === generation.current) setBusy(false);
    }
  }
  function change(next: Args) {
    const requested = { ...next, cursor: undefined, offset: 0 };
    if (!next.query) nonSearchSort.current = next.sort as string | undefined;
    generation.current++;
    explicitChange.current = true;
    // An explicit search/filter changes membership. Never present the old
    // query's rows as matches. Sorting the same membership stays warm.
    const membership = ({sort: _sort, cursor: _cursor, offset: _offset, ...query}: Args) => JSON.stringify(query);
    if (environment.embedded && membership(requested) !== membership(args)) setResult(null);
    setVisible(compact ? 5 : 20);
    pages.current = [];
    setPreviewPage(0);
    failedNext.current = null;
    pageOffset.current = 0;
    setArgs(requested);
    if (!bare && !environment.embedded) {
      appNavigation.updateUrl?.({page:"Tasks", scope:scopeOf(next), input:next});
    }
  }
  useEffect(() => {
    if (!plannedToday) return;
    const update = () => {
      const current = latestArgs.current, day = today();
      if (current.planned_from !== day || current.planned_through !== day)
        change({ ...current, planned_from: day, planned_through: day });
    };
    update();
    const timer = setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [plannedToday]);
  function selectScope(scope: string) {
    const {
      status: _,
      view: __,
      task_id: ___,
      task_ids: ____,
      archived: _____,
      exclude_statuses: ______,
      ...rest
    } = args;
    change({ ...rest, ...scopeArgs(scope) });
    onScope?.(scope);
  }
  const rows = [...(result?.items || [])];
  const captured = saves.captureReceipt?.task;
  // A new capture must remain visible even when Inbox already spans pages.
  if (
    captured &&
    captured.id === expandedTaskId &&
    !args.offset &&
    !rows.some((t) => t.id === captured.id) &&
    inScope(controller.project(captured, saves), args)
  ) {
    rows.unshift(captured);
  }
  for (const task of drafts.current.values())
    if (!rows.some((t) => t.id === task.id)) rows.push(task);
  for (const intent of saves.intents.values()) {
    const task = intent.before || intent.preview;
    if (
      task &&
      task.entity_type !== "project" &&
      !rows.some((t) => t.id === task.id)
    ) {
      // Retain unresolved writes without guessing a different client-side priority.
      rows.push(task);
    }
  }
  // Immediately remove acknowledged rows from their old scope; optimistic rows stay reachable.
  const shown = rows.filter(
    (t) =>
      saves.intents.has(t.id) ||
      drafts.current.has(t.id) ||
      t.id === editingTaskId ||
      inScope(controller.project(t, saves), args),
  );
  const batches: string[][] = [];
  const remaining = new Map(shown.map((task) => [task.id, task]));
  for (const page of pages.current.length
    ? pages.current
    : result
      ? [{ args, data: result }]
      : []) {
    const ids = page.data.items.flatMap((task) => {
      if (!remaining.delete(task.id)) return [];
      return [task.id];
    });
    for (let offset = 0; offset < ids.length; offset += COMPACT_PAGE_SIZE)
      batches.push(ids.slice(offset, offset + COMPACT_PAGE_SIZE));
  }
  // Optimistic/draft rows absent from the last read remain reachable as well.
  const extra = [...remaining.keys()];
  for (let offset = 0; offset < extra.length; offset += COMPACT_PAGE_SIZE)
    batches.push(extra.slice(offset, offset + COMPACT_PAGE_SIZE));
  const activePage = Math.min(previewPage, Math.max(0, batches.length - 1));
  useEffect(() => {
    if (previewPage !== activePage) setPreviewPage(activePage);
  }, [previewPage, activePage]);
  const pageIds = new Set(batches[activePage] || []);
  const nextRequest = pages.current.length
    ? continuation(pages.current[pages.current.length - 1])
    : result
      ? continuation({ args, data: result })
      : null;
  const hasNext = activePage + 1 < batches.length || !!nextRequest;
  function showPreviewPage(page: number) {
    // Leaving a failed continuation dismisses only that read error. The cached
    // pages are still valid, and Next can request the continuation again later.
    if (failedNext.current) {
      failedNext.current = null;
      setError("");
    }
    setPreviewPage(page);
  }
  const scope = scopeOf(args);
  // Scope, not result count, distinguishes a focused confirmation from a list.
  // An empty/failed refresh must not make the hide control disappear.
  const singleTaskCard =
    compact &&
    !navigation &&
    scope === "selected" &&
    (!!args.task_id ||
      (Array.isArray(args.task_ids) && args.task_ids.length === 1));
  const toolbarVisible = !singleTaskCard || controlsOpened;
  const filtering = !!(
    (Array.isArray(args.exclude_statuses) && args.exclude_statuses.length) ||
    (scope === "all" && args.archived !== false) ||
    args.max_estimated_minutes != null || args.max_effort ||
    args.planned_from ||
    args.planned_through ||
    args.due_from ||
    args.due_through ||
    args.undated ||
    args.include_deleted
  );
  const empty =
    !result && !error
      ? null
      : !shown.length &&
        !error &&
        !filtering &&
        !filters &&
        !search &&
        !drafts.current.size;
  useEffect(() => {
    onEmptyChange?.(empty);
  }, [empty, onEmptyChange]);
  const scopeSelector = (
    <>
      <button
        ref={scopeAnchor}
        className="scope-select scope-button"
        aria-label="Task view"
        aria-haspopup="menu"
        aria-expanded={scopeMenu}
        onClick={() => {
          if (scopeMenu) scopeAnchor.current?.focus({ preventScroll: true });
          setFilters(false);
          setScopeMenu(!scopeMenu);
        }}
      >
        {views.find(([value]) => value === scope)?.[1] ||
          (scope === "review" ? "Review" : "Selected")}
        <ChevronDown />
      </button>
      {scopeMenu && (
        <Menu
          label="Task views"
          anchor={scopeAnchor}
          close={() => setScopeMenu(false)}
        >
          {views
            .filter(([value]) => value !== "active")
            .map(([value, label]) => (
              <button
                key={value}
                role="menuitemradio"
                aria-checked={scope === value}
                onClick={() => {
                  setScopeMenu(false);
                  scopeAnchor.current?.focus({ preventScroll: true });
                  selectScope(value);
                }}
              >
                <span>{label}</span>
                {scope === value && <Check />}
              </button>
            ))}
        </Menu>
      )}
    </>
  );
  const pagination = previewPaging ? (
    (batches.length > 1 || !!nextRequest) && (
      <div
        className="page-actions compact-pagination"
        role="group"
        aria-label="Task pages"
      >
        <IconButton
          label="Previous task page"
          disabled={busy || activePage === 0}
          onClick={() => showPreviewPage(Math.max(0, activePage - 1))}
        >
          <ChevronLeft />
        </IconButton>
        <span
          className="muted"
          aria-live="polite"
          aria-label={`Task page ${activePage + 1}`}
        >
          {activePage + 1}
        </span>
        <IconButton
          label="Next task page"
          disabled={busy || !hasNext}
          onClick={() => {
            if (activePage + 1 < batches.length)
              showPreviewPage(activePage + 1);
            else if (nextRequest) void loadNext(nextRequest);
          }}
        >
          <ChevronRight />
        </IconButton>
      </div>
    )
  ) : (
    <>
      {!paged && shown.length > visible && (
        <button
          type="button"
          className="text-action"
          onClick={() => setVisible(visible + (compact ? 5 : 20))}
        >
          Show more
          <ChevronRight />
        </button>
      )}
      {!paged && (!!args.offset || !!args.cursor) && (
        <IconButton
          label="First page"
          disabled={busy}
          onClick={() => change({ ...args, offset: 0 })}
        >
          <ChevronLeft />
        </IconButton>
      )}
      {(paged
        ? !!nextRequest
        : result?.next_offset != null && visible >= shown.length) && (
        <IconButton
          label="More tasks"
          disabled={busy}
          onClick={() => {
            if (paged && nextRequest) {
              void loadNext(nextRequest, false);
              return;
            }
            if (!result) return;
            setVisible(compact ? 5 : 20);
            pageOffset.current = result.next_offset || 0;
            setArgs({
              ...args,
              // A cursor must retain the grouping used to produce its page.
              // Older host results without metadata use their original input.
              group_recurrences:
                result.group_recurrences ?? args.group_recurrences ?? false,
              cursor: result.next_cursor || undefined,
              offset: result.next_cursor ? 0 : result.next_offset,
            });
          }}
        >
          <ChevronRight />
        </IconButton>
      )}
    </>
  );
  const searchField = (
    <form
      className="search-line card-search"
      onSubmit={(e) => {
        e.preventDefault();
        if (query && !args.query) nonSearchSort.current = args.sort as string | undefined;
        change({ ...args, query: query || undefined,
          sort: !query ? nonSearchSort.current : args.query ? args.sort : "relevance" });
      }}
    >
      <IconButton label="Search" type="submit">
        {busy ? <RefreshCw className="spinning" /> : <Search />}
      </IconButton>
      <input
        ref={searchInput}
        type="search"
        aria-label="Search titles and notes"
        placeholder="Search titles and notes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            closeSearch();
          }
        }}
      />
      {!previewPaging && pagination}
      {error && (
        <IconButton label="View connection problem" onClick={revealError}>
          <AlertCircle className="save-error" />
        </IconButton>
      )}
      <IconButton
        label="Close search"
        onClick={() => {
          closeSearch();
        }}
      >
        <X />
      </IconButton>
    </form>
  );
  const appliedSort = result?.sort || defaultTaskSort(args);
  const requestedSort = defaultTaskSort(args);
  const sortControl = <SortControl value={appliedSort} select={(sort) => change({ ...args, sort })}
    options={[...(args.query ? ["relevance"] : []), ...(args.review_on ? ["review"] : []), "action", "effective_due", "importance", "updated", "created", "created_desc"]}
    pending={appliedSort !== requestedSort ? requestedSort : undefined} />;
  const utilities = (
    <>
      <UndoButton />
      <IconButton
        ref={searchAnchor}
        label="Search tasks"
        aria-expanded={search}
        onClick={(event) => {
          setFilters(false);
          setScopeMenu(false);
          searchHeight.current = event.currentTarget.closest(".compact-toolbar")?.getBoundingClientRect().height || 0;
          setSearch(!search);
        }}
      >
        <Search />
      </IconButton>
      <IconButton
        label={error ? "View connection problem" : "Refresh tasks"}
        onClick={() => {
          if (error) revealError();
          else {
            api.invalidateReads?.();
            void refresh(undefined, true);
          }
        }}
        disabled={busy}
      >
        {error ? (
          <AlertCircle className="save-error" />
        ) : (
          <RefreshCw className={busy ? "spinning" : ""} />
        )}
      </IconButton>
      <IconButton
        ref={filterAnchor}
        label="Sort and filter tasks"
        data-filtered={filtering || !!args.sort || undefined}
        aria-haspopup="dialog"
        aria-expanded={filters}
        onClick={(e) => {
          filterAnchor.current = e.currentTarget;
          if (filters) e.currentTarget.focus({ preventScroll: true });
          setScopeMenu(false);
          setFilters(!filters);
        }}
      >
        <SlidersHorizontal />
      </IconButton>
    </>
  );
  const toolbar = (
    <div className="compact-toolbar" style={search && searchHeight.current ? {minHeight: searchHeight.current} : undefined}>
      <div className="list-controls" id={controlsId} hidden={!toolbarVisible}>
        {compact && search ? (
          searchField
        ) : (
          <>
            <div className="page-actions">
              {compact && (navigation || scopeSelector)}
              {!previewPaging && pagination}
            </div>
            {(compact || bare) && <div className="list-sort">{sortControl}</div>}
            {compact && <div className="view-actions">{utilities}</div>}
          </>
        )}
      </div>
      {singleTaskCard && (
        <>
          {!toolbarVisible && error && (
            <IconButton label="View connection problem" onClick={revealError}>
              <AlertCircle className="save-error" />
            </IconButton>
          )}
          <IconButton
            label={toolbarVisible ? "Hide list controls" : "Show list controls"}
            aria-expanded={toolbarVisible}
            aria-controls={controlsId}
            aria-description={
              filtering || args.query || args.sort
                ? "Filters or sorting applied"
                : undefined
            }
            data-filtered={
              (!toolbarVisible && !!(filtering || args.query || args.sort)) ||
              undefined
            }
            onClick={(e) => {
              e.currentTarget.focus({ preventScroll: true });
              setFilters(false);
              setScopeMenu(false);
              setControlsOpened(!toolbarVisible);
            }}
          >
            <ListIcon />
          </IconButton>
        </>
      )}
    </div>
  );
  if (hideWhenEmpty && empty !== false) return null;
  return (
    <ViewScope id={cacheKey}>
    <section
      ref={scrollAnchor.root}
      className={`${compact ? "compact-widget" : "task-browser compact-widget"}${previewPaging ? " compact-paged" : ""}`}
      data-sort={appliedSort}
      aria-label="Task list"
      aria-busy={busy}
      data-build={compact ? BUILD : undefined}
    >
      {!compact && !bare && (
        <div className="browse-toolbar">
          <div className="workspace-list-heading">
            {navigation}
            <h1>{views.find(([value]) => value === scope)?.[1] || "Tasks"}</h1>
          </div>
          <div className="view-actions">
            {toolbarActions}
            {sortControl}
            <UndoButton />
            {error && (
              <IconButton label="View connection problem" onClick={revealError}>
                <AlertCircle className="save-error" />
              </IconButton>
            )}
            <IconButton
              label={
                filtering
                  ? "Sort and filter tasks (filters applied)"
                  : "Sort and filter tasks"
              }
              aria-haspopup="dialog"
              aria-expanded={filters}
              data-filtered={filtering || undefined}
              onClick={(e) => {
                filterAnchor.current = e.currentTarget;
                if (filters) e.currentTarget.focus({ preventScroll: true });
                setFilters(!filters);
              }}
            >
              <SlidersHorizontal />
            </IconButton>
          </div>
        </div>
      )}
      {compact && toolbar}
      {error && (!hostWriteError || recover) &&
        (!environment.embedded || !result || recover || failedNext.current) && (
        <div className="recovery" role="alert" ref={readError} tabIndex={-1}>
          <p>{error}</p>
          {result && !hostWriteError && !failedNext.current && (
            <p className="muted">
              Previously loaded tasks may not match the current search or
              filters.
            </p>
          )}
          {(!hostError || hostCanRefresh) && (
            <button
              disabled={busy}
              onClick={() =>
                failedNext.current
                  ? void loadNext(failedNext.current)
                  : void refresh()
              }
            >
              {busy ? "Retrying…" : "Retry refresh"}
            </button>
          )}
        </div>
      )}
      {!result && !error && (
        <div className="compact-empty" role="status">
          Loading…
        </div>
      )}
      {result && !shown.length && !error && !busy && (
        <div className="compact-empty">
          {scope === "active" && !args.query
            ? "Nothing to do here."
            : "No matching tasks"}
        </div>
      )}
      {(paged ? shown : shown.slice(0, visible)).map((task) => (
        <Activity
          key={task.id}
          mode={!previewPaging || pageIds.has(task.id) ? "visible" : "hidden"}
        >
          <TaskRow
            task={task}
            api={api}
            preparation={preparation}
            onOpen={onOpen}
            inlineDetails={!!onOpen || !compact}
            expandedByDefault={task.id === expandedTaskId}
            update={(t) => {
              setResult((r) =>
                r
                  ? {
                      ...r,
                      items: r.items.map((x) =>
                        x.id === t.id && t.version >= x.version ? t : x,
                      ),
                    }
                  : r,
              );
            }}
            onDraft={(t, dirty) => {
              if (dirty) drafts.current.set(t.id, t);
              else drafts.current.delete(t.id);
              dirtyCallback.current?.(drafts.current.size > 0);
            }}
          />
        </Activity>
      ))}
      {previewPaging && pagination}
      {!compact && toolbar}
      {filters && (
        <FloatingPanel
          anchor={filterAnchor}
          close={() => setFilters(false)}
          label="Sort and filter tasks"
          className="browse-filters"
        >
          <TaskFilters
            args={args}
            scope={scope}
            filtering={filtering}
            plannedToday={plannedToday}
            setPlannedToday={setPlannedToday}
            change={change}
          />
        </FloatingPanel>
      )}
    </section>
    </ViewScope>
  );
}
