import { BriefField } from "./brief-field";
import {useDraftFields} from "./use-record-draft";
import {useViewState, useViewRef} from "./view-state";
import { days, weekdayNames, readSeries, repeatSummary } from "./repeat-model";
import { OccurrenceDetails } from "./occurrence-details";
import { repeatPlanning, RepeatPlanningFields } from "./planning-fields";
import { useExpandedView } from "./expanded-view";
import { AgentNotes } from "./agent-notes";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import {
  Repeat2,
  ChevronDown,
  ChevronLeft,
  LoaderCircle,
  AlertCircle,
  Check,
  Circle,
  Pause,
  Play,
  Square,
  Undo2,
  MoreHorizontal,
  NotebookPen,
} from "lucide-react";
import {
  type Api,
  type Args,
  type Task,
  type List,
  type Projects,
  type RepeatRule,
  type RepeatTemplate,
  type Occurrences,
  type Mutation,
  ApiError,
  today,
  day,
  errorText,
} from "./api";
import { Menu } from "./floating-panel";
import { TaskExpansion } from "./task-expansion";
import { ContextFields } from "./task-context";
import { useEnvironment, useAppNavigation } from "./app-context";
function RepeatSelect(props: ComponentProps<"select">) {
  return (
    <span className="repeat-select">
      <select {...props} />
      <ChevronDown aria-hidden="true" />
    </span>
  );
}
function RepeatProjectField({
  api,
  value,
  onChange,
}: {
  api: Api;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const [projects, setProjects] = useState<Task[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .call<Projects>("list_projects", {})
      .then(async (result) => {
        const rows = [...result.projects];
        if (value && !rows.some((project) => project.id === value)) {
          const exact = await api.call<Projects>("list_projects", {
            project_id: value,
            include_deleted: true,
          });
          rows.push(...exact.projects);
        }
        if (active) {
          setProjects(rows);
          setCursor(result.next_cursor);
          setError("");
        }
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, attempt, value]);
  async function more() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const result = await api.call<Projects>("list_projects", { cursor });
      setProjects((previous) => [
        ...previous,
        ...result.projects.filter(
          (row) => !previous.some((old) => old.id === row.id),
        ),
      ]);
      setCursor(result.next_cursor);
      setError("");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="repeat-project-field">
      <label>
        Project
        <RepeatSelect
          value={value || ""}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">Standalone task</option>
          {value && !projects.some((project) => project.id === value) && (
            <option value={value}>Current project</option>
          )}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </RepeatSelect>
      </label>
      {loading && (
        <small className="muted" role="status">
          Loading projects…
        </small>
      )}
      {error && (
        <div role="alert" className="recovery">
          <p>{error}</p>
          <button
            type="button"
            disabled={loading}
            onClick={() => setAttempt(attempt + 1)}
          >
            Reload projects
          </button>
        </div>
      )}
      {cursor && (
        <button
          type="button"
          className="text-action"
          disabled={loading}
          onClick={() => void more()}
        >
          Load more projects
        </button>
      )}
    </div>
  );
}
const initialRule = (): RepeatRule => ({
  start_date: today(),
  frequency: "weekly",
  interval: 1,
  weekdays: [],
  month_day: null,
  ordinal: null,
  until: null,
  count: null,
});
function offset(value: string | null | undefined, start: string) {
  return value
    ? Math.round(
        (Date.parse(`${value}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) /
          86400000,
      )
    : null;
}
function defaults(task: Task, start: string): RepeatTemplate {
  return {
    ...repeatPlanning(task,start),
    title: task.title,
    brief: task.brief || "",
    notes: task.notes || "",
    links: task.links || [],
    location: task.location || null,
    project_id: task.project_id || null,
    status: ["done", "archived", "active"].includes(task.status)
      ? "next"
      : task.status,
    due_offset_days: offset(task.due_date, start),
    review_offset_days: offset(task.review_date, start),
  };
}
function visibleTemplate(template: RepeatTemplate): RepeatTemplate {
  const { agent_notes, has_agent_notes, omitted_fields, ...visible } = template;
  if (visible.work_blocks) { delete visible.planned_start; delete visible.planned_finish; }
  return visible;
}
function modified<T extends object>(current: T, previous: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(current).filter(
      ([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(previous[key as keyof T]),
    ),
  ) as Partial<T>;
}
function changed() {
  window.dispatchEvent(new Event("gtd:changed"));
}
export function RepeatControls({
  task,
  api,
  disabled = false,
  editor = "combined",
  onDirtyChange,
  onTask,
}: {
  task: Task;
  api: Api;
  disabled?: boolean;
  editor?: "combined" | "schedule" | "details";
  onDirtyChange?: (value: boolean) => void;
  onTask?: (task: Task) => void;
}) {
  const id =
    task.occurrence?.series_id ||
    (task.entity_type === "recurrence" ? task.id : null);
  const field=useDraftFields(`repeat:${task.id}:${editor}`,()=>({
    open:task.entity_type === "recurrence",series:null as Task|null,rule:initialRule(),template:defaults(task,today()),base:null as string|null,
    busy:false,needsReview:false,recovery:false,receipt:null as Mutation|null,error:"",notice:"",loadError:"",
    intent:{current:null as {name:string;args:Args}|null},inFlight:{current:false},offsetEdited:{current:new Set<string>()},initializedEditor:{current:null as string|null},
  }),value=>value.busy||!!value.intent.current||(value.base!==null&&JSON.stringify({rule:value.rule,template:value.template})!==value.base));
  const [open,setOpen]=field('open'),[series,setSeries]=field('series'),[rule,setRule]=field('rule'),[template,setTemplate]=field('template'),[base,setBase]=field('base');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = field('loadError');
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = field('error');
  const [notice, setNotice] = field('notice');
  const [busy, setBusy] = field("busy");
  const [needsReview, setNeedsReview] = field("needsReview");
  const [recovery, setRecovery] = field("recovery");
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [scopeMenu, setScopeMenu] = useState(false);
  const [preview, setPreview] = useState<string[]>([]);
  const [previewAdjustments, setPreviewAdjustments] = useState<string[]>([]);
  const [previewKey, setPreviewKey] = useState("");
  const [previewRevision, setPreviewRevision] = useState(0);
  const [receipt, setReceipt] = field("receipt");
  const [intent] = field("intent");
  const [inFlight] = field("inFlight");
  const [offsetEdited] = field("offsetEdited");
  const loadGeneration = useRef(0);
  const scopeAnchor = useRef<HTMLButtonElement>(null);
  const errorAnchor = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const effectiveId = id || series?.id;
  const formKey = JSON.stringify({ rule, template });
  const dirty =
    open && (busy || !!intent.current || (base !== null && formKey !== base));
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  const [initializedEditor] = field("initializedEditor");
  function acceptSeries(fresh: Task, preserve = false) {
    initializedEditor.current = id || "new";
    const segment = fresh.recurrence!.segments.at(-1)!;
    let nextRule = segment.rule,
      nextTemplate = visibleTemplate(segment.template);
    if (preserve && base) {
      const previous = JSON.parse(base);
      nextRule = { ...nextRule, ...modified(rule, previous.rule) };
      nextTemplate = {
        ...nextTemplate,
        ...modified(template, previous.template),
      };
    }
    setSeries(fresh);
    setRule(nextRule);
    setTemplate(nextTemplate);
    setBase(
      JSON.stringify({
        rule: segment.rule,
        template: visibleTemplate(segment.template),
      }),
    );
  }
  async function reload(preserve = false) {
    if (!effectiveId) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError("");
    try {
      const fresh = await readSeries(api, effectiveId);
      if (generation !== loadGeneration.current) return;
      acceptSeries(fresh, preserve);
      setNeedsReview(false);
      setError("");
      setRecovery(false);
      if (preserve)
        setNotice(
          "Current version loaded. Review your preserved changes before saving.",
        );
    } catch (e) {
      if (generation === loadGeneration.current) setLoadError(errorText(e));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!open) { initializedEditor.current = null; return; }
    if (initializedEditor.current === (id || "new") && base !== null) return;
    setError("");
    setLoadError("");
    setNotice("");
    if (id) {
      void reload();
    } else {
      const nextRule = initialRule(),
        nextTemplate = defaults(task, nextRule.start_date);
      setRule(nextRule);
      setTemplate(nextTemplate);
      setBase(JSON.stringify({ rule: nextRule, template: nextTemplate }));
      initializedEditor.current = "new";
    }
    return () => {
      ++loadGeneration.current;
    };
  }, [open, id, api]);
  const ruleKey = JSON.stringify({ rule, template });
  useEffect(() => {
    if (!open || base === null) return;
    let active = true;
    setPreviewKey("");
    setPreviewError("");
    const timer = setTimeout(() => {
      api
        .call<Occurrences>("list_occurrences", {
          rule,
          template,
          from: editor === "details" && rule.start_date < today() ? today() : rule.start_date,
          limit: 5,
        })
        .then((result) => {
          if (active) {
            const dates = result.occurrences.map((row) => row.scheduled_date);
            setPreview(dates);
            setPreviewAdjustments([...new Set(result.occurrences.flatMap(row => row.timing_adjustments || []))]);
            setPreviewKey(ruleKey);
            if (!effectiveId && dates[0])
              setTemplate((current) => ({
                ...current,
                ...(!offsetEdited.current.has("due_offset_days")
                  ? { due_offset_days: offset(task.due_date, dates[0]) }
                  : {}),
                ...(!offsetEdited.current.has("review_offset_days")
                  ? { review_offset_days: offset(task.review_date, dates[0]) }
                  : {}),
              }));
          }
        })
        .catch((e) => {
          if (active) {
            setPreview([]);
            setPreviewError(errorText(e));
          }
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [ruleKey, open, api, base === null, previewRevision, editor]);
  function update(value: Partial<RepeatRule>) {
    setRule({ ...rule, ...value });
    setNotice("");
  }
  async function submit(name: string, args: Args) {
    if (inFlight.current) return;
    const call = intent.current || {
      name,
      args: { ...args, request_id: crypto.randomUUID() },
    };
    intent.current = call;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setRecovery(false);
    try {
      const response = await api.call<Mutation & { series?: Task }>(
        call.name,
        call.args,
      );
      const saved = response.series || response.task;
      if (!response?.change || !saved)
        throw new ApiError("The change was not confirmed.", "response", true);
      const result = { ...response, task: saved };
      intent.current = null;
      setReceipt(result);
      setBase(formKey);
      setNeedsReview(false);
      const newId =
        result.task.entity_type === "recurrence"
          ? result.task.id
          : result.task.occurrence?.series_id || effectiveId;
      if (newId) {
        if (result.task.entity_type === "recurrence") setSeries(result.task);
        try {
          const fresh = await readSeries(api, newId);
          acceptSeries(fresh);
          if (task.entity_type === "recurrence") onTask?.(fresh);
          setLoadError("");
        } catch {
          setLoadError(
            "Saved. Reload repeat settings to see the latest version.",
          );
        }
      }
      if (task.entity_type !== "recurrence") {
        try {
          const fresh = await api.call<List>("list_items", {
            task_id: task.id,
            include_deleted: true,
            detail: "full",
          });
          if (fresh.items[0]) onTask?.(fresh.items[0]);
        } catch {
          setNotice("Saved. Refresh the task to see its latest details.");
        }
      }
      changed();
    } catch (e) {
      if (!(e instanceof ApiError) || !e.uncertain) intent.current = null;
      setNeedsReview(e instanceof ApiError && e.code === "conflict");
      setError(errorText(e));
      setRecovery(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function save(scope: "following" | "all") {
    setScopeMenu(false);
    if (locked || base === null) return;
    const invalid = Array.from(
      formRef.current?.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input,select,textarea") || [],
    ).find((input) => !input.checkValidity());
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    if (!effectiveId) {
      void submit("create_recurrence", {
        task_id: task.id,
        expected_task_version: task.version,
        rule,
        template,
        reason: "Added repetition using the task editor.",
      });
      return;
    }
    if (!series) return;
    const scheduled = task.occurrence?.scheduled_date;
    const scopedRule =
      scope === "following" && scheduled && rule.start_date < scheduled
        ? { ...rule, start_date: scheduled }
        : rule;
    const replacement = {...template};
    // Content omissions preserve every segment independently. A change to other
    // defaults must not overwrite earlier segment briefs with the visible one.
    if (template.brief === JSON.parse(base).template.brief) delete replacement.brief;
    void submit("update_recurrence", {
      series_id: series.id,
      expected_version: series.version,
      scope,
      action: "edit",
      ...(scope === "following"
        ? { original_date: task.occurrence?.original_date }
        : {}),
      ...(editor !== "details" ? { rule: scopedRule } : {}),
      ...(editor !== "schedule" ? { template: replacement } : {}),
      reason: `Changed ${editor === "details" ? "repeating task details" : "repeat settings"} for ${scope === "following" ? "this and following occurrences" : "the series"} using the task editor.`,
    });
  }
  const paused = !!series?.recurrence?.pauses.some((p) => !p.through),
    ended = !!series?.recurrence?.ended_on;
  const locked = disabled || busy || loading || needsReview || !!intent.current;
  return (
    <div className="repeat-controls">
      {task.entity_type !== "recurrence" && (
        <button
          type="button"
          className="text-action"
          aria-expanded={open}
          disabled={dirty || (disabled && !open)}
          onClick={() => {
            if (!dirty) setOpen(!open);
          }}
        >
          <Repeat2 /> {effectiveId ? "Repeat settings" : "Repeat"}
          <ChevronDown className={open ? "turned" : ""} />
        </button>
      )}
      <TaskExpansion open={open}>
        <div className="repeat-form" ref={formRef}>
          {disabled && (
            <p className="muted">
              Save other edits before changing repetition.
            </p>
          )}
          {loading && (
            <p role="status" className="muted">
              Loading repeat settings…
            </p>
          )}
          {loadError && (
            <div role="alert" className="recovery">
              <p>{loadError}</p>
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => void reload(base !== null)}
              >
                Reload repeat settings
              </button>
            </div>
          )}
          {notice && (
            <p role="status" className="muted">
              {notice}
            </p>
          )}
          <fieldset
            disabled={locked || base === null}
            style={base === null ? { display: "none" } : undefined}
          >
            {editor !== "details" && (
              <>
                <label className="repeat-setting">
                  <span>Repeats</span>
                  <RepeatSelect
                    aria-label="Repeat"
                    value={rule.frequency}
                    onChange={(e) =>
                      update({
                        frequency: e.target.value as RepeatRule["frequency"],
                        weekdays: [],
                        month_day: null,
                        ordinal: null,
                      })
                    }
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </RepeatSelect>
                </label>
                <label className="repeat-setting">
                  <span>Every</span>
                  <span className="repeat-interval">
                    <input
                      aria-label="Every"
                      type="number"
                      min={1}
                      max={365}
                      required
                      value={rule.interval}
                      onChange={(e) =>
                        update({ interval: Number(e.target.value) })
                      }
                    />
                    <span className="muted">
                      {
                        {
                          daily: rule.interval === 1 ? "day" : "days",
                          weekly: rule.interval === 1 ? "week" : "weeks",
                          monthly: rule.interval === 1 ? "month" : "months",
                          yearly: rule.interval === 1 ? "year" : "years",
                        }[rule.frequency]
                      }
                    </span>
                  </span>
                </label>
                <label className="repeat-setting">
                  <span>Starts</span>
                  <input
                    type="date"
                    required
                    value={rule.start_date}
                    min="2000-01-01"
                    max="2199-12-31"
                    onChange={(e) => update({ start_date: e.target.value })}
                  />
                </label>
                {rule.frequency === "weekly" && (
                  <div className="repeat-setting repeat-on">
                    <span className="field-label">On</span>
                    <div className="repeat-day-controls">
                      <div className="repeat-weekdays">
                        {days.map((d, i) => (
                          <label key={d}>
                            <input
                              type="checkbox"
                              aria-label={weekdayNames[i]}
                              checked={rule.weekdays.includes(d)}
                              onChange={(e) =>
                                update({
                                  weekdays: e.target.checked
                                    ? [...rule.weekdays, d]
                                    : rule.weekdays.filter((x) => x !== d),
                                })
                              }
                            />
                            <span>{weekdayNames[i].slice(0, 2)}</span>
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="text-action"
                        onClick={() => update({ weekdays: days.slice(0, 5) })}
                      >
                        Weekdays
                      </button>
                    </div>
                  </div>
                )}
                {rule.frequency === "monthly" && (
                  <>
                    <label className="repeat-setting">
                      <span>By</span>
                      <RepeatSelect
                        value={rule.ordinal ? "weekday" : "date"}
                        onChange={(e) =>
                          update(
                            e.target.value === "weekday"
                              ? {
                                  ordinal: 1,
                                  weekdays: ["MO"],
                                  month_day: null,
                                }
                              : { ordinal: null, weekdays: [], month_day: 1 },
                          )
                        }
                      >
                        <option value="date">Day of month</option>
                        <option value="weekday">Weekday</option>
                      </RepeatSelect>
                    </label>
                    {rule.ordinal ? (
                      <div className="field-row">
                        <label>
                          Week
                          <RepeatSelect
                            value={rule.ordinal}
                            onChange={(e) =>
                              update({ ordinal: Number(e.target.value) })
                            }
                          >
                            {[1, 2, 3, 4, -1].map((n, i) => (
                              <option key={n} value={n}>
                                {
                                  [
                                    "First",
                                    "Second",
                                    "Third",
                                    "Fourth",
                                    "Last",
                                  ][i]
                                }
                              </option>
                            ))}
                          </RepeatSelect>
                        </label>
                        <label>
                          Weekday
                          <RepeatSelect
                            value={rule.weekdays[0]}
                            onChange={(e) =>
                              update({ weekdays: [e.target.value] })
                            }
                          >
                            {days.map((d, i) => (
                              <option key={d} value={d}>
                                {weekdayNames[i]}
                              </option>
                            ))}
                          </RepeatSelect>
                        </label>
                      </div>
                    ) : (
                      <label className="repeat-setting">
                        <span>Day</span>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={
                            rule.month_day || Number(rule.start_date.slice(-2))
                          }
                          onChange={(e) =>
                            update({ month_day: Number(e.target.value) })
                          }
                        />
                      </label>
                    )}
                  </>
                )}
                <label className="repeat-setting">
                  <span>Ends</span>
                  <RepeatSelect
                    value={
                      rule.count !== null
                        ? "count"
                        : rule.until
                          ? "date"
                          : "never"
                    }
                    onChange={(e) =>
                      update({
                        count: e.target.value === "count" ? 10 : null,
                        until:
                          e.target.value === "date" ? rule.start_date : null,
                      })
                    }
                  >
                    <option value="never">Never</option>
                    <option value="date">On a date</option>
                    <option value="count">After a count</option>
                  </RepeatSelect>
                </label>
                {rule.until !== null && (
                  <label className="repeat-setting">
                    <span>Last date</span>
                    <input
                      type="date"
                      min={rule.start_date}
                      value={rule.until}
                      onChange={(e) => update({ until: e.target.value })}
                    />
                  </label>
                )}
                {rule.count !== null && (
                  <label className="repeat-setting">
                    <span>Occurrences</span>
                    <input
                      type="number"
                      min={1}
                      max={50000}
                      value={rule.count}
                      onChange={(e) =>
                        update({ count: Number(e.target.value) })
                      }
                    />
                  </label>
                )}
              </>
            )}
            {editor !== "schedule" && (
              <div
                className={
                  editor === "details"
                    ? "repeat-task-details"
                    : "repeat-defaults"
                }
              >
                {editor !== "details" && (
                  <button
                    type="button"
                    className="text-action repeat-defaults-toggle"
                    aria-expanded={defaultsOpen}
                    onClick={() => setDefaultsOpen(!defaultsOpen)}
                  >
                    Task defaults{" "}
                    <ChevronDown className={defaultsOpen ? "turned" : ""} />
                  </button>
                )}
                <TaskExpansion open={editor === "details" || defaultsOpen}>
                  <div className="repeat-default-fields">
                    <label>
                      Title
                      <input
                        required
                        maxLength={500}
                        value={template.title}
                        onChange={(e) =>
                          setTemplate({ ...template, title: e.target.value })
                        }
                      />
                    </label>
                    <BriefField value={template.brief} onChange={brief => setTemplate({...template, brief})}
                      required={template.status !== "inbox"} />
                    <label>
                      Notes
                      <textarea
                        rows={3}
                        maxLength={10000}
                        value={template.notes}
                        onChange={(e) =>
                          setTemplate({ ...template, notes: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Status
                      <RepeatSelect
                        value={template.status}
                        onChange={(e) =>
                          setTemplate({
                            ...template,
                            status: e.target.value as Task["status"],
                          })
                        }
                      >
                        {["next", "blocked", "waiting", "inbox", "someday"].map(
                          (s) => (
                            <option key={s} value={s}>
                              {
                                {
                                  next: "Next action",
                                  blocked: "Blocked",
                                  waiting: "Waiting",
                                  inbox: "Inbox",
                                  someday: "Someday",
                                }[s]
                              }
                            </option>
                          ),
                        )}
                      </RepeatSelect>
                    </label>
                    <RepeatPlanningFields value={template} onChange={setTemplate}/>
                    <ContextFields
                      value={{
                        links: template.links,
                        location: template.location || "",
                      }}
                      onChange={(value) =>
                        setTemplate({
                          ...template,
                          links: value.links,
                          location: value.location || null,
                        })
                      }
                    />
                    <RepeatProjectField
                      api={api}
                      value={template.project_id}
                      onChange={(value) =>
                        setTemplate({ ...template, project_id: value })
                      }
                    />
                    <div className="field-row">
                      {(["due_offset_days", "review_offset_days"] as const).map(
                        (k, i) => (
                          <label key={k}>
                            {i ? "Review offset" : "Deadline offset"}
                            <input
                              type="number"
                              min={-3660}
                              max={3660}
                              placeholder="None"
                              value={template[k] ?? ""}
                              onChange={(e) => (
                                offsetEdited.current.add(k),
                                setTemplate({
                                  ...template,
                                  [k]:
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                })
                              )}
                            />
                          </label>
                        ),
                      )}
                    </div>
                    <p className="muted">
                      Optional days before (−) or after each scheduled date.
                      Individual task overrides are preserved.
                    </p>
                  </div>
                </TaskExpansion>
              </div>
            )}
          </fieldset>
          {(editor !== "details" || previewAdjustments.length > 0 || previewError) && (
            <>
              <div className="repeat-preview" aria-live="polite">
                <span className="muted">Schedule preview</span>
                <span>
                  {previewKey === ruleKey
                    ? preview.length
                      ? preview.map(day).join(" · ")
                      : "No dates in this schedule."
                    : previewError
                      ? "Preview unavailable"
                      : "Checking dates…"}
                </span>
                {previewAdjustments.map(note => <small className="planning-hint" key={note}>{note}</small>)}
                <small className="muted">
                  Missed tasks stay unfinished. Invalid calendar dates are
                  omitted.
                </small>
              </div>
              {previewError && (
                <div role="alert" className="recovery">
                  <p>{previewError}</p>
                  <button
                    type="button"
                    onClick={() => setPreviewRevision((value) => value + 1)}
                  >
                    Retry schedule preview
                  </button>
                </div>
              )}
            </>
          )}
          <div className="repeat-actions repeat-save-actions">
            <button
              type="button"
              className="primary"
              ref={scopeAnchor}
              disabled={
                locked ||
                (previewKey !== ruleKey || (editor !== "details" && !preview.length)) ||
                base === null ||
                (!!effectiveId && (!series || !dirty))
              }
              aria-haspopup={effectiveId ? "menu" : undefined}
              aria-expanded={effectiveId ? scopeMenu : undefined}
              onClick={() =>
                effectiveId ? setScopeMenu(!scopeMenu) : save("all")
              }
            >
              {busy ? (
                <LoaderCircle className="spinning" />
              ) : editor === "details" ? (
                "Save task details"
              ) : effectiveId ? (
                "Save repeat"
              ) : (
                "Start repeating"
              )}
            </button>
            {dirty && !busy && !intent.current && (
              <button
                type="button"
                className="text-action"
                onClick={() => {
                  offsetEdited.current.clear();
                  const b = JSON.parse(base!);
                  setRule(b.rule);
                  setTemplate(b.template);
                  setError("");
                  setNotice("");
                  if (needsReview) void reload();
                }}
              >
                {editor === "details"
                  ? "Discard details draft"
                  : "Discard repeat draft"}
              </button>
            )}
            {error && (
              <button
                type="button"
                className="icon-button save-error"
                ref={errorAnchor}
                aria-label="Repeat change needs attention"
                onClick={() => setRecovery(!recovery)}
              >
                <AlertCircle />
              </button>
            )}
          </div>
          {scopeMenu && (
            <Menu
              label="Repeat change scope"
              anchor={scopeAnchor}
              close={() => setScopeMenu(false)}
            >
              {task.occurrence && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => save("following")}
                >
                  This and following
                </button>
              )}
              <button type="button" role="menuitem" onClick={() => save("all")}>
                Entire series
              </button>
            </Menu>
          )}
          {recovery && error && (
            <div role="alert" className="banner error">
              {error}
              {intent.current ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void submit(intent.current!.name, intent.current!.args)
                  }
                >
                  Retry same change
                </button>
              ) : (
                effectiveId && (
                  <button
                    type="button"
                    disabled={busy || loading}
                    onClick={() => void reload(true)}
                  >
                    Read current version
                  </button>
                )
              )}
            </div>
          )}
          {series && (editor !== "details" || receipt) && (
            <div className="repeat-actions repeat-series-actions">
              {!ended && editor !== "details" && (
                <>
                  <button
                    type="button"
                    className="text-action"
                    disabled={locked || dirty}
                    onClick={() =>
                      void submit("update_recurrence", {
                        series_id: series.id,
                        expected_version: series.version,
                        scope: "all",
                        action: paused ? "resume" : "pause",
                        reason: `${paused ? "Resumed" : "Paused"} repetition using the interface.`,
                      })
                    }
                  >
                    {paused ? <Play /> : <Pause />}
                    {paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    className="text-action"
                    disabled={locked || dirty}
                    onClick={() =>
                      void submit("update_recurrence", {
                        series_id: series.id,
                        expected_version: series.version,
                        scope: "all",
                        action: "end",
                        reason:
                          "Ended future repetition using the interface; outstanding tasks remain.",
                      })
                    }
                  >
                    <Square />
                    End repetition
                  </button>
                </>
              )}
              {ended && editor !== "details" && (
                <span className="muted">
                  Repetition ended · Outstanding tasks remain.
                </span>
              )}
              {receipt && (
                <button
                  type="button"
                  className="text-action"
                  disabled={locked || dirty}
                  onClick={() =>
                    void submit("undo_change", {
                      change_id: receipt.change.id,
                      expected_version: receipt.task.version,
                      reason: "Undid repeat settings using the interface.",
                    })
                  }
                >
                  <Undo2 />
                  Undo
                </button>
              )}
            </div>
          )}
        </div>
      </TaskExpansion>
    </div>
  );
}
type OccurrenceRow = Occurrences["occurrences"][number];
type OccurrenceIntent = { name: string; args: Args; originalDate: string };
export function OccurrenceManager({
  task,
  api,
  onTask,
  onDirtyChange,
  revision = 0,
  disabled = false,
}: {
  task: Task;
  api: Api;
  onTask?: (task: Task) => void;
  onDirtyChange?: (dirty: boolean) => void;
  revision?: number;
  disabled?: boolean;
}) {
  const seriesId =
    task.occurrence?.series_id ||
    (task.entity_type === "recurrence" ? task.id : null);
  return seriesId ? (
    <section className="occurrence-manager" aria-label="Manage occurrences">
      <OccurrenceList
        seriesId={seriesId}
        api={api}
        task={task}
        onTask={onTask}
        onDirtyChange={onDirtyChange}
        revision={revision}
        disabled={disabled}
      />
    </section>
  ) : null;
}
function OccurrenceList({
  seriesId,
  api,
  task,
  onTask,
  onDirtyChange,
  revision = 0,
  disabled = false,
}: {
  seriesId: string;
  api: Api;
  task?: Task;
  onTask?: (task: Task) => void;
  onDirtyChange?: (dirty: boolean) => void;
  revision?: number;
  disabled?: boolean;
}) {
  const field=useDraftFields(`occurrences:${seriesId}`,()=>({
    data:null as Occurrences|null,error:"",notice:"",busy:false,needsReview:false,recovery:false,
    editing:null as {row:OccurrenceRow;date:string;seriesVersion:number}|null,
    request:{current:null as OccurrenceIntent|null},inFlight:{current:false},
  }),value=>value.busy||!!value.request.current||!!(value.editing&&value.editing.date!==value.editing.row.scheduled_date));
  const [data,setData]=field('data'),[error,setError]=field('error'),[notice,setNotice]=field('notice'),[busy,setBusy]=field('busy'),[needsReview,setNeedsReview]=field('needsReview'),[recovery,setRecovery]=field('recovery'),[editing,setEditing]=field('editing'),[request]=field('request'),[inFlight]=field('inFlight');
  const [readError,setReadError]=useState(''),[loading,setLoading]=useState(false),[actionRow,setActionRow]=useState<OccurrenceRow|null>(null);
  const generation=useRef(0);
  const menuAnchor = useRef<HTMLButtonElement>(null),
    dateInput = useRef<HTMLInputElement>(null);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const dirty =
    busy ||
    !!request.current ||
    !!(editing && editing.date !== editing.row.scheduled_date);
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  useEffect(() => {
    if (editing) dateInput.current?.focus({ preventScroll: true });
  }, [editing?.row.original_date]);
  const args: Args = { series_id: seriesId, from: "2000-01-01", limit: 10 };
  async function load(cursor?: string, rebase = false) {
    const current = ++generation.current;
    setLoading(true);
    setReadError("");
    try {
      const result = await api.call<Occurrences>("list_occurrences", {
        ...args,
        ...(cursor ? { cursor } : {}),
      });
      if (current !== generation.current) return;
      setData((previous) =>
        cursor && previous
          ? {
              ...result,
              series: result.series || previous.series,
              occurrences: [
                ...previous.occurrences,
                ...result.occurrences.filter(
                  (row) =>
                    !previous.occurrences.some(
                      (old) => old.original_date === row.original_date,
                    ),
                ),
              ],
            }
          : result,
      );
      if (rebase) {
        const fresh =
          editing &&
          result.occurrences.find(
            (row) => row.original_date === editing.row.original_date,
          );
        if (editing && !fresh) {
          setReadError(
            "This occurrence is no longer in the current results. Discard its draft and reopen it.",
          );
          return;
        }
        if (editing && fresh && result.series)
          setEditing({
            ...editing,
            row: fresh,
            seriesVersion: result.series.version,
          });
        setNeedsReview(false);
        setError("");
        setRecovery(false);
        setNotice(
          editing
            ? "Current occurrences loaded. Review your preserved date before saving again."
            : "Current occurrences loaded. Review the occurrence before trying again.",
        );
      }
    } catch (e) {
      if (current === generation.current) setReadError(errorText(e));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
    };
  }, [seriesId, api, revision, task?.version]);
  async function write(intent: OccurrenceIntent) {
    if (inFlight.current) return;
    const call = request.current || intent;
    request.current = call;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setRecovery(false);
    try {
      const result = await api.call<Mutation>(call.name, call.args);
      if (!result?.task?.occurrence || !result.change)
        throw new ApiError("The change was not confirmed.", "response", true);
      request.current = null;
      setNeedsReview(false);
      setData(
        (previous) =>
          previous && {
            ...previous,
            occurrences: previous.occurrences.map((row) =>
              row.original_date === call.originalDate
                ? {
                    original_date: result.task.occurrence!.original_date,
                    scheduled_date: result.task.occurrence!.scheduled_date,
                    task: result.task,
                    preview: false,
                  }
                : row,
            ),
          },
      );
      if (editing?.row.original_date === call.originalDate) {
        setEditing(null);
        requestAnimationFrame(() =>
          menuAnchor.current?.focus({ preventScroll: true }),
        );
      }
      if (task?.id === result.task.id) onTask?.(result.task);
      changed();
    } catch (e) {
      if (!(e instanceof ApiError) || !e.uncertain) request.current = null;
      setNeedsReview(e instanceof ApiError && e.code === "conflict");
      setError(errorText(e));
      setRecovery(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function repeatArgs(row: OccurrenceRow): Args {
    return {
      request_id: crypto.randomUUID(),
      series_id: seriesId,
      expected_version: data!.series!.version,
      scope: "this",
      original_date: row.original_date,
      ...(row.task ? { expected_occurrence_version: row.task.version } : {}),
    };
  }
  function skip(row: OccurrenceRow) {
    setActionRow(null);
    if (locked || !data?.series) return;
    void write({
      name: "update_recurrence",
      originalDate: row.original_date,
      args: {
        ...repeatArgs(row),
        action: row.task?.occurrence?.skipped ? "unskip" : "skip",
        reason:
          "Changed one occurrence's skipped state using the recurrence view.",
      },
    });
  }
  function complete(row: OccurrenceRow) {
    if (locked || !row.task || row.task.occurrence?.skipped) return;
    void write({
      name: "update_item",
      originalDate: row.original_date,
      args: {
        request_id: crypto.randomUUID(),
        task_id: row.task.id,
        expected_version: row.task.version,
        status: row.task.status === "done" ? "next" : "done",
        reason:
          "Changed one occurrence's completion using the recurrence view.",
      },
    });
  }
  const locked = disabled || busy || needsReview || !!request.current;
  const rows = [...(data?.occurrences || [])];
  if (
    editing &&
    !rows.some((row) => row.original_date === editing.row.original_date)
  )
    rows.push(editing.row);
  return (
    <div className="occurrence-list" aria-busy={loading || busy}>
      {!data && !readError && (
        <p role="status" className="muted">
          Loading occurrences…
        </p>
      )}
      {readError && (
        <div role="alert" className="recovery">
          <p>{readError}</p>
          {data && (
            <p className="muted">
              Previously loaded occurrences may be out of date.
            </p>
          )}
          <button
            type="button"
            disabled={loading || busy}
            onClick={() => void load(undefined, needsReview)}
          >
            Reload occurrences
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      {data && !rows.length && !loading && !readError && (
        <p className="muted">No occurrences in this date range.</p>
      )}
      {rows.map((row) => {
        const done = row.task?.status === "done",
          skipped = !!row.task?.occurrence?.skipped;
        const selected = editing?.row.original_date === row.original_date;
        const label = day(row.scheduled_date);
        return (
          <div
            key={row.original_date}
            role="group"
            aria-label={`Occurrence ${row.original_date}`}
          >
            <div className="occurrence-row">
              <div
                className="repeat-actions"
                style={{ flexWrap: "nowrap", minWidth: 0 }}
              >
                {row.task && !row.task.deleted ? (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${done ? "Reopen" : "Complete"} occurrence ${row.original_date}`}
                    aria-pressed={done}
                    disabled={locked || !!editing || skipped}
                    onClick={() => complete(row)}
                  >
                    {done ? <Check /> : <Circle />}
                  </button>
                ) : (
                  <span className="occurrence-check-space" aria-hidden="true" />
                )}
                <span>
                  {label}
                  <small className="muted">
                    {row.task?.deleted
                      ? "Removed"
                      : row.preview
                        ? "Upcoming"
                        : skipped
                          ? "Skipped"
                          : done
                            ? "Done"
                            : row.scheduled_date < today()
                              ? "Missed"
                              : "To do"}
                  </small>
                  {row.original_date !== row.scheduled_date && (
                    <small className="muted">
                      Originally {day(row.original_date)}
                    </small>
                  )}
                </span>
              </div>
              {!row.task?.deleted && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Actions for occurrence ${row.original_date}`}
                  aria-haspopup="menu"
                  aria-expanded={actionRow?.original_date === row.original_date}
                  disabled={locked || !!editing || !data?.series}
                  onClick={(event) => {
                    menuAnchor.current = event.currentTarget;
                    setActionRow(row);
                  }}
                >
                  <MoreHorizontal />
                </button>
              )}
            </div>
            <TaskExpansion open={selected}>
              {selected && editing && (
                <form
                  className="repeat-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      locked ||
                      editing.date === editing.row.scheduled_date ||
                      !dateInput.current?.reportValidity()
                    )
                      return;
                    void write({
                      name: "update_recurrence",
                      originalDate: editing.row.original_date,
                      args: {
                        ...repeatArgs(editing.row),
                        expected_version: editing.seriesVersion,
                        action: "edit",
                        scheduled_date: editing.date,
                        reason:
                          "Rescheduled one occurrence using the recurrence view.",
                      },
                    });
                  }}
                >
                  <label>
                    Scheduled date
                    <input
                      ref={dateInput}
                      type="date"
                      required
                      min="2000-01-01"
                      max="2199-12-31"
                      disabled={locked}
                      value={editing.date}
                      onChange={(event) =>
                        setEditing({ ...editing, date: event.target.value })
                      }
                    />
                  </label>
                  <p className="muted">
                    Changes only this occurrence. The repeating schedule stays
                    the same.
                  </p>
                  <div className="repeat-actions">
                    <button
                      type="submit"
                      className="primary"
                      disabled={
                        locked ||
                        !editing.date ||
                        editing.date === editing.row.scheduled_date
                      }
                    >
                      Save date
                    </button>
                    <button
                      type="button"
                      className="text-action"
                      disabled={busy || !!request.current}
                      onClick={() => {
                        setEditing(null);
                        if (needsReview) void load();
                        setNeedsReview(false);
                        setError("");
                        requestAnimationFrame(() =>
                          menuAnchor.current?.focus({ preventScroll: true }),
                        );
                      }}
                    >
                      Discard date draft
                    </button>
                  </div>
                </form>
              )}
            </TaskExpansion>
          </div>
        );
      })}
      {actionRow && (
        <Menu
          label="Occurrence actions"
          anchor={menuAnchor}
          close={() => setActionRow(null)}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEditing({
                row: actionRow,
                date: actionRow.scheduled_date,
                seriesVersion: data!.series!.version,
              });
              setActionRow(null);
              setNotice("");
            }}
          >
            Reschedule
          </button>
          {actionRow.task?.status !== "done" && (
            <button
              type="button"
              role="menuitem"
              onClick={() => skip(actionRow)}
            >
              {actionRow.task?.occurrence?.skipped ? "Unskip" : "Skip"}
            </button>
          )}
        </Menu>
      )}
      {error && (
        <div className="repeat-actions">
          <button
            type="button"
            className="icon-button save-error"
            aria-label="Occurrence change needs attention"
            onClick={() => setRecovery((value) => !value)}
          >
            <AlertCircle />
          </button>
        </div>
      )}
      <TaskExpansion open={!!error && recovery}>
        <div role="alert" className="recovery">
          <p>{error}</p>
          {request.current ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void write(request.current!)}
            >
              Retry same change
            </button>
          ) : needsReview ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(undefined, true)}
            >
              Read current occurrences
            </button>
          ) : null}
        </div>
      </TaskExpansion>
      {data?.next_cursor && (
        <button
          type="button"
          className="text-action"
          disabled={loading || locked || !!editing}
          onClick={() => void load(data.next_cursor!)}
        >
          Show more occurrences
        </button>
      )}
    </div>
  );
}
export function Repeating({
  initialSeriesId,
  api,
  revision,
  onDirtyChange,
}: {
  api: Api;
  revision: number;
  onDirtyChange?: (dirty: boolean) => void;
  initialSeriesId?: string;
}) {
  const {embedded} = useEnvironment();
  const navigationState = useAppNavigation();
  const [data, setData] = useViewState<Occurrences | null>("repeating:data",null),
    [error, setError] = useState(""),
    [selected, setSelected] = useViewState<Task | null>("repeating:selected",null),
    [loading, setLoading] = useState(false);
  const [view, setView] = useViewState<
    "overview" | "settings" | "details" | "occurrences" | "agent-notes"
  >("repeating:view","overview");
  const expand = useExpandedView();
  const loadedInitial = useRef(false);
  useEffect(() => {
    if (!initialSeriesId || loadedInitial.current) return;
    let active = true;
    api.call<Occurrences>("list_occurrences", {series_id: initialSeriesId, limit: 1}).then(result => {
      if (active && result.series) { setSelected(result.series); loadedInitial.current = true; }
    }).catch(error => { if (active) setError(errorText(error)); });
    return () => {active = false};
  }, [api, initialSeriesId]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsAnchor = useRef<HTMLButtonElement>(null);
  const routeAnchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && view !== "overview")
      routeAnchor.current?.focus({ preventScroll: true });
  }, [view]);
  const [repeatDirty, setRepeatDirty] = useState(false),
    [occurrenceDirty, setOccurrenceDirty] = useState(false);
  const generation = useRef(0),
    container = useRef<HTMLElement>(null),
    returnId = useRef<string | null>(null),
    dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const dirty = repeatDirty || occurrenceDirty;
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  useEffect(() => {
    if (!selected && returnId.current)
      container.current
        ?.querySelector<HTMLButtonElement>(
          `[data-series-id="${CSS.escape(returnId.current)}"]`,
        )
        ?.focus({ preventScroll: true });
  }, [selected]);
  const retainedCount = useViewRef("repeating:count",0);
  async function load(cursor?: string) {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      let result = await api.call<Occurrences>(
        "list_occurrences",
        cursor ? { cursor } : {},
      );
      while (!cursor && result.next_cursor && (result.series_list?.length || 0) < retainedCount.current && current === generation.current) {
        const next = await api.call<Occurrences>("list_occurrences", {cursor: result.next_cursor});
        result = {...next, series_list: [...(result.series_list || []), ...(next.series_list || [])]};
      }
      if (cursor) retainedCount.current += result.series_list?.length || 0;
      else retainedCount.current = result.series_list?.length || 0;
      if (current === generation.current)
        setData((previous) =>
          cursor && previous
            ? {
                ...result,
                series_list: [
                  ...(previous.series_list || []),
                  ...(result.series_list || []).filter(
                    (series) =>
                      !previous.series_list?.some(
                        (old) => old.id === series.id,
                      ),
                  ),
                ],
              }
            : result,
        );
    } catch (e) {
      if (current === generation.current) setError(errorText(e));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
    };
  }, [api, revision]);
  return (
    <section className="repeating-page" ref={container}>
      {selected ? (
        <>
          <div ref={routeAnchor} tabIndex={-1} className="repeat-route-heading">
            <button
              type="button"
              className="text-action"
              disabled={dirty}
              onClick={() => {
                if (view !== "overview") setView("overview");
                else if (embedded) setSelected(null);
                else navigationState.go({page:"Repeating"}, `[data-series-id="${CSS.escape(selected.id)}"]`);
              }}
            >
              <ChevronLeft aria-hidden="true" />
              {view === "overview" ? "Back to repeats" : "Back to repeat"}
            </button>
            <div className="repeat-route-title">
              <h2 style={{ overflowWrap: "anywhere" }}>{selected.title}</h2>
              {view === "overview" && (
                <button
                  type="button"
                  className="icon-button"
                  ref={optionsAnchor}
                  aria-label="More options for repeat"
                  aria-haspopup="menu"
                  aria-expanded={optionsOpen}
                  onClick={() => setOptionsOpen(!optionsOpen)}
                >
                  <MoreHorizontal />
                </button>
              )}
            </div>
          </div>
          {view === "overview" ? (
            <>
              <OccurrenceDetails
                task={selected}
                api={api}
                revision={revision}
                onSeries={(series) => setSelected((current) =>
                  current?.id === series.id && series.version > current.version
                    ? series : current,
                )}
              />
              <div className="repeat-overview-actions">
                <button
                  type="button"
                  className="text-action"
                  onClick={() => expand(() => setView("details"))}
                >
                  Edit task details
                </button>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => expand(() => setView("settings"))}
                >
                  Edit schedule
                </button>
              </div>
              {optionsOpen && (
                <Menu
                  label="Repeat options"
                  anchor={optionsAnchor}
                  close={() => setOptionsOpen(false)}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOptionsOpen(false);
                      expand(() => setView("agent-notes"));
                    }}
                  >
                    <NotebookPen />
                    Agent notes
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOptionsOpen(false);
                      expand(() => setView("occurrences"));
                    }}
                  >
                    <Repeat2 />
                    Manage occurrences
                  </button>
                </Menu>
              )}
            </>
          ) : <div className="expanded-only">{view === "agent-notes" ? (
            <AgentNotes
              key={selected.id}
              task={selected}
              api={api}
              onTask={setSelected}
              onDirtyChange={setRepeatDirty}
            />
          ) : view === "settings" || view === "details" ? (
            <RepeatControls
              key={`${selected.id}-${view}`}
              editor={view === "details" ? "details" : "schedule"}
              task={selected}
              api={api}
              disabled={occurrenceDirty}
              onDirtyChange={setRepeatDirty}
              onTask={setSelected}
            />
          ) : (
            <OccurrenceManager
              key={`occurrences-${selected.id}`}
              task={selected}
              api={api}
              revision={revision}
              disabled={repeatDirty}
              onDirtyChange={setOccurrenceDirty}
            />
          )}</div>}
          {view !== "overview" && <button className="text-action preview-resume" onClick={() => expand(() => {})}>Continue editing</button>}
        </>
      ) : (
        <>
          {loading && !data && (
            <p role="status" className="muted">
              Loading repeating tasks…
            </p>
          )}
          {error && (
            <div role="alert" className="recovery">
              <p>{error}</p>
              <button
                type="button"
                disabled={loading}
                onClick={() => void load()}
              >
                Reload repeating tasks
              </button>
            </div>
          )}
          {data?.series_list?.map((series) => (
            <button
              type="button"
              className="repeat-series"
              key={series.id}
              data-series-id={series.id}
              onClick={() => {
                if (!embedded) {
                  navigationState.go({page:"Repeating", input:{series_id:series.id}});
                  return;
                }
                returnId.current = series.id;
                setView("overview");
                setSelected(series);
              }}
            >
              <Repeat2 />
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                {series.title}
                <small className="muted">
                  {series.recurrence_summary?.ended_on ||
                  series.recurrence?.ended_on
                    ? "Ended"
                    : series.recurrence_summary?.paused ||
                        series.recurrence?.pauses.some(
                          (pause) => !pause.through,
                        )
                      ? "Paused"
                      : series.recurrence_summary?.current_rule ||
                          series.recurrence?.segments.at(-1)?.rule
                        ? repeatSummary(
                            (series.recurrence_summary?.current_rule ||
                              series.recurrence?.segments.at(-1)?.rule)!,
                          )
                        : "Repeating"}
                </small>
              </span>
              <ChevronDown />
            </button>
          ))}
          {data?.series_list?.length === 0 && !loading && !error && (
            <p className="muted">
              No repeating tasks.
            </p>
          )}
          {data?.next_cursor && (
            <button
              type="button"
              className="text-action"
              disabled={loading}
              onClick={() => void load(data.next_cursor!)}
            >
              Show more repeating tasks
            </button>
          )}
        </>
      )}
    </section>
  );
}
