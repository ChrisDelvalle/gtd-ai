import type { TaskPreparation } from "./task-preparation";
import { useViewState, useViewRef } from "./view-state";
import {
  nowMoment,
  clockLabel,
  momentLabel,
  shortTimezone,
} from "./planning-fields";
import { OccurrenceDetails } from "./occurrence-details";
import { OccurrenceManager } from "./lazy-recurrence";
import {
  useState,
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type Ref,
} from "react";

import {
  Check,
  Circle,
  CircleDot,
  MoreHorizontal,
  Pencil,
  History,
  Undo2,
  Archive,
  RotateCcw,
  X,
  ChevronLeft,
  ChevronDown,
  CalendarDays,
  AlignLeft,
  AlertCircle,
  LoaderCircle,
  Repeat2,
  NotebookPen,
} from "lucide-react";
import {
  type Args,
  type List,
  type Task,
  type Api,
  isArchived,
  errorText,
} from "./api";
import { useActions, useTaskState, SaveIcon, Recovery } from "./actions";
import { Inspector, preloadInspector } from "./lazy-inspector";

import { Menu } from "./floating-panel";

import { ProjectContext, WorkflowContext } from "./workflow-fields";
import { TaskContext, preloadDescription } from "./task-context";
import { useExpandedView } from "./expanded-view";
import { TaskExpansion } from "./task-expansion";
import { SwipeTaskRow } from "./swipe-actions";

