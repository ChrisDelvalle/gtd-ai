# Working with GTD

## Capture and clarify

Put loose ideas into Inbox. During clarification, decide the concrete next action,
write a brief, and choose Next, Waiting, or Someday. A project describes an outcome
that takes more than one action. Dependencies keep later steps blocked until
prerequisites are complete. A project is a grouping, not an automatic dependency.

The brief should explain the task to a person. Notes contain supporting detail.
Agent notes retain context for another assistant: decisions, partial progress,
uncertainties, and what remains. Agent notes are available through the task menu.
Links can point to relevant documents or calendar events.

## Dates have different meanings

| Field | Meaning |
| --- | --- |
| Deadline | The task must be finished by this date or time. |
| Start by | The latest intended start; marking started fulfills this constraint. |
| Not before / availability | The earliest time the task becomes available; it does not remove dependencies. |
| Work block / planned time | A period reserved for working on the task, separate from its deadline. |
| Review on | When to reconsider the task or project. |
| Recurrence schedule | When an occurrence belongs; occurrences keep their own identities. |

Date-only deadlines last through the end of their day in the saved timezone.
Changing your default timezone does not silently move an existing recurring
schedule. Estimates describe remaining work; effort expresses the kind of energy
it needs. Marking started records progress, not completion.

## Choose work

Home highlights recommended work. Next lists ready actions, Blocked shows
unfinished prerequisites, and Waiting holds work awaiting a response or event.
Use time and effort filters when you have a particular working window.

The Priorities matrix combines importance with timing. Tasks inherit higher
importance and earlier urgency from unfinished work they block; stored values
remain unchanged. Date constraints take precedence, with planned/scheduled work
providing a fallback. The drilldown explains inherited priority and timing sources.
Archived, deleted, and skipped work is excluded. Select a square to inspect its
matching tasks; a single-task square behaves the same as any other square.

## Review progress

Completed heatmap counts distinct tasks with a recorded completion on each local
date. Ordinary reopening preserves the earlier completion; explicitly undoing it
removes that contribution, and redoing it restores the original day.

Activity counts deliberate record revisions, one per revision even if several
fields changed. Automatic recurrence generation and availability transitions remain
in history but do not inflate chart totals. Retries returning an existing receipt
add no activity. Charts show recorded events, not an inferred time of actual work.

For an assistant recap, request `list_changes` with `days: 7`, then follow its
cursor. This means the previous seven complete local calendar days, excluding
today. Explicit `from` and `through` dates are inclusive. Note edits and planning
changes do not prove work was performed.

## Let an assistant help

Read and write tools return data. `show_tasks`, `show_projects`, and `show_gtd`
explicitly display cards. After a batch, an assistant can display its returned
request ID using `show_gtd` with `view: "results"` and `from_request_ids`.

Keep the same request ID and arguments when retrying an uncertain write. A stale
version means the record changed; read the current record and reconcile before
trying again. Undo is recorded in history and respects coupled recurrence changes.

### Priority and ordering

Recommended combines importance with a bounded boost for a deadline or outstanding
Start by. A missed low-importance deadline does not automatically outrank critical
work due tomorrow. Work blocks help break comparable ties rather than creating a
higher tier. After timing and importance, started work wins a tie, then older
tasks. A stable record identifier resolves the final tie.

A Next, Blocked, or Waiting task without its own deadline uses the deadline of its
active, unarchived project. Its own deadline always takes precedence, even if
later. The inherited date is labeled **Project** and does not change the task.
Inbox, Someday, completed, archived, and skipped tasks do not borrow project dates.
Project importance is not inherited.

Dependencies resolve these facts first. Recommended inherits the strongest whole
recommendation through committed work. The matrix inherits importance and urgency
independently through open dependencies, so its axes may come from different tasks.
The linked source labels explain each contribution.

Use the visible sort selector to choose Recommended, Deadline, Importance, Recently
changed, Oldest first, or Newest first. Deadline includes the project fallback;
the existing Task deadline filter uses only a task’s saved date. Sorting applies
to all matches before pagination. Search defaults to Relevance, Review to Review
date, and Done/Archive to Recently changed. The featured Home task always remains
Recommended; its Next preview has its own order. Title sorts use Unicode lowercase
and UTF-8 byte order, independent of browser locale.

In Priorities, **All timing**, **Deadlines**, **Start by**, **Planned**, and
**Undated** filter membership without moving tasks to different squares. These
filters include dependency timing sources. Cell lists default to Recommended and
retain the grid’s snapshot when sorted. **Planned today** filters unfinished tasks
by their own work blocks, using the account’s calendar day. It rolls forward at
midnight; manually selected date ranges remain fixed.
