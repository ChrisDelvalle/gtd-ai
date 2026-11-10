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

- [ ] Shared resolver, complete comparator, adversarial policy tests.
- [ ] PostgreSQL/SQLite reads, query contracts, cursor invalidation, isolation.
- [ ] Matrix timing membership and sorted drilldowns.
- [ ] Shared controls, source explanations, derived freshness, Planned today.
- [ ] Static demo parity and documentation.
- [ ] Deterministic suites, screenshots, performance comparison.
- [ ] Guarded staging and rollback rehearsal.
- [ ] Verified backup, production deployment and read-only verification.
- [ ] Published demos, discovery refresh, staging stopped, acceptance report.

No model evaluations are included. Physical-device and actual-host checks must
be distinguished from deterministic browser coverage. Private deployment details
and evidence stay outside this repository.
