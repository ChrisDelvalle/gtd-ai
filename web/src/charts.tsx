import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { errorText, today } from "./api";
import { useAppNavigation, useEnvironment } from "./app-context";
import { IconButton } from "./task-row";
import { ChartSelector, intensity } from "./chart-controls";
import { PriorityChart } from "./priority-chart";
import { useViewState } from "./view-state";
import { defaultZone } from "./calendar-context";

import { categories, categoryNames } from "./activity-labels";
type Mode = "heatmap" | "bars" | "priorities";
type Category = (typeof categories)[number];
type Preference = { mode: Mode; category: Category | null };
const modeLabels = { heatmap: "Heatmap", bars: "Bar Chart", priorities: "Priorities" };
const categoryLabels: Record<string, string> = { all: "All activity", ...categoryNames };
function readPreference(key?: string): Preference {
  const fallback: Preference = { mode: "heatmap", category: "completed" };
  try {
    const saved = key && localStorage.getItem(key);
    if (!saved || saved === "completed") return fallback;
    // Preserve previous all-activity choices when upgrading the selector.
    if (saved === "activity" || saved === "bars")
      return { mode: saved === "bars" ? "bars" : "heatmap", category: null };
    const value = JSON.parse(saved);
    return (value.mode === "heatmap" || value.mode === "bars" || value.mode === "priorities") &&
      (value.category === null || categories.includes(value.category))
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}
type Day = {
  date: string;
  count: number | null;
  categories: Partial<Record<(typeof categories)[number], number>>;
  partial: boolean;
  future: boolean;
};
type Summary = {
  days: Day[];
  total: number;
  categories: Day["categories"];
  snapshot: string;
  has_history: boolean;
  window: { timezone: string };
  automatic_count: number;
};
type ChartWindow = {
  from: string;
  through: string;
  data: Summary;
  revision: number;
  fetched: number;
  scope: string;
  day: string;
};
export function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function chartRange(end: string, mode: Mode, barDays: number) {
  if (mode === "bars")
    return { from: shiftDate(end, 1 - barDays), through: end };
  const through = shiftDate(end, 6 - new Date(`${end}T12:00:00Z`).getUTCDay());
  return { from: shiftDate(through, 1 - 52 * 7), through };
}
const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", timeZone: "UTC",
});
const fullDate = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
});
const monthName = new Intl.DateTimeFormat("en-US", {
  month: "short", timeZone: "UTC",
});
const dateLabel = (date: string, year = false) =>
  (year ? fullDate : shortDate).format(new Date(`${date}T12:00:00Z`));
