import type { Launch } from "../app-context";
import type { DemoStore } from "./store";
export const scenarios = [
  {
    id: "pickup",
    title: "Before school pickup",
    prompt:
      "I've got a little time before school pickup. What's the thing I really shouldn't let slip today? Can you show me the priorities?",
  },
  {
    id: "capture",
    title: "A few things before I forget",
    prompt:
      "A few things before I forget — ask Priya whether that refund test is still failing, sometime this afternoon. And remind me to ask Daniel for a photo of the pickup notice tonight. Oh, and maybe put a little hook by the door for the library bag. Not this week though.",
  },
  {
    id: "energy",
    title: "Twenty minutes, low energy",
    prompt:
      "I'm home, pretty wiped, and I've got about twenty minutes. Anything small I can get off my plate without getting into work stuff?",
  },
] as const;
export type ScenarioId = (typeof scenarios)[number]["id"];
export function runScenario(
  store: DemoStore,
  id: ScenarioId,
): { response: string; launch: Launch } {
  if (id === "pickup")
    return {
      response:
        "Start with the exception replay. It's only 15 minutes, but it unlocks the critical refund check due at 2:30; that check's 12:45 start-by has already passed. The winter pickup authorization is also overdue and should take about 12 minutes.",
      launch: { page: "Charts" },
    };
  if (id === "capture") {
    const project = (title: string) =>
      store.records.find(
        (t) => t.entity_type === "project" && t.title === title,
      )!.id;
    store.execute("apply_changes", {
      request_id: "script-capture-once",
      reason: "Maya's prepared capture example.",
      operations: [
        {
          operation: "capture",
          title: "Ask Priya whether the refund test is still failing",
          brief:
            "Check the latest result with Priya before the afternoon release decision.",
          status: "next",
          importance: "high",
          estimated_minutes: 5,
          effort: "low",
          project_id: project("Clear November's payment verification gate"),
          due_date: "2026-11-06",
          work_blocks: [
            {
              start: {
                date: "2026-11-06",
                time: "13:15",
                timezone: "America/New_York",
              },
              finish: {
                date: "2026-11-06",
                time: "13:20",
                timezone: "America/New_York",
              },
            },
          ],
          agent_notes:
            "Maya asked for an afternoon follow-up, not another test run. Ask Priya for the current result; do not infer that the failure is resolved.",
        },
        {
          operation: "capture",
          title: "Ask Daniel for a photo of the pickup notice",
          brief:
            "Ask Daniel to photograph the notice so the pickup details can be checked.",
          status: "next",
          importance: "normal",
          estimated_minutes: 5,
          effort: "low",
          location: "Home",
          project_id: project(
            "Get the family through the winter school schedule",
          ),
          work_blocks: [
            {
              start: {
                date: "2026-11-06",
                time: "19:30",
                timezone: "America/New_York",
              },
              finish: {
                date: "2026-11-06",
                time: "19:35",
                timezone: "America/New_York",
              },
            },
          ],
          agent_notes:
            "Maya said tonight; 7:30 PM is a suggested block that she can move. This task is a reminder to ask, not a message already sent.",
        },
        {
          operation: "capture",
          title: "Consider a hook by the door for the library bag",
          brief:
            "See whether a small hook would make the library bag easier to find.",
          status: "someday",
          importance: "low",
          project_id: project(
            "Make the apartment easier to use through winter",
          ),
          agent_notes:
            "Maya explicitly does not want to do this this week. Keep it in Someday without a deadline.",
        },
      ],
    });
    return {
      response:
        "Got all three. Priya's follow-up is on today's work list. I penciled Daniel's reminder in for 7:30 tonight—you can move that—and put the library-bag hook in Someday. No messages sent.",
      launch: {
        page: "Results",
        input: { from_request_ids: ["script-capture-once"] },
      },
    };
  }
  const result = store.execute("list_items", {
    status: "next",
    location: "Home",
    max_estimated_minutes: 20,
    max_effort: "low",
    limit: 100,
  });
  const ids = result.items.map((t: { id: string }) => t.id);
  return {
    response:
      "A few things fit: home tasks, no unfinished prerequisites, low effort, and no more than twenty minutes each. I'd pick just one. Refilling Nico's folder is about ten minutes; sorting the spare screws is eight if you want something especially easy.",
    launch: {
      page: "Tasks",
      scope: "selected",
      input: { task_ids: ids, limit: 20 },
      initial: store.execute("list_items", { task_ids: ids, limit: 20 }),
    },
  };
}
