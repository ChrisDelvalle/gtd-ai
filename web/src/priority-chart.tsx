import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import {
  errorText,
  importanceLevels,
  type Importance,
  type Moment,
  type Projects,
} from "./api";
import { useAppNavigation, useEnvironment } from "./app-context";
import { ChartSelector } from "./chart-controls";
import { importanceLabel, momentLabel } from "./planning-fields";
import { restorePosition } from "./scroll-restoration";
import { useViewRef, useViewState } from "./view-state";
import { priorityProjectArgs } from "./widget-reads";

const urgencyBuckets = [
  { id: "undated", label: "Undated", short: "None", color: "#a970ff" },
  { id: "later", label: "Later", short: "Later", color: "#61a8ea" },
  { id: "weeks", label: "2–4 weeks", short: "2–4w", color: "#a8c64b" },
  { id: "within_7_days", label: "Within 7 days", short: "7d", color: "#eabb2c" },
  { id: "within_48_hours", label: "Within 48 hours", short: "48h", color: "#fc972f" },
  { id: "immediate", label: "Immediate", short: "Now", color: "#fa6630" },
  { id: "overdue", label: "Overdue", short: "Late", color: "#ff4136" },
] as const;
const columns = [...urgencyBuckets].reverse();
const PAGE_SIZE = 20;
const scopeNames = {
  next: "Next",
  blocked: "Blocked",
  waiting: "Waiting",
  someday: "Someday",
  inbox: "Inbox",
  committed: "Committed",
  all: "All open",
};
type Scope = keyof typeof scopeNames;
type Counts = Record<Exclude<Scope, "committed" | "all">, number>;
type Summary = {
  counts: Counts[][];
  previews?: Row[][];
  snapshot: string;
  next_change_at: string | null;
};
type Cell = {
  importance: Importance;
  urgency: (typeof columns)[number]["id"];
  scope: Scope;
};
type Row = {
  id: string;
  title: string;
  status: keyof Counts;
  work_block: Moment | null;
  scheduled?: Moment;
  priority_from: { id: string; title: string } | null;
  urgency_from?: { id: string; title: string };
};
type Page = { items: Row[]; next_cursor: string | null };
type Snapshot = { project: string; summary: Summary };
type View = Snapshot & { list?: Page & { cell: Cell; offset?: number } };
type ProjectFilter = { id: string; title: string };
const anyProject = { id: "", title: "Any project" };
const allProjects = { id: "all", title: "All projects" };
const cellKey = (cell: Pick<Cell, "importance" | "urgency">) =>
  `${cell.importance}-${cell.urgency}`;
function countFor(counts: Counts | undefined, scope: Scope) {
  if (!counts) return 0;
  if (scope === "all")
    return (
      counts.next +
      counts.blocked +
      counts.waiting +
      counts.someday +
      counts.inbox
    );
  if (scope === "committed")
    return counts.next + counts.blocked + counts.waiting;
  return counts[scope];
}
function position(cell: Cell) {
  return [
    6 - importanceLevels.indexOf(cell.importance),
    urgencyBuckets.findIndex(({ id }) => id === cell.urgency),
  ] as const;
}
function countIn(summary: Summary, cell: Cell) {
  const [row, column] = position(cell);
  return countFor(summary.counts[row]?.[column], cell.scope);
}
function previewRows(summary: Summary, cell: Cell) {
  const [row, column] = position(cell);
  const preview = summary.previews?.[row * 7 + column];
  if (!preview) return [];
  const counts = summary.counts[row][column];
  const items: Row[] = [];
  // Follow Recommended order, and stop before any gap in the prefix so the
  // continuation always starts at the first record that has not been shown.
  for (const status of [
    "next",
    "inbox",
    "waiting",
    "blocked",
    "someday",
  ] as const) {
    if (
      cell.scope !== status &&
      cell.scope !== "all" &&
      !(
        cell.scope === "committed" &&
        status !== "inbox" &&
        status !== "someday"
      )
    )
      continue;
    const rows = preview.filter((item) => item.status === status);
    items.push(...rows.slice(0, PAGE_SIZE - items.length));
    if (items.length >= PAGE_SIZE || rows.length < counts[status]) break;
  }
  return items;
}
function preference(key?: string): { scope: Scope; project: ProjectFilter } {
  const fallback = { scope: "next" as const, project: anyProject };
  try {
    const saved = key && localStorage.getItem(key);
    if (!saved) return fallback;
    const { scope, project } = JSON.parse(saved);
    return {
      scope: Object.hasOwn(scopeNames, scope) ? scope : fallback.scope,
      project:
        typeof project?.id === "string" && typeof project?.title === "string"
          ? project
          : anyProject,
    };
  } catch {
    return fallback;
  }
}

