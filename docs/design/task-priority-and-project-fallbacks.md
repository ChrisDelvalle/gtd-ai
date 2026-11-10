# Task priority, project fallbacks, and sorting

Status: **Design for review. Not implemented.**

Date: November 10, 2026. Implementation inspected at `7068d84`.

This document proposes how GTD AI should use project information, deadlines,
planned work, and dependencies to surface useful tasks. It also covers the
controls for exploring those tasks on the website and in widgets. Implementation
planning follows review of these decisions; this document does not authorize a
release or change the running service.

## 1. Product intent

The task list answers “What should I work on?” The Priorities matrix lets someone
inspect the same workload along two dimensions: importance and urgency. Opening
a square should give a useful, Recommended list of its tasks. Simple sorts and
filters should make it possible to inspect a deadline or a plan without having
to accept the recommendation algorithm's trade-offs.

The system should use explicit information before assumptions, explain borrowed
priority, and avoid making users maintain the same deadline on every task in a
project. It should remain predictable enough that someone can understand why a
task moved and correct the underlying information.

There cannot be a universally correct order. A deadline does not encode the cost
of missing it, importance is subjective, and a work block may be aspirational.
The design should expose these limits through understandable behavior, rather
than accumulating weights that imply more certainty than the data supports.

### Constraints established in the discussion

- An explicit task deadline wins over its project's deadline, including when the
  task deadline is later. Missing task deadlines can use the project deadline.
- A project deadline is a strong signal. Do not wait until every task work block
  and other timing fallback is absent before considering it.
- Resolve fields independently. Setting task importance does not suppress a
  missing-deadline fallback.
- Inheritance changes derived priority, not stored task fields or audit history.
- Committed work is the main concern. Someday is uncommitted, not necessarily
  unimportant; do not invent urgency merely because it belongs to an active project.
- An ambitious calendar must not give ordinary planned work an absolute advantage
  over urgent, important work. Trivial overdue work need not beat Critical work
  due tomorrow.
- Matrix cell lists default to Recommended. Basic sorting must also be easy to
  find in task lists on the website and in widgets.
- Preserve warm content, task expansion, pagination, and the shared UI. A new
  filter should not bring back a blank screen on every widget interaction.

### Recommended direction

Use project deadlines as a field-level fallback for committed tasks. Keep
deadline/Start by constraints ahead of work-block fallback in matrix placement.
Replace the ranking algorithm's absolute timing tiers with a bounded urgency
contribution, and use work blocks to break otherwise comparable ties. Keep
matrix coordinates independent of visual filters. Expose a small timing menu and
a visible sort selector, with the actual order named correctly.

Project importance needs a separate, explicit inheritance setting. Section 5
describes that addition and its costs; it must not be smuggled in by reinterpreting
existing Normal values.

## 2. What the implementation does today

These are observed behaviors, not proposed promises.

| Area | Current behavior | Consequence |
| --- | --- | --- |
| Project fields | Projects have a deadline and review date. No project importance, Start by, work blocks, effort, or estimate. | Most proposed project fallbacks have no source field today. |
| Task importance | Required on creation; omitted/null updates preserve it; clearing is rejected. Legacy missing values rank as Normal. | Normal cannot safely mean “inherit.” |
| Project membership | Neither ranking nor matrix timing consults the parent project. | An undated task in a dated project receives no project urgency. |
| Ranking | Immediate constraints first, then current work blocks, then importance with a small approaching-date boost. | These first two tiers override importance across tiers. |
| Matrix timing | Own deadline/outstanding Start by first; then current/next/latest-ended block; then occurrence date. | A far-away deadline currently takes precedence over a work block today. |
| Matrix dependencies | Independently propagates maximum importance and urgency through open-task dependencies. | The two axes can come from different downstream tasks. |
| Ranking dependencies | Inherits the strongest whole recommendation through committed tasks. | It avoids combining unrelated donors into a new, stronger recommendation. |
| Matrix scope | Task-group/project filters restrict displayed tasks after dependency propagation. | A hidden task can still explain a visible prerequisite's position. |
| Cell lists | Already use ordinary Recommended order, with workflow ordering for combined scopes. | Keep this default; there is no need to invent another cell ranking. |
| Task sorting | A selector exists inside Filters: Recommended, Next actions first, Importance, Due date, Recently changed, Created. | Sorting exists, but is buried and has ambiguous labels. |
| Default sort | Unspecified sort means relevance for searches, recently changed for Done/Archive, otherwise Recommended. Both explicit `action` and ordinary no-sort task lists use the recommendation algorithm. | The UI can display “Recommended” when that is not the effective order. “Next actions first” is not a separate algorithm. |
| Explicit field sorts | Deadline and importance sorts do not use dependency-inherited values. Recommended groups workflow states; field sorts normally do not. Review queries apply review-date ordering first. | New controls must describe their actual behavior, not just rename options. |

Relevant implementation:

- [Models and query contracts](../../src/model.rs), [planning and current rank](../../src/planning.rs), [buffers and work blocks](../../src/task_planning.rs).
- [Dependency propagation](../../src/dependencies.rs), [matrix classification and previews](../../src/priority_grid.rs).
- [PostgreSQL snapshots and comparison](../../src/postgres/read_snapshot.rs), [priority reads](../../src/postgres/priorities.rs).
- [Matrix UI](../../web/src/priority-chart.tsx), [task filters](../../web/src/task-filters.tsx), [task lists](../../web/src/task-list.tsx), [project browser](../../web/src/projects.tsx).
- [Browser-local demo calculations](../../web/src/demo/domain.ts), which also need parity if the policy changes.

