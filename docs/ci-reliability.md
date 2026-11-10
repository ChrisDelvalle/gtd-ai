# Browser test reliability

## Review scope

Reviewed the latest 30 workflow runs on November 10, 2026, including the failed
job logs rather than treating every red workflow as an intermittent failure.
Cancelled runs are not failures. A later green run does not close an unexplained
failure.

| Failure family | Finding and disposition |
| --- | --- |
| Wrapped headers, capture position, Review offsets | Real layout defects caught consistently in both engines. Fixed in `6f79e3a`; retain the geometry assertions. |
| Widget navigation during host resize | The menu became interactive before its host supplied the reserved height. `4a54389` gates it on actual host geometry and tests delayed resize delivery. |
| Lazy recurrence overview | The Markdown placeholder collapsed between pointer-down and pointer-up. `d84a807` waits for the fixture's loaded notes before targeting controls below it. |
| Touch pagination after scrolling | Run `42915864506` missed Load more after an implicit scroll-to-button and immediate tap. The test now waits for sheet entry, explicitly reveals the footer, waits for scroll completion and paint, then sends one native tap. Page counts, one-call and background-scroll assertions remain unchanged. |
| Task save/undo assertions | Earlier checks read authoritative state before the acknowledgement. Current tests wait for the response or poll the saved record. |
| Fixture selection and initial layout | Current tests target their own task/project and wait for the selected-task toolbar and accepted host size. Shared disposable data must not determine which row a test acts on. |
| WebKit document scroll | The Linux automated wheel path did not scroll even before opening the modal. The test uses supported keyboard input for document-scroll release, while retaining native Chromium touch coverage. |
| Demo result counts after adding sort controls | The new toolbar changed narrow-card capacity. The compact header was corrected; the two-result assertion remains in place. |

## Guardrails

- No test retries; flaky outcomes fail CI even if a future test overrides the
  default retry count. CI rejects focused tests.
- Keep JSON results on both pass and failure for 30 days, and failure traces and
  screenshots for seven days. Artifact names include the workflow attempt so a
  manual rerun cannot overwrite the original evidence.
- Wait for the condition the interaction needs: content, acknowledgement,
  geometry, animation completion or scroll completion. Keep tests for actions
  during delayed loads separate so waiting in setup does not hide a product bug.
- Fixed delays remain appropriate for sampled animations, gesture velocity and
  bounded negative assertions. They are not substitutes for readiness checks.
- Repeat affected scenarios in both engines, then run the complete suite.
  Preserve real taps, version checks and result assertions; do not force actions.
- Keep the single-worker application suites until their shared database fixtures
  are independently scoped. Engine jobs already run in parallel.

This review covers observed failures and related patterns, not a claim that
future timing defects are impossible. A new intermittent failure blocks release
until its cause and verification are recorded.

The original touch failure did not reproduce in 12 macOS Chromium and 20 Linux
Chromium runs with event tracing. Those passes are not proof of a fix. The trace
identified the unsynchronized scroll/tap boundary; candidate repetitions and the
complete CI run are required before promotion.

The corrected touch scenario passed 20 Linux Chromium repetitions and ten WebKit
repetitions. Related navigation, recurrence, editing, expansion and timezone
scenarios passed 60 repetitions in each engine, with no retries. CI report files
use explicit paths and are checked separately from the test exit status.

[Full CI run 42919867454](https://github.com/ChrisDelvalle/gtd-ai/actions/runs/42919867454)
passed on its first attempt: 400 Chromium and 399 WebKit tests, plus source,
dependency/security, installation and demo checks. Browser JSON artifacts were
verified. A follow-up corrects the demo JSON output path and makes missing result
artifacts an error; that path was independently verified with a demo browser test.
