# Deterministic local work only. No deployments or model prompts.
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

test-browser *specs:
    node scripts/test-browser.mjs {{specs}}

fixture port="18081":
    cd web && GTD_TEST_SERVER_ORIGIN=http://127.0.0.1:{{port}} node test-server.mjs

images:
    python3 deploy/build.py

# Creates and tears down its own databases. Never accepts a production address.
test-postgres:
    python3 scripts/test-postgres.py