## 3. Shared facts, distinct questions

Resolve facts once per account snapshot. Keep the user's stored input separate
from its effective meaning and from the final recommendation.

```text
Stored task + eligible parent project + evaluation time
                         |
                  Resolved task facts
                         |
             +-----------+------------+
             |                        |
       Matrix placement         Base recommendation
             |                        |
   Dependency axis maxima      Strongest whole dependency
             |                  recommendation
             +-----------+------------+
                         |
                Visible scope / filters
                         |
              Selected ordering / paging
```

Three distinctions are essential:

1. **Readiness is not urgency.** A task can be Critical and overdue while waiting
   on someone else or held by Not before. It belongs in a suitable matrix scope,
   but not in Home's ready Next recommendation.
2. **A plan is not a deadline.** A missed block may be displayed as Overdue under
   the existing matrix contract, but it must retain its work-block provenance.
   It does not acquire the ranking strength of a missed deadline.
3. **A two-dimensional grid is not a row-by-row sort.** Recommended combines
   importance and timing. It need not read all Critical squares before all High
   squares. Tasks sharing a square can still differ in precise dates, sources,
   readiness, and dependency consequences.

For tasks without dependency inheritance, both presentations should be derived
from the same resolved importance, constraints, and plans. The existing
independent-axis dependency rule is an explicit exception discussed in section 7,
not an accidental discrepancy to conceal.

## 4. Project fallback and date semantics

### Eligibility

Apply project fallback only to live, unarchived, unskipped **Next, Blocked, and
Waiting** tasks in a live, unarchived **Active** project in the same account.
Inbox and Someday retain their own information but receive no project fallback.
Done, archived, deleted, and skipped tasks receive no current-work escalation.

Existing relationship validation already constrains project lifecycle changes;
fallback resolution should not bypass it or automatically promote members to
Next. An invalid/missing project reference is not permission to search another
account or match by title. No eligible project means no project fallback.

### Field decisions

| Field | Proposed source/order | Why / boundary |
| --- | --- | --- |
| Deadline | Own deadline if present; otherwise eligible project's deadline. | Honors explicit exceptions and captures the high-signal project commitment. |
| Start by | Task's outstanding Start by only; ignore after actual start. | Projects do not have this field. Starting a project would not imply every child must start then. |
| Importance | Own explicit level; optional project mode described below. | Never infer absence from Normal. |
| Safety buffer | Existing task buffer against the task deadline it currently validates against. | Do not copy project-wide margins or quietly change buffer write validation in this pass. |
| Work blocks / legacy Planned | Own current block, next block, then latest ended block. | A project's calendar reservation would not schedule all its children. No such project field exists today. |
| Occurrence scheduled date | Own recurring occurrence, in its series timezone, after work-block fallback. | A date of occurrence is not automatically a hard completion deadline. |
| Not before | Own value; controls availability only. | Do not make unavailable work urgent simply because its hold expires. |
| Review date | Own review behavior; project review stays a project review. | A reminder to reconsider work is not a deadline to finish it. |
| Effort, estimate, location | Own fields; no project inheritance. | A two-week project estimate or office location says little about an individual action. |
| Status / completion / actual start | Own lifecycle and existing dependency rules. | Project grouping must not manufacture activity or completion evidence. |

No additional project date field should be introduced solely to fill another
fallback slot. If project Start by is added later, its meaning needs its own
design: “begin this outcome” is different from “start every member task.”

### Resolving urgency

1. Resolve the deadline using the table above.
2. Evaluate it alongside the task's outstanding Start by. The more urgent
   constraint determines matrix urgency; retain both for explanation and ties.
3. Keep existing buffer behavior: it can advance an approaching target into the
   seven-day or 48-hour bands, but cannot manufacture Immediate/Overdue status.
4. If there are no constraints, use current/next/latest-ended work-block timing,
   then the occurrence date. With none of these, use Undated.

This preserves the current constraint-before-plan matrix behavior. A project
deadline next month plus a block today lands in the project's deadline band;
the block remains visible in details and can affect ranking ties. This is a
deliberate trade-off: the matrix emphasizes the commitment, not the calendar.
Taking the maximum of every possible date instead would reproduce the user's
concern that ambitious planning makes everything look urgent.

The Planned filter described later selects tasks with plans; it does **not**
silently turn the matrix into a calendar or discard their deadlines.

### Boundaries and provenance

- A date-only deadline is due throughout that date and becomes overdue at the
  start of the following day in the date's interpretation timezone. A timed
  constraint becomes overdue at its instant; two elapsed hours marks Immediate.
- Seven days and 48 hours use the existing elapsed-time bucket rules. Calendar
  dates and day buffers retain calendar arithmetic across DST.
- Current date-only `due_date` resolution uses `default_zone()`
  (`America/New_York`), whereas timed moments and recurrence carry zones. Project
  fallback must use the same resolver as a project deadline read. Do not silently
  reinterpret retained dates in the browser/account timezone as part of ranking.
  Generalizing date-only timezone storage is a separate migration decision.
- The next boundary includes project midnight, approaching thresholds, Start by
  fulfillment, and block starts/ends. It is not merely the child's update time.
- Return source kind, source record ID, interpreted moment/zone, and whether the
  source is a real constraint or a plan. Do not overwrite `due_date` in reads.

### Overrides, clearing, and contradictory plans

