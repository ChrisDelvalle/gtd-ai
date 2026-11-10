# MCP integrations

GTD provides authenticated Streamable HTTP at `/mcp`. Each person connects using
their own GTD account. The server uses predefined OAuth clients with PKCE S256 and
exact resource/audience validation; it does not support arbitrary dynamic client
registration. Client IDs use `gtd-` in production and `gtd-staging-` in staging.

| Client | Endpoint | OAuth client | Requested scopes |
| --- | --- | --- | --- |
| ChatGPT | `https://<chatgpt_host>/mcp` | `gtd-chatgpt` | `gtd:access offline_access` |
| Claude | `https://<mcp_host>/mcp` | `gtd-claude` | `gtd:access offline_access` |
| Website | configured website | `gtd-website` | managed by the application |

Browser authorization uses `https://<auth_host>/realms/gtd`. The callback URIs are
exactly `https://chatgpt.com/connector_platform_oauth_redirect` and
`https://claude.ai/api/mcp/auth_callback`. Public MCP clients have no client secret.
The ChatGPT client permits optional `email` because some connection dialogs add
it automatically; GTD neither requires email nor uses it for account identity.
`openid` is a protocol scope, not an extra GTD permission.

Create a private/custom MCP connection in the host's current connection UI. Enter
the endpoint and OAuth client ID, then sign in as the intended GTD user. Inspect
the connected identity before using it. Provider plan eligibility and UI controls
can change. Do not paste access tokens, client secrets, or passwords into a chat.

Display tools (`show_gtd`, `show_tasks`, `show_projects`) carry the interactive
resource metadata. Ordinary operations return data. App-only tools serve widget
interactions; they are not general model-facing administration tools. Host
rendering is separate from tool success. Refresh discovery after schema, guidance,
or immutable widget changes; preserve a working connection during any migration.

## Cloudflare Tunnel (optional)

Use one named tunnel with hostname routes for the configured auth and MCP names.
Route each to `http://127.0.0.1:20546` (staging: `19546`) and end the tunnel config
with a catch-all HTTP 404. Keep `httpHostHeader` as the original configured hostname.
Use TLS on the public side, disable caching and browser challenges for protocol
routes, and never expose the loopback gateway as an inbound public port.

`tunnel` ingress trusts the local connector's `CF-Connecting-IP`. If you want a
private website, omit its hostname from the tunnel and route it through your
private reverse proxy instead. Cloudflare Access and direct iframe requests are
not part of this integration.

Optional `chatgpt_ranges` and `claude_ranges` restrict only MCP traffic. Obtain
current ranges from the providers' published integration-egress documents, validate
CIDRs, and review configuration before replacement. Discovery and browser sign-in
must remain reachable. Preserve the last valid configuration if an update fails.
Never treat source IP as identity or weaken OAuth for a network restriction.

## Other clients and local development

A general remote client needs its own reviewed predefined client registration and
exact callback URI. The current automated installer prepares ChatGPT and Claude;
it does not enable wildcard redirect URIs or automatic registration.

Local development can launch `target/debug/todo-mcp --db /absolute/path/tasks.sqlite3`
over stdio. That local process has filesystem authority and no multi-user OAuth
boundary; do not expose it as an anonymous production HTTP service.
