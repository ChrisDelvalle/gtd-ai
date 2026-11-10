import { useEffect, useRef } from "react";
import { sourceInfo } from "./source-info";

export function Help({embedded = false}: {embedded?: boolean}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });

  }, []);
  return (
    <article className="help-page" aria-labelledby="help-title">
      <h1 id="help-title" ref={heading} tabIndex={-1}>
        Getting things done
      </h1>
      <section aria-labelledby="help-start">
        <h2 id="help-start">Start small</h2>
        <p>
          Add one thing to Inbox. Decide its next concrete step, move it to Next
          actions, and check it off when it’s done.
        </p>
      </section>
      <section aria-labelledby="help-context">
        <h2 id="help-context">Keep useful details close</h2>
        <p>
          Use Add detail while editing to attach labeled links or a
          place/address. Expand a task to open its resources or location in
          Google Maps. Descriptions hold instructions; due dates are deadlines,
          not appointments.
        </p>
        <p>
          Briefs explain what to do. Notes hold supporting detail. Agent notes
          hold working context for ChatGPT, such as decisions and uncertainties.
          Open Agent notes from the … menu to read or edit them; they stay out
          of ordinary task details.
        </p>
        <p>
          Descriptions support lightweight Markdown: headings, bold, italics,
          lists, links, quotes, and code. For example, use{" "}
          <code>## Preparation</code> for a heading or{" "}
          <code>- Bring your ID</code> for a list item. HTML stays plain text;
          images are not loaded.
        </p>
      </section>
      <section aria-labelledby="help-projects">
        <h2 id="help-projects">Projects, dates and results</h2>
        <p>
          A project is an outcome that needs more than one action. Create it in
          Projects, then add its next action and blocked steps. Tasks can belong
          to one project or stand alone. Completing a project asks you what to
          do with its unfinished tasks.
        </p>
        <p>
          A deadline is when something must be done. Review on is when to
          reconsider it; Review gathers items due for attention. Work sessions
          link to your calendar. These details are optional and never move a
          task to Someday automatically.
        </p>
        <p>
          After completion, you can add a short result explaining what was
          resolved. Reopening clears the current result; History keeps it.
        </p>
      </section>
      <section aria-labelledby="help-planning">
        <h2 id="help-planning">Importance and timing</h2>
        <p>
          Importance describes what matters to you, independently of urgency.
          Every task has an importance; Normal is the default.
          Critical is for exceptional stakes. Low importance can still be a commitment.
        </p>
        <p>
          Timing in the editor adds an optional deadline time, Start by, or one
          planned block. Start by is the latest intended start; a block is when
          you intend to work. Moving it leaves the deadline unchanged. Review on
          is for reconsidering the plan. Ready work can stay Next when scheduled later.
        </p>
        <p>
          Dates without times keep their whole-day meaning. Times use the saved
          timezone, initially America/New_York. Mark started in the task menu
          confirms progress and stops Start by affecting recommendations.
          Starting does not complete the task.
        </p>
      </section>
      <section aria-labelledby="help-method">
        <h2 id="help-method">The five steps</h2>
        <ol className="help-steps">
          <li>
            <strong>Capture.</strong> Put ideas, tasks and loose ends in Inbox.
          </li>
          <li>
            <strong>Clarify.</strong> Decide what each item needs. Write an
            action you can actually do: “Email Sam for a quote,” for example. A
            project needs several actions; note the outcome and identify the
            next one.
          </li>
          <li>
            <strong>Organize.</strong> Move ready work to Next actions, blocked
            work to Waiting, committed steps with prerequisites or manual holds to Blocked, and possibilities
            without a current commitment to Someday.
          </li>
          <li>
            <strong>Reflect.</strong> Review weekly: clear Inbox, check Waiting,
            and make sure each ongoing project has a next action.
          </li>
          <li>
            <strong>Engage.</strong> Choose an action that fits your situation,
            available time, energy and priorities.
          </li>
        </ol>
      </section>
      <details className="help-topic" open>
        <summary>What the lists mean</summary>
        <dl className="help-lists">
          <div>
            <dt>Home</dt>
            <dd>
              The highest-ranked ready task, followed by Next, Review, Waiting
              and Someday previews. Empty sections stay hidden. Collapse a
              section or use View all to open its full list.
            </dd>
          </div>
          <div>
            <dt>Next actions</dt>
            <dd>Concrete steps ready to do.</dd>
          </div>
          <div>
            <dt>Inbox</dt>
            <dd>Captured items you still need to clarify.</dd>
          </div>
          <div>
            <dt>Waiting</dt>
            <dd>Work blocked by someone else or an external event.</dd>
          </div>
          <div>
            <dt>Blocked</dt>
            <dd>Committed steps that are not ready to do yet.</dd>
          </div>
          <div>
            <dt>Someday</dt>
            <dd>Possibilities without a current commitment.</dd>
          </div>
          <div>
            <dt>Done</dt>
            <dd>Completed tasks.</dd>
          </div>
          <div>
            <dt>Archive</dt>
            <dd>
              Items set aside, done or unfinished. Completing one keeps it here;
              Unarchive returns it to its normal list.
            </dd>
          </div>
          <div>
            <dt>All tasks</dt>
            <dd>
              Every workflow status, including Done. Use filters to exclude statuses
              or include archived items; archived items start hidden.
            </dd>
          </div>
        </dl>
      </details>
      <details className="help-topic">
        <summary>Editing, search and undo</summary>
        <ul>
          <li>
            Click a task’s title to expand or collapse its information. Choose
            Edit in the … menu to open the side panel. Use the circle to
            complete or reopen a task.
          </li>
          <li>
            Search matches up to ten words across titles, notes, links,
            locations and completion results, including accents and common
            typos. It keeps every query term and ranks relevant titles first.
            Search stays within the current view. Choose All tasks for a wider
            search; use filters to narrow by due date.
          </li>
          <li>
            Recommended keeps Next actions first in combined lists. Within each status,
            importance combines with a bounded boost for deadlines and outstanding Start by.
            Planned work and started tasks break comparable ties. A task without its own
            deadline can use its active project’s deadline; Inbox and Someday do not.
          </li>
          <li>
            History shows changes to one task; Activity shows changes across all
            tasks. Undo reverses a change when no newer edit conflicts.
          </li>
          <li>
            Controls update immediately while saving. A red icon means a change
            needs attention; click it for recovery options. Keep the page open
            until an uncertain save is resolved.
          </li>
        </ul>
      </details>
      <details className="help-topic">
        <summary>Repeating tasks</summary>
        <p>
          Open a task’s editor and choose Repeat. Preview the upcoming dates,
          then save. Use Repeating in the sidebar to manage a series, including
          ones that haven’t started yet.
        </p>
        <p>
          Each occurrence has its own scheduled date and completion result.
          Missed tasks remain unfinished; completing one late doesn’t move the
          schedule. Skip an occurrence when no work is needed. Pause stops new
          occurrences until resumed. End repetition stops future dates while
          keeping outstanding tasks.
        </p>
        <p>
          Ordinary edits affect that task only. Repeat settings let you choose
          this and following, or the entire series. Completed history and
          individual changes are preserved. Undo reverses the whole scoped
          change when none of its affected records has newer edits.
        </p>
      </details>
      <details className="help-topic">
        <summary>Using ChatGPT</summary>
        <p>
          Use the GTD plugin to capture, organize or review the same tasks. Try
          “Show my next actions,” “What’s due this weekend?” or “Help me process
          my inbox.” Marking a task done records completion; it doesn’t perform
          the work itself.
        </p>
      </details>
      {!embedded && <><details className="help-topic">
        <summary>On your phone</summary>
        <p>
          Tap + to capture a task. Close the composer to keep an unfinished
          title for later while the page stays open. Pull down from the top of a
          list to refresh. Swipe right from the left edge to open navigation, or
          left across the drawer to close it. The menu button works too.
        </p>
        <p>
          In Safari, use Share → Add to Home Screen to open GTD like an app.
          Tailscale must stay connected outside your home network.
        </p>
      </details>
      <details className="help-topic">
        <summary>About this website</summary>
        <p>
          Lists refresh automatically while the page is visible. Appearance
          follows your device’s light or dark setting. The gear menu contains Activity, logs
          and service health.
        </p>
      </details></>}
      {embedded && <details className="help-topic"><summary>Using this card</summary><p>Use the view menu to move between lists, projects and review. Choose Add task to capture an idea. Expand for longer content or editing; close the expanded view to return to the conversation. Drafts stay available while the card remains open.</p><p>Refresh reloads the current view. Returning to the app and saving a change also refresh relevant data.</p></details>}
      <p className="help-source">
        <a href={sourceInfo.url} target="_blank" rel="noreferrer">Source code</a>
        {" · "}<a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">AGPL-3.0-only</a>
        {sourceInfo.revision !== "development" && <> · {sourceInfo.revision.slice(0, 7)}</>}
      </p>
      <p className="help-source">
        More on the method:{" "}
        <a
          href="https://gettingthingsdone.com/what-is-gtd/"
          target="_blank"
          rel="noreferrer"
        >
          David Allen’s GTD guide
        </a>
        .
      </p>
    </article>
  );
}
