# syntax=docker/dockerfile:1
# Build the complete deployment from the repository root.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG RUST_IMAGE=rust:1.93-bookworm@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31

FROM ${NODE_IMAGE} AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ARG GTD_SOURCE_REVISION=development
ARG GTD_SOURCE_URL=https://github.com/ChrisDelvalle/gtd-ai
ENV GTD_SOURCE_REVISION=${GTD_SOURCE_REVISION} GTD_SOURCE_URL=${GTD_SOURCE_URL}
RUN GTD_REQUIRE_ACCOUNT_WIDGET=1 npm run build

FROM ${NODE_IMAGE} AS adapter-builder
WORKDIR /adapter
COPY --chmod=0644 adapter/package.json adapter/package-lock.json ./
RUN npm ci --omit=dev
COPY --chmod=0644 adapter/*.mjs ./

FROM ${RUST_IMAGE} AS rust-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
# Bound compilation parallelism on the single-server staging host. This does
# not change release optimization or act as a container memory/CPU quota.
ARG CARGO_BUILD_JOBS=1
# Lindera's versioned data cache avoids rebuilding its large, portable search
# dictionary on every Rust source change. It is build-only, never runtime state.
ENV LINDERA_BUILD_DICTIONARY_CACHE_DIR=/build/dictionaries
COPY Cargo.toml Cargo.lock LICENSE NOTICE ./
COPY src ./src
COPY scripts/rust-notices.py ./scripts/rust-notices.py
COPY third_party ./third_party
# The serving binary is built without private operator authority.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    --mount=type=cache,id=gtd-lindera,target=/build/dictionaries \
    cargo build --locked --release --features postgres-storage --bin gtd-account-server \
    && cp target/release/gtd-account-server /gtd-account-server \
    && python3 scripts/rust-notices.py /THIRD_PARTY_NOTICES_RUST.txt

FROM rust-builder AS operator-builder
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    --mount=type=cache,id=gtd-lindera,target=/build/dictionaries \
    cargo build --locked --release --features postgres-operator --bin gtd-migrate --bin gtd-activity-migrate \
    && cp target/release/gtd-migrate /gtd-migrate && cp target/release/gtd-activity-migrate /gtd-activity-migrate

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 700 -o 1000 -g 1000 /logs \
    && install -d -m 755 /app/src
COPY LICENSE NOTICE /app/licenses/
COPY --from=rust-builder /THIRD_PARTY_NOTICES_RUST.txt /app/licenses/
USER 1000:1000
WORKDIR /app

FROM runtime AS service
COPY --from=rust-builder /gtd-account-server /usr/local/bin/gtd-account-server
COPY --from=web-builder /web/dist /app/web
ENV TODO_WEB_DIR=/app/web
ENTRYPOINT ["gtd-account-server"]

FROM runtime AS adapter
COPY --from=adapter-builder /adapter /app/adapter
COPY --chmod=0644 src/tool_guidance.json /app/src/tool_guidance.json
COPY --from=web-builder /web/dist/widget-adapter.html /app/adapter/widget.html
ENTRYPOINT ["node", "/app/adapter/http-server.mjs"]

# Offline tool image, kept separate from either serving process.
FROM runtime AS operator
COPY --from=operator-builder /gtd-migrate /usr/local/bin/gtd-migrate
COPY --from=operator-builder /gtd-activity-migrate /usr/local/bin/gtd-activity-migrate
ENTRYPOINT ["gtd-migrate"]
