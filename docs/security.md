# Security and privacy model

GTD is designed for separate personal accounts on a self-hosted server. An
administrator can invite or disable users but cannot read their tasks through
application administration. A host/database operator has infrastructure authority
and must protect databases, backups, provider state, and secrets accordingly.

## Network boundaries

Only HTTPS website, browser sign-in, OAuth discovery, and MCP routes belong at the
public edge. Database, search, application internals, diagnostics, and identity
administration listen on loopback. The supported deployment uses Linux host
networking with explicit loopback listeners; host access is therefore trusted.

The direct HTTPS edge runs with only `NET_BIND_SERVICE` so it can bind host ports
80/443. All other capabilities are dropped; it has no database or identity
credentials mounted. Application, adapter, identity, and search use non-root
users. Tunnel-mode Caddy also runs non-root. Docker operator access is privileged.

Direct Caddy ingress uses the connecting peer for optional MCP source restrictions.
Tunnel mode trusts `CF-Connecting-IP` only from a local tunnel connector. Do not
publish its loopback gateway through an untrusted forwarding proxy. OAuth remains
mandatory independently of an IP allowlist or tunnel.

## Authentication and isolation

Tokens are bound to the exact configured resource. Sessions, IP addresses, tunnel
access, and usernames are not identities. Application requests check account
state immediately; provider grant revocation has bounded propagation. Access
tokens last two minutes. Website sessions last up to 30 days when remembered,
otherwise 12 hours with a browser-session cookie.

The website checks OIDC state/nonce, validated redirects, same-origin requests,
and CSRF headers. Changes use version/conflict checks. PostgreSQL RLS and scoped
queries protect account boundaries; the runtime role has no ownership/bypass.

## Data leaving the server

An MCP host receives the requested tool results and may retain them in a
conversation. Agent notes are part of complete agent context. The interactive
shell is generic; private launch data belongs to authenticated tool metadata.
Third-party links open deliberately; Markdown does not execute embedded HTML.

Application diagnostics record safe identifiers, operation names, outcomes,
timing, and sizes. Do not enable proxy body logging or copy identity dumps into
issues. Backups contain task content, identity material, and recovery credentials;
keep the encrypted repository and its recovery password independently protected.

## Operator responsibilities

Use supported HTTPS, restrict SSH/host administration, protect external state
files, maintain independent verified backups, and review pinned dependency updates.
Use `SECURITY.md` for vulnerability reports. Public test keys are synthetic and
must never enter a deployed provider. No test command should select a personal
account or mutate production data.
