# Architecture

The current multi-user service is `gtd-account-server` (Rust). The React website
and embedded MCP app share task, project, chart, editor, navigation, and state
components. The Node adapter owns protocol and host presentation metadata; Rust
owns business rules and authoritative authorization.

## Data and identity

PostgreSQL stores account-owned tasks, projects, recurrence, history, request
receipts, sessions, and derived activity projections. Runtime credentials neither
own protected tables nor bypass RLS. Each transaction sets its account locally;
pooled connections cannot carry that context to another account. Changes serialize
within an account and revisions follow commit order. Different accounts can work
independently.

Keycloak provides passwords and OAuth authorization-code flow with PKCE. Accounts
bind to issuer and subject, never a matching username/email. The website holds
provider tokens server-side and uses Secure, HttpOnly cookies. MCP requests carry
per-user tokens whose signature, issuer, audience, expiry, scope, credential
generation, authentication cutoff, and account state are checked.

Application administrators manage invitations and access, not other users' tasks.
The private Keycloak operator is a separate credential, not mounted into the
application containers. Public registration is disabled.

## Read and write contracts

Writes use request IDs and expected record versions. Retry receipts preserve the
original result; atomic batches either commit together or fail. Audit events are
immutable and undo respects recurrence coupling. Current agent reads carry full
context. Compact history lists omit note bodies and can resolve full details.

History and chart cursors freeze evaluation time and revision and bind the account,
environment, database, and query. Chart data is rebuildable. Meilisearch is a
separate derived index; results are filtered and revalidated against authoritative
records. Background work is bounded per account.

The widget shell is generic. Account-bound launch data is sent in tool-result
metadata, never personalized cached HTML. Warm views remain usable during refresh;
late responses from another identity are discarded. Subsequent widget calls use
the authenticated host bridge. Direct browser access to the backend is not enabled.

## Source layout

- `src/`: shared Rust domain, storage, identity, HTTP, and MCP contracts.
- `web/src/`: shared React UI and website/widget bridges.
- `adapter/`: Streamable HTTP and local stdio MCP integration.
- `deploy/`: generic deployment, identity build, backups, and deterministic fixtures.
- `tests/` and `web/tests/`: disposable protocol, domain, and browser coverage.

SQLite remains for local fixtures and legacy import/recovery. Multi-user production
uses PostgreSQL compatibility 13. The operator binaries are separate from the
serving image and are never exposed as tools or HTTP endpoints.