function Heatmap({
  days,
  choose,
}: {
  days: Day[];
  choose: (day: Day) => void;
}) {
  const [focus, setFocus] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const firstDate = days[0]?.date;
  useLayoutEffect(() => {
    // Start at the recent end of the full year when a narrow card must scroll.
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, [firstDate]);
  const last = days.reduce((last, d, i) => (d.future ? last : i), -1);
  const active = Math.min(focus < 0 ? last : focus, last);
  const weeks = Math.ceil(days.length / 7);
  function key(e: KeyboardEvent, index: number) {
    const moves: Record<string, number> = {
      ArrowLeft: -7,
      ArrowRight: 7,
      ArrowUp: -1,
      ArrowDown: 1,
    };
    const target =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : e.key in moves
            ? Math.max(0, Math.min(last, index + moves[e.key]))
            : null;
    if (target === null) return;
    e.preventDefault();
    setFocus(target);
    root.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${target}"]`)
      ?.focus();
  }
  return (
    <div className="heat-scroll" ref={scroll}>
      <div
        className="heat-layout"
        style={{ "--weeks": weeks } as React.CSSProperties}
      >
        <div className="heat-months" aria-hidden="true">
          {days
            .filter((d, i) => i % 7 === 0)
            .map((d, i, a) => {
              return (
                <span key={d.date}>
                  {i === 0 || a[i - 1].date.slice(0, 7) !== d.date.slice(0, 7)
                    ? monthName.format(new Date(`${d.date}T12:00:00Z`))
                    : ""}
                </span>
              );
            })}
        </div>
        <div className="heat-weekdays" aria-hidden="true">
          {["", "Mon", "", "Wed", "", "Fri", ""].map((s, i) => (
            <span key={i}>{s}</span>
          ))}
        </div>
        <div className="heat-grid" ref={root} aria-label="Daily counts">
          {days.map((d, i) => {
            const label = dateLabel(d.date, true);
            return (
              <button
                key={d.date}
                data-day={i}
                type="button"
                disabled={d.future}
                tabIndex={i === active ? 0 : -1}
                data-level={intensity(d.count || 0)}
                data-future={d.future}
                aria-label={`${label}: ${d.future ? "unavailable" : `${d.count} ${d.count === 1 ? "event" : "events"}${d.partial ? ", today so far" : ""}`}`}
                onFocus={() => setFocus(i)}
                onKeyDown={(e) => key(e, i)}
                onClick={() => choose(d)}
                title={`${label} · ${d.future ? "Unavailable" : d.count}${d.partial ? " · Today so far" : ""}`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
function Bars({
  days,
  choose,
  category,
}: {
  days: Day[];
  choose: (day: Day, category?: string) => void;
  category: Category | null;
}) {
  const count = (day: Day) => day.count || 0;
  const max = Math.max(1, ...days.map(count));
  const unit = Math.max(1, 10 ** Math.floor(Math.log10(max / 3 || 1)));
  const step = Math.max(1, Math.ceil(max / 3 / unit) * unit),
    ceiling = step * 3;
  return (
    <div className="activity-bars">
      <div className="bar-gridlines" aria-hidden="true">
        {[3, 2, 1, 0].map((t) => (
          <div key={t}>
            <span>{t * step}</span>
            <i />
          </div>
        ))}
      </div>
      <div className="bar-columns">
        {days.map((d) => (
          <div className="bar-column" key={d.date}>
            <button
              className="bar-total"
              aria-label={`${dateLabel(d.date, true)}: ${count(d)} ${category ? categoryNames[category] : "changes"}${d.partial ? ", today so far" : ""}`}
              onClick={() => choose(d, category || undefined)}
              title={`${dateLabel(d.date)} · ${count(d)} ${category ? categoryNames[category] : "changes"}`}
            />
            <div
              className="bar-stack"
              style={{ height: `${(count(d) / ceiling) * 100}%` }}
            >
              {categories
                .filter((c) => d.categories[c])
                .map((c) => (
                  <button
                    key={c}
                    className={`chart-color-${c}`}
                    data-category={c}
                    data-hidden={category !== null && category !== c}
                    aria-hidden={category !== null && category !== c}
                    tabIndex={category !== null && category !== c ? -1 : 0}
                    style={{
                      flexGrow:
                        category && category !== c ? 0 : d.categories[c],
                    }}
                    aria-label={`${dateLabel(d.date, true)}: ${d.categories[c]} ${categoryNames[c]}`}
                    title={`${categoryNames[c]} · ${d.categories[c]}`}
                    onClick={() => choose(d, c)}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
      <div className="bar-dates" aria-hidden="true">
        {[days[0], days[Math.floor(days.length / 2)], days.at(-1)].map(
          (d, i) => (
            <span key={i}>{d && dateLabel(d.date)}</span>
          ),
        )}
      </div>
    </div>
  );
}
export function Charts({
  revision,
  home = false,
}: {
  revision: number;
  home?: boolean;
}) {
  const { api, embedded, refreshGeneration = revision } = useEnvironment(),
    navigation = useAppNavigation();
  const root = useRef<HTMLElement>(null);
  const typeButton = useRef<HTMLButtonElement>(null);
  const restoreTypeFocus = useRef(false);
  const storageKey = api.identityScope?.();
  const key = storageKey
    ? `gtd:charts:${storageKey}:${embedded ? "widget" : "website"}`
    : undefined;
  const [preference, setPreference] = useViewState("charts:preference", () => readPreference(key));
  const { mode, category } = preference;
  const priorities = mode === "priorities";
  useLayoutEffect(() => {
    if (restoreTypeFocus.current) {
      restoreTypeFocus.current = false;
      typeButton.current?.focus({ preventScroll: true });
    }
  }, [mode]);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 640),
    [barDays, setBarDays] = useState(30),
    [end, setEnd] = useState(today),
    [retry, setRetry] = useState(0);
  const [windows, setWindows] = useState<ChartWindow[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const cached = useRef(windows);
  cached.current = windows;
  const { from, through } = chartRange(end, mode, barDays);
  const metric = "changes";
  const day = today();
  const scope = `${storageKey || "local"}:${defaultZone}`;
  const matching = windows.find((window) =>
    window.scope === scope && window.from <= from && window.through >= through,
  );
  const year = chartRange(end, "heatmap", barDays);
  const queryFrom = matching?.from ?? year.from;
  const queryThrough = matching?.through ?? year.through;
  const expired = !!matching && Date.now() - matching.fetched >= 30_000;
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new ResizeObserver(([e]) =>
      setNarrow(e.contentRect.width < 640),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [priorities]);
  useEffect(() => {
    if (priorities) return;
    const previous = cached.current.find((window) =>
      window.scope === scope && window.from === queryFrom && window.through === queryThrough,
    );
    if (previous?.revision === refreshGeneration && previous.day === day &&
        Date.now() - previous.fetched < 30_000) {
      setError("");
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    const query = { from: queryFrom, through: queryThrough, metric };
    api
      .call<Summary>("activity_summary", query)
      .then((data) => {
        if (!alive) return;
        if (!data || !Array.isArray(data.days) || typeof data.has_history !== "boolean" ||
            !data.categories || !data.window || typeof data.window.timezone !== "string" ||
            !data.days.every(day => typeof day.date === "string" && day.categories &&
              (day.count === null || Number.isFinite(day.count)))) {
          throw new Error("Could not load chart data. Try again.");
        }
        const entry = { ...query, data, revision: refreshGeneration, scope, day, fetched: Date.now() };
        setWindows((previous) => [entry, ...previous.filter((window) =>
          window.scope === scope && (window.from !== queryFrom || window.through !== queryThrough),
        )].slice(0, 3));
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, queryFrom, queryThrough, metric, refreshGeneration, retry, scope, day, expired, priorities]);
  const data = matching?.data;
  function select(next: Partial<Preference>) {
    const value = { ...preference, ...next };
    setPreference(value);
    try {
      if (key) localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Preferences are optional. */
    }
  }
  const typeControl = (
    <ChartSelector
      value={mode}
      select={(next) => {
        restoreTypeFocus.current = (next === "priorities") !== priorities;
        select({ mode: next });
      }}
      anchorRef={typeButton}
      options={["heatmap", "bars", "priorities"]}
      labels={modeLabels}
      label="Chart type"
      prefix="Chart"
    />
  );
  if (priorities)
    return <PriorityChart key={scope} revision={refreshGeneration} preferenceKey={key} identity={scope} typeControl={typeControl} />;
  const visibleDays = data?.days.filter((day) => day.date >= from && day.date <= through) || [];
  const days =
    visibleDays.map((day) => ({
      ...day,
      count: day.future
        ? null
        : category
          ? day.categories[category] || 0
          : day.count,
    }));
  const totals: Day["categories"] = {};
  for (const day of visibleDays) {
    if (day.future) continue;
    for (const key of categories)
      totals[key] = (totals[key] || 0) + (day.categories[key] || 0);
  }
  const total = days.reduce((sum, day) => sum + (day.count || 0), 0);
  const summary = `${total.toLocaleString()} ${category ? categoryNames[category].toLowerCase() : "changes"}`;
  function choose(day: Day, category?: string) {
    if (!matching) return;
    navigation.go({
      page: "Activity",
      input: {
        chart: {
          from: matching.from,
          through: matching.through,
          metric,
          snapshot: matching.data.snapshot,
          day: day.date,
          ...(category ? { category } : {}),
        },
      },
    });
  }
  const rangeDays = mode === "bars" ? barDays : 52 * 7;
  const retryControl = error && (
    <div className="chart-error" role="status">
      {error}{" "}
      <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
    </div>
  );
  const dateControl = (
    <label className="chart-range-date">
      <span>
        {dateLabel(from, from.slice(0, 4) !== through.slice(0, 4))} –{" "}
        {dateLabel(through, true)}
      </span>
      <input
        type="date"
        aria-label="Chart ending date"
        value={end}
        max={today()}
        onChange={(e) => {
          if (e.target.value && e.target.validity.valid) setEnd(e.target.value);
        }}
      />
    </label>
  );
  const arrows = (
    <span className="chart-arrows">
      <IconButton
        label="Previous period"
        onClick={() => setEnd(shiftDate(end, -rangeDays))}
      >
        <ChevronLeft />
      </IconButton>
      <IconButton
        label="Next period"
        disabled={end >= today()}
        onClick={() =>
          setEnd(
            shiftDate(end, rangeDays) > today()
              ? today()
              : shiftDate(end, rangeDays),
          )
        }
      >
        <ChevronRight />
      </IconButton>
    </span>
  );
  // Keep the observer mounted even when an account has no history.
  if (data && !data.has_history)
    return (
      <section className={home ? undefined : "charts"} ref={root}>
        {!home && <><div className="chart-controls">{typeControl}</div><p className="empty">No activity yet.</p></>}
        {retryControl}
      </section>
    );
  return (
    <section
      className={`charts chart-${category === "completed" ? "completed" : "changes"}${mode === "bars" ? " chart-bars-mode" : ""}${narrow ? " chart-narrow" : ""}`}
      ref={root}
      aria-label="Activity charts"
      aria-busy={loading}
    >
      <div className="chart-range">
        {dateControl}
        {mode === "bars" && (
          <div className="chart-period" role="group" aria-label="Period">
            {[7, 30].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={barDays === n}
                onClick={() => setBarDays(n)}
              >
                {n}d
              </button>
            ))}
          </div>
        )}
        <div className="chart-range-actions">
          {typeControl}
          {arrows}
        </div>
      </div>
      <div className="chart-panel">
        {data ? (
          <>
            {mode === "bars" ? (
              <Bars days={days} choose={choose} category={category} />
            ) : (
              <Heatmap
                days={days}
                choose={(day) => choose(day, category || undefined)}
              />
            )}
            <div className="chart-footer">
              {mode === "bars" ? (
                <span>{summary}</span>
              ) : (
                <>
                  <ChartSelector
                    value={category || "all"}
                    select={(category) =>
                      select({ category: category === "all" ? null : category })
                    }
                    options={["all", ...categories]}
                    labels={categoryLabels}
                    label="Activity category"
                    prefix="Activity"
                    triggerLabel={summary}
                  />
                  <span
                    className="heat-key"
                    aria-label="Counts: 0, 1–2, 3–5, 6–10, 11 or more"
                  >
                    {["0", "1–2", "3–5", "6–10", "11+"].map((s, i) => (
                      <span key={s}>
                        <i data-level={i} />
                        {s}
                      </span>
                    ))}
                  </span>
                </>
              )}
            </div>
            {mode === "bars" && (
              <div className="chart-legend" aria-label="Activity categories">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={category === c}
                    data-muted={category !== null && category !== c}
                    onClick={() =>
                      select({ category: category === c ? null : c })
                    }
                  >
                    <i className={`chart-color-${c}`} />
                    {categoryNames[c]}{" "}
                    <strong>
                      {(totals[c] || 0).toLocaleString()}
                    </strong>
                  </button>
                ))}
              </div>
            )}
            {retryControl}
          </>
        ) : error ? (
          retryControl
        ) : (
          <div className="chart-placeholder" role="status">
            Loading…
          </div>
        )}
      </div>
    </section>
  );
}
