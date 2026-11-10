import { setApplicationTime } from "../application-clock";
import { setDefaultZone } from "../calendar-context";
import { NOW, ZONE } from "./domain";
import type { Fixture } from "./store";
declare const __DEMO_FIXTURE__: string;
export async function loadDemo(): Promise<Fixture> {
  setApplicationTime(NOW);
  setDefaultZone(ZONE);
  const response = await fetch(new URL(__DEMO_FIXTURE__, import.meta.url));
  if (!response.ok)
    throw new Error("The demo could not load. Reload to try again.");
  return response.json();
}
export function preparePreferences(
  scope: string,
  presentation: "website" | "widget",
) {
  const identity = `demo:${scope}:${ZONE}`;
  // Demo preferences live only for this mount; never touch a normal account's keys.
  for (const key of Object.keys(localStorage))
    if (key.includes(identity)) localStorage.removeItem(key);
  localStorage.setItem(
    `gtd:charts:${identity}:${presentation}`,
    JSON.stringify({ mode: "priorities", category: "completed" }),
  );
}
export function localLinks() {
  document.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      const url = new URL(target.href);
      if (url.origin !== location.origin) {
        event.preventDefault();
        window.alert("External links are disabled in this demo.");
      }
    },
    true,
  );
}