A task deadline later than its project's is respected. The task may be a
post-launch action, or the data may be inconsistent; the system cannot know.
Show both dates when someone inspects timing, with the project date linked, but
do not create a warning banner on every task or invent a stronger deadline.

Clearing a task deadline reactivates the project fallback. The editor must show
the resulting inherited deadline immediately rather than appearing to remove all
timing. Start with this simple rule and explicit preview. A separate “Ignore
project deadline” setting is not recommended initially: it adds another hidden
override to every task. If users need deliberate undated exceptions within
committed project work, that is a real reason to revisit the decision, not a
reason to fake an exception with a far-future date.

## 5. Project importance requires an explicit product decision

Deadline fallback works with fields that exist. Importance inheritance does not:
projects have no importance, and supported task creation always supplies one.
Adding it is reasonable, but it is a small data-model feature rather than a
ranking-only fix.

| Approach | Benefit | Problem | Recommendation |
| --- | --- | --- | --- |
| Treat Normal as missing | No new control | Reinterprets intentional Normal tasks; changing a project unexpectedly moves existing work | Reject |
| Inherit only legacy null importance | Minimal schema work | Ordinary users cannot select it; mostly affects old data arbitrarily | Reject |
| Always take max(task, project) | Simple propagation | Overrides explicit task priority, contrary to the agreed fallback rule | Reject |
| Optional project importance + explicit task “Use project” | Clear user intent; preserves existing data | Requires schema, editor, recurrence, old-client, and rollback work | Preferred if importance inheritance is included |
| Ship deadline fallback first | Smaller, entirely derived change | No new importance fallback yet | Acceptable scope reduction; make it explicit |

For the opt-in design, preserve the existing stored task importance as its
fallback and add a separate project-inheritance mode, defaulting off for all
existing records. When enabled on an eligible task, use project importance if
set; otherwise use the retained task level. This avoids changing task priority
arbitrarily when it leaves a project or becomes Someday.

The task editor's importance menu offers the seven explicit levels and **Use
project** when a project is assigned. Selecting an explicit level disables the
mode. Selecting Use project preserves the previous explicit level as the
fallback. The control displays the resolved level; the menu shows the fallback
as a concise field instruction, for example “Otherwise Normal.” An inherited
read shows **High · Project: Website launch**, with a link to the project.

On Inbox/Someday, show the retained task level; the mode is dormant and resumes
on commitment. Do not make a status change rewrite importance. The editor must
make the dormant mode visible on inspection, so a move back to Next is not an
unexplained priority change. If this is too much UI for the value delivered,
defer the feature rather than replacing it with implicit inheritance.

API behavior must be explicit: an importance update selects an explicit level;
an omitted importance preserves the current mode; entering project mode is a
separate documented request. Legacy null behavior remains unchanged. Recurring
templates need the same mode semantics, with the inherited value resolved for
each occurrence rather than copied permanently when generated.

**Recommendation for review:** include opt-in project importance only if this
mode/fallback UX is accepted. Deadline, ranking, filtering, and sorting can be
implemented independently. No historical task should be enrolled automatically.

## 6. Recommended ordering: compare policies before choosing one

### Why the present tiers fail

Today, a Trivial overdue task is in the first tier and a Critical task due
tomorrow can be in the third. A Low task in a current block also jumps above
unscheduled Critical work. These outcomes follow directly from the comparator;
they are not missing indexes, stale caches, or incidental tie-breakers.

### Alternatives

| Policy | What it handles well | Where it fails |
| --- | --- | --- |
| Current absolute timing tiers | Strong respect for near commitments and the calendar | Low-stakes overdue work and ambitious blocks dominate importance |
| Strict importance, then date | Critical always wins; very easy to explain | Critical but indefinite work can starve concrete, time-sensitive normal work |
| Earliest deadline first | Excellent for auditing deadlines | Treats all consequences as equal; misses undated enabling work unless separately inherited |
| Continuous age/urgency scoring | Smooth numerical movement | Unbounded lateness can dominate forever; harder to predict, cache, explain, and calibrate |
| User-adjustable weights | Supports many preferences | Asks users to maintain the algorithm; difficult to explain recommendations consistently |
| Bounded urgency + importance | Fixes the stated counterexamples with a small number of rules | Still makes explicit value judgments at equal-score boundaries |

### Proposed candidate

Use the existing seven importance levels, from 0 (Unimportant) to 6 (Critical).
For each task's resolved constraints, define a bounded urgency contribution:

| Constraint state | Contribution |
| --- | ---: |
| No constraint, or more than seven days away | 0 |
| Within seven days | 1 |
| Within 48 hours | 2 |
| Due today as a date-only constraint, within two hours as a timed constraint, or overdue | 3 |

Start by participates only while outstanding. An eligible project deadline has
the same strength as a task deadline; inherited does not mean less important.
Use the maximum applicable contribution, not a sum per date or per project.

An existing buffer target can supply at most 2. Thus:

```text
base score = resolved importance + max(constraint contribution, buffer contribution)
```

Work blocks and occurrence dates **do not add score** in the recommended
candidate. Current planned work wins otherwise comparable ties. This is the
smallest scheduling influence that still respects intent without making an
extra block a way to manufacture priority.

Order within the eligible workflow group:

1. Higher base score.
2. Stronger actual constraint contribution, before a buffer-only contribution.
3. Higher resolved importance.
4. Earlier relevant constraint/target within a boosted band. A distant deadline
   with zero boost does not beat current planned work merely by existing.
