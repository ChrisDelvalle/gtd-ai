// The self-contained release/widget already includes these screens. Avoid a
// transient Suspense surface where there is no separate chunk to download.
export { ProjectBrowser, Review } from "./projects";
export { Activity } from "./activity";
export async function preloadPage(_page: string) {}
