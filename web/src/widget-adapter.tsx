import "./input-modality";
import { EnvironmentBoundary } from "./environment-boundary";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  adapterApi,
  widgetEnvironment,
  widgetIdentity,
  hostState,
  subscribeHost,
  requestDisplayMode,
  reopenGtd,
} from "./adapter-bridge";
import { WidgetSurface } from "./widget-display";
import { Application } from "./application";
import type { Launch } from "./app-context";
function Widget() {
  const [state, setState] = useState({ ...hostState });
  useEffect(() => {
    performance.mark("gtd:shell-ready");
    const update = () => setState({ ...hostState });
    const unsubscribe = subscribeHost(update);
    update();
    return unsubscribe;
  }, []);
  const pages = {home: "Home", repeating: "Repeating", review: "Review", activity: "Activity", charts: "Charts", help: "Help", results: "Results"} as const;
  const launch: Launch | null = state.launch
    ? {page: pages[state.launch.view as keyof typeof pages], home: state.launch.home, input: state.launch.view === "results" ? {from_request_ids: state.launch.from_request_ids, limit: state.launch.resultLimit, initial_results: state.launch.results} : state.launch.series_id ? {series_id: state.launch.series_id} : {}}
    : state.projects
    ? { page: "Projects", input: state.input, projects: state.projects }
    : state.result || state.error
      ? {
          page: "Tasks",
          input: state.input,
          initial: state.result,
          error: state.error,
          canRefresh: state.canRefresh,
          errorIsWrite: state.errorIsWrite,
          recheck: !!state.notice,
        }
      : null;
  return (
    <EnvironmentBoundary guard={widgetIdentity} conceal reopen={state.canMessage ? reopenGtd : undefined}>
    <EnvironmentBoundary guard={widgetEnvironment} reopen={state.canMessage ? reopenGtd : undefined}><WidgetSurface
      context={state.context}
      requestExpansion={requestDisplayMode}
    >
      {widgetIdentity.ready ? <Application
        api={adapterApi}
        embedded
        compact={state.context.displayMode !== "fullscreen"}
        launch={launch}
        test={state.environment === "demo" ? "demo" : state.environment === "test" || state.environment === "staging"}
      /> : <p role="status">{state.error || "Connecting…"}</p>}
    </WidgetSurface></EnvironmentBoundary></EnvironmentBoundary>
  );
}
createRoot(document.getElementById("root")!).render(<Widget />);
