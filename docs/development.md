# Development

Use Rust 1.93+, Node.js 24+, Python 3.11+, a native C compiler, and optionally
`just`. Linux is the deployment platform; macOS works for local development.
Docker is required for PostgreSQL/identity integration tests. The SQLite library
is bundled, so compiling it still requires a C toolchain.
The multilingual search dictionaries make debug builds sizable. On small machines,
use `CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
CARGO_PROFILE_TEST_DEBUG=0` to bound build pressure, as CI does. These settings
remove debug symbols and incremental artifacts, not test assertions.

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

## Common commands

`just` provides shortcuts for the existing scripts; it is optional. Run `just`
for the list. Commands run from the repository root even when invoked inside a
subdirectory.

| Command | Purpose |
| --- | --- |
| `just setup` | Install locked frontend and adapter dependencies |
| `just dev` | Build and serve a disposable local website on port 18081 |
| `just demos` | Build and preview both static demos on port 4175 |
| `just test-demos` | Build and check demo data and both browser engines |
| `just check` | Rust, client, adapter, and deployment configuration checks |
| `just test-browser [specs…]` | Chromium checks with disposable search |
| `just test-browser-webkit [specs…]` | The same checks in WebKit |
| `just images` | Build the full self-hosted deployment without starting it |

The disposable website is removed when its server exits. The two demo URLs are
`http://127.0.0.1:4175/gtd-ai/website/` and
`http://127.0.0.1:4175/gtd-ai/chat/`. Install Playwright browsers below before
running browser checks.

For an existing local installation, `just deploy-local DATABASE_ID SERVICE_IMAGE
ADAPTER_IMAGE [CONFIG]` delegates to the guarded same-schema upgrade command.
Use immutable `sha256:` image IDs, take a verified backup first, and follow
[operations](operations.md). It never discovers or connects to a remote server,
creates accounts, migrates a schema, or bypasses the backup requirement.

## CI runtime

GitHub Actions caches npm downloads, Rust dependencies, the pinned advisory-checker
binary, and expensive Docker build layers. A missing or evicted cache falls back
to the normal build. Checks and installation rehearsals still run on every
change, and no test retries are enabled. Docker cache exports are limited to the
operator target, which also includes the service's Rust build, to avoid uploading
the same layers from every image. They contain build artifacts, never installation
configuration or test databases.
The image cache is most effective for frontend and documentation changes. Rust
source or lockfile changes can require a full release rebuild: BuildKit's local
layer export does not preserve the compiler's mutable cache mounts.

Browser suites intentionally use one worker per engine: some integration tests
share the disposable server. Parallelizing those before isolating their state
would trade runtime for unreliable results. Chromium and WebKit already run in
separate jobs.

## Browser and protocol tests

```sh
cd web && npx --no-install playwright install chromium webkit && cd ..
docker pull getmeili/meilisearch:v1.54.3@sha256:e68913ab7d6f5b159529e472cfd362ce3c741fafd3c127961b2142abbe41b3c9
node scripts/test-browser-with-search.mjs
GTD_TEST_BROWSER=webkit node scripts/test-browser-with-search.mjs
npm --prefix adapter test
python3 scripts/test-postgres.py
python3 -m unittest discover -s deploy/multi-user -p 'test_*.py'
python3 -m unittest discover -s deploy/tests -p 'test_*.py'
```

The complete browser suite uses its own disposable search container. Individual
mocked UI tests can use `scripts/test-browser.mjs` without search. Tests start a loopback-only
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
The deployment builder rejects uncommitted source changes. For disposable local
images only, `GTD_SOURCE_REVISION=development python3 deploy/build.py` explicitly
marks them as development builds rather than misidentifying a committed revision.

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
