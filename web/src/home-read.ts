import type { Api, HomeSnapshot, List, Projects } from "./api";

/** The same Home contract over HTTP composition or the existing MCP read tools. */
export async function readHome(
  api: Api,
  reviewOn: string,
): Promise<HomeSnapshot> {
  if (api.home) return api.home(reviewOn);
  const [next, waiting, someday, reviewTasks, reviewProjects] =
    await Promise.all([
      api.call<List>("list_items", {
        group_recurrences: true,
        status: "next",
        limit: 7,
      }),
      api.call<List>("list_items", {
        group_recurrences: true,
        status: "waiting",
        limit: 4,
      }),
      api.call<List>("list_items", {
        group_recurrences: true,
        status: "someday",
        limit: 4,
      }),
      api.call<List>("list_items", {
        group_recurrences: true,
        review_on: reviewOn,
        limit: 4,
      }),
      api.call<Projects>("list_projects", { review_on: reviewOn, limit: 4 }),
    ]);
  const empty = ![
    next.items,
    waiting.items,
    someday.items,
    reviewTasks.items,
    reviewProjects.projects,
  ].some((rows) => rows.length);
  const remaining = empty
    ? (
        await api.call<List>("list_items", {
          view: "all",
          archived: false,
          exclude_statuses: ["done"],
          limit: 1,
        })
      ).items[0]?.status || null
    : null;
  return { next, waiting, someday, reviewTasks, reviewProjects, remaining };
}
