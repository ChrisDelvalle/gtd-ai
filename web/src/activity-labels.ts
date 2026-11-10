export const categories = [
  "undo",
  "completed",
  "added",
  "started",
  "status",
  "scheduling",
  "edited",
] as const;
export const categoryNames: Record<string, string> = {
  undo: "Undo / redo",
  completed: "Completed",
  added: "Added",
  started: "Started",
  status: "Status changed",
  scheduling: "Scheduling",
  edited: "Other edits",
};
