import {deferred} from "./deferred-component";
import { Suspense, type ComponentProps } from "react";
import type * as Projects from "./projects";
import type * as History from "./activity";

const projects = deferred<ComponentProps<typeof Projects.ProjectBrowser>>(() => import("./projects").then(m => ({default:m.ProjectBrowser})));
const review = deferred<ComponentProps<typeof Projects.Review>>(() => import("./projects").then(m => ({default:m.Review})));
const activity = deferred<ComponentProps<typeof History.Activity>>(() => import("./activity").then(m => ({default:m.Activity})));
const ProjectPage = projects.Component, ReviewPage = review.Component, ActivityPage = activity.Component;
export async function preloadPage(page: string) {
  if (page === "Projects") await projects.preload();
  if (page === "Review") await review.preload();
  if (page === "Activity") await activity.preload();
}
const loading = (
  <div className="compact-empty" role="status">
    Loading…
  </div>
);

export function ProjectBrowser(
  props: ComponentProps<typeof Projects.ProjectBrowser>,
) {
  return (
    <Suspense fallback={loading}>
      <ProjectPage {...props} />
    </Suspense>
  );
}
export function Review(props: ComponentProps<typeof Projects.Review>) {
  return (
    <Suspense fallback={loading}>
      <ReviewPage {...props} />
    </Suspense>
  );
}
export function Activity(props: ComponentProps<typeof History.Activity>) {
  return (
    <Suspense fallback={loading}>
      <ActivityPage {...props} />
    </Suspense>
  );
}