5. Current work block before otherwise equivalent unscheduled work.
6. Earlier remaining timing, taking the earliest of the relevant selected
   plan/occurrence and distant constraint dates, with absent values last.
   Creation sequence and ID finally make the order stable. Merely having a plan
   next year must not beat an otherwise equivalent deadline eight days away.

“Relevant selected plan” uses the same current/next/latest-ended block selection
as the matrix, then occurrence fallback. It never adds together multiple blocks.
Within an exact tie, earlier missed plans can precede later plans; their age
cannot lift them over a higher-scoring task. No estimate, number of dependents,
or number of work blocks is an extra score multiplier.

Recommended retains the existing ready-work-first workflow grouping in combined
lists. Home chooses ready Next work. Explicit field sorts, in contrast, should
order the whole selected task set without a hidden workflow grouping.

### Concrete comparisons

These examples compare ready tasks without dependency inheritance. “Tomorrow”
means a constraint inside the 48-hour band; “now” for a block means in progress.

| Pair | Current first | Proposed first | Trade-off |
| --- | --- | --- | --- |
| Trivial overdue vs Critical due tomorrow | Trivial | Critical: 8 vs 3 | A missed low-stakes commitment does not dominate much more important near-term work. |
| Low block now vs High due tomorrow | Low | High: 6 vs 2 | Calendar intent cannot override this deadline. |
| Normal due in one hour vs Critical undated | Normal | Normal: both 6, actual urgency wins | Immediate normal work can beat indefinite critical work; this is an intentional boundary. |
| Low overdue vs Critical undated | Low | Critical: 6 vs 5 | Not every overdue item deserves first place. |
| Normal block now vs Normal due in five days | Block | Deadline: 4 vs 3 | A plan is secondary even here; this is the main cost of the conservative schedule rule. |
| Normal block now vs Normal unscheduled | Block | Block: equal score, plan breaks tie | Scheduling remains useful without an absolute tier. |
| Critical block now vs Normal due in one hour | Normal | Normal: equal 6, actual urgency wins | A +1 schedule bonus would reverse this result; tie-only avoids that. |
| Very low overdue vs High undated | Very low | Very low: equal 4, actual urgency wins | A deliberate difficult case: reducing maximum urgency to 2 would reverse it. |
| High task due next month with buffer target today vs High actual deadline tomorrow | Buffer target | Actual deadline: equal 6, actual constraint wins | Buffer does not impersonate a deadline. |

The last two rows prevent selective validation using only favorable examples.
A maximum contribution of 2 would better protect importance, but Normal due in
an hour would lose to Critical undated. A maximum of 4 would let Low overdue beat
Critical undated outright. A maximum of 3 is the recommended compromise, not an
empirically proven optimum.

A small analytical comparison checked the eight non-buffer pairs above and
monotonicity across 56 combinations of importance, constraint band, and current
block presence. It confirms the arithmetic of the candidate, **not** the
production implementation or real-world recommendation quality. Full scenario
fixtures are required during implementation.

### Deliberate limitations

- Overdue receives no ever-growing boost. A very old trivial item cannot become
  more important solely through neglect.
- Indefinite Critical work can still dominate lower-scoring work. Review or
  correcting importance is the remedy; there is no invisible aging mechanism.
- An impossible set of deadlines remains impossible. The algorithm does not
  allocate capacity, reschedule tasks, or guarantee feasibility.
- Effort and duration remain explicit filters, not a permanent quick-task bias.
  A useful default should not continually postpone demanding work.
- A genuine appointment with consequences should carry an appropriate deadline
  or Start by, rather than rely on an ordinary work block as a hard commitment.
- Existing ranked order will change. This requires an intentional release note,
  updated help/agent guidance, and a measured comparison with the old policy.

## 7. Dependencies and consistency between the matrix and list

Project fallback is applied to each task **before** dependency propagation. An
undated prerequisite can then inherit the recommendation of a task whose missing
deadline comes from a project, including across project boundaries. The displayed
explanation must retain the full reason: prerequisite → dependent → project
deadline, not falsely claim the prerequisite belongs to that project.

Preserve the two existing dependency contracts initially:

- Matrix axes use independent maxima across eligible open dependency paths.
- Ranking takes the strongest complete recommendation across committed paths.

Consider an enabling task that blocks both a Critical undated initiative and a
Trivial overdue errand. Independent axes place it at Critical/Overdue. Scoring
that composite as 6 + 3 would invent an urgency/importance combination that no
actual downstream commitment has. Strongest-whole ranking instead gives it the
Critical initiative's 6, not 9. This protects a separate Critical task due
tomorrow with score 8.

The cost is visible: matrix coordinates alone cannot reconstruct that enabling
task's rank. Its cell list still uses Recommended, and its source labels must
show **Importance from** and **Urgency from** separately when they differ.
Keeping this exception is preferable to quietly manufacturing emergency work or
discarding the earlier requirement that each axis show the maximum downstream
stakes. If exact one-to-one grid/rank equivalence is required, review that
requirement explicitly: using one donor for both axes would be a product change.

For equal urgency values, prefer stronger evidence (constraint before
buffer/plan), then the earlier relevant moment. Prefer the task itself when that
evidence is equivalent. For equal importance values, prefer its own resolved
importance. Use a stable donor ID tie-break otherwise. Equal-value donors should
not make source labels flicker with database iteration order. A recommendation
inherited from another task's work block must say it enables planned work, not
claim that the prerequisite itself has a work block.

