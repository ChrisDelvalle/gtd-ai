# Priority release implementation

Approved scope: project **deadline** fallback, bounded urgency, strongest-whole
dependency ranking, matrix timing filters, visible sorting, and Planned today.
Project importance is deferred. PostgreSQL compatibility remains 13.

## Intended behavior

- Resolve project deadlines before dependency inheritance, without rewriting tasks.
- Matrix axes inherit independently; Recommended inherits one whole semantic key.
- Sorting is global before pagination, deterministic, and honestly labeled.
- Counts, cell lists, and reasons retain their frozen snapshot.
- Warm views and expanded task details remain usable while refreshing.
- Controls fit phone, sidebar, inline-widget, and expanded-widget containers.
- Keep existing grid alignment, colors, sheet motion, and scroll locking.

## Checkpoints

- [x] Shared resolver, complete comparator, adversarial policy tests.
- [x] PostgreSQL/SQLite reads, query contracts, cursor invalidation, isolation.
- [x] Matrix timing membership and sorted drilldowns.
- [x] Shared controls, source explanations, derived freshness, Planned today.
- [x] Static demo parity and documentation.
- [x] Deterministic suites, screenshots, performance comparison.
- [x] Guarded staging and rollback rehearsal.
- [x] Verified backup, production deployment and read-only verification.
- [x] Published demos, discovery refresh, staging stopped, acceptance report.

Released November 10, 2026, after the
[complete CI run](https://github.com/ChrisDelvalle/gtd-ai/actions/runs/42822654513)
passed. Chromium: 385 passed; WebKit: 384 passed; demo browser tests: 114 passed.
The suites retain 11 opt-in measurement/screenshot skips; WebKit also skips the
Chromium-native touch test.
Production health, immutable assets, authenticated profile and Charts launch
were verified. Existing ChatGPT and Claude tool discovery was refreshed, and
both published demos were checked. Staging is stopped.

No model evaluations are included. Physical-device and actual-host checks must
be distinguished from deterministic browser coverage. Private deployment details
and evidence stay outside this repository.

See the [acceptance report](priority-release-acceptance.md) for coverage,
performance measurements and verification limits.
