import { applicationNow } from "./application-clock";
import { Charts } from "./charts";
import { taskPreparation } from "./task-preparation";
import { homeModel } from "./home-model";
import { ViewScope } from "./view-state";
import { readHome } from "./home-read";
import { interactionInProgress } from "./interaction-order";
import {
  Activity,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Folder,
} from "lucide-react";
import {
  type Api,
  type List,
  type Task,
  type Projects,
  today,
  errorText,
} from "./api";
import { useAppNavigation, useEnvironment } from "./app-context";
import { useActions, UndoButton } from "./actions";
import { IconButton, TaskRow } from "./task-row";
import { TaskExpansion } from "./task-expansion";
import { preloadDescription } from "./task-context";
import { useTaskScrollAnchor } from "./scroll-restoration";

type Snapshot = {
  revalidate?: boolean;
  next: List;
  waiting: List;
  someday: List;
  reviewTasks: List;
  reviewProjects: Projects;
  remaining: string | null;
};
type Section = "next" | "review" | "waiting" | "someday";
const preferenceKey = "gtd.home.collapsed.v1";
function initialCollapsed(): Partial<Record<Section, boolean>> {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || "{}");
    return Object.fromEntries(
      ["next", "review", "waiting", "someday"].map((key) => [
        key,
        saved?.[key] === true,
      ]),
    );
  } catch {
    // Opaque widget origins may not allow browser storage. Session state works.
    return {};
  }
}

function HomeSection({
  name,
  label,
  rows,
  more,
  open,
  toggle,
  onView,
  render,
}: {
  name: Section;
  label: string;
  rows: Task[];
  more: boolean;
  open: boolean;
  toggle: () => void;
  onView: () => void;
  render: (task: Task) => ReactNode;
}) {
  const { compact, embedded } = useEnvironment();
  const limit = compact ? (name === "next" ? 2 : 1) : name === "next" ? 5 : 3;
  if (!rows.length) return null;
  return (
    <section className="home-section" aria-labelledby={`home-${name}-heading`}>
      <div className="home-section-heading">
        <h2 id={`home-${name}-heading`}>
          <button
            className="home-section-toggle"
            aria-expanded={open}
            aria-controls={`home-${name}-items`}
            onClick={toggle}
          >
            {label}
            <ChevronDown aria-hidden="true" />
          </button>
        </h2>
        {(more || rows.length > limit) && (
          <button className="text-action" onClick={onView}>
            View all <ArrowRight />
          </button>
        )}
      </div>
      <div id={`home-${name}-items`}>
        <TaskExpansion open={open}>
          {rows.slice(0, name === "next" ? 5 : 3).map((task, i) => (
            <Activity key={task.id} mode={i >= limit ? "hidden" : "visible"}>
              {render(task)}
            </Activity>
          ))}
        </TaskExpansion>
      </div>
    </section>
  );
}

