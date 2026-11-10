# Development

Use Rust 1.93+, Node.js 24+, Python 3.11+, a native C compiler, and optionally
`just`. Linux is the deployment platform; macOS works for local development.
Docker is required for PostgreSQL/identity integration tests. The SQLite library
is bundled, so compiling it still requires a C toolchain.

```sh
npm --prefix web ci
npm --prefix adapter ci
npm --prefix web run build
cargo build --locked
cp web/dist/widget-adapter.html adapter/widget.html
cargo test --locked --features postgres-operator
cargo clippy --locked --all-targets --features postgres-operator -- -D warnings
cargo fmt --check
```

The default `todo-mcp` binary supports local stdio MCP and disposable website
fixtures. `gtd-account-server`, built with `postgres-storage`, is the authenticated
multi-user service. `postgres-operator` adds offline migration binaries; those
are excluded from serving containers. `benchmark-clock` is a test-only clock.

## Browser and protocol tests

```sh
npx --prefix web playwright install chromium webkit
node scripts/test-browser.mjs
GTD_TEST_BROWSER=webkit node scripts/test-browser.mjs
npm --prefix adapter test
python3 scripts/test-postgres.py
python3 -m unittest discover -s deploy/multi-user -p 'test_*.py'
python3 -m unittest discover -s deploy/tests -p 'test_*.py'
```

Use `cd web && npx playwright install chromium webkit` if your npm version does
not resolve `--prefix` for executable packages. Browser tests start a loopback-only
server with a temporary database, verify its test environment, and remove it on
exit. Do not point tests at an existing deployment. PostgreSQL tests create their
own containers and random credentials; they accept no personal DSN.

Full installation/identity acceptance requires built images and runs through
`python3 scripts/test-installation.py`. It creates isolated disposable services,
performs deterministic login/OAuth requests, and tears them down. On Linux,
`python3 scripts/test-operator-cli.py` additionally rehearses the documented
prepare/bootstrap/backup/recovery commands without opening public ingress. No model prompt
or real host account is involved.

## Builds and source attribution

`web/build.mjs` emits fingerprinted assets, gzip/Brotli variants, a generic widget,
third-party notices, and source build metadata. Generated files stay ignored.
Use `GTD_SOURCE_URL` for your fork and `GTD_SOURCE_REVISION` for the full 40-character
commit when building without `.git` (such as a container source archive). A
published build should identify the matching source, not an unrelated branch.

If you modify GTD and offer it for remote interaction, provide those users an
accessible way to obtain the corresponding source for that deployed version.
Keep Help's source link usable by the deployment's users, include your changes,
build/install scripts and required notices, and identify the matching revision.
A link to an inaccessible private repository or only the unmodified upstream
source is insufficient for a modified deployment. See [AGPL section 13](https://www.gnu.org/licenses/agpl-3.0.en.html#section13)
and the full license for its terms.

See `AGENTS.md` for UI verification and model-test safeguards. `artifacts/` is the
ignored location for new evidence. Public documentation screenshots must contain
only fictional fixtures. Do not promote browser traces or logs without review.
