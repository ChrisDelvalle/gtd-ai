# Release readiness

Prepared privately on November 9, 2026. Public publication and production
installation remain separate decisions. The initial history contains reviewed
source, not the former operational workspace or release archives.

## Acceptance record

| Check | Result |
| --- | --- |
| Locked Rust build, formatting, strict Clippy, deterministic domain tests | Passed locally and in Linux CI |
| PostgreSQL runtime-role isolation, RLS, concurrent writes, receipts, history, sessions and activity reads | Passed |
| JavaScript client and adapter tests | 55 client checks and 8 adapter checks passed |
| Complete Chromium suite | 379 passed; 11 expected skips |
| Complete WebKit suite | 378 passed; 12 expected skips |
| Fresh private GitHub clone | Dependency installation and frontend build passed with committed files only |
| Source-built deployment images | Application, adapter, operator, gateway and patched identity images built |
| Fresh multi-user installation | Invitation, password replacement, ordinary-user isolation, search, recurrence, OAuth linking/renewal passed with disposable accounts |
| Administrator enrollment and setup failures | Independent name/timezone, issuer/subject mapping, interrupted provisioning, repeat setup and configuration-change guards passed |
| Encrypted independent backup and isolated recovery | Task/audit/receipt and identity mappings preserved; old sessions/grants rejected; exact release image archive verified |
| Documented operator CLI on Linux | Prepare, bootstrap, backup and isolated restore passed; repeated restore refused; public ingress never started |
| Dependencies and licenses | npm audit clean; Cargo advisory/license checks pass with the two narrow exceptions below; both JavaScript lockfiles checked |
| Source export and history | Structural, local documentation-link, secret and separate privacy checks passed |
| Public screenshots | Five focused crops of fictional demo content inspected; source PDFs excluded; no identifying image metadata |

The browser matrix covers phone and wide desktop, sidebar states, themes,
embedded/expanded widgets, drafts, conflicts, pagination, account boundaries,
loading failures, and warm refreshes. Expected skips are opt-in performance
measurements and documentation capture; WebKit additionally skips a native
Chromium touch-transport test. Documentation capture was run separately.

The preparation pass fixed malformed chart responses blanking Home and deferred
refreshes concealing conflicts while an editor remained open. Browser fixtures now
use the current composed Home and app-only contracts, select their own records,
and wait for write acknowledgements when checking authoritative state.

[Deterministic CI](https://github.com/ChrisDelvalle/todo-mcp/actions/workflows/ci.yml)
repeats source, dependency/history, browser and full Linux installation checks.
It has read-only default permissions, pinned actions, disposable credentials,
and no deployment or live-model steps. Dependency update proposals require review;
there is no automatic merge or provider upgrade.

## Remaining boundaries

Deterministic widget harnesses are not actual ChatGPT or Claude observations.
No live model prompts, production changes, new host grants, or physical-device
checks were performed in this preparation pass. Each operator must verify their
own DNS, HTTPS certificate issuance, ingress restrictions, provider callbacks and
host connections. Linux x86-64 is covered by CI; local browser/development checks
also ran on macOS. Cross-architecture recovery is not claimed.

The pinned Keycloak resource-renewal patch and experimental resource-binding
feature remain maintained dependencies. Two Rust timing-advisory exceptions apply
only to the locked public-key verification chain; see
[dependency review](dependency-review.md). No independent penetration-test or
security-certification claim is made.

## Before making the repository public

Re-run export/history scanners and CI, review any new artifacts, and enable
GitHub private vulnerability reporting. That feature is configured for public
repositories; see [GitHub's documentation](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
GitHub's [secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning)
supplements pre-upload review. Paid private-repository security products are not
required or enabled automatically. Keep deployment configuration, operational
records, captures and backups outside the source repository.
