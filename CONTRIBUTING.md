# Contributing

Start with the [development guide](docs/development.md) and [AGENTS.md](AGENTS.md).
Discuss substantial behavior or storage changes in an issue before implementing
them. Small focused fixes are welcome.

Use a branch and a focused pull request. Explain the problem, resulting behavior,
and relevant validation. Include disposable-data screenshots for visible changes,
covering the layout conditions that affect the result. Do not attach personal task
data, identity dumps, credentials, or logs containing user content.

Preserve complete agent context, account isolation, optimistic versions, retry
receipts, immutable history, and undo. Schema changes need compatibility checks
and a tested migration/recovery path. Keep website and widget behavior coherent.

Run the relevant deterministic checks before submitting. Live model tests require
separate explicit approval and are never dependencies of CI or ordinary tests.
Do not use a production account for fixtures.

Contributions are offered under AGPL-3.0-only. Retain third-party attribution and
identify imported code or assets and their licenses. Do not submit code you do
not have permission to license.
