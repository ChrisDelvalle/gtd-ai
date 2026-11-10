# Compact deadline labels

## Intended behavior

Task rows on Home, task lists and widgets show `Jun 30` for the account's
current calendar year and `Jun 30, 2028` for any other year. Keep the exact day;
neither older overdue dates nor distant future dates should be ambiguous.
Use the application clock so the public demos remain deterministic.

An unfinished, live task whose deadline has passed uses the deadline accent
and a small alert icon in place of the calendar icon. Completed, archived,
deleted and skipped tasks retain neutral dates. Accessible descriptions and
tooltips include the full date and overdue state. Inherited project deadlines
keep their Project attribution and follow the same rules.

Timed deadlines use their stored timezone and offset. Date-only deadlines are
overdue after their local day ends, using the existing server semantics (legacy
task date-only deadlines use America/New_York). The account timezone determines
the current year for display; the browser timezone does not override it.
Visible labels update at deadline/year boundaries and on return to visibility
without a server read.

Keep the existing compact text size. Narrow rows omit time and icons first,
and may put the year on a second line. Never hide the entire deadline just
because the widget is narrow. Titles, completion controls and menus must remain
usable; row elements remain vertically centered.

## Verification and release

- Reproduce the missing-year regression against the previous build.
- Check current/past/future years, timed and date-only boundaries, DST offsets,
  account/browser timezone differences, project fallback and non-live tasks.
- Check Home and task lists, phone and wide desktop, sidebar states, inline and
  expanded widgets, both themes and the narrow-row breakpoints. Inspect screenshots
  and assert that labels stay inside their row without overlapping controls.
- Run the relevant deterministic suites and CI. Exercise the immutable candidate
  in guarded staging, preserve rollback and back up before deployment.
- Keep production data unchanged and record physical-device/actual-host checks
  separately from browser simulations. No live model prompts are required.

## Acceptance evidence

The application implementation is `aec2bcf`. The previous build failed the
different-year regression: all three June 30 deadlines displayed the same label.

- Fifteen focused Chromium checks passed. Thirty WebKit checks passed, including
  Home, project fallback and existing planning/editing interactions.
- Screenshots inspected at 320, 390, 480, 1280 and 1440 pixels cover phone and
  desktop, both themes, Home/Next, and inline/expanded widgets. Geometry assertions
  check label containment, neighboring controls and the featured row's centerline.
- Deadline and account-year boundaries update without reads. A device timezone
  different from the account, repeated DST hour offsets, inherited project dates,
  skipped occurrences, completed/archived tasks and hidden deleted rows are covered.
- Hosted staging passed two-account OAuth refresh, audience/source rejection,
  account isolation, launch/bundle checks and served-asset verification. Staging
  shuts down after verification. Deployment receipts and image pins remain private.
- The existing recurrence test helper now waits for the lazy Markdown body before
  clicking controls below it. A previous WebKit trace showed the body replacing a
  taller placeholder during the click. The conflicted-draft scenario passed twelve
  consecutive runs after this correction; no assertions or retries were relaxed.

Full CI and the production backup/rollback gates still apply before promotion.
No live model tests or physical-device checks are included in these results.
