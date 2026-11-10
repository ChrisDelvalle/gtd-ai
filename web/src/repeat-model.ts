import {
  type Api,
  type Changes,
  type Occurrences,
  type RepeatRule,
} from "./api";

export const weekdayNames = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export async function readSeries(api: Api, id: string) {
  const r = await api.call<Occurrences>("list_occurrences", {
    series_id: id,
    limit: 1,
  });
  if (r.series && !r.series.recurrence) {
    const audit = await api.call<Changes>("list_changes", {
      change_id: r.series.last_change_id,
      detail: "full",
    });
    if (audit.changes[0]?.after) r.series = audit.changes[0].after;
  }
  if (!r.series?.recurrence)
    throw new Error("Repeat settings could not be loaded.");
  return r.series;
}
export function repeatSummary(rule: RepeatRule) {
  const every = rule.interval === 1;
  const joinDays = (values: string[]) =>
    values
      .map((value) => weekdayNames[days.indexOf(value)])
      .filter(Boolean)
      .join(", ");
  if (rule.frequency === "daily")
    return every ? "Every day" : `Every ${rule.interval} days`;
  if (rule.frequency === "weekly") {
    const selected = rule.weekdays.length
      ? days.filter((day) => rule.weekdays.includes(day))
      : [days[(new Date(`${rule.start_date}T12:00:00Z`).getUTCDay() + 6) % 7]];
    if (every && selected.join() === days.slice(0, 5).join())
      return "Every weekday";
    return every
      ? `Every ${joinDays(selected)}`
      : `Every ${rule.interval} weeks on ${joinDays(selected)}`;
  }
  if (rule.frequency === "monthly") {
    const when = rule.ordinal
      ? `${({ 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" } as Record<number, string>)[rule.ordinal]} ${joinDays(rule.weekdays)}`
      : `day ${rule.month_day || Number(rule.start_date.slice(-2))}`;
    return `${every ? "Monthly" : `Every ${rule.interval} months`} on ${when}`;
  }
  const date = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${rule.start_date}T12:00:00Z`));
  return `${every ? "Yearly" : `Every ${rule.interval} years`} on ${date}`;
}
