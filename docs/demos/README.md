# Interactive demos

The website and scripted-chat demos run entirely in the visitor's browser. They use the same React application and widget components as GTD. All edits are temporary; reload or Reset demo restores the fixture.

## Intended behavior

- Start at November 6, 2026, 1:00 PM in America/New_York, independent of device date or timezone.
- Show Maya's fictional year, including history, archived work, recurring occurrences, plans, and dependencies.
- Support everyday task and project edits with version checks, atomic batches, history, and undo. Recurrence definitions are read-only. No sign-in or external integrations.
- Each chat has its own sandbox. Sending its prepared prompt runs once; switching conversations preserves edits and scroll. Reload resets every conversation.
- Match the inspected ChatGPT reference: a 768px conversation column, 16px system text with 26px message line height, purple user bubbles, dark card surfaces, responsive chat sidebar, and fixed composer. Keep GTD AI branding and omit unrelated account/model controls.
- Expanded widgets occupy a resizable right-side viewer on desktop and the content area on phones, with a 53px host toolbar. The inline card leaves the conversation flow while expanded. Closing restores its position, state, and keyboard focus.
- Both demos default to the system light/dark setting and follow it until the visitor uses the theme toggle. Reload or Reset demo clears that override. Chat widgets follow the chat theme.
- Website and chat cards remain usable on phone and wide desktop, with sidebars open/closed, both themes, keyboard focus, touch, and reduced motion. Modal gestures must not scroll the background.

## Data provenance

Maya Rivera is a fictional software engineer in Queens, married to Daniel, with two school-age children, Lucia and Nico. She works from home on Mondays and Fridays, shares school pickups around Daniel's clinic shifts, and uses Friday reviews to keep work and family plans realistic. Her year includes release deadlines, holidays, household repairs, school logistics, library visits, sketches, and postponed hobby ideas.

The fixture is derived from the authored November 2025–November 2026 story and revised check-in calendar. Only fictional application records are published. Authentication, account bindings, server configuration, and operational records are excluded. New public identifiers preserve references without carrying production identity.

## Development

From `web/`, run `npm ci`, `npm run build:demos`, then `npm run demo:serve`. Open `/gtd-ai/website/` or `/gtd-ai/chat/` on the printed local address. `npm run test:demos` checks the local data contracts; `npm run test:demos:browser` checks the published artifact with disposable browser state.

The separate Pages build shares assets across both demos. Production builds do not include the fixture or browser-local data service. GitHub Actions publishes only after deterministic checks succeed. No model calls are part of the build or tests.

## Updating the examples

Edit the reviewed JSON parts listed in `web/demo/maya/manifest.json`; keep task, project, occurrence, and history references consistent. The public fixture has 1,082 tasks, 11 projects, four recurring definitions, and 1,303 changes. Eight ordinary household actions have an explicit Home location so the low-energy example can filter on context. Keep fictional names and identifiers; do not export a personal account or copy operational files into this directory.

The four prepared exchanges are in `web/src/demo/scenarios.ts`: priorities before pickup, a loose capture of three tasks, email action items, and low-energy tasks at home. The capture and inbox examples save idempotent batch receipts; their replies say what was recorded without claiming to contact anyone. The inbox sources are authored alongside the scenario in `web/src/demo/inbox.tsx`: two emails require replies, while a library newsletter does not create a task. Deadlines reflect when the response is needed, rather than when the event happens.

Cards appear before the assistant reply, which streams with brief paragraphs, lists, and bold emphasis. Reduced-motion preferences show the completed result immediately. The composer keeps only the prepared message and send control; the host-level demo indicator and reset remain available. The chat host owns one `DemoStore` per conversation. The priorities example shows both the chart and its two recommended tasks in separate widgets; both use that same store and refresh each other after edits or undo. Frame messages are checked against their registered window, conversation, card, and origin. Each viewer slides in from the right and slides out before returning focus to its original inline card. Records and edits are held in memory, not persisted. The local search supports words and structured filters, without the production search service's typo tolerance. Recurring definitions and external actions return a demo limitation.

Regenerate the reference in a disposable database after deliberately changing the fixture or domain behavior:

```sh
TODO_ENVIRONMENT=test TODO_BENCHMARK_NOW=2026-11-06T18:00:00Z \
  cargo run --locked --features benchmark-clock --example demo_reference > /tmp/demo-reference.json
node web/demo/check-reference.mjs /tmp/demo-reference.json
```