There is another existing distinction: the matrix can receive influence from
Inbox/Someday open tasks, whereas recommendation propagation is committed-only.
Selecting Next does not remove those hidden donors from the matrix. Project
fallback should not quietly change that rule. Preserve it and show provenance;
changing donor eligibility in both presentations is a separate review decision.

Filters must never prune the graph before calculating influence. A project view
can legitimately contain a prerequisite carrying urgency from another project.
Done, archived, skipped, and deleted donors must not contribute live urgency.
One hundred equally urgent dependents confer no larger score than one; duplicate
paths must not stack boosts.

## 8. Timing filters for the matrix

Use one compact, single-choice **Timing** menu. Proposed options:

| Choice | Membership |
| --- | --- |
| All timing | All tasks in the selected group/project, including undated tasks. Default. |
| Deadlines | Has an effective own/project deadline, or is a prerequisite on an eligible open dependency path to one. |
| Start by | Has an outstanding own Start by, or enables a task with one on such a path. Fulfilled Start by does not match. |
| Planned | Has a usable work block or occurrence schedule, or enables work with one. Ended blocks can match while unfinished. |
| Undated | Has no effective timing after the complete fallback and dependency calculation; occupies the Undated column. |

Deadlines, Start by, and Planned can overlap. They are views, not additive
statistics. A project review date, Not before, or an already fulfilled Start by
does not make an otherwise undated task dated. A task's own explicit deadline
still counts in Someday even though project fallback is disabled there.

Membership is independent of which source wins its final urgency axis. A task
can have a deadline next month and inherit a more urgent Start by from a
dependent. It remains in Deadlines and stays in its original square, with the
actual urgency source visible. This preserves spatial consistency.

That is a limitation of a membership filter: Deadlines does not mean “every
Overdue square represents a missed deadline.” Label it as a filter, not a
“deadline-only urgency” mode. A future lens that recomputes coordinates using
only deadlines could answer that different question, but would require a clearly
named mode and changed legend. Do not add it silently to this menu.

The explicit Start by choice avoids hiding real constraints under “Planned” or
mislabeling them as deadlines. A five-item menu is still small; independent
checkboxes and arbitrary Boolean filter combinations are unnecessary here.

## 9. Straightforward sorting across website and widgets

### Sort choices and meaning

Make the active sort a visible flat text-and-chevron control, not an option
buried inside Filters. Remove the duplicate “Next actions first” presentation;
Recommended already includes that workflow behavior. Reuse the shared menu and
keyboard/focus conventions.

| Task sort | Meaning | Default direction |
| --- | --- | --- |
| Recommended | New recommendation policy, dependency effects, and readiness-oriented workflow grouping | Best first |
| Deadline | Own deadline, otherwise eligible project deadline; no work-block/Start by substitution and no dependency donor's deadline | Earliest first; undated last |
| Importance | Explicit task level, or resolved project level if opt-in mode is adopted; no dependency escalation | Highest first; unset legacy values use Normal |
| Recently changed | Actual record changes, not the time a derived recommendation was recomputed | Newest first |
| Oldest first | Task creation order | Oldest first |
| Newest first | Task creation order | Newest first |
| Relevance | Search result relevance; available only for a nonempty search | Best match first |

This is enough for the first pass. Avoid adding a general comparator builder or
a second ascending/descending toggle for every choice. Project Name A–Z is
useful for project browsing; estimate/effort sorting can follow a demonstrated
need, since their filters already answer time-and-energy questions.

Deadline sort is intentionally literal. A prerequisite's dependency urgency is
handled by Recommended, not displayed as a deadline it does not have. The row
must show the date being sorted on and its source. If Importance uses project
fallback, display that resolved value as well. Otherwise the order looks wrong
even when the comparator is correct.

Keep existing MCP `due` and `importance` semantics for clients relying on stored
fields. Add distinctly named effective-field sorts where needed; do not silently
repurpose old parameters. The website/widget Deadline and Importance choices
can use those explicit new modes. Response metadata should identify the
effective sort. Exact wire names are an implementation-planning decision.

### Placement and defaults

| Surface | Default and controls |
| --- | --- |
| Next, Inbox, Waiting, Blocked, Someday, All tasks; project task lists | Visible Recommended selector with the relevant task sorts. |
| Done and Archive | Recently changed, shown honestly; allow the other applicable field sorts. |
| Search | Relevance by default. Choosing Deadline or another sort keeps the search membership. Clearing search restores the prior non-search order. |
| Home | Featured task remains Recommended. The preview task section can have its own sort beside its existing controls; “View all” carries the selection. Do not relabel a deadline-sorted preview as the system's recommendation. |
| Matrix cell task list | Recommended every first visit unless the user explicitly chooses another order for cell browsing. Shared sort control in the sheet header. |
| Projects | Deadline, Recently changed, Name A–Z; Review date where relevant. No task importance option unless projects actually gain importance. |
| Review | Review date by default within each existing task/project section. An explicit field sort replaces the date precedence within that section; no invisible secondary day grouping. Eligibility for review is unchanged. |
| Mixed Results | Preserve receipt/result order by default. Offer only sorts meaningful across the displayed record types, such as Recently changed and Title; task-only selections can use task sorts. |
| Repeating | Keep its occurrence-oriented order for this change; no fake task Recommended control on definitions. A future schedule sort requires a real series query contract. |
| Activity / history / chart axes | Keep chronological or fixed axis order. Generic task sorting does not apply. |

