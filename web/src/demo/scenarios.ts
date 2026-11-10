import type { Launch } from "../app-context";
import type { DemoStore } from "./store";
import { inbox } from "./inbox";
export const scenarios = [
  {
    id: "pickup",
    title: "Before school pickup",
    prompt:
      "I've got a little time before school pickup. What's the thing I really shouldn't let slip today? Can you show me the priorities chart?",
  },
  {
    id: "capture",
    title: "A few things before I forget",
    prompt:
      "A few things before I forget — ask Priya whether that refund test is still failing, sometime this afternoon. And remind me to ask Daniel for a photo of the pickup notice tonight. Oh, and maybe put a little hook by the door for the library bag. Not this week though.",
  },
  {
    id: "inbox",
    title: "From my inbox",
    prompt:
      "Can you check my emails for anything I need to do? Add it to my tasks so I don't lose track. I don't need a task for every newsletter though.",
  },
  {
    id: "energy",
    title: "Twenty minutes, low energy",
    prompt:
      "I'm home, pretty wiped, and I've got about twenty minutes. Anything small I can get off my plate without getting into work stuff?",
  },
] as const;
export type ScenarioId = (typeof scenarios)[number]["id"];
export const cardCount = (id: ScenarioId) => (id === "pickup" ? 2 : 1);
export function runScenario(
  store: DemoStore,
  id: ScenarioId,
): { response: string; launch: Launch; additionalLaunches?: Launch[] } {
  const project = (title: string) =>
    store.records.find((t) => t.entity_type === "project" && t.title === title)!
      .id;
  if (id === "pickup")
    return {
      response:
        "**Start with the exception replay.** Two things need attention before pickup:\n\n1. **Prepare the replay — 15 minutes.** It unblocks the refund check, which needs another 55 minutes and is due at **2:30 PM**. You’re already past its latest start time, so I’d tackle this first.\n2. **Send the winter pickup authorization — 12 minutes.** It was due yesterday. The signed form is in the blue school folder; ask the office to confirm they’ve received it.",
      launch: { page: "Charts" },
      additionalLaunches: [
        {
          page: "Tasks",
          scope: "selected",
          input: {
            task_ids: [
              store.records.find(
                (t) =>
                  t.title ===
                  "Prepare the scrubbed exception replay for the release gate",
              )!.id,
            ],
          },
        },
      ],
    };
  if (id === "capture") {
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
        "Added all three:\n\n- **Priya:** check whether the refund test is still failing. I’ve set aside five minutes at **1:15 this afternoon**, under the payment verification project.\n- **Daniel:** ask for a photo of the pickup notice. I penciled in **7:30 tonight**; move it if another time suits you better.\n- **Library bag hook:** saved in **Someday**, with no deadline.\n\nNo messages sent.",
      launch: {
        page: "Results",
        input: { from_request_ids: ["script-capture-once"] },
      },
    };
  }
  if (id === "inbox") {
    store.execute("apply_changes", {
      request_id: "script-inbox-once",
      reason: "Action items from Maya's email check.",
      operations: [
        {
          operation: "capture",
          title: "Send Priya the owner and backup for Monday's retry rehearsal",
          brief:
            "Confirm the two names and reply to Priya before she finishes the handoff sheet.",
          status: "next",
          importance: "high",
          estimated_minutes: 10,
          effort: "low",
          project_id: project("Clear November's payment verification gate"),
          due_date: "2026-11-06",
          deadline_time: { time: "16:00", timezone: "America/New_York" },
          agent_notes: `Source: ${inbox[0].id}, ${inbox[0].subject}, received ${inbox[0].received}.\n\n${inbox[0].body}\n\nPriya needs the names, not another rehearsal. No reply has been sent.`,
        },
        {
          operation: "capture",
          title: "Confirm Tuesday's pickup adult with the school office",
          brief:
            "Check the plan with Daniel, then tell the school who will collect Nico on November 10.",
          status: "next",
          importance: "normal",
          estimated_minutes: 5,
          effort: "low",
          location: "Home",
          project_id: project(
            "Get the family through the winter school schedule",
          ),
          due_date: "2026-11-09",
          deadline_time: { time: "12:00", timezone: "America/New_York" },
          agent_notes: `Source: ${inbox[1].id}, ${inbox[1].subject}, received ${inbox[1].received}.\n\n${inbox[1].body}\n\nThe response is due Monday; the pickup itself is Tuesday. Do not assume which parent is available. No reply has been sent.`,
        },
      ],
    });
    return {
      response:
        "**Two emails need a response.** I added both to your tasks:\n\n- **Priya’s rehearsal handoff:** send her the owner and backup by **4 PM today**. It’s in the payment verification project, estimated at ten minutes.\n- **Tuesday school pickup:** confirm who’s collecting Nico by **noon Monday**. It’s in the school schedule project; I left the pickup person open until you’ve checked with Daniel.\n\nThe library email is just a drop-in event, so I left it out. I haven’t replied to either email.",
      launch: {
        page: "Results",
        input: { from_request_ids: ["script-inbox-once"] },
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
      "**I’d refill Nico’s folder.** It’s a small, useful thing you can finish without much thought.\n\n- **Refill Nico’s spare folder — 10 minutes.** Add a blank permission slip and the contact card.\n- **Put away the extra closet screws — 8 minutes.** The labeled bag just needs to go in the repair box.\n\nBoth are ready to do at home, with nothing blocking them. You could fit both into twenty minutes, but one is plenty if you’re wiped.",
    launch: {
      page: "Tasks",
      scope: "selected",
      input: { task_ids: ids, limit: 20 },
      initial: store.execute("list_items", { task_ids: ids, limit: 20 }),
    },
  };
}
