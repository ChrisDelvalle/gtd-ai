# Working on GTD

The product goal is a trustworthy GTD system that removes maintenance effort from
the user. Keep implementation and agent guidance practical, concise, and grounded
in supported behavior. Preserve the shared website/widget design.

## Interface copy

Do not add explanatory page subtitles or introductions below page headings.
Default to omitting them; ask the user before adding one. Keep interface copy
concise. Hide empty sections when other content is available; use a single
empty state when an entire page has no content. Preserve necessary errors and
instructions that help the user complete a specific action.

Avoid hover highlighting; preserve keyboard focus indicators and selected states.
Use browser reload or mobile pull-to-refresh for routine website refreshes,
rather than adding page refresh buttons. Keep explicit error-recovery controls.

## UI verification

Before deploying a visible change, write down the intended behavior and check
the affected surfaces with disposable data. Cover the layouts and states that
can change the result, such as phone and wide desktop, both sides of relevant
breakpoints, sidebars or panels, and embedded and expanded widget modes.
Assert the rendered outcome against its intended reference, such as the
content pane or an adjacent control. Inspect representative screenshots for
layout changes. For a reported regression, confirm the new check fails on the
previous build when feasible, then run it on the candidate before promotion.

## Live model tests

Every live model test and rerun requires explicit user approval for its model,
settings, scenarios, and limits. Implementation approval does not authorize model
testing. This includes Codex-based evaluations and prompts submitted to ChatGPT
for acceptance testing. Approval covers only the described run.

Never start model evaluations from CI, deployments, ordinary test commands, or
automatic retries. Default to one targeted scenario. Use the lowest-usage
available subscription model with minimal supported reasoning. Never silently
substitute a more expensive model, use paid API access, or expand the approved
scope. Report actual usage and distinguish enforceable limits from estimates.

Use disposable GTD data and isolated agent configuration without personal
memories or production access. Define expected outcomes before the run and keep
them out of the test agent's prompt. Ordinary deterministic tests and browser
interaction tests that do not invoke a model do not require this extra approval.

## Data and releases

Never create synthetic records in production. Use independent guarded staging for
unreleased features, migrations, destructive checks, and load tests; do not switch
production into test mode. Test utilities must verify both the environment and
its immutable account identity and must not hold personal-account credentials.
Retain retry/version protections, audit history, undo, and database
compatibility guards. Back up production before migration or deployment; a
rollback must preserve or explicitly reconcile subsequent writes.
