import type { Destination } from "./app-context";

export const navigationModel = [
  [
    {
      label: "Next",
      icon: "arrow-right",
      route: { page: "Tasks", scope: "next" },
    },
    { label: "Inbox", icon: "inbox", route: { page: "Tasks", scope: "inbox" } },
    {
      label: "Waiting",
      icon: "timer",
      route: { page: "Tasks", scope: "waiting" },
    },
    {
      label: "Blocked",
      icon: "layers",
      route: { page: "Tasks", scope: "blocked" },
    },
  ],
  [
    { label: "Projects", icon: "folder", route: { page: "Projects" } },
    { label: "Repeating", icon: "repeat-2", route: { page: "Repeating" } },
    { label: "Review", icon: "calendar-days", route: { page: "Review" } },
    {
      label: "Someday",
      icon: "lightbulb",
      route: { page: "Tasks", scope: "someday" },
    },
  ],
  [
    {
      label: "All tasks",
      icon: "list-todo",
      route: { page: "Tasks", scope: "all" },
    },
    {
      label: "Done",
      icon: "check-check",
      route: { page: "Tasks", scope: "done" },
    },
    {
      label: "Archive",
      icon: "archive",
      route: { page: "Tasks", scope: "archived" },
    },
  ],
] satisfies { label: string; icon: string; route: Destination }[][];


export function isDestination(current: Destination, route: Destination) {
  return current.page === route.page && current.scope === route.scope;
}
