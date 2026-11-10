# Local development and explicit local operations. No remote deployment or model prompts.
default:
    @just --list

setup:
    npm --prefix web ci
    npm --prefix adapter ci

build:
    npm --prefix web run build
    cargo build --locked
    cp web/dist/widget-adapter.html adapter/widget.html

release:
    npm --prefix web run build
    cargo build --release --locked --features postgres-operator

check:
    cargo fmt --check
    cargo clippy --locked --all-targets --features postgres-operator -- -D warnings
    cargo test --locked --features postgres-operator
    just test-client
    npm --prefix adapter test
    python3 -m unittest discover -s deploy/multi-user -p 'test_*.py'
    python3 -m unittest discover -s deploy/tests -p 'test_*.py'
    python3 scripts/check-repository.py

test-client:
    cd web && node --experimental-transform-types --test *.test.mjs *.test.ts

[positional-arguments]
test-browser *specs:
    node scripts/test-browser-with-search.mjs "$@"

[positional-arguments]
fixture port="18081":
    cd web && GTD_TEST_SERVER_ORIGIN="http://127.0.0.1:$1" node test-server.mjs

images:
    python3 deploy/build.py

# Creates and tears down its own databases. Never accepts a production address.
test-postgres:
    python3 scripts/test-postgres.py

# Build and serve a throwaway, loopback-only website. Ctrl-C removes its data.
[positional-arguments]
dev port="18081": build
    just fixture "$1"

# Build and preview both static demos at /gtd-ai/website/ and /gtd-ai/chat/.
demos:
    npm --prefix web run build:demos
    npm --prefix web run demo:serve

# Deterministic demo data and Chromium/WebKit checks, including a fresh build.
test-demos:
    npm --prefix web run build:demos
    npm --prefix web run test:demos
    npm --prefix web run test:demos:browser

[positional-arguments]
test-browser-webkit *specs:
    GTD_TEST_BROWSER=webkit node scripts/test-browser-with-search.mjs "$@"

# Guarded same-schema upgrade: requires immutable image IDs and a verified backup.
[positional-arguments]
deploy-local database_id service_image adapter_image config="installation.toml":
    python3 deploy/upgrade.py --config "$4" --expected-database "$1" --service-image "$2" --adapter-image "$3"