export function IconButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
export function TaskRow({
  task: supplied,
  api,
  onOpen,
  update,
  onDraft,
  inlineDetails = false,
  expandedByDefault = false,
  featured = false,
  statusContext,
  preparation,
}: {
  task: Task;
  api: Api;
  preparation?: TaskPreparation;
  onOpen?: (
    task: Task,
    view: "details" | "edit" | "history" | "agent-notes",
  ) => void;
  update: (t: Task) => void;
  onDraft: (task: Task, dirty: boolean) => void;
  inlineDetails?: boolean;
  expandedByDefault?: boolean;
  featured?: boolean;
  statusContext?: Task["status"];
}) {
  const expanded = useExpandedView();
  const { task, intent, controller } = useTaskState(supplied);
  const inProgress = !!task.started && task.status !== "done" && !task.deleted;
  const [full, setFull] = useViewState<Task | null>(
      `row:${supplied.id}:full`,
      null,
    ),
    [readError, setReadError] = useState("");
  const detailed =
    typeof task.notes === "string"
      ? task
      : full?.version === task.version
        ? full
        : null;
  // A refreshed summary can arrive before its full body. Keep the same editor
  // mounted during that read so an unsaved draft survives the version change.
  const lastDetailed = useViewRef(`row:${supplied.id}:detailed`, detailed);
  if (detailed) lastDetailed.current = detailed;
  const [menu, setMenu] = useState(false),
    [panel, setPanel] = useViewState<
      "details" | "edit" | "history" | "agent-notes" | "occurrences" | null
    >(`row:${supplied.id}:panel`, expandedByDefault ? "details" : null),
    [readAttempt, setReadAttempt] = useState(0);
  const prepareCancel = useRef<(() => void) | undefined>(undefined);
  const prepare = (delay?: number) => {
    if (!preparation || detailed || panel) return;
    prepareCancel.current?.();
    prepareCancel.current = preparation.schedule(task, setFull, delay);
  };
  useEffect(
    () => () => prepareCancel.current?.(),
    [preparation, task.id, task.version, panel],
  );
  const detailId = useId();
  useEffect(() => {
    if (expandedByDefault) setPanel("details");
  }, [expandedByDefault]);
  const [editorMounted, setEditorMounted] = useViewState(
      `row:${supplied.id}:editorMounted`,
      false,
    ),
    [editorView, setEditorView] = useViewState<
      "edit" | "history" | "agent-notes"
    >(`row:${supplied.id}:editorView`, "edit"),
    [editorDirty, setDirty] = useState(false),
    [occurrenceDirty, setOccurrenceDirty] = useState(false),
    [occurrencesMounted, setOccurrencesMounted] = useState(false);
  const dirty = editorDirty || occurrenceDirty;
  const titleAnchor = useRef<HTMLButtonElement>(null);
  function closePanel() {
    titleAnchor.current?.focus({ preventScroll: true });
    setPanel(null);
  }
  const anchor = useRef<HTMLButtonElement>(null),
    content = useRef<HTMLDivElement>(null);
  const { run } = useActions();
  const disabled = !!intent;
  useEffect(() => {
    if (!panel || panel === "agent-notes" || detailed) return;
    let active = true;
    setReadError("");
    api
      .call<List>("list_items", {
        task_id: task.id,
        include_deleted: true,
        detail: "full",
      })
      .then((r) => {
        if (active && r.items[0]) {
          setFull(r.items[0]);
          update(r.items[0]);
          setReadError("");
        }
      })
      .catch((e) => {
        if (active) setReadError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [panel, task.id, task.version, detailed, readAttempt]);
  function open(next: "details" | "edit" | "history" | "agent-notes") {
    if (next === "details") void preloadDescription().catch(() => {});
    setMenu(false);
    if (onOpen && !(inlineDetails && next === "details")) {
      onOpen(task, next);
      return;
    }
    if (next === "details") setPanel(next);
    else
      expanded(() => {
        setPanel(next);
        setEditorMounted(true);
        setEditorView(next);
      });
  }
  function openOccurrences() {
    setMenu(false);
    expanded(() => {
      setOccurrencesMounted(true);
      setPanel("occurrences");
    });
  }
  useEffect(() => {
    if (panel === "edit")
      content.current?.parentElement
        ?.querySelector<HTMLInputElement>(".inline-editor input")
        ?.focus({ preventScroll: true });
  }, [panel, !!detailed]);
  useEffect(() => {
    onDraft(task, dirty);
  }, [task, dirty, onDraft]);
  async function change(name: string, args: Args) {
    setMenu(false);
    let preview: Task | undefined;
    if (name === "update_item") preview = { ...task, ...args } as Task;
    else {
      const receipt = controller.state.saved.get(task.id);
      if (receipt?.change.id === task.last_change_id)
        preview =
          receipt.change.before ??
          (receipt.change.operation === "capture"
            ? { ...task, deleted: true }
            : undefined);
    }
    const result = await run(name, args, detailed || task, preview);
    if (result) update(result.task);
  }
  function menuAction(action: () => void) {
    setMenu(false);
    anchor.current?.focus({ preventScroll: true });
    action();
  }
  function archive() {
    void change("update_item", {
      task_id: task.id,
      expected_version: task.version,
      archived: !isArchived(task),
      reason: isArchived(task)
        ? "Restored from archive using the task card."
        : "Archived using the task card.",
    });
  }
  return (
    <article
      className={`compact-task ${task.status === "done" ? "is-done" : ""} ${inlineDetails ? "expandable-task" : ""} ${featured ? "featured-task" : ""}`}
      data-expanded={panel !== null || undefined}
      data-gtd-task={task.id}
    >
      <SwipeTaskRow
        title={task.title}
        archived={isArchived(task)}
        disabled={
          disabled ||
          dirty ||
          task.deleted ||
          task.version === 0 ||
          menu ||
          (panel !== null && panel !== "details")
        }
        onEdit={() => open("edit")}
        onArchive={archive}
      >
        <IconButton
          label={
            task.deleted
              ? `Restore task: ${task.title}`
              : task.status === "done"
                ? `Reopen: ${task.title}`
                : `Mark complete: ${task.title}`
          }
          disabled={disabled || dirty}
          aria-pressed={task.status === "done"}
          aria-describedby={inProgress ? `${detailId}-started` : undefined}
          {...(inProgress ? { title: "Started · Mark complete" } : {})}
          onClick={() =>
            void change(
              task.deleted ? "undo_change" : "update_item",
              task.deleted
                ? {
                    change_id: task.last_change_id,
                    expected_version: task.version,
                    reason: "Restored capture using the task card.",
                  }
                : {
                    task_id: task.id,
                    expected_version: task.version,
                    status: task.status === "done" ? "inbox" : "done",
                    reason:
                      task.status === "done"
                        ? isArchived(task)
                          ? "Marked incomplete in the archive using the task card."
                          : "Reopened in inbox using the task card."
                        : "Marked complete using the task card.",
                  },
            )
          }
        >
          {task.deleted ? (
            <RotateCcw />
          ) : task.status === "done" ? (
            <Check />
          ) : inProgress ? (
            <CircleDot className="task-started-icon" aria-hidden="true" />
          ) : (
            <Circle />
          )}
          {inProgress && (
            <span id={`${detailId}-started`} className="sr-only">
              Started
            </span>
          )}
        </IconButton>
        <button
          ref={titleAnchor}
          className="task-title"
          onPointerEnter={
            preparation
              ? (e) => {
                  if (e.pointerType === "mouse") prepare();
                }
              : undefined
          }
          onPointerLeave={
            preparation ? () => prepareCancel.current?.() : undefined
          }
          onFocus={preparation ? () => prepare() : undefined}
          onBlur={preparation ? () => prepareCancel.current?.() : undefined}
          disabled={task.version === 0}
          aria-label={`Details: ${task.title}`}
          aria-expanded={panel !== null}
          aria-controls={inlineDetails ? detailId : undefined}
          onClick={() => (panel ? setPanel(null) : open("details"))}
        >
          <span>{task.title}</span>
          {(task.deleted ||
            isArchived(task) ||
            (task.status !== statusContext &&
              ["waiting", "someday"].includes(task.status))) && (
            <small>
              {task.deleted
                ? "Deleted"
                : isArchived(task)
                  ? "Archived"
                  : task.status}
            </small>
          )}
          {inlineDetails && <ChevronDown className="disclosure-chevron" />}
        </button>
        {task.occurrence && (
          <span
            className="repeat-chip"
            title={`Scheduled ${task.occurrence.scheduled_date}`}
          >
            <Repeat2 aria-label="Repeating task" />
            {(task.pending_occurrence_count || 0) > 1 && (
              <small>{task.pending_occurrence_count}</small>
            )}
          </span>
        )}
        {task.due_date && inlineDetails ? (
          <span
            className="date-chip"
            title={`Deadline: ${task.deadline_time ? momentLabel({ date: task.due_date, ...task.deadline_time }) : shortDate(task.due_date)}`}
          >
            <CalendarDays />
            <span>
              {shortDate(task.due_date)}
              {task.deadline_time && (
                <span className="date-chip-time">{` · ${clockLabel(task.deadline_time.time)} ${shortTimezone({ date: task.due_date, ...task.deadline_time })}`}</span>
              )}
            </span>
          </span>
        ) : (
          task.due_date && (
            <button
              className="date-chip"
              title={`Deadline: ${task.deadline_time ? momentLabel({ date: task.due_date, ...task.deadline_time }) : shortDate(task.due_date)}`}
              aria-label={`Edit due date: ${task.due_date}`}
              onClick={() => open("edit")}
            >
              <CalendarDays />
              <span>
                {shortDate(task.due_date)}
                {task.deadline_time && (
                  <span className="date-chip-time">{` · ${clockLabel(task.deadline_time.time)} ${shortTimezone({ date: task.due_date, ...task.deadline_time })}`}</span>
                )}
              </span>
            </button>
          )
        )}
        <button
          type="button"
          className="icon-button"
          ref={anchor}
          aria-label={`${intent?.phase === "error" ? "Resolve save" : "More options"}: ${task.title}`}
          title={
            intent?.phase === "error"
              ? "Change needs attention"
              : intent
                ? "Saving"
                : "More options"
          }
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => {
            if (!menu) void preloadInspector().catch(() => {});
            setMenu(!menu);
          }}
        >
          {intent ? (
            <>
              <span className="save-slot">
                <SaveIcon taskId={task.id} />
              </span>
              <MoreHorizontal className="save-fallback" />
            </>
          ) : (
            <MoreHorizontal />
          )}
        </button>
      </SwipeTaskRow>
      {menu && (
        <Menu close={() => setMenu(false)} anchor={anchor}>
          <Recovery taskId={task.id} onEdit={() => open("edit")} />
          <button
            role="menuitem"
            onClick={() => menuAction(() => open("details"))}
          >
            <AlignLeft />
            Details
          </button>
          {!task.deleted && (
            <button
              role="menuitem"
              disabled={dirty && editorView !== "edit"}
              onClick={() => menuAction(() => open("edit"))}
            >
              <Pencil />
              Edit
            </button>
          )}
          {!task.deleted && task.status !== "done" && (
            <button
              role="menuitem"
              disabled={disabled || dirty}
              onClick={() =>
                void change("update_item", {
                  task_id: task.id,
                  expected_version: task.version,
                  started: !task.started,
                  ...(!task.started ? { started_at: nowMoment() } : {}),
                  reason: task.started
                    ? "Reset the started marker using the task interface."
                    : "Confirmed starting work using the task interface.",
                })
              }
            >
              {task.started ? <Circle /> : <CircleDot />}
              {task.started ? "Reset started" : "Mark started"}
            </button>
          )}
          <button
            role="menuitem"
            disabled={dirty && editorView !== "agent-notes"}
            onClick={() => menuAction(() => open("agent-notes"))}
          >
            <NotebookPen />
            Agent notes
          </button>
          {task.occurrence && (
            <button
              role="menuitem"
              disabled={editorDirty}
              onClick={() => menuAction(openOccurrences)}
            >
              <Repeat2 />
              Manage occurrences
            </button>
          )}
          <button
            role="menuitem"
            disabled={dirty && editorView === "agent-notes"}
            onClick={() => menuAction(() => open("history"))}
          >
            <History />
            History
          </button>
          <button
            role="menuitem"
            disabled={disabled || dirty}
            onClick={() =>
              void change("undo_change", {
                change_id: task.last_change_id,
                expected_version: task.version,
                reason: "Undid the latest task change using the task card.",
              })
            }
          >
            <Undo2 />
            Undo latest
          </button>
          {!task.deleted && (
            <button
              role="menuitem"
              disabled={disabled || dirty}
              onClick={archive}
            >
              <Archive />
              {isArchived(task) ? "Unarchive" : "Archive"}
            </button>
          )}
        </Menu>
      )}
      {inlineDetails && (
        <TaskExpansion open={panel === "details"}>
          <div
            className="task-disclosure"
            id={detailId}
            role="region"
            aria-label={`Task information: ${task.title}`}
          >
            {(!featured || task.project_id) && (
              <div className="task-summary-metadata">
                <ProjectContext task={task} api={api} />
                {!featured && (
                  <span
                    className="metadata-badge status-badge"
                    data-status={task.deleted ? "deleted" : task.status}
                  >
                    {task.deleted
                      ? "Deleted"
                      : {
                          next: "Next action",
                          inbox: "Inbox",
                          waiting: "Waiting",
                          blocked: "Blocked",
                          planned: "Blocked",
                          active: "Active",
                          someday: "Someday / maybe",
                          done: "Done",
                          archived: "Archived",
                        }[task.status]}
                  </span>
                )}
              </div>
            )}
            {detailed ? (
              <>
                <TaskContext task={detailed} api={api} />
                <WorkflowContext task={{ ...detailed, blocking_count: supplied.blocking_count ?? detailed.blocking_count }} api={api} />
                {task.occurrence && <OccurrenceDetails task={task} api={api} />}
              </>
            ) : readError ? (
              <button
                className="text-action"
                onClick={() => setReadAttempt((n) => n + 1)}
              >
                <AlertCircle /> Retry details
              </button>
            ) : (
              <LoaderCircle className="spinning" aria-label="Loading details" />
            )}
          </div>
        </TaskExpansion>
      )}
      {(panel === "edit" || panel === "history") && (
        <div className="inline-panel" ref={content}>
          <div className="panel-bar">
            <span>
              {panel === "edit" ? "Edit" : panel === "history" ? "History" : ""}
            </span>
            <IconButton label="Close details" onClick={closePanel}>
              <X />
            </IconButton>
          </div>
        </div>
      )}
      {!inlineDetails && (
        <TaskExpansion open={panel === "details"}>
          <div className="inline-panel">
            <div className="panel-bar">
              <span />
              <IconButton label="Close details" onClick={closePanel}>
                <X />
              </IconButton>
            </div>
            <div className="task-notes">
              {detailed ? (
                <>
                  {detailed.project_id && (
                    <div className="task-summary-metadata">
                      <ProjectContext task={detailed} api={api} />
                    </div>
                  )}
                  <TaskContext task={detailed} api={api} />
                  <WorkflowContext task={{ ...detailed, blocking_count: supplied.blocking_count ?? detailed.blocking_count }} api={api} />
                  {task.occurrence && (
                    <OccurrenceDetails task={task} api={api} />
                  )}
                </>
              ) : readError ? (
                <button
                  className="text-action"
                  onClick={() => setReadAttempt((n) => n + 1)}
                >
                  <AlertCircle />
                  Retry details
                </button>
              ) : (
                <LoaderCircle
                  className="spinning"
                  aria-label="Loading details"
                />
              )}
              {!task.deleted && (
                <button className="text-action" onClick={() => open("edit")}>
                  <Pencil />
                  Edit
                </button>
              )}
            </div>
          </div>
        </TaskExpansion>
      )}
      {occurrencesMounted && task.occurrence && (
        <div className="inline-panel" hidden={panel !== "occurrences"}>
          <div className="panel-bar">
            <IconButton
              label="Back to task details"
              onClick={() => setPanel("details")}
            >
              <ChevronLeft />
            </IconButton>
            <span>Occurrences</span>
            <IconButton label="Close occurrences" onClick={closePanel}>
              <X />
            </IconButton>
          </div>
          <OccurrenceManager
            task={task}
            api={api}
            onTask={update}
            onDirtyChange={setOccurrenceDirty}
            disabled={disabled || editorDirty}
          />
        </div>
      )}
      {editorMounted &&
        (detailed || lastDetailed.current || editorView === "agent-notes") && (
          <div
            className="inline-editor"
            hidden={
              panel !== "edit" && panel !== "history" && panel !== "agent-notes"
            }
          >
            <Inspector
              task={detailed || lastDetailed.current || task}
              api={api}
              embeddedView={editorView}
              active={panel === editorView}
              onClose={closePanel}
              onDirtyChange={setDirty}
              onSubmitted={closePanel}
              onTask={(t) => {
                update(t);
                if (panel !== "agent-notes") setPanel(null);
              }}
            />
          </div>
        )}
    </article>
  );
}