function ProjectSelector({
  value,
  select,
  revision,
}: {
  value: ProjectFilter;
  select: (value: ProjectFilter) => void;
  revision: number;
}) {
  const { api } = useEnvironment();
  const [projects, setProjects] = useState<Projects>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const readRevision = useRef<number>(-1);
  async function load(cursor?: string) {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const result = await api.call<Projects>("list_projects", {
        ...priorityProjectArgs,
        ...(cursor ? { cursor } : {}),
      });
      setProjects((old) => ({
        ...result,
        projects: cursor
          ? [...(old?.projects || []), ...result.projects]
          : result.projects,
      }));
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (loading || readRevision.current === revision) return;
    readRevision.current = revision;
    void load();
  }, [api, revision, loading]);
  const options = [anyProject, allProjects, ...(projects?.projects || [])];
  if (!options.some((p) => p.id === value.id)) options.push(value);
  const labels = Object.fromEntries(options.map((p) => [p.id, p.title]));
  return (
    <ChartSelector
      value={value.id}
      select={(id) => select({ id, title: labels[id] })}
      options={options.map((p) => p.id)}
      labels={labels}
      label="Filter by project"
      prefix="Project"
    >
      {loading && (
        <span className="priority-menu-status" role="status">
          Loading projects…
        </span>
      )}
      {error && (
        <>
          <span className="priority-menu-status" role="status">
            {error}
          </span>
          <button role="menuitem" onClick={() => void load()}>
            Retry
          </button>
        </>
      )}
      {!loading && !error && projects?.next_cursor && (
        <button
          role="menuitem"
          onClick={() => void load(projects.next_cursor!)}
        >
          More projects
        </button>
      )}
    </ChartSelector>
  );
}