An agent's explicit launch order takes precedence over remembered preferences.
Do not reorder a selected list of search results on first paint just because the
user last viewed Archive. After a user changes sort, record that preference for
the same account/environment/presentation/view family. Matrix-cell sort is
separate from main task lists and historical chart drilldowns. Never silently
reuse a non-default cell sort without showing its label.

All sorts operate over the full eligible set **before pagination**. Do not sort
only the loaded page or re-sort preloaded first-page previews and imply they are
globally correct. Stable ties use creation sequence and ID. Changing sort resets
the continuation, retains membership filters, and obtains a coherent first page.
Title sorts need one documented, deterministic normalization/collation shared
by server and demo; browser locale must not change page membership. Existing
stored-date search filters retain their current contract. If an effective-date
filter is exposed alongside the new Deadline sort, it needs a distinct query
field and matching UI label; sorting by a project date must not silently rewrite
what an existing `due_from` query means.

## 10. Detailed interaction design

### Matrix toolbar

On a spacious website or expanded widget, keep the task group and project on the
left, add **All timing ▾** next to them, and retain **Priorities ▾** on the right.
Use the existing flat controls. No new panel border, explanatory subtitle,
permanent legend paragraph, or ranking score appears above the grid.

On narrow layouts, keep group/project together and the chart type at the trailing
edge where they fit. If the Timing control would compress labels or collide,
place it on one compact second toolbar row. Wrap based on container width, not
the whole browser width: sidebars and expanded host panels change available
space. Prefer a clean two-row toolbar over clipped text or an unlabeled icon.

Selection uses radio-menu semantics. Checkmarks indicate the choice; pointer
clicks do not leave keyboard-style focus rings. Keyboard navigation retains
visible focus, Escape closes, and focus returns to the trigger. Menus remain
within the viewport and have accessible full names when labels are shortened.

### Grid and cell list

- Keep all seven columns and importance rows fixed; filters change counts, not
  axis labels, color semantics, or task positions. Do not encode rank with a new
  color or count-based priority boost.
- Opening any occupied square opens the same task-list sheet, even for one task.
  The header shows the cell name, a compact **Recommended ▾**, and the existing
  plain close icon. On narrow widths, the sort moves beneath the title within
  the header rather than squeezing the close target.
- The list is already Recommended today; retain that behavior explicitly in
  tests. Non-default sorting is a user choice, not a chart-coordinate change.
- Each task shows only relevant explanation: **Deadline · Project: Launch**,
  **Start by · Today**, **Work block ended · Yesterday**, or linked **Importance
  from** / **Urgency from**. Use short factual rows rather than a prose tutorial.
- A dependency source link opens its task; a project source opens its project.
  Returning restores cell, scroll, sort, and focus. Do not send a hidden model
  prompt to explain the reason.
- Keep the website's sheet anchored beneath the grid labels on desktop and
  phone. Keep the widget's bottom-sheet presentation. Preserve backdrop fade,
  open/close motion, reduced-motion behavior, and background scroll locking.
- A zero-result filtered grid uses one concise state with **Clear timing filter**
  when that control can resolve it. Existing useful content remains visible.

### Editing and refreshing

Inherited values must look derived rather than editable copies. Opening the
deadline editor shows the task's own field plus a compact project fallback
preview. Saving an explicit date replaces the fallback; clearing it reveals the
fallback. Ordinary detail views show the effective date/source without requiring
an extra MCP call.

Project edits can move many tasks without changing their versions. Refresh the
grid, list order, source labels, and task expansions from one new snapshot.
Preserve drafts and postpone row movement while someone is editing, scrolling,
or interacting. The old snapshot remains usable while the replacement arrives.
Do not keep an updated count paired with old membership.

A sort/filter change is immediate user intent: acknowledge the selected control
immediately. If its result is not cached, keep the old list visible with a small
local pending state; do not present that list as already sorted/filtered under
the new rule. Commit the new label/result state together, or visibly distinguish
pending selection. On failure keep the last successful view and offer Retry.

## 11. Query, caching, and compatibility design

### One account snapshot

Build an effective-facts map once from the existing account/revision/evaluation
snapshot. Resolve parent projects before ranking and graph propagation. Reuse
the map for Home, lists, exact reads, matrix counts, cell previews, and details.
No per-row project lookup and no writes during reads.

The optimized exact-task read currently loads dependency closure but not parent
projects. It must load the projects of every relevant task in that closure, not
just the requested task, and agree with the full snapshot path. Historical
snapshots need historical project versions, not current project dates. Source
records and all explanation links remain account-bound and authorized.

Return a compact derived object with the effective deadline, importance source,
constraint/plan kind, dependency sources, evaluation time, next boundary, and
policy version. Keep raw fields unchanged. Agent reads get enough provenance to
avoid copying inherited values back into tasks or mistaking plans for deadlines.
Ordinary current task context remains complete; compact previews omit note bodies.

### Counts and preloading

Timing membership can be represented by three flags: has deadline, outstanding
Start by, and plan, including eligible dependency sources. Keep Undated tied to
the resolved urgency. Propagate membership flags separately from the winning
urgency source: a non-winning deadline still makes the Deadlines filter match.

Aggregate counts by cell, status, and flag combination. At most 49 × 5 × 8
integer counts are required before sparse encoding. This is bounded and should
allow timing/task-group changes without another MCP request. Measure actual
serialized size; it is not a claim that arbitrary drilldown data is free.