The example creates its own temporary SQLite database and refuses to run without the fixed test environment. It compares every initial ranking and history classification, all status pages, and both activity measures against Rust. Review intentional changes before replacing `web/demo/reference.json`; do not update expected output just to silence a failure.

## Publication

The `demos` job builds the artifact from committed source and checks the data contracts, packaging, and Chromium/WebKit interactions. The `publish-demos` job waits for every deterministic CI job, then publishes through the `github-pages` environment on `main`. Pull requests cannot publish. The artifact contains only the static demos and their shared assets; no production deployment commands or credentials are involved.

Browser tests assert that runtime requests remain GETs to the static site. A restrictive Content Security Policy provides a second boundary. External task links are disabled. The production asset dependency graph is tested separately to keep demo data and transport out of normal releases.

## Acceptance record

The initial November 10, 2026 publication passed these checks:

| Area | Evidence |
|---|---|
| Data parity | All 1,097 record rankings and 1,303 history classifications match the disposable Rust reference. Status-page ordering and daily activity/completion totals also match. |
| Local behavior | 16 contract and packaging tests cover queries, pagination, frozen snapshots, edits, atomic batches, retry receipts, dependencies, coupled undo, scripts, and production-bundle separation. |
| Browser behavior | 28 Chromium/WebKit checks cover 390–1440px layouts, both themes, navigation, chart overlays, local edits, reset, all three conversations, expansion, focus restoration, and failed fixture loading. |
| Time | Initial priority counts remain identical in New York and Tokyo with the browser clock moved to 2035. The application date remains November 6, 2026. |
| Touch | Additional touch-enabled phone checks pass for list dismissal, background scroll locking, expansion/return, and the conversation drawer in both engines. These are emulated phones, not physical-device checks. |
| Packaging | A clean clone builds using committed source and newly installed dependencies. License notices and source-revision metadata are included; the production build excludes demo code and data. |
| Privacy | The fixture uses fictional identifiers and content. Repository/history secret scanning passed; runtime checks permit only static asset reads. |
| Visual review | Website, inline/expanded chat, and overlay screenshots were inspected. Expanded views were compared with the live reference at matching sizes. The Results styling regression check fails on the previous build and passes on the candidate. |
| CI | [Run 42759868768](https://github.com/ChrisDelvalle/gtd-ai/actions/runs/42759868768) passed source, PostgreSQL, adapter, both existing browser suites, dependency/security, installation/recovery, demo, and Pages jobs. |
| Published artifact | Both public URLs return the reviewed build, revision `db02bfd100716803292125e42c1866137bc4f2ff`. All 28 browser checks passed again against GitHub Pages, including hash navigation, reset, asset loading, and static-only network requests. |

No live model prompts were sent. The chat sequence is local and scripted; inspecting the live host for styling does not constitute host integration testing. Physical-device verification remains outstanding.

Published demos: [website](https://chrisdelvalle.github.io/gtd-ai/website/) · [chat](https://chrisdelvalle.github.io/gtd-ai/chat/). The existing production application, accounts, databases, and connector registrations were not changed.

### Chat presentation follow-up

The follow-up adds a fourth conversation for email action items, streamed Markdown replies, measured composer/sidebar typography, and two linked cards in the priorities conversation. A short working/opening sequence precedes the cards, followed by the reply. The viewer slides in and out from the right without remounting its card; desktop visitors can resize the split or enter full view. The low-energy card shows both recommendations from the reply on its first page.

The expanded verification matrix contains 18 data/packaging checks and 74 Chromium/WebKit cases. It covers cross-card completion/undo, email sources, clipboard controls, reduced motion, keyboard and pointer resizing, focus restoration, and both sides of the 800px and 1000px layout breakpoints. Additional sizes reach from 360px phones to 1920px desktops. The visual findings and intentional host differences are recorded in [design verification](../../design-qa.md).

Published November 10, 2026 at revision `dd49c211d2bf0ad132ff059a0ac930b9ab135557`. [CI run 42771159671](https://github.com/ChrisDelvalle/gtd-ai/actions/runs/42771159671) passed every gate, including both full application browser suites, source/PostgreSQL checks, dependency/security checks, fresh installation/recovery, and Pages publication. All 74 demo browser cases then passed against the public URLs. The public build metadata confirms the reviewed revision and fixed logical time. No production deployment or live model prompt was involved.