export function Home({
  api,
  revision,
  navigation,
  toolbarActions,
  initial,
  onOpen,
  onView,
  onDirtyChange,
}: {
  api: Api;
  revision: number;
  navigation: ReactNode;
  toolbarActions?: ReactNode;
  initial?: Snapshot | null;
  onOpen: (
    task: Task,
    view: "details" | "edit" | "history" | "agent-notes",
  ) => void;
  onView: (view: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const app = useAppNavigation();
  const { embedded } = useEnvironment();
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const dirty = Object.values(drafts).some(Boolean);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  // Server HTML and the first hydration render must agree. Preferences remain
  // browser-owned and are applied after hydration, without a second data read.
  const [collapsed, setCollapsed] = useState<Partial<Record<Section, boolean>>>(
    {},
  );
  useEffect(() => setCollapsed(initialCollapsed()), []);
  function toggle(section: Section) {
    setCollapsed((previous) => {
      const next = { ...previous, [section]: !previous[section] };
      try {
        localStorage.setItem(preferenceKey, JSON.stringify(next));
      } catch {}
      return next;
    });
  }
  const [data, setData] = useState<Snapshot | null>(initial || null);
  const anchor = useTaskScrollAnchor();
  useEffect(() => {
    if (!data?.next.items.some((task) => task.has_notes || task.notes)) return;
    // Primary recommendations are likely to be opened next. Warm only their
    // shared renderer once recommendations mount; record bodies remain bounded by
    // the selected loading policy. This holds no personal data or draft state.
    const frame = requestAnimationFrame(() => {
      void preloadDescription().catch(() => {});
    });
    return () => cancelAnimationFrame(frame);
  }, [!!data]);
  const preparation = useMemo(
    () => (api.taskPreparation ? taskPreparation(api) : undefined),
    [api, revision, data],
  );
  useEffect(() => () => preparation?.dispose(), [preparation]);
  const [error, setError] = useState("");
  const [showError, setShowError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const { controller, state: saves } = useActions();
  const consumedInitial = useRef(false);
  useEffect(() => {
    const gen = ++generation.current;
    if (initial && !consumedInitial.current) {
      consumedInitial.current = true;
      controller.observe([
        ...initial.next.items,
        ...initial.waiting.items,
        ...initial.someday.items,
        ...initial.reviewTasks.items,
        ...initial.reviewProjects.projects,
      ]);
      return;
    }
    let deferred: ReturnType<typeof setTimeout>;
    readHome(api, today())
      .then(
        ({
          next,
          waiting,
          someday,
          reviewTasks,
          reviewProjects,
          remaining,
        }) => {
          if (gen !== generation.current) return;
          const commit = () => {
            if (gen !== generation.current) return;
            // Defer, rather than discard, an update received during a gesture or edit.
            if (controller.snapshot().intents.size || interactionInProgress()) {
              deferred = setTimeout(commit, 150);
              return;
            }
            anchor.remember();
            controller.observe([
              ...next.items,
              ...waiting.items,
              ...someday.items,
              ...reviewTasks.items,
              ...reviewProjects.projects,
            ]);
            setData({
              next,
              waiting,
              someday,
              reviewTasks,
              reviewProjects,
              remaining,
            });
            setError("");
          };
          commit();
        },
      )
      .catch((e) => {
        if (gen === generation.current) setError(errorText(e));
      });
    return () => {
      ++generation.current;
      clearTimeout(deferred);
    };
  }, [api, revision, attempt, controller]);

  useEffect(() => {
    if (!initial?.revalidate) return;
    let next = 0;
    const first = requestAnimationFrame(() => {
      next = requestAnimationFrame(() => setAttempt((n) => n + 1));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(next);
    };
  }, [initial]);

  useEffect(() => {
    const next = [
      data?.next.next_change_at,
      data?.waiting.next_change_at,
      data?.someday.next_change_at,
      data?.reviewTasks.next_change_at,
    ]
      .filter((v): v is string => !!v)
      .sort()[0];
    if (!next) return;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (applicationNow() < Date.parse(next)) {
        timer = setTimeout(
          refresh,
          Math.min(2147483647, Date.parse(next) - applicationNow() + 50),
        );
        return;
      }
      if (saves.intents.size || interactionInProgress()) {
        timer = setTimeout(refresh, 1000);
        return;
      }
      setAttempt((n) => n + 1);
    };
    timer = setTimeout(
      refresh,
      Math.min(2147483647, Math.max(100, Date.parse(next) - applicationNow() + 50)),
    );
    const visible = () => {
      if (applicationNow() >= Date.parse(next)) refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [data, saves.intents.size]);
  const { next, lead, waiting, someday, review, empty, effective } = homeModel(
    data,
    today(),
    saves.intents,
    (task) => controller.project(task, saves),
  );
  const taskRow = (
    task: Task,
    featured = false,
    statusContext?: Task["status"],
  ) => (
    <ViewScope
      key={task.id}
      id={`home:${featured ? "featured" : statusContext || "next"}:${task.id}`}
    >
      <TaskRow
        key={task.id}
        task={task}
        api={api}
        onOpen={onOpen}
        inlineDetails
        preparation={preparation}
        featured={featured}
        statusContext={statusContext}
        update={(t) => controller.observe([t])}
        onDraft={(record, value) =>
          setDrafts((old) =>
            old[record.id] === value ? old : { ...old, [record.id]: value },
          )
        }
      />
    </ViewScope>
  );
  const reviewRow = (task: Task) =>
    task.entity_type === "project" ? (
      <button
        className="home-project-row"
        onClick={() =>
          app.go({ page: "Projects", input: { project_id: task.id } })
        }
      >
        <Folder aria-hidden="true" />
        <span>
          <strong>{effective(task).title}</strong>
          <small>Project</small>
        </span>
        <ChevronRight aria-hidden="true" />
      </button>
    ) : (
      <ViewScope id="home:review">{taskRow(task)}</ViewScope>
    );
  return (
    <section
      ref={anchor.root}
      className="home-browser task-browser compact-widget"
      aria-label="Home"
    >
      <div className="browse-toolbar">
        <div className="workspace-list-heading">
          {navigation}
          <h1>Home</h1>
        </div>
        <div className="view-actions">
          {toolbarActions}
          <UndoButton />
          {error && (
            <IconButton
              label="View connection problem"
              onClick={() => setShowError(!showError)}
            >
              <AlertCircle className="save-error" />
            </IconButton>
          )}
        </div>
      </div>
      {!embedded && <Charts revision={revision} home />}
      {error && (showError || !data) && (
        <div className="recovery" role="alert">
          <p>{error}</p>
          <button onClick={() => setAttempt((n) => n + 1)}>
            Retry refresh
          </button>
        </div>
      )}
      {!data && !error && (
        <div className="compact-empty" role="status">
          Loading…
        </div>
      )}
      {data && (
        <>
          {lead && (
            <section className="home-focus" aria-label="Next action">
              {taskRow(lead, true)}
            </section>
          )}
          <HomeSection
            name="next"
            label="Next"
            rows={next.slice(1)}
            more={!!data.next.next_cursor}
            open={!collapsed.next}
            toggle={() => toggle("next")}
            onView={() => onView("next")}
            render={taskRow}
          />
          <HomeSection
            name="review"
            label="Review"
            rows={review}
            more={
              !!data.reviewTasks.next_cursor ||
              !!data.reviewProjects.next_cursor
            }
            open={!collapsed.review}
            toggle={() => toggle("review")}
            onView={() => onView("review")}
            render={reviewRow}
          />
          <HomeSection
            name="waiting"
            label="Waiting"
            rows={waiting}
            more={!!data.waiting.next_cursor}
            open={!collapsed.waiting}
            toggle={() => toggle("waiting")}
            onView={() => onView("waiting")}
            render={(task) => taskRow(task, false, "waiting")}
          />
          <HomeSection
            name="someday"
            label="Someday"
            rows={someday}
            more={!!data.someday.next_cursor}
            open={!collapsed.someday}
            toggle={() => toggle("someday")}
            onView={() => onView("someday")}
            render={(task) => taskRow(task, false, "someday")}
          />
          {empty && (
            <div className="home-empty" role="status">
              <p>{data.remaining ? "No ready tasks" : "No tasks to show."}</p>
              {data.remaining && (
                <button
                  className="text-action"
                  onClick={() =>
                    onView(data.remaining === "blocked" ? "blocked" : "all")
                  }
                >
                  {data.remaining === "blocked" ? "View blocked" : "View all"}{" "}
                  <ArrowRight />
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
