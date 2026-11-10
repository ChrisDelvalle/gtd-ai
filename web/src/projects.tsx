import { SortControl } from "./sort-control";
import { BriefField } from "./brief-field";
import { useViewState, useViewRef } from "./view-state";
import { ImportanceField } from "./planning-fields";
import { EstimateFields } from "./planning-schedule";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDraftFields, useDraftRef } from "./use-record-draft";
import {
  ArrowLeft,
  ChevronDown,
  Folder,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Pencil,
  CheckCheck,
  Archive,
  Lightbulb,
  RotateCcw,
  History,
  Undo2,
  NotebookPen,
} from "lucide-react";
import {
  type Api,
  type Args,
  type Project,
  type Projects,
  type List,
  type Task,
  ApiError,
  errorText,
  today,
} from "./api";
import { Inspector, Recovery, useActions, SaveIcon } from "./shared";
import { TaskContext } from "./task-context";
import { WorkflowContext } from "./workflow-fields";
import { TaskList } from "./task-list";
import { IconButton } from "./task-row";
import { Menu } from "./floating-panel";
import { TaskExpansion } from "./task-expansion";
import { useExpandedView } from "./expanded-view";
import { retryable } from "./mutations";
import { useEnvironment, useAppNavigation } from "./app-context";

type ResolutionTarget = "done" | "someday" | "archive";
type Choice = "" | "done" | "someday" | "archive" | "remove";