export function PriorityChart({
  revision,
  preferenceKey,
  identity,
  typeControl,
}: {
  revision: number;
  preferenceKey?: string;
  identity: string;
  typeControl: ReactNode;
}) {
  const { api } = useEnvironment();
  const navigation = useAppNavigation();
  const key = preferenceKey && `${preferenceKey}:priority`;
  const [filter, setFilter] = useViewState(`priority:${identity}:filter`, () =>
    preference(key),
  );
  const { scope, project } = filter;
  const [saved, setSaved] = useViewState<View | null>(
    `priority:${identity}:view`,
    null,
  );
  const [chosen, setChosen] = useViewState<Omit<Cell, "scope"> | null>(
    `priority:${identity}:cell`,
    null,
  );
  const returnFocus = useViewRef<string | null>(
    `priority:${identity}:focus`,
    null,
  );
  const listScroll = useViewRef(`priority:${identity}:scroll`, 0);
  const root = useRef<HTMLElement>(null);
  const resultId = useId();
  const [incoming, setIncoming] = useState<Snapshot | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [cellError, setCellError] = useState("");
  const [paging, setPaging] = useState(false);
  const [focus, setFocus] = useState(-1);
  const view = saved?.project === project.id ? saved : null;
  const pending = incoming?.project === project.id ? incoming : null;
  const target = pending || view;
  const selected = chosen && { ...chosen, scope };
  const list =
    view?.list &&
    selected &&
    cellKey(view.list.cell) === cellKey(selected) &&
    view.list.cell.scope === scope
      ? view.list
      : undefined;

  function changeFilter(update: Partial<typeof filter>) {
    const value = { ...filter, ...update };
    setFilter(value);
    try {
      if (key) localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Optional storage. */
    }
  }
  useEffect(() => {
    let active = true;
    setError("");
    api
      .call<Summary>("priority_grid", project.id ? { project: project.id } : {})
      .then((summary) => {
        if (active) setIncoming({ project: project.id, summary });
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [api, project.id, revision, attempt]);

  useEffect(() => {
    const boundary = view?.summary.next_change_at;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (document.hidden) return;
      const left = boundary ? Date.parse(boundary) - Date.now() : Infinity;
      if (left > 0) {
        if (Number.isFinite(left))
          timer = setTimeout(check, Math.min(left + 50, 2147483647));
      } else setAttempt((n) => n + 1);
    };
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        setAttempt((n) => n + 1);
      }
    };
    if (boundary) timer = setTimeout(check, 0);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [view?.summary]);

  useEffect(() => {
    if (!target || (!pending && (!chosen || list))) return;
    const cell = chosen && { ...chosen, scope };
    setCellError("");
    if (!cell || countIn(target.summary, cell) === 0) {
      if (pending) {
        setSaved(pending);
        setIncoming(null);
      }
      return;
    }
    const items =
      (list?.items.length ?? 0) <= PAGE_SIZE
        ? previewRows(target.summary, cell)
        : [];
    if (items.length) {
      setSaved({
        ...target,
        list: {
          cell,
          items,
          next_cursor: null,
          offset:
            items.length < countIn(target.summary, cell)
              ? items.length
              : undefined,
        },
      });
      if (pending) setIncoming(null);
      return;
    }
    let active = true;
    api
      .call<Page>("priority_grid", {
        ...(target.project ? { project: target.project } : {}),
        cell,
        snapshot: target.summary.snapshot,
        ...(list && list.items.length > PAGE_SIZE
          ? { limit: Math.min(list.items.length, 100) }
          : {}),
      })
      .then((page) => {
        if (!active) return;
        setSaved({
          project: target.project,
          summary: target.summary,
          list: { ...page, cell },
        });
        if (pending) setIncoming(null);
      })
      .catch((error) => {
        if (active) setCellError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [api, target, pending, chosen, scope, list, setSaved, attempt]);

  useLayoutEffect(() => {
    const key = returnFocus.current;
    if (!key) return;
    returnFocus.current = null;
    let restore: (() => void) | undefined;
    const frame = requestAnimationFrame(() => {
      restore = restorePosition(
        undefined,
        `[data-priority-focus="${CSS.escape(key)}"]`,
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      restore?.();
    };
  }, [returnFocus]);

  function open(id: string, focusKey: string) {
    returnFocus.current = focusKey;
    navigation.go({
      page: "Tasks",
      input: { task_id: id, open_details: true },
    });
  }
  function choose(cell: Cell) {
    setCellError("");
    listScroll.current = 0;
    setChosen({ importance: cell.importance, urgency: cell.urgency });
  }
  function closeList() {
    setChosen(null);
    if (selected)
      root.current
        ?.querySelector<HTMLButtonElement>(`[data-priority-focus="${cellKey(selected)}"]`)
        ?.focus({ preventScroll: true });
  }
  function retry() {
    setCellError("");
    setAttempt((n) => n + 1);
  }
  async function more() {
    if (!view || !list || (!list.next_cursor && list.offset == null) || paging)
      return;
    setPaging(true);
    setCellError("");
    try {
      const page = await api.call<Page>("priority_grid", {
        ...(view.project ? { project: view.project } : {}),
        cell: list.cell,
        snapshot: view.summary.snapshot,
        ...(list.next_cursor
          ? { cursor: list.next_cursor }
          : { offset: list.offset }),
      });
      setSaved((old) =>
        old === view
          ? {
              ...view,
              list: {
                ...page,
                cell: list.cell,
                items: [...list.items, ...page.items],
              },
            }
          : old,
      );
    } catch (error) {
      setCellError(errorText(error));
    } finally {
      setPaging(false);
    }
  }

  const count = (row: number, column: number) =>
    countFor(view?.summary.counts[6 - row]?.[6 - column], scope);
  const occupied = importanceLevels.flatMap((_, row) =>
    columns.flatMap((_, column) =>
      count(row, column) ? [row * 7 + column] : [],
    ),
  );
  const active = occupied.includes(focus) ? focus : occupied[0];
  function move(event: KeyboardEvent, row: number, column: number) {
    const delta = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }[event.key];
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    let next = event.key === "Home" ? occupied[0] : occupied.at(-1);
    if (delta) {
      next = undefined;
      for (
        let y = row + delta[0], x = column + delta[1];
        y >= 0 && y < 7 && x >= 0 && x < 7;
        y += delta[0], x += delta[1]
      ) {
        if (count(y, x)) {
          next = y * 7 + x;
          break;
        }
      }
    }
    if (next !== undefined)
      root.current
        ?.querySelector<HTMLButtonElement>(`[data-priority-index="${next}"]`)
        ?.focus();
  }
  return (
    <section
      className="charts priority-chart"
      aria-label="Priorities chart"
      ref={root}
    >
      <div className="chart-controls priority-controls">
        <div className="priority-filters">
          <ChartSelector
            value={scope}
            select={(scope) => changeFilter({ scope })}
            options={Object.keys(scopeNames) as Scope[]}
            labels={scopeNames}
            label="Task group"
            prefix="Task group"
          />
          <ProjectSelector
            value={project}
            select={(project) => changeFilter({ project })}
            revision={revision}
          />
        </div>
        {typeControl}
      </div>
      {view ? (
        <>
          <div
            className="priority-grid"
            role="group"
            aria-label="Task counts by importance and urgency"
          >
            <span />
            {columns.map(({ id, label, short }) => (
              <span
                className="priority-column"
                key={id}
                title={label}
                aria-hidden="true"
              >
                <span>{id === "immediate" ? short : label}</span>
                <span>{short}</span>
              </span>
            ))}
            {importanceLevels.map((importance, y) => (
              <PriorityRow
                key={importance}
                {...{
                  importance,
                  y,
                  count,
                  scope,
                  active,
                  selected,
                  resultId,
                  choose,
                  move,
                  setFocus,
                }}
              />
            ))}
          </div>
          {!occupied.length && <p className="empty">No tasks in this group.</p>}
          {selected && (
            <PrioritySheet
              id={resultId}
              title={`${importanceLabel(selected.importance)} · ${columns.find(({ id }) => id === selected.urgency)!.label}`}
              scroll={listScroll}
              close={closeList}
            >
              {list ? (
                <>
                  <ul>
                    {list.items.map((task) => (
                      <li key={task.id}>
                        <button
                          className="priority-task"
                          data-priority-focus={`task-${task.id}`}
                          onClick={() => open(task.id, `task-${task.id}`)}
                        >
                          {task.title}
                        </button>
                        <div className="priority-task-meta">
                          {task.status !== scope && (
                            <span>{scopeNames[task.status]}</span>
                          )}
                          {task.work_block && (
                            <span>
                              Work block · {momentLabel(task.work_block)}
                            </span>
                          )}
                          {task.scheduled && (
                            <span>Scheduled · {momentLabel(task.scheduled)}</span>
                          )}
                          {task.priority_from && (
                            <button
                              className="text-action"
                              data-priority-focus={`source-${task.id}`}
                              onClick={() =>
                                open(
                                  task.priority_from!.id,
                                  `source-${task.id}`,
                                )
                              }
                            >
                              {task.urgency_from ? "Importance" : "Priority"} from{" "}
                              {task.priority_from.title}
                            </button>
                          )}
                          {task.urgency_from && (
                            <button
                              className="text-action"
                              data-priority-focus={`urgency-${task.id}`}
                              onClick={() =>
                                open(task.urgency_from!.id, `urgency-${task.id}`)
                              }
                            >
                              Urgency from {task.urgency_from.title}
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {(list.next_cursor || list.offset != null) && (
                    <button
                      className="text-action"
                      onClick={() => void more()}
                      disabled={paging}
                    >
                      Load more
                    </button>
                  )}
                </>
              ) : countIn(view.summary, selected) === 0 ? (
                <p className="empty">No tasks in this square.</p>
              ) : (
                !cellError && (
                  <div className="priority-menu-status" role="status">
                    Loading tasks…
                  </div>
                )
              )}
              {(error || cellError) && (
                <div className="chart-error" role="status">
                  {error || cellError} <button onClick={retry}>Retry</button>
                </div>
              )}
            </PrioritySheet>
          )}
        </>
      ) : (
        !error && (
          <div className="chart-placeholder" role="status">
            Loading…
          </div>
        )
      )}
      {error && !(view && selected) && (
        <div className="chart-error" role="status">
          {error} <button onClick={retry}>Retry</button>
        </div>
      )}
    </section>
  );
}

function PrioritySheet({
  id,
  title,
  scroll,
  close,
  children,
}: {
  id: string;
  title: string;
  scroll: { current: number };
  close: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current!;
    const surface = node.closest(".widget-surface");
    const anchor = surface ?? node.parentElement?.querySelector(".priority-grid");
    const fit = () => {
      if (!anchor) return;
      const bounds = anchor.getBoundingClientRect();
      if (surface) {
        node.style.inset = `${Math.max(0, bounds.top)}px ${Math.max(0, window.innerWidth - bounds.right)}px ${Math.max(0, window.innerHeight - bounds.bottom)}px ${Math.max(0, bounds.left)}px`;
      } else {
        const firstRow = anchor.querySelector(".priority-square");
        const middle = anchor.querySelectorAll(".priority-column")[Math.floor(columns.length / 2)]?.getBoundingClientRect() ?? bounds;
        node.style.setProperty("--priority-popup-top", `${firstRow?.getBoundingClientRect().top ?? bounds.top}px`);
        node.style.setProperty("--priority-popup-center", `${middle.left + middle.width / 2}px`);
      }
    };
    fit();
    node.showModal();
    panel.current!.scrollTop = scroll.current;
    // Lay out the initial transparent state before transitioning the dialog in.
    node.getBoundingClientRect();
    node.dataset.visible = "true";
    const observer = anchor && new ResizeObserver(fit);
    if (anchor && observer) {
      observer.observe(anchor);
      window.addEventListener("resize", fit);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fit);
      delete node.dataset.visible;
      node.close();
    };
  }, [scroll]);
  function dismiss() {
    const node = dialog.current;
    if (!node?.hasAttribute("data-visible")) return;
    delete node.dataset.visible;
    const transitions = [
      ...node.getAnimations(),
      ...(panel.current?.getAnimations() ?? []),
    ];
    // Keep native modality and focus containment until the exit finishes.
    void Promise.allSettled(transitions.map((animation) => animation.finished)).then(() => {
      if (!node.open || node.hasAttribute("data-visible")) return;
      node.close();
      close();
    });
  }
  return (
    <dialog
      ref={dialog}
      id={id}
      className="priority-sheet"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className="priority-sheet-scrim" aria-hidden="true" onClick={dismiss} />
      <div className="priority-sheet-placement">
        <div
          className="priority-sheet-panel"
          ref={panel}
          onScroll={(event) => { scroll.current = event.currentTarget.scrollTop; }}
        >
          <header className="priority-sheet-header">
            <h2 id={`${id}-title`}>{title}</h2>
            <button
              type="button"
              className="priority-sheet-close"
              aria-label="Close task list"
              autoFocus
              onClick={dismiss}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="priority-results">{children}</div>
        </div>
      </div>
    </dialog>
  );
}

function PriorityRow({
  importance,
  y,
  count,
  scope,
  active,
  selected,
  resultId,
  choose,
  move,
  setFocus,
}: {
  importance: Importance;
  y: number;
  count: (row: number, column: number) => number;
  scope: Scope;
  active: number | undefined;
  selected: Cell | null;
  resultId: string;
  choose: (cell: Cell) => void;
  move: (event: KeyboardEvent, row: number, column: number) => void;
  setFocus: (index: number) => void;
}) {
  const label = importanceLabel(importance);
  return (
    <>
      <span className="priority-importance" aria-hidden="true" title={label}>
        <span className="priority-importance-full">{label}</span>
        {importance === "unimportant" && (
          <span className="priority-importance-short">Trivial</span>
        )}
      </span>
      {columns.map(({ id: urgency, label: column, color }, x) => {
        const n = count(y, x);
        const number = n.toLocaleString();
        const cell = { importance, urgency, scope };
        const key = cellKey(cell);
        const index = y * 7 + x;
        const importanceStrength = (6 - y) / 6;
        // Even a low-importance timed task keeps a hint of its urgency hue.
        const floor = urgency === "undated" ? 0 : 16;
        const strength = floor + (100 - floor) * importanceStrength;
        const expanded = !!selected && cellKey(selected) === key;
        return (
          <button
            type="button"
            className="priority-square"
            key={urgency}
            style={
              {
                "--priority-urgency-color": color,
                "--priority-strength": `${strength}%`,
                "--priority-count-length": number.length,
              } as CSSProperties
            }
            disabled={!n}
            tabIndex={index === active ? 0 : -1}
            data-priority-index={index}
            data-priority-focus={key}
            aria-label={`${label}, ${column}: ${number} ${n === 1 ? "task" : "tasks"}`}
            aria-haspopup={n > 0 ? "dialog" : undefined}
            aria-expanded={n > 0 ? expanded : undefined}
            aria-controls={expanded ? resultId : undefined}
            onFocus={() => setFocus(index)}
            onKeyDown={(event) => move(event, y, x)}
            onClick={() => choose(cell)}
          >
            {n > 0 && <span className="priority-count">{number}</span>}
          </button>
        );
      })}
    </>
  );
}
