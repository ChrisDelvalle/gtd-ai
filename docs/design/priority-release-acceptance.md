# Priority policy release acceptance

Implementation: `6f79e3a5e27a8810bfaae70485af5a278f74a494`, November 10, 2026.
The final test correction is `089259a`; it changes only the native-touch
pagination sequence, with no application or asset changes.
The [design](task-priority-and-project-fallbacks.md) records the decisions and
counterexamples; the [user guide](../user-guide.md#priority-and-ordering) describes
the shipped controls and behavior.

## Scope

Eligible tasks borrow an active project's deadline only when their own deadline
is absent. No task fields are rewritten. Project importance is deferred.
Recommended uses bounded urgency and complete deterministic tie-breakers, and
inherits the strongest whole recommendation through dependencies. The matrix
continues to inherit its two axes independently. Timing filters change membership,
not coordinates. Task and cell lists expose their actual sort order; Planned
today uses the account's calendar day.

Database compatibility remains 13. Derived policy/cache signatures advance to
`priority-v4`; incompatible frozen cursors require a fresh snapshot. Authoritative
records, history and retry receipts keep their existing formats.

## Deterministic verification

| Area | Evidence |
| --- | --- |
| Policy | Explicit-task precedence, project eligibility, Start by fulfillment, bounded urgency, buffers, work blocks, DST, transitive dependencies, independent matrix axes, whole-key ranking, started/age/ID tie-breakers |
| Storage | Rust domain tests and PostgreSQL runtime-role tests; optimized SQLite sorts compared with full-snapshot reference results; frozen pagination and account isolation |
| Client | Adapter and client suites, demo/Rust comparison, mutation recovery, launch bundles and derived freshness |
| Interface | Chromium and WebKit; narrow and wide task lists, visible sorts, filtered matrix counts and cell lists, pending/failing reads, source links, sidebar and embedded/expanded states |
| Regression checks | Explicit searches replace unrelated warm rows promptly; expired chart snapshots recover once; wrapped toolbars do not overlap pinned task headers or capture forms; Review retains its page-level offset; hidden controls remain hidden; touch paging and dismissal use a continuous touch sequence |
| Inspection | Representative phone, desktop, expanded-widget and scrolled-card screenshots inspected; grid placement measured against its content pane |
| Hosted staging | Two disposable accounts, OAuth refresh, wrong-audience and spoofed-source denial, identity pins, project-deadline propagation, chart snapshot isolation, launch metadata and background bundles |

The complete hosted CI run and release status are recorded in the
[implementation checklist](priority-release-checklist.md). Tests use disposable
fixtures. No model prompts or synthetic production records are part of acceptance.

## Performance

Measurements use local debug binaries and a disposable PostgreSQL container
limited to one CPU and 1 GiB. They include storage, rules, projections and JSON
serialization, but exclude OAuth, HTTP, internet latency, host processing and
rendering. These are regression measurements, not claims about ChatGPT latency.

Thirty launch sessions on an account with 179 tasks:

| Path | Baseline p50 / p95 | Candidate p50 / p95 | Response bytes, baseline → candidate |
| --- | ---: | ---: | ---: |
| Requested Home | 25.6 / 29.1 ms | 28.2 / 30.9 ms | 50,110 → 50,680 |
| Full launch bundle | 97.2 / 116.5 ms | 107.7 / 116.1 ms | 325,706 → 358,575 |
| Deferred background bundle | 95.1 / 104.9 ms | 105.3 / 114.1 ms | — |

An eight-operation workflow covers Home, Next, task details, edit, capture,
clarification, completion and Home after writing. The final sequential run, with
other local test workloads stopped, produced:

| Profile | Flows | Baseline p50 / p95 | Candidate p50 / p95 |
| --- | ---: | ---: | ---: |
| SQLite, one session | 24 | 104.2 / 107.5 ms | 115.0 / 118.2 ms |
| PostgreSQL, one account/session | 24 | 169.0 / 177.0 ms | 177.8 / 183.9 ms |
| PostgreSQL, three accounts/sessions | 24 | 184.5 / 200.1 ms | 197.5 / 205.9 ms |
| PostgreSQL, 100 accounts/ten sessions | 200 | 409.9 / 461.8 ms | 407.4 / 461.5 ms |

Earlier stress runs varied substantially when browser and container work overlapped
the benchmark, so they are not treated as evidence of an improvement. The isolated
comparison shows the expected small cost of additional derived facts, with no
regression exceeding the greater of 10% or 20 ms. No new index was added. Existing
exact-read index behavior was also exercised on accounts with up to 2,500 tasks,
including an add/remove comparison in a disposable database.

## Release and rollback

Released to production on November 10, 2026, using the same immutable service
and adapter images accepted in staging, with their versioned website and widget
assets. The coordinated application/identity backup captured at 13:23 UTC passed
independent laptop restoration before activation. Prior images and configuration
remain available. A staging rollback rehearsal verified that the previous
application can read changes made by the new release without restoring an older
database or discarding intervening writes.

Production verification passed for health, discovery, ingress restrictions, the
new read contract, exact website/widget asset identities, the authenticated
profile, and a read-only Charts launch. Existing ChatGPT and Claude discovery
was refreshed without replacing connections or changing permissions. The
published website and chat demos expose the new timing and sort controls.
Staging is stopped.

## Unverified observations

Phone layouts are browser simulations, not physical-device checks. This release
has no new ChatGPT/Claude model evaluation or actual-host visual timing run.
Protocol checks and widget harnesses do not establish host rendering parity.
The ranking policy is deterministic and scenario-tested, not a guarantee that it
can infer every user's priorities or solve an impossible schedule.
