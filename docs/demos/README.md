# Interactive demos

The website and scripted-chat demos run entirely in the visitor's browser. They use the same React application and widget components as GTD. All edits are temporary; reload or Reset demo restores the fixture.

## Intended behavior

- Start at November 6, 2026, 1:00 PM in America/New_York, independent of device date or timezone.
- Show Maya's fictional year, including history, archived work, recurring occurrences, plans, and dependencies.
- Support everyday task and project edits with version checks, atomic batches, history, and undo. Recurrence definitions are read-only. No sign-in or external integrations.
- Each chat has its own sandbox. Sending its prepared prompt runs once; switching conversations preserves edits and scroll. Reload resets every conversation.
- Match the inspected ChatGPT reference: a 768px conversation column, 16px system text with 26px message line height, purple user bubbles, dark card surfaces, responsive chat sidebar, and fixed composer. Keep GTD AI branding and omit unrelated account/model controls.
- Expanded widgets occupy a right-side viewer on desktop and the content area on phones, with a 52px host toolbar. Closing restores the inline widget and its state.
- Website and chat cards remain usable on phone and wide desktop, with sidebars open/closed, both themes, keyboard focus, touch, and reduced motion. Modal gestures must not scroll the background.

## Data provenance

Maya Rivera is a fictional software engineer in Queens, married to Daniel, with two school-age children, Lucia and Nico. She works from home on Mondays and Fridays, shares school pickups around Daniel's clinic shifts, and uses Friday reviews to keep work and family plans realistic. Her year includes release deadlines, holidays, household repairs, school logistics, library visits, sketches, and postponed hobby ideas.

The fixture is derived from the authored November 2025–November 2026 story and revised check-in calendar. Only fictional application records are published. Authentication, account bindings, server configuration, and operational records are excluded. New public identifiers preserve references without carrying production identity.

## Development

From `web/`, run `npm ci`, `npm run build:demos`, then `npm run demo:serve`. Open `/gtd-ai/website/` or `/gtd-ai/chat/` on the printed local address. `npm run test:demos` checks the local data contracts; `npm run test:demos:browser` checks the published artifact with disposable browser state.

The separate Pages build shares assets across both demos. Production builds do not include the fixture or browser-local data service. GitHub Actions publishes only after deterministic checks succeed. No model calls are part of the build or tests.
