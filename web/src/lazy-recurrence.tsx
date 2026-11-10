import {deferred} from "./deferred-component";
import { Suspense, type ComponentProps } from "react";
import type * as Repeat from "./recurrence";

const controls = deferred<ComponentProps<typeof Repeat.RepeatControls>>(() =>
  import("./recurrence").then((m) => ({ default: m.RepeatControls })),
);
const manager = deferred<ComponentProps<typeof Repeat.OccurrenceManager>>(() =>
  import("./recurrence").then((m) => ({ default: m.OccurrenceManager })),
);
const repeating = deferred<ComponentProps<typeof Repeat.Repeating>>(() =>
  import("./recurrence").then((m) => ({ default: m.Repeating })),
);
const Browser = repeating.Component, Controls = controls.Component, Manager = manager.Component;
export const preloadRepeating = repeating.preload;
const loading = (
  <div className="compact-empty" role="status">
    Loading…
  </div>
);

export function RepeatControls(
  props: ComponentProps<typeof Repeat.RepeatControls>,
) {
  return (
    <Suspense fallback={loading}>
      <Controls {...props} />
    </Suspense>
  );
}
export function OccurrenceManager(
  props: ComponentProps<typeof Repeat.OccurrenceManager>,
) {
  return (
    <Suspense fallback={loading}>
      <Manager {...props} />
    </Suspense>
  );
}
export function Repeating(props: ComponentProps<typeof Repeat.Repeating>) {
  return (
    <Suspense fallback={loading}>
      <Browser {...props} />
    </Suspense>
  );
}
