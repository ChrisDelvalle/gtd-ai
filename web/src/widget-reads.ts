import { widgetBundle, type WidgetBundle } from "./widget-launch";
import { defaultZone } from "./calendar-context";
import { ApiError, today, type Api, type Args, type HomeSnapshot } from "./api";

type View = "home" | "tasks" | "charts";
type Snapshot<T> =
  | { kind: "full"; token: string | null; data: T; home_notes_reusable?: boolean; reused_home_notes?: string[]; chart_today?: string }
  | { kind: "unchanged"; token: string };
type Entry = {
  data: unknown;
  token?: string;
  fetched: number;
  day: string;
  boundary: number;
  generation: number;
  homeNotesReusable: boolean;
};

const FRESH_MS = 30_000;
const MAX_VIEWS = 24;
export const priorityProjectArgs = { view: "all", archived: false, limit: 20 };
const homeQuery = (reviewOn: string) => ({
  view: "home",
  review_on: reviewOn,
  loading: "top-three",
});

function boundary(data: unknown): number {
  if (!data || typeof data !== "object") return Infinity;
  const value = data as { next_change_at?: string } & Record<string, unknown>;
  const sections = ["next", "waiting", "someday", "reviewTasks"].map(
    (name) => (value[name] as { next_change_at?: string } | undefined)?.next_change_at,
  );
  return Math.min(
    Infinity,
    ...[value.next_change_at, ...sections].map(
      (at) => typeof at === "string" ? Date.parse(at) || Infinity : Infinity,
    ),
  );
}

function viewFor(name: string, args: Args): View | undefined {
  if (name === "activity_summary" && !args.snapshot) return "charts";
  if (name === "list_items" && !args.cursor && !args.offset && args.query == null &&
      !args.task_id && !args.task_ids && !args.include_history && !args.include_agent_notes)
    return "tasks";
}

function reusable(name: string, args: Args) {
  if (name === "priority_grid") return !args.cell;
  return (name === "list_projects" && !args.project_id && !args.query ||
    name === "list_changes" && !args.change_id ||
    name === "list_occurrences" && !args.series_id) &&
    !args.cursor && !args.before_id && !args.include_agent_notes;
}

function expandChart(data: unknown, args: Args, chartToday: string) {
  type Day = { date: string; count: number | null; categories: Record<string, number>; partial: boolean; future: boolean };
  const chart = data as { days: Day[] };
  const days = new Map(chart.days.map((day) => [day.date, day]));
  const cursor = new Date(`${args.from}T12:00:00Z`);
  const through = new Date(`${args.through}T12:00:00Z`);
  chart.days = [];
  for (; cursor <= through; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const future = date > chartToday;
    chart.days.push(days.get(date) || { date, count: future ? null : 0, categories: {}, partial: date === chartToday, future });
  }
}

