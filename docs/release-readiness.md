# Release readiness

This repository is being prepared privately. Public publication and any update to
an existing deployment are separate decisions. The initial history contains the
reviewed source export, not an operational workspace or old release archives.

## Verified in the preparation environment

- Locked Rust build, formatting, strict Clippy checks, and deterministic tests.
- JavaScript adapter/client tests and frontend builds.
- PostgreSQL account isolation, RLS, concurrent writes, retry receipts, history,
  administration, sessions, and activity-query integration tests.
- Source-built application, adapter, operator, gateway, and patched identity images.
- Networkless multi-user installation acceptance: invitation, first-password
  replacement, account isolation, search, recurrence, OAuth linking and renewal.
- Interrupted administrator enrollment and exact issuer/subject binding with an
  independently chosen administrator name and timezone.
- Encrypted independent backup copy and full isolated application/identity recovery,
  including old session/grant rejection and preservation of task/audit/receipt data.
- Fresh fictional documentation screenshots; no production screenshots or task
  exports are included.

## Checks in progress before the initial push

- Full Chromium and WebKit suites, including narrow/wide layouts and widget modes.
- The documented operator command sequence on Linux from committed files.
- Final staged-file privacy, image metadata, secret, and reachable-history review.
- Clean-clone build and GitHub CI execution.

This section is updated with the actual results before the release handoff.

## Separate host and device checks

Deterministic widget harnesses are not actual ChatGPT or Claude observations.
No live model prompts, account grants, production changes, or physical-device tests
are part of this preparation pass. A new operator must verify their own public DNS,
certificate issuance, source restrictions, provider callbacks, and host connections.

The small pinned Keycloak resource-renewal patch remains a maintained dependency.
The advisory exceptions and their constraints are documented in
[dependency review](dependency-review.md). This is not an independent security
certification.

## Before making the repository public

Re-run the export/history scanners and CI, review any new artifacts, and enable
GitHub private vulnerability reporting. That feature is configured for public
repositories; see [GitHub's documentation](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
GitHub's [secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning)
supplements local scanning; paid private-repository security products are not a
prerequisite and are not enabled automatically.
