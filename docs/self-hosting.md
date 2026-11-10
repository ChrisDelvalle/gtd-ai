# Self-hosting on Linux

The supported full installation uses a dedicated non-root user with Docker
access, Docker Compose v2, Python 3.11+, and a Linux server. Allow time and disk
space for the initial Rust and identity builds. Use HTTPS names you control for
the website, identity provider, and each enabled MCP host. The application uses
PostgreSQL; the local SQLite preview is not this installation path.

## 1. Build from source

```sh
git clone https://github.com/ChrisDelvalle/todo-mcp.git
cd todo-mcp
python3 deploy/build.py
```

This builds the pinned Keycloak patch and all five application/operator images.
No private image registry or pre-existing installation is needed. It starts no
services. Build logs and provenance go to ignored `artifacts/`.

## 2. Configure a new installation

```sh
cp installation.example.toml installation.toml
```

Edit every hostname, the initial administrator username, timezone, and external
`state_dir`. The parent directory must exist and be writable by your deployment
user; for `/srv/gtd`, an operator can provision the parent with suitable ownership.
Do not run the application installer as root. Installation state must be outside
the checkout. Leave credential values out of TOML and shell history.

`ingress = "direct"` uses Caddy HTTPS on ports 80/443. Point DNS to the server and
permit certificate issuance. `ingress = "tunnel"` keeps ingress on loopback; see
[integrations](integrations.md) for a Cloudflare Tunnel configuration. A private
website can also be placed behind your own VPN/reverse proxy.

```sh
python3 deploy/gtd.py validate
python3 deploy/gtd.py prepare
```

Record the printed database identity as `DATABASE_ID`. Preparation creates random
credentials, independent identity/application databases, and a private runtime
Compose file. It refuses existing state rather than overwriting it. Staging uses
separate ports and requires hostnames containing `staging`.

## 3. Enroll the first administrator

```sh
python3 deploy/gtd.py --expected-database "$DATABASE_ID" bootstrap
```

Only the private database and identity services start. Enrollment is journaled and
retry-safe: the account is bound to its immutable provider subject, not adopted
because a username matches. The bootstrap provider user is replaced by a private
operator credential. Keep the external state directory private and backed up. Prepared hostnames,
identity settings, and ingress are immutable to these commands: they reject a
changed configuration rather than silently changing a running installation.

## 4. Start and sign in

```sh
python3 deploy/gtd.py --expected-database "$DATABASE_ID" start
python3 deploy/gtd.py --expected-database "$DATABASE_ID" status
python3 deploy/gtd.py --expected-database "$DATABASE_ID" login
```

The last command reveals the initial temporary password only in a terminal. Sign
into the configured website and replace it. Use Settings → Users for further
invitations. Save temporary credentials privately and share them through your own
secure channel. There is no SMTP dependency or public registration.

Keep PostgreSQL, Meilisearch, internal application ports, and Keycloak admin access
private. The generated public gateway intentionally does not route `/admin` or
`/internal`. Read [security](security.md) before exposing a service.

## 5. Back up and connect clients

Set up encrypted and independent backups before relying on the system; follow
[operations](operations.md). Then configure the selected MCP integrations using
[integrations](integrations.md). Ordinary site access does not require an AI host
account. A GTD invitation does not grant access to any external provider.
