import { Suspense } from "react";
import type { InspectorProps } from "./inspector";
import { deferred } from "./deferred-component";
const editor = deferred<InspectorProps>(() =>
  import("./inspector").then((module) => ({ default: module.Inspector })),
);
const Editor = editor.Component;
export const preloadInspector = editor.preload;
export function Inspector(props: InspectorProps) {
  return (
    <Suspense
      fallback={
        <div className="compact-empty" role="status">
          Loading…
        </div>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}