export function ProjectBrowser({
  navigation,
  toolbarActions,
  api,
  revision = 0,
  initial,
  input = {},
  onDirtyChange,
  hideWhenEmpty = false,
  onEmptyChange,
}: {
  navigation?: ReactNode;
  toolbarActions?: ReactNode;
  api: Api;
  revision?: number;
  initial?: Projects | null;
  input?: Args;
  onDirtyChange?: (dirty: boolean) => void;
  hideWhenEmpty?: boolean;
  onEmptyChange?: (empty: boolean | null) => void;
}) {
  const expanded = useExpandedView();
  const { embedded } = useEnvironment();
  const navigationState = useAppNavigation();
  const [selected, setSelected] = useState<string | null>(
    typeof input.project_id === "string" ? input.project_id : null,
  );
  const [scopeChanged, setScopeChanged] = useState(false);
  const [scope, setScope] = useState(
    String(
      input.archived === true
        ? "archive"
        : input.status || (input.view === "all" ? "all" : "active"),
    ),
  );
  const [rows, setRows] = useViewState<Project[]>(
      "projects:rows",
      initial?.projects || [],
    ),
    [cursor, setCursor] = useViewState<string | null>(
      "projects:cursor",
      initial?.next_cursor || null,
    );
  const [sort, setSort] = useViewState<string>("projects:sort", String(input.sort || (input.query ? "relevance" : input.review_on ? "review" : "due")));
  const [appliedSort, setAppliedSort] = useState(sort);
  const [loaded, setLoaded] = useState(!!initial);
  const [project, setProject] = useState<Project | null>(() => initial?.projects.find((row) => row.id === selected) ?? null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0);
  const fields = useDraftFields(
    `projects:${input.project_id || input.review_on || "list"}`,
    () => ({
      create: false,
      title: "",
      brief: "",
      resolution: null as ResolutionTarget | null,
    }),
    (v) => !!v.title.trim() || !!v.brief.trim() || !!v.resolution,
  );
  const [create, setCreate] = fields("create"),
    [title, setTitle] = fields("title"),
    [brief, setBrief] = fields("brief"),
    [editor, setEditor] = useViewState<
      "edit" | "history" | "agent-notes" | null
    >("projects:editor", null),
    [dirty, setDirty] = useState(false),
    [resolution, setResolution] = fields("resolution");
  const [menu, setMenu] = useState(false),
    [scopeMenu, setScopeMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null),
    scopeAnchor = useRef<HTMLButtonElement>(null),
    generation = useRef(0);
  const { controller, run } = useActions();
  const creationReceipt = controller.state.receipts.get("create_project");
  const seenCreation = useRef(creationReceipt);
  const creationRequest = useDraftRef<string | null>(
    "projects:create-request",
    null,
    Boolean,
  );
  useEffect(() => {
    if (creationReceipt && creationReceipt !== seenCreation.current) {
      seenCreation.current = creationReceipt;
      if (
        controller.state.receiptRequests.get("create_project") !==
        creationRequest.current
      )
        return;
      creationRequest.current = null;
      setTitle("");
      setBrief("");
      setCreate(false);
      setSelected(creationReceipt.task.id);
      setProject(creationReceipt.task);
      setEditor(null);
      if (!embedded && navigationState.current.page === "Projects")
        navigationState.go({
          page: "Projects",
          input: { project_id: creationReceipt.task.id },
        });
    }
  }, [creationReceipt]);
  const [nestedDrafts, setNestedDrafts] = useState<Record<string, boolean>>({});
  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  const nestedDirty = Object.values(nestedDrafts).some(Boolean);
  const hasDraft = dirty || !!title.trim() || !!brief.trim() || !!resolution || nestedDirty;
  function nested(key: string, value: boolean) {
    setNestedDrafts((old) =>
      old[key] === value ? old : { ...old, [key]: value },
    );
  }
  const inputKey = JSON.stringify(input);
  const appliedInput = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (appliedInput.current === inputKey) return;
    appliedInput.current = inputKey;
    if (input.sort || input.query || input.review_on)
      setSort(String(input.sort || (input.query ? "relevance" : "review")));
    setSelected(typeof input.project_id === "string" ? input.project_id : null);
    setScope(
      String(
        input.archived === true
          ? "archive"
          : input.status || (input.view === "all" ? "all" : "active"),
      ),
    );
  }, [inputKey]);
  useEffect(() => {
    report.current?.(hasDraft);
  }, [hasDraft]);
  useEffect(() => () => report.current?.(false), []);
  const filter: Args = selected
    ? { project_id: selected, include_deleted: true, detail: "full" }
    : {
        ...Object.fromEntries(
          Object.entries(input).filter(([key]) => key !== "project_id"),
        ),
        ...(scopeChanged || !Object.keys(input).length
          ? {
              status: ["archive", "all"].includes(scope) ? undefined : scope,
              view: scope === "all" ? "all" : undefined,
              archived: scope === "all" ? undefined : scope === "archive",
              cursor: undefined,
            }
          : {}),
        ...(input.review_on ? { status: undefined } : {}),
        detail: "summary", sort,
      };
  const filterKey = JSON.stringify(filter);
  const firstRead = useRef(true);
  const loadedCount = useViewRef("projects:loaded-count", rows.length || 20);
  const lastFilter = useRef(filterKey);
  useEffect(() => {
    if (firstRead.current && initial && (!selected || project?.id === selected && typeof project.notes === "string")) {
      firstRead.current = false;
      return;
    }
    firstRead.current = false;
    const gen = ++generation.current;
    if (lastFilter.current !== filterKey) loadedCount.current = 20;
    lastFilter.current = filterKey;
    setBusy(true);
    const read = async () => {
      let result = await api.call<Projects>("list_projects", filter);
      while (
        !selected &&
        result.next_cursor &&
        result.projects.length < loadedCount.current &&
        gen === generation.current
      ) {
        const next = await api.call<Projects>("list_projects", {
          ...filter,
          cursor: result.next_cursor,
        });
        result = { ...next, projects: [...result.projects, ...next.projects] };
      }
      return result;
    };
    read()
      .then((r) => {
        if (gen !== generation.current) return;
        if (selected) {
          setProject(r.projects[0] || null);
          if (r.projects[0]) controller.observe(r.projects);
        } else {
          setRows(r.projects);
          setAppliedSort(sort);
          setCursor(r.next_cursor);
        }
        setLoaded(true);
        setError("");
      })
      .catch((e) => {
        if (gen === generation.current) setError(errorText(e));
      })
      .finally(() => {
        if (gen === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [api, filterKey, revision, attempt]);
  async function more() {
    if (!cursor || busy) return;
    const gen = generation.current;
    setBusy(true);
    try {
      const r = await api.call<Projects>("list_projects", {
        ...filter,
        cursor,
      });
      if (gen === generation.current) {
        loadedCount.current = rows.length + r.projects.length;
        setRows((p) => [
          ...p,
          ...r.projects.filter((x) => !p.some((y) => y.id === x.id)),
        ]);
        setCursor(r.next_cursor);
        setError("");
      }
    } catch (e) {
      if (gen === generation.current) setError(errorText(e));
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }
  async function capture() {
    if (!title.trim()) return;
    const pending = run("create_project", {
      title: title.trim(),
      brief,
      reason: "Created a project using the project interface.",
    });
    creationRequest.current = String(
      controller.state.intents.get("create_project")?.args.request_id || "",
    );
    const r = await pending;
    if (r) {
      seenCreation.current = controller.state.receipts.get("create_project");
      setTitle("");
      setBrief("");
      setCreate(false);
      setSelected(r.task.id);
      setProject(r.task);
      setEditor(null);
      if (!embedded && navigationState.current.page === "Projects")
        navigationState.go({
          page: "Projects",
          input: { project_id: r.task.id },
        });
    }
  }
  const current = project
    ? ({
        ...controller.project(project),
        task_counts: project.task_counts,
        needs_next_action: project.needs_next_action,
      } as Project)
    : null;
  const refresh = () => setAttempt((n) => n + 1);
  function open(id: string) {
    if (hasDraft) return;
    expanded(() => {
      if (!embedded) {
        navigationState.go({ page: "Projects", input: { project_id: id } });
        return;
      }
      setSelected(id);
      setProject(null);
      setEditor(null);
    });
  }
  function action(fn: () => void) {
    setMenu(false);
    anchor.current?.focus({ preventScroll: true });
    expanded(fn);
  }
  async function restore() {
    if (!current) return;
    const r = await run(
      "update_project",
      {
        project_id: current.id,
        expected_version: current.version,
        ...(current.archived ? { archived: false } : { status: "active" }),
        reason: "Reactivated the project using the project interface.",
      },
      current,
      {
        ...current,
        archived: false,
        status: current.archived ? current.status : "active",
      },
    );
    if (r) refresh();
  }
  const empty =
    !loaded && !error
      ? null
      : !rows.length && !selected && !create && !hasDraft && !error;
  useEffect(() => {
    onEmptyChange?.(empty);
  }, [empty, onEmptyChange]);
  if (hideWhenEmpty && empty !== false) return null;
  return (
    <section
      className="project-browser compact-widget"
      aria-label="Projects"
      aria-busy={busy}
    >
      <div className="project-toolbar">
        <div className="project-toolbar-start">
          {navigation}
          {selected ? (
            <IconButton
              label="Back to projects"
              disabled={
                hasDraft ||
                !!(current && controller.state.intents.has(current.id))
              }
              onClick={() => {
                if (!embedded) {
                  navigationState.go({ page: "Projects" });
                  return;
                }
                setSelected(null);
                setProject(null);
                setEditor(null);
              }}
            >
              <ArrowLeft />
            </IconButton>
          ) : (
            <>
              <button
                className="scope-button"
                ref={scopeAnchor}
                aria-haspopup="menu"
                aria-expanded={scopeMenu}
                disabled={!!input.review_on}
                onClick={() => setScopeMenu(!scopeMenu)}
              >
                <span>
                  {input.review_on
                    ? "Projects to review"
                    : scope === "archive"
                      ? "Archived projects"
                      : scope === "someday"
                        ? "Someday projects"
                        : scope === "done"
                          ? "Completed projects"
                          : scope === "all"
                            ? "All projects"
                            : "Active projects"}
                </span>
                {!input.review_on && <ChevronDown />}
              </button>
              {scopeMenu && (
                <Menu
                  label="Project views"
                  anchor={scopeAnchor}
                  close={() => setScopeMenu(false)}
                >
                  {["active", "someday", "done", "archive", "all"].map((s) => (
                    <button
                      role="menuitemradio"
                      aria-checked={s === scope}
                      key={s}
                      onClick={() => {
                        setScope(s);
                        if (
                          !embedded &&
                          navigationState.current.page === "Projects"
                        )
                          navigationState.updateUrl?.({
                            page: "Projects",
                            input: {
                              ...input,
                              project_id: undefined,
                              status: ["archive", "all"].includes(s)
                                ? undefined
                                : s,
                              view: s === "all" ? "all" : undefined,
                              archived:
                                s === "all" ? undefined : s === "archive",
                            },
                          });
                        setScopeChanged(true);
                        setScopeMenu(false);
                      }}
                    >
                      {s === "active"
                        ? "Active"
                        : s === "someday"
                          ? "Someday / maybe"
                          : s === "done"
                            ? "Done"
                            : s === "all"
                              ? "All projects"
                              : "Archive"}
                    </button>
                  ))}
                </Menu>
              )}
            </>
          )}
        </div>
        <div className="view-actions">
          {!selected && <SortControl labels={{due:"Deadline"}} value={appliedSort} select={setSort}
            options={[...(input.query ? ["relevance"] : []), ...(input.review_on ? ["review"] : []), "due", "updated", "title"]}
            pending={sort !== appliedSort ? sort : undefined} />}
          {toolbarActions}
          {embedded && (
            <IconButton
              label="Refresh projects"
              disabled={busy}
              onClick={refresh}
            >
              <RefreshCw className={busy ? "spinning" : ""} />
            </IconButton>
          )}
          {!selected && (
            <IconButton
              label="Create project"
              onClick={() => expanded(() => setCreate(!create))}
            >
              <Plus />
            </IconButton>
          )}
          {current && (
            <>
              <SaveIcon taskId={current.id} />
              <IconButton
                ref={anchor}
                label="Project options"
                aria-haspopup="menu"
                aria-expanded={menu}
                disabled={
                  hasDraft ||
                  !!(current && controller.state.intents.has(current.id))
                }
                onClick={() => setMenu(!menu)}
              >
                <MoreHorizontal />
              </IconButton>
              {menu && (
                <Menu
                  label="Project options"
                  anchor={anchor}
                  close={() => setMenu(false)}
                >
                  <button
                    role="menuitem"
                    onClick={() =>
                      action(() => setEditor(editor === "edit" ? null : "edit"))
                    }
                  >
                    <Pencil />
                    Edit project
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => action(() => setEditor("agent-notes"))}
                  >
                    <NotebookPen />
                    Agent notes
                  </button>
                  <button
                    role="menuitem"
                    onClick={() =>
                      action(() =>
                        setEditor(editor === "history" ? null : "history"),
                      )
                    }
                  >
                    <History />
                    History
                  </button>
                  {!current.deleted && (
                    <>
                      {current.status !== "done" && (
                        <button
                          role="menuitem"
                          onClick={() => action(() => setResolution("done"))}
                        >
                          <CheckCheck />
                          Complete project
                        </button>
                      )}
                      {current.status !== "someday" && !current.archived && (
                        <button
                          role="menuitem"
                          onClick={() => action(() => setResolution("someday"))}
                        >
                          <Lightbulb />
                          Move to someday
                        </button>
                      )}
                      {(current.archived || current.status !== "active") && (
                        <button
                          role="menuitem"
                          onClick={() => action(() => void restore())}
                        >
                          <RotateCcw />
                          {current.archived ? "Unarchive" : "Reactivate"}
                        </button>
                      )}
                      {!current.archived && (
                        <button
                          role="menuitem"
                          onClick={() => action(() => setResolution("archive"))}
                        >
                          <Archive />
                          Archive project
                        </button>
                      )}
                    </>
                  )}
                  <button
                    role="menuitem"
                    onClick={() =>
                      action(
                        () =>
                          void run(
                            "undo_change",
                            {
                              change_id: current.last_change_id,
                              expected_version: current.version,
                              reason:
                                "Undid the latest project change using the interface.",
                            },
                            current,
                          ).then((r) => {
                            if (r) refresh();
                          }),
                      )
                    }
                  >
                    <Undo2 />
                    {current.deleted ? "Restore project" : "Undo latest"}
                  </button>
                </Menu>
              )}
            </>
          )}
        </div>
      </div>
      {error && (
        <div className="recovery" role="alert">
          {error}
          <button onClick={refresh}>Retry</button>
        </div>
      )}
      {!selected && (
        <>
          <TaskExpansion open={create}>
            <form
              className="project-create"
              onSubmit={(e) => {
                e.preventDefault();
                void capture();
              }}
            >
              <label>
                Desired outcome
                <input
                  autoFocus
                  required
                  maxLength={500}
                  value={title}
                  placeholder="What will be true when this is finished?"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <BriefField value={brief} onChange={setBrief} required />
              <button
                className="primary"
                disabled={
                  controller.state.intents.has("create_project") ||
                  !title.trim()
                }
              >
                Create project
              </button>
              <Recovery taskId="create_project" />
            </form>
          </TaskExpansion>
          {!rows.length && !busy && !error && (
            <p className="compact-empty">No projects in this view.</p>
          )}
          {rows.map((p) => (
            <button
              className="project-row"
              key={p.id}
              onClick={() => open(p.id)}
              disabled={hasDraft}
            >
              <Folder aria-hidden="true" />
              <span>
                <strong>{p.title}</strong>
                <span className="muted">
                  {p.needs_next_action
                    ? "Needs a next action"
                    : p.task_counts?.next
                      ? `${p.task_counts.next} next action${p.task_counts.next === 1 ? "" : "s"}`
                      : p.task_counts?.waiting
                        ? "Waiting"
                        : p.status === "done"
                          ? "Completed"
                          : ""}
                  {p.task_counts?.blocked
                    ? ` · ${p.task_counts.blocked} blocked`
                    : ""}
                </span>
              </span>
            </button>
          ))}
          {cursor && (
            <button
              className="text-action"
              disabled={busy}
              onClick={() => void more()}
            >
              More projects
            </button>
          )}
        </>
      )}
      {selected && !current && !error && (
        <p className="compact-empty" role="status">
          {busy ? "Loading project…" : "Project not found."}
        </p>
      )}
      {current && (
        <>
          <div className="project-heading">
            <h2>{current.title}</h2>
            {(current.archived ||
              current.status !== "active" ||
              current.deleted) && (
              <span className="muted">
                {current.deleted
                  ? "Capture undone"
                  : current.archived
                    ? "Archived"
                    : current.status === "someday"
                      ? "Someday / maybe"
                      : "Completed"}
              </span>
            )}
          </div>
          <Recovery taskId={current.id} />
          {!!(current.brief || current.notes || current.links?.length) && (
            <TaskContext task={current} api={api} />
          )}
          <WorkflowContext task={current} api={api} />
          {current.needs_next_action && !current.deleted && (
            <p className="muted project-next-hint">
              Clarify a next action, or review whether this outcome is still
              committed.
            </p>
          )}
          <TaskExpansion open={!!editor}>
            <div className="project-editor">
              {editor && (
                <Inspector
                  key={current.id}
                  task={current}
                  api={api}
                  embeddedView={editor}
                  onDirtyChange={setDirty}
                  onTask={(p) => {
                    setProject(p);
                    refresh();
                  }}
                />
              )}
              <button
                className="text-action"
                disabled={dirty}
                onClick={() => setEditor(null)}
              >
                Close {editor === "agent-notes" ? "agent notes" : editor}
              </button>
            </div>
          </TaskExpansion>
          {resolution && (
            <ProjectResolution
              api={api}
              project={current}
              target={resolution}
              onClose={() => setResolution(null)}
              onSaved={() => {
                setResolution(null);
                refresh();
              }}
            />
          )}
          <div inert={!!resolution}>
            {!current.deleted &&
              [
                ...([
                  "next",
                  "waiting",
                  "blocked",
                  "inbox",
                  "someday",
                  "done",
                  "archived",
                ] as const),
              ].map((status) => {
                const count = current.task_counts?.[status] || 0;
                return count > 0 || nestedDrafts[status] ? (
                  <ProjectGroup
                    key={status}
                    api={api}
                    project={current}
                    status={status}
                    count={count}
                    revision={revision + attempt}
                    onDirtyChange={(value) => nested(status, value)}
                  />
                ) : null;
              })}
            {!current.deleted && (
              <ProjectCapture
                key={current.id}
                api={api}
                project={current}
                onSaved={refresh}
                onDirtyChange={(value) => nested("capture", value)}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
function ProjectGroup({
  api,
  project,
  status,
  count,
  revision,
  onDirtyChange,
}: {
  api: Api;
  project: Project;
  status: string;
  count: number;
  revision: number;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(status !== "done" && status !== "archived");
  return (
    <section className="project-group">
      <button
        className="project-group-heading"
        disabled={dirty}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          {
            (
              {
                next: "Next actions",
                waiting: "Waiting",
                blocked: "Blocked",
                planned: "Blocked",
                inbox: "Inbox",
                someday: "Someday / maybe",
                done: "Done",
                archived: "Archived tasks",
              } as Record<string, string>
            )[status]
          }{" "}
          <span className="muted">{count}</span>
        </span>
        <ChevronDown className={open ? "turned" : ""} />
      </button>
      <TaskExpansion open={open}>
        <TaskList
          api={api}
          bare
          input={{
            project_id: project.id,
            ...(status === "archived"
              ? { archived: true }
              : { status, archived: false }),
          }}
          revision={revision}
          onDirtyChange={(value) => {
            setDirty(value);
            onDirtyChange(value);
          }}
        />
      </TaskExpansion>
    </section>
  );
}
function ProjectCapture({
  api,
  project,
  onSaved,
  onDirtyChange,
}: {
  api: Api;
  project: Project;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const field = useDraftFields(
    `project-capture:${project.id}`,
    () => ({
      open: false,
      title: "",
      brief: "",
      status: "blocked",
      importance: "normal" as import("./api").Importance,
      estimates: {} as Pick<Task, "estimated_minutes" | "effort">,
    }),
    (value) => !!value.title.trim() || !!value.brief.trim(),
  );
  const [open, setOpen] = field("open"),
    [title, setTitle] = field("title"),
    [brief, setBrief] = field("brief"),
    [status, setStatus] = field("status");
  const [importance, setImportance] = field("importance");
  const [estimates, setEstimates] = field("estimates");
  const { run, controller } = useActions();
  const captureKey = `project-capture:${project.id}`;
  const receipt = controller.state.receipts.get(captureKey);
  const seen = useRef(receipt),
    saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(() => {
    if (receipt && receipt !== seen.current) {
      seen.current = receipt;
      if (
        receipt.task.entity_type !== "project" &&
        receipt.change.operation === "capture"
      ) {
        setTitle("");
      setBrief("");
        setImportance("normal");
        setEstimates({});
        setOpen(false);
        saved.current();
      }
    }
  }, [receipt]);
  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  useEffect(() => {
    report.current(!!title.trim());
  }, [title]);
  useEffect(() => () => report.current(false), []);
  if ((project.archived || project.status === "done") && !title.trim())
    return null;
  async function capture() {
    const result = await run(
      "capture_item",
      {
        title,
        brief,
        project_id: project.id,
        importance,
        ...estimates,
        status: project.status === "someday" ? "someday" : status,
        reason: "Added a project action using the interface.",
      },
      undefined,
      undefined,
      captureKey,
    );
    if (result) {
      setTitle("");
      setBrief("");
      setImportance("normal");
      setEstimates({});
      setOpen(false);
      onSaved();
    }
  }
  return (
    <div className="project-capture">
      <button
        type="button"
        className="text-action"
        disabled={!!title.trim()}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Plus />
        Add action
      </button>
      <TaskExpansion open={open}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void capture();
          }}
        >
          <label>
            Action
            <input
              required
              maxLength={500}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <BriefField value={brief} onChange={setBrief} required={project.status === "someday" || status !== "inbox"} />
          <ImportanceField
            value={importance}
            onChange={setImportance}
            disabled={controller.state.intents.has(captureKey)}
          />
          {project.status === "active" && (
            <label>
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="blocked">Blocked</option>
                <option value="next">Next action</option>
                <option value="inbox">Inbox</option>
                <option value="waiting">Waiting</option>
              </select>
            </label>
          )}
          <EstimateFields
            value={estimates}
            required={project.status !== "someday" && status !== "inbox"}
            onChange={(value) =>
              setEstimates((previous) => ({ ...previous, ...value }))
            }
          />
          <button
            className="primary"
            disabled={!title.trim() || controller.state.intents.has(captureKey)}
          >
            Add action
          </button>
          <button
            type="button"
            disabled={controller.state.intents.has(captureKey)}
            onClick={() => {
              setTitle("");
      setBrief("");
              setEstimates({});
              setOpen(false);
            }}
          >
            Cancel
          </button>
          <Recovery taskId={captureKey} />
        </form>
      </TaskExpansion>
    </div>
  );
}
function ProjectResolution({
  api,
  project,
  target,
  onClose,
  onSaved,
}: {
  api: Api;
  project: Project;
  target: ResolutionTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { controller } = useActions();
  const fields = useDraftFields(
    `project-resolution:${project.id}:${target}`,
    () => ({
      rows: [] as Task[],
      base: project,
      choices: {} as Record<string, Choice>,
      loaded: false,
      busy: false,
      error: "",
      uncertain: false,
    }),
    (v) => v.busy || v.uncertain || Object.keys(v.choices).length > 0,
  );
  const [rows, setRows] = fields("rows"),
    [base, setBase] = fields("base"),
    [choices, setChoices] = fields("choices"),
    [loaded, setLoaded] = fields("loaded"),
    [busy, setBusy] = fields("busy"),
    [error, setError] = fields("error"),
    [uncertain, setUncertain] = fields("uncertain");
  const request = useDraftRef<Args | null>(
      `project-resolution-request:${project.id}:${target}`,
      null,
      Boolean,
    ),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    if (!request.current && !busy) void load();
    return () => {
      live.current = false;
    };
  }, []);
  async function load() {
    setLoaded(false);
    setError("");
    try {
      const [p, first] = await Promise.all([
        api.call<Projects>("list_projects", {
          project_id: project.id,
          detail: "full",
        }),
        api.call<List>("list_items", {
          project_id: project.id,
          view: "all",
          archived: false,
          limit: 100,
        }),
      ]);
      let all = first.items,
        next = first.next_cursor;
      while (next) {
        const page = await api.call<List>("list_items", {
          project_id: project.id,
          view: "all",
          archived: false,
          limit: 100,
          cursor: next,
        });
        all = all.concat(page.items);
        next = page.next_cursor;
      }
      if (!live.current) return;
      setBase(p.projects[0] || project);
      const affected = all.filter((t) =>
        target === "archive" || target === "done"
          ? target === "archive" || t.status !== "done"
          : !["done", "someday"].includes(t.status),
      );
      setRows(affected);
      setChoices((old) =>
        Object.fromEntries(
          affected.map((t) => [
            t.id,
            old[t.id] || (target === "done" ? "" : target),
          ]),
        ),
      );
      setLoaded(true);
    } catch (e) {
      if (live.current) setError(errorText(e));
    }
  }
  async function submit(retry = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    if (!retry) {
      const ops = rows.map((t) => ({
        operation: "update",
        task_id: t.id,
        expected_version: t.version,
        ...(choices[t.id] === "remove"
          ? { clear_project: true }
          : choices[t.id] === "archive"
            ? { archived: true }
            : { status: choices[t.id] }),
        reason: `Resolved a project task while ${target === "done" ? "completing" : target === "someday" ? "shelving" : "archiving"} its project.`,
      }));
      request.current = {
        request_id: crypto.randomUUID(),
        operations: [
          ...ops,
          {
            operation: "update_project",
            project_id: base.id,
            expected_version: base.version,
            ...(target === "archive" ? { archived: true } : { status: target }),
            reason: `${target === "done" ? "Completed" : target === "someday" ? "Shelved" : "Archived"} the project after explicitly resolving its tasks.`,
          },
        ],
      };
    }
    try {
      for (let n = 0; ; n++) {
        try {
          await api.call("apply_changes", request.current!);
          controller.clearConfirmation();
          break;
        } catch (e) {
          if (e instanceof ApiError && retryable(e) && n < 2) {
            await new Promise((r) => setTimeout(r, 600 * 2 ** n));
            continue;
          }
          throw e;
        }
      }
      setUncertain(false);
      setChoices({});
      request.current = null;
      onSaved();
    } catch (e) {
      setError(errorText(e));
      const uncertain = e instanceof ApiError && e.uncertain;
      setUncertain(uncertain);
      if (!uncertain) request.current = null;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-resolution" aria-label="Resolve project tasks">
      <h3>
        {target === "done"
          ? "Complete project"
          : target === "someday"
            ? "Move project to someday"
            : "Archive project"}
      </h3>
      {!loaded && !error && <p role="status">Checking remaining tasks…</p>}
      {loaded && (
        <>
          <p className="muted">
            {rows.length
              ? "Choose what happens to the remaining tasks. These changes are saved together."
              : "No task changes are needed."}
          </p>
          {rows.map((t) => (
            <label className="resolution-row" key={t.id}>
              <span>{t.title}</span>
              <select
                disabled={busy || uncertain}
                value={choices[t.id]}
                onChange={(e) =>
                  setChoices({ ...choices, [t.id]: e.target.value as Choice })
                }
              >
                <option value="" disabled>
                  Choose an outcome
                </option>
                {target !== "archive" && (
                  <option value="done">Mark done</option>
                )}
                {target === "someday" && (
                  <option value="someday">Someday / maybe</option>
                )}
                <option value="archive">
                  Archive{t.status !== "done" ? " unfinished" : ""}
                </option>
                <option value="remove">Remove from project</option>
              </select>
            </label>
          ))}
        </>
      )}
      {rows.length > 49 && (
        <p role="alert">
          This exceeds the 50-record atomic limit. Resolve some tasks in their
          editors, then review the remaining tasks here.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="resolution-actions">
        {uncertain ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void submit(true)}
          >
            Retry original change
          </button>
        ) : (
          <>
            <button
              className="primary"
              disabled={
                !loaded ||
                busy ||
                rows.length > 49 ||
                !!error ||
                rows.some((t) => !choices[t.id])
              }
              onClick={() => void submit()}
            >
              Confirm{" "}
              {target === "done"
                ? "completion"
                : target === "someday"
                  ? "move"
                  : "archive"}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setChoices({});
                request.current = null;
                onClose();
              }}
            >
              Cancel
            </button>
            {(error || rows.length > 49) && (
              <button disabled={busy} onClick={() => void load()}>
                Review current tasks
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function Review({
  api,
  revision = 0,
  onDirtyChange,
}: {
  api: Api;
  revision?: number;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [projectsEmpty, setProjectsEmpty] = useState<boolean | null>(null);
  const [tasksEmpty, setTasksEmpty] = useState<boolean | null>(null);
  const dirty = useRef<Record<string, boolean>>({});
  const report = (key: string, value: boolean) => {
    dirty.current[key] = value;
    onDirtyChange?.(Object.values(dirty.current).some(Boolean));
  };
  return (
    <section className="review-browser">
      {projectsEmpty !== false && tasksEmpty !== false && (
        <p className="compact-empty" role="status">
          {projectsEmpty && tasksEmpty ? "Nothing to review." : "Loading…"}
        </p>
      )}
      <ProjectBrowser
        api={api}
        revision={revision}
        input={{ review_on: today() }}
        hideWhenEmpty
        onEmptyChange={setProjectsEmpty}
        onDirtyChange={(value) => report("projects", value)}
      />
      <TaskList
        api={api}
        input={{ review_on: today() }}
        revision={revision}
        bare
        hideWhenEmpty
        onEmptyChange={setTasksEmpty}
        onDirtyChange={(value) => report("tasks", value)}
      />
    </section>
  );
}