export function widgetReads(
  source: Api,
  assertIdentity: () => void,
  identity?: () => { account?: string; environment?: string },
  onRefresh?: () => void,
) {
  let generation = 0;
  let scope = "";
  let snapshotsSupported = true;
  let sparseChartsSupported = true;
  const entries = new Map<string, Entry>();
  const refreshingViews = new Map<string, Promise<void>>();
  let launchCapable = false;
  let latestRevision = -1;
  let bundleCheck: { at: number; day: string; generation: number } | undefined;
  let background: { generation: number; refresh: boolean; promise: Promise<void> } | undefined;
  let chartPreload: Promise<unknown> | undefined;
  function clear() {
    generation++;
    entries.clear();
    refreshingViews.clear();
    launchCapable = false;
    latestRevision = -1;
    bundleCheck = undefined;
    background = undefined;
    chartPreload = undefined;
  }
  function scopeKey() {
    assertIdentity();
    const current = `${source.identityScope?.() || "legacy"}:${defaultZone}`;
    if (current !== scope) {
      scope = current;
      clear();
    }
    return current;
  }
  function keyFor(name: string, args: Args) {
    const defaults = new Set(["offset", "history_after", "undated", "include_deleted", "include_history", "include_agent_notes", "group_recurrences"]);
    const sorted = Object.fromEntries(Object.entries(args)
      .filter(([key, value]) => value != null && !(defaults.has(key) && (value === false || value === 0))
        && !(key === "detail" && value === "summary" && !args.task_id && !args.project_id))
      .sort(([a], [b]) => a.localeCompare(b)));
    return `${name}:${JSON.stringify(sorted)}`;
  }
  function store(key: string, data: unknown, token?: string, homeNotesReusable = false, fetched = Date.now()) {
    entries.delete(key);
    entries.set(key, { data, token, fetched, day: today(), boundary: boundary(data), generation, homeNotesReusable });
    if (key.startsWith("activity_summary:")) {
      const charts = [...entries.keys()].filter((name) => name.startsWith("activity_summary:"));
      if (charts.length > 3) entries.delete(charts[0]);
    }
    while (entries.size > MAX_VIEWS) entries.delete(entries.keys().next().value!);
  }

  function fresh(key: string) {
    const entry = entries.get(key);
    const now = Date.now();
    return entry?.generation === generation && entry.day === today() && now - entry.fetched < FRESH_MS && now < entry.boundary
      ? entry : undefined;
  }
  function decode(value: unknown) {
    return widgetBundle(value, { ...identity?.(), timezone: defaultZone });
  }
  function seedChart(data: unknown, fetched?: number) {
    const chart = data as { priorities?: { kind?: string }; priority_projects?: { projects?: unknown } };
    if (chart.priorities?.kind === "priority_grid")
      store(keyFor("priority_grid", {}), chart.priorities, undefined, false, fetched);
    if (Array.isArray(chart.priority_projects?.projects))
      store(keyFor("list_projects", priorityProjectArgs), chart.priority_projects, undefined, false, fetched);
  }
  function seedPages(bundle: WidgetBundle, fetched = Date.now()) {
    if (bundle.revision < latestRevision) return false;
    latestRevision = bundle.revision;
    for (const page of bundle.pages) {
      if (page.operation === "activity_summary") seedChart(page.data, fetched);
      if (page.operation === "activity_summary" && typeof page.data.chart_today === "string") {
        expandChart(page.data, page.arguments, page.data.chart_today);
        if (page.data.completions)
          expandChart(page.data.completions, page.arguments, page.data.chart_today);
      }
      store(keyFor(page.operation, page.arguments), page.data, undefined, false, fetched);
    }
    return true;
  }
  function afterPaint() {
    return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }
  function loadDefaults(refresh: boolean, exclude?: Args) {
    const activeScope = scopeKey();
    const started = generation;
    bundleCheck = { at: Date.now(), day: today(), generation: started };
    const promise = afterPaint().then(async () => {
      if (scopeKey() !== activeScope || generation !== started) return;
      const value = await source.call<unknown>("widget_pages", exclude ? { exclude } : {});
      if (scopeKey() !== activeScope || generation !== started) return;
      const update = decode(value);
      if (update && seedPages(update)) {
        bundleCheck = { at: Date.now(), day: today(), generation: started };
        if (refresh) onRefresh?.();
      }
    }).catch(() => {
      // The last snapshot remains usable. A foreground read can fall back to
      // its normal request when the bundle doesn't deliver that destination.
    }).finally(() => {
      if (background?.promise === promise) background = undefined;
    });
    return background = { generation: started, refresh, promise };
  }
  function revalidate() {
    if (!launchCapable) return;
    scopeKey();
    if (!launchCapable) return;
    if (background?.generation === generation) return background;
    if (!bundleCheck || bundleCheck.generation !== generation ||
        bundleCheck.day !== today() || Date.now() - bundleCheck.at >= FRESH_MS)
      return loadDefaults(true);
  }
  function preloaded<T>(name: string, args: Args) {
    const value = fresh(keyFor(name, args));
    return value?.data as T | undefined;
  }
  function defaultDestination(name: string, args: Args) {
    if (name === "home" || name === "activity_summary" || name === "list_changes") return true;
    if (name === "priority_grid") return !args.cell && !args.project;
    if (name === "list_occurrences") return !args.series_id && !args.cursor;
    return (name === "list_items" || name === "list_projects") &&
      !args.task_id && !args.task_ids && !args.project_id && !args.query && !args.cursor;
  }
  async function readComposed<T>(name: string, args: Args): Promise<T | undefined> {
    if (!launchCapable || !["home", "list_items", "list_projects"].includes(name) ||
        args.query || args.cursor || args.include_agent_notes || args.include_history) return;
    const started = generation;
    const activeScope = scopeKey();
    try {
      const response = await source.call<unknown>("widget_pages", {
        target: { operation: name, arguments: args },
      });
      if (scopeKey() !== activeScope || started !== generation)
        throw new ApiError("A newer refresh replaced this read.", "stale_read");
      const bundle = decode(response);
      if (!bundle || !seedPages(bundle)) throw new ApiError("The host returned an incomplete view.", "response", true);
      return bundle.pages[0]?.data as T | undefined;
    } catch (error) {
      if (!(error instanceof ApiError) || !["invalid_arguments", "validation_error"].includes(error.code)) throw error;
      launchCapable = false;
      return undefined;
    }
  }
  async function read<T>(
    name: string,
    args: Args,
    view: View | undefined,
    fallback: () => Promise<T>,
    allowStale = true,
  ): Promise<T> {
    const identity = scopeKey();
    const started = generation;
    const key = keyFor(name, args);
    const cached = entries.get(key);
    const warm = preloaded<T>(name, args);
    if (warm !== undefined) return warm;
    const defaults = defaultDestination(name, args);
    const stale = allowStale && launchCapable && defaults && cached?.generation === started
      ? cached : undefined;
    const preload = defaults ? revalidate() : undefined;
    if (preload) {
      // A soft expiry shouldn't block navigation or hide an existing view.
      // Explicit invalidation still waits for the new generation.
      if (preload.refresh && stale) return stale.data as T;
      await preload.promise;
      if (scopeKey() !== identity || generation !== started)
        throw new ApiError("A newer refresh replaced this read.", "stale_read");
      const loaded = preloaded<T>(name, args);
      if (loaded !== undefined) return loaded;
    }
    if (stale) {
      // A bundle can omit a page under its size limit or fail in transit.
      // Refresh that page on demand without taking its saved rows off screen.
      if (!refreshingViews.has(key)) {
        const pending = read(name, args, view, fallback, false).then(() => {
          if (generation === started && fresh(key)) onRefresh?.();
        }).catch(() => {}).finally(() => {
          if (refreshingViews.get(key) === pending) refreshingViews.delete(key);
        });
        refreshingViews.set(key, pending);
      }
      return stale.data as T;
    }
    const composed = await readComposed<T>(name, args);
    if (composed !== undefined) return composed;
    let data: T;
    let token: string | undefined;
    let homeNotesReusable = false;
    if (view && snapshotsSupported) {
      try {
        const request = {
          query: { view, arguments: args },
          ...(cached?.token ? { token: cached.token } : {}),
          ...(view === "home" && cached?.token && cached.homeNotesReusable ? { reuse_home_notes: true } : {}),
        };
        const send = (extra: Args = {}) =>
          source.call<Snapshot<T>>("view_snapshot", { ...request, ...extra });
        const result = view === "charts" && sparseChartsSupported
          ? await send({ sparse_chart: true }).catch((error) => {
              if (!(error instanceof ApiError) || error.code !== "invalid_arguments" ||
                  !error.message.startsWith("Arguments do not match this operation's schema")) throw error;
              sparseChartsSupported = false;
              return send();
            })
          : await send();
        if (result.kind === "full" && result.data) {
          data = result.data;
          token = result.token || undefined;
          homeNotesReusable = result.home_notes_reusable === true;
          if (view === "charts" && result.chart_today) expandChart(data, args, result.chart_today);
          if (result.reused_home_notes?.length) {
            const base = cached?.data as HomeSnapshot | undefined;
            const current = data as HomeSnapshot;
            for (const id of result.reused_home_notes) {
              const row = current.next?.items.find((task) => task.id === id);
              const notes = base?.next?.items.find((task) => task.id === id)?.notes;
              if (view !== "home" || !cached?.homeNotesReusable || !row || row.notes !== undefined || typeof notes !== "string") {
                if (entries.get(key) === cached) entries.delete(key);
                throw new ApiError("The host returned an incomplete view.", "response", true);
              }
              row.notes = notes;
            }
          }
        } else if (result.kind === "unchanged" && cached?.token && result.token === cached.token) {
          data = cached.data as T;
          token = cached.token;
          homeNotesReusable = cached.homeNotesReusable;
        } else {
          throw new ApiError("The host returned an incomplete view.", "response", true);
        }
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "invalid_arguments" ||
            error.message !== "Unsupported UI operation") throw error;
        snapshotsSupported = false;
        data = await fallback();
      }
    } else data = await fallback();
    if (scopeKey() !== identity || generation !== started)
      throw new ApiError("A newer refresh replaced this read.", "stale_read");
    if (view === "charts" && data !== cached?.data) seedChart(data);
    store(key, data, token, homeNotesReusable);
    return data;
  }
  const api: Api = {
    ...source,
    taskPreparation: "widget-intent",
    invalidateReads() {
      generation++;
      refreshingViews.clear();
    },
    async home(reviewOn) {
      return read("home", homeQuery(reviewOn), "home", async () => {
        const { readHome } = await import("./home-read");
        return readHome({ call: source.call }, reviewOn);
      });
    },
    call<T>(name: string, args: Args): Promise<T> {
      if (launchCapable) {
        scopeKey();
        const value = preloaded<T>(name, args);
        if (value !== undefined) return Promise.resolve(value);
      }
      const view = viewFor(name, args);
      const load = () => source.call<T>(name, args);
      if (view === "charts") {
        const pending = read(name, args, view, load);
        chartPreload = pending;
        void pending.finally(() => { if (chartPreload === pending) chartPreload = undefined; }).catch(() => {});
        return pending;
      }
      if (chartPreload && (name === "priority_grid" && defaultDestination(name, args) ||
          name === "list_projects" && keyFor(name, args) === keyFor(name, priorityProjectArgs))) {
        return chartPreload.catch(() => {}).then(() => read(name, args, view, load));
      }
      if (view === "tasks") {
        // A forced first-page refresh supplies an explicit offset of zero.
        // Use the same snapshot key as the original request.
        const { offset: _offset, cursor: _cursor, query: _query, ...firstPage } = args;
        return read(name, firstPage, view, load);
      }
      return view || reusable(name, args) || launchCapable &&
        ["list_items", "list_projects", "list_occurrences"].includes(name) &&
        !args.cursor && !args.include_agent_notes && !args.include_history
        ? read(name, args, view, load) : load();
    },
  };
  return {
    api,
    clear,
    revalidate,
    seedBundle(value: unknown) {
      const bundle = decode(value);
      if (!bundle) return;
      scopeKey();
      const fetched = Math.min(Date.now(), Date.parse(bundle.evaluated_at));
      if (!seedPages(bundle, fetched)) return;
      launchCapable = true;
      bundleCheck = { at: fetched, day: today(), generation };
      if (Date.now() - fetched >= FRESH_MS) {
        revalidate();
      } else if (bundle.deferred && background?.generation !== generation) {
        const home = bundle.pages.find(page => page.operation === "home");
        loadDefaults(false, home && { operation: "home", arguments: home.arguments });
      }
      return bundle;
    },
    seed(value: unknown): HomeSnapshot | undefined {
      const seed = value as (Snapshot<HomeSnapshot> & { review_on: string }) | undefined;
      const reviewOn = today();
      if (seed?.kind !== "full" || seed.review_on !== reviewOn ||
          !Array.isArray(seed.data?.next?.items)) return;
      scopeKey();
      store(keyFor("home", homeQuery(reviewOn)), seed.data, seed.token || undefined, seed.home_notes_reusable === true);
      return seed.data;
    },
  };
}
