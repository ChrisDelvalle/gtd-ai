# Frontend verification

See [development](../docs/development.md) for setup and deterministic test commands.
`node scripts/test-browser.mjs` runs the suite with an isolated loopback fixture;
set `GTD_TEST_BROWSER=webkit` for WebKit. Tests verify the fixture identity before
writing. They do not connect to a deployed website or invoke an assistant.

For visible changes, follow [AGENTS.md](../AGENTS.md): state the intended outcome,
cover phone/wide layouts, sidebar states, themes and embedded/expanded widgets,
and inspect representative screenshots. Assert alignment relative to the actual
content pane. A numerical DOM check alone is not sufficient visual review.

Actual ChatGPT/Claude and physical-device checks are recorded separately from
browser simulations. Every live model run needs approval for that exact run.