Keep the existing bounded cell previews and preload the selected filter's
Recommended first pages. Deduplicate row data. Reuse a filtered preview only
when it proves a complete ordered prefix; otherwise fetch that cell's first page
and expansions together. Do not multiply every cell by every filter and every
sort in the initial payload. Prioritize the active view, then use the existing
bounded background bundle. Other sorts may require one read unless their
complete membership is already available.

Cache keys include account, environment, database, policy version, revision,
evaluation time/boundary, project, group, timing filter, sort, and presentation
where page size differs. A child-version-only cache is insufficient after a
project edit. A project rename can change source labels without changing order;
it still invalidates the corresponding derived display data.

### Pagination and failure handling

Count, preview, first page, continuation, and detail data use the same frozen
snapshot and policy. New writes or a midnight boundary must not silently alter
later pages of an existing cell. Refresh replaces the page set coherently.
Changing a filter or sort starts a new query; a cursor from another query is
rejected. Expired snapshots get the normal recoverable refresh path.

An authentication/account failure clears account-owned caches. Other read
failures retain the successful view. Discard late results from an earlier
identity, query, or refresh. Preserve write version checks and draft conflict
recovery even when the ordering shown is stale.

### Storage and old clients

Deadline resolution and ranking are derived; they need no mass update of child
records, history, or retry receipts. Advance ranking/matrix cursor policy
identifiers so a cursor cannot straddle changed algorithms. Do not change
database compatibility merely to invalidate a derived cache.

If project importance/mode becomes stored data, review schema compatibility,
legacy validators, recurrence templates, undo, import/export, old writers, and
rollback explicitly. An old server that drops an unknown mode cannot be a safe
rollback. Existing immutable receipts must replay unchanged; fresh reads can
provide new derived explanations separately.

The website, both supported widget bridges, MCP contracts, SQLite fixture/import
paths, PostgreSQL paths, and static demos must agree where the behavior is
supported. One Rust resolver should own the serving policy. Demo parity checks
must compare against it; updating a golden file without investigating changed
results is not validation.

## 12. Failure scenarios and acceptance expectations

The following is a design test catalogue. It defines intended outcomes before
implementation and includes cases where the proposal has a known limitation.

| Scenario | Required outcome / accepted limitation |
| --- | --- |
| Undated Next task in a project due tomorrow | Uses the project deadline, displays its source, and ranks with that constraint. |
| Task due next month in a project due tomorrow | Keeps next month's task deadline. Project conflict can be inspected; no silent override. |
| Task Start by in one hour, project deadline next month | Start by determines urgent placement/rank; project deadline remains available. Starting the task removes Start by influence. |
| Task block now, project deadline next month | Matrix uses the constraint; current block only breaks comparable ranking ties. Planned filter still finds it. |
| Task block next month, project deadline tomorrow | Project deadline wins; the block cannot postpone a real commitment. |
| Someday aspiration in a project due tomorrow | No project deadline/importance fallback. Its own explicit date/importance remains meaningful. |
| Inbox capture in a dated project | No inferred commitment before clarification. |
| Normal explicit task in Critical project, if importance is added | Remains Normal. Only explicit Use project opts in. |
| Use project task loses its project or moves to Someday | Uses retained task importance; no rewrite. UI shows the dormant/fallback mode when inspected. |
| Project deadline cleared or postponed | Children without overrides refresh together; explicit task dates do not change. |
| Project deadline moved but task version unchanged | New reads, details, and warm lists reflect the new project revision; old frozen pages remain stable. |
| Deadline cleared on task while project is dated | Editor immediately reveals fallback. Never imply that all deadline influence was removed. |
| Not before next week but project deadline tomorrow | Task remains unavailable. Matrix can expose the contradiction; Home does not suggest doing it now. |
| Waiting task due in an hour | Visible in Waiting/Committed; no automatic conversion to ready work. |
| Trivial overdue versus Critical tomorrow | Critical ranks first under the candidate. |
| Critical indefinitely versus Normal due in an hour | Normal ranks first on the candidate's tie. This preference needs review, not concealment. |
| Very low overdue versus High indefinitely | Very low wins the tie; documented compromise. |
| A dozen overlapping blocks | No accumulated score. Choose one relevant block and one next timing boundary. |
| Ended block plus an upcoming block | Upcoming block replaces the ended one for timing; do not keep an old missed plan forever when a replacement exists. |
| Only ended work block on unfinished task | Matrix remains Overdue as currently requested; no hard-deadline score. Show “Work block ended.” |
| Old recurring occurrence plus newer unfinished occurrences | Count actual eligible occurrences; preserve current recurrence grouping in task lists. Do not reinterpret a scheduled date as a deadline. |
| Date-only deadline on DST transition | Correct local day and next-day boundary; no fixed 24-hour substitution. |
| Browser changes timezone or device clock is wrong | Server snapshot controls evaluation. Existing stored timezone meaning does not change. |
| Large buffer target already passed | Can supply approaching boost, never fake a missed hard deadline. |
| Project review tomorrow but no deadline | Review visibility only; task remains undated absent other timing. |
| Blocker gets project urgency through a downstream task | Shows dependency and project provenance; no copied deadline field. |
| Critical undated donor plus Trivial overdue donor | Matrix shows both maxima; Recommended uses strongest whole donor, not a fabricated score of 9. |
| Hidden Someday donor influences visible Next prerequisite | Preserve existing matrix behavior and show source; Next-only filtering does not claim ranking parity. |
| Selected project has cross-project dependency | Hidden external-project donor still influences the selected task; all records must belong to the same account. |
| Completed/archived/skipped donor | No live influence. Undo/redo recomputes from the restored committed state. |
| Same graph reached by duplicate paths | Same priority as one path; no multiplicative urgency. |
| Deadlines filter selects a task whose Start by is more urgent | Keep coordinates, show Start by source; filter membership does not reinterpret urgency. |
| Filter leaves zero tasks | Correct zero grid and one recoverable empty state; no unrelated fallback list. |
| Cell has one, four, or hundreds of tasks | Same sheet behavior; Recommended before pagination; exact count matches all pages. |
| Switch from Recommended to Deadline on page two | New first-page snapshot, unchanged membership, no mixed-order continuation. |
| Deadline/importance sort with inherited project value | Row displays the value used; raw fields remain accessible and unchanged. |
| Search then change sort | Same matches, explicit new global order; relevance restored only by user/default rules. |
| Background refresh completes during edit/swipe | Keep draft/focus/scroll; defer movement, then replace coherently. |
| Multiple accounts reuse the same record/query IDs | No shared results, preference leakage, sources, or tokens. |
| Incorrect legacy/unsupported timing | Do not fabricate a deadline. Apply existing validation/recovery behavior and make malformed retained data diagnosable. |
| All tasks are Critical or many deadlines are impossible | Honest ordered view; no claim that the recommendation solves capacity or prioritization mistakes. |

## 13. Validation strategy and evidence required

### Policy checks

Create small named fixtures for the catalogue, with expected winners and matrix
positions written independently of the comparator. Compare current policy,
bounded urgency, and the +1 schedule alternative on the same inputs. Review all
changed outcomes, including regressions against the proposed expectations.

Check properties as well as examples: increasing a task's importance cannot
worsen its base rank; approaching a constraint cannot reduce its urgency band;
project changes cannot override an explicit task field; adding duplicate blocks
or dependency paths cannot stack score; visual filters cannot move a task's
coordinates; selected field sorts are global and deterministic.

Exercise both storage paths, full/exact reads, inherited sources, frozen
pagination, ordinary writes, retries, undo, and source deletion. Compare sum of
counts to all drilldown pages for every group/project/timing combination. Test
new sorts with ties, nulls, mixed workflow states, long titles, search, Review,
and concurrent project edits.

### UI verification

Write intended geometry and interaction states before changing components.
Check Chromium and WebKit at phone widths around 320/375/390/430 CSS pixels,
tablet widths, and wide desktop. Test both sides of any actual breakpoint,
website sidebar open/closed, inline/expanded widgets, and light/dark themes.
These are simulated layouts until physical-device checks are separately recorded.

Inspect screenshots of normal and long labels, Timing/Sort menus, selected
filters, one/many-task cells, and task/project source links. Assert grid centering
against the **content container**, never the viewport. Check keyboard focus,
touch targets, large counts, reduced motion, sheet entry/exit, background scroll
locking, and focus restoration. Preserve the existing regression coverage.

Use delayed/failing responses to prove that warm content does not blank, sorts
are not falsely labeled complete while pending, and project changes do not
combine fresh counts with stale rows. Verify launch and background bundles carry
the needed derived data without extra task-expansion reads.

### Performance and quality limits

Measure resolver/graph cost and serialized bytes on ordinary and large
disposable accounts. Compare account snapshot reuse with any focused-read
changes; inspect query plans before proposing indexes. Avoid an N+1 project
lookup. Confirm warm timing-scope changes use cached aggregates, Recommended
previews remain bounded, and sort changes make no duplicate MCP requests.

Use fixed evaluation times for deterministic comparisons. No synthetic
production records or live model tests are part of this design work. During
implementation, any live model evaluation still needs its own approval under
AGENTS.md. A mathematical score table is not evidence of model usability or
physical-device correctness.

## 14. Review decisions before implementation planning

| Decision | Recommended position | What would justify another choice |
| --- | --- | --- |
| Project deadline fallback | Committed tasks only; explicit task deadline wins | A clear use case requiring deliberate per-task opt-out, beyond the editor preview |
| Matrix plans versus constraints | Preserve constraints first; plans are fallback | Users primarily want a calendar-intent matrix, with a separately named lens |
| Urgency contribution | Maximum 3; no accumulated overdue age | Review rejects the explicit Normal-immediate/Critical-undated or Very-low-overdue/High-undated trade-offs |
| Scheduling strength | Tie-breaker, not an extra point or tier | Scenario evidence shows scheduled work is consistently buried despite comparable stakes |
| Dependency consistency | Preserve independent matrix axes and strongest-whole rank, with provenance | Exact grid-to-rank equivalence is more valuable than showing both independent maxima |
| Someday/Inbox dependency donors | Preserve current matrix behavior; no new project fallback | A separately approved change to make both dependency policies committed-only |
| Project importance | Explicit opt-in mode with retained fallback, or defer it | Avoiding the additional data-model/editor complexity takes priority for this release |
| Matrix Timing menu | Five simple membership views; no coordinate changes | Users need deadline-only coordinate recalculation, not just membership filtering |
| Sorting | Visible shared selector; honest effective defaults; distinct effective-field API modes | A surface has a genuinely non-task order, such as Activity or recurrence definitions |

After review, implementation planning should separate derived-policy changes
from any importance storage change, establish compatibility and rollback
requirements, and define staged acceptance. A release must preserve task
content/history/receipts, back up before deployment, invalidate incompatible
cursors, update help and tool guidance, and provide a rollback that cannot drop
newly written fields. No part of that rollout is performed by this document.
