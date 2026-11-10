import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertTestEnvironment, testOrigin } from "./test-environment.mjs";

const web = dirname(fileURLToPath(import.meta.url));
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "gtd-isolation-check-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function healthServer(t, body, status = 200, headers = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    response.writeHead(status, {
      "Content-Type": "application/json",
      ...headers,
    });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}
function subprocess(args, env, cwd = web) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const finished = once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    output,
  }));
  return { child, finished };
}

test("only an explicit test environment passes the health gate", async (t) => {
  for (const environment of [
    "production",
    "demo",
    "development",
    undefined,
    true,
    "TEST",
  ]) {
    await t.test(`refuses ${String(environment)}`, async (t) => {
      const server = await healthServer(t, { environment, database: true });
      await assert.rejects(
        assertTestEnvironment(server.origin),
        /Refusing browser tests/,
      );
      assert.deepEqual(server.calls, [{ method: "GET", path: "/api/health" }]);
    });
  }
  const server = await healthServer(t, { environment: "test" });
  await assertTestEnvironment(server.origin);
  assert.deepEqual(server.calls, [{ method: "GET", path: "/api/health" }]);
});

test("redirects, malformed health, and failed responses never pass", async (t) => {
  const destination = await healthServer(t, { environment: "test" });
  const redirect = await healthServer(t, {}, 302, {
    Location: `${destination.origin}/api/health`,
  });
  await assert.rejects(assertTestEnvironment(redirect.origin), /HTTP 302/);
  assert.deepEqual(destination.calls, []);
  const malformed = await healthServer(t, "not JSON");
  await assert.rejects(assertTestEnvironment(malformed.origin), /not JSON/);
  const failure = await healthServer(t, { environment: "test" }, 503);
  await assert.rejects(assertTestEnvironment(failure.origin), /HTTP 503/);
});

test("test origins reject credentials, paths, and unsupported protocols", () => {
  for (const value of [
    undefined,
    "relative",
    "file:///tmp/test",
    "https://user:secret@example.test",
    "https://example.test/app",
    "https://example.test?test=1",
    "https://example.test#test",
  ]) {
    assert.throws(() => testOrigin(value));
  }
  assert.equal(testOrigin("http://127.0.0.1:18081/"), "http://127.0.0.1:18081");
});

for (const managed of [false, true])
  test(
    managed
      ? "the managed configuration never reuses an existing test server"
      : "the actual Playwright configuration refuses a non-test server before any test body",
    async (t) => {
      const directory = temporary(t);
      const marker = join(directory, "test-body-ran");
      const server = await healthServer(t, {
        environment: managed ? "test" : "production",
        database: true,
      });
      const config = join(directory, "playwright.config.ts");
      writeFileSync(join(directory, "package.json"), '{"type":"module"}');
      writeFileSync(
        config,
        `import config from ${JSON.stringify(join(web, "playwright.config.ts"))};\nexport default { ...config, testDir: ${JSON.stringify(directory)}, outputDir: ${JSON.stringify(join(directory, "output"))} };\n`,
      );
      writeFileSync(
        join(directory, "sentinel.spec.cjs"),
        `const { test } = require(${JSON.stringify(join(web, "node_modules/@playwright/test"))});\ntest('mutation sentinel', async () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); await fetch(${JSON.stringify(server.origin + "/api/tools/capture_item")}, { method: 'POST' }); });\n`,
      );
      const { finished } = subprocess(
        [
          join(web, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          config,
        ],
        {
          GTD_BASE_URL: managed ? "" : server.origin,
          GTD_TEST_PORT: new URL(server.origin).port,
        },
      );
      const outcome = await finished;
      assert.notEqual(outcome.code, 0);
      assert.match(
        outcome.output,
        managed ? /already used/ : /Refusing browser tests/,
      );
      assert.equal(existsSync(marker), false);
      assert.ok(server.calls.length > 0);
      assert.ok(
        server.calls.every(
          (call) => call.method === "GET" && call.path === "/api/health",
        ),
      );
    },
  );

test("repository-root invocation discovers the same environment gate", async (t) => {
  const server = await healthServer(t, { environment: "production" });
  const { finished } = subprocess(
    [
      join(web, "node_modules/@playwright/test/cli.js"),
      "test",
      "web/tests/read-errors.spec.ts",
    ],
    { GTD_BASE_URL: server.origin },
    dirname(web),
  );
  const outcome = await finished;
  assert.notEqual(outcome.code, 0);
  assert.match(outcome.output, /Refusing browser tests/);
  assert.ok(server.calls.length > 0);
  assert.ok(
    server.calls.every(
      (call) => call.method === "GET" && call.path === "/api/health",
    ),
  );
});

for (const withSearch of [false, true])
  test(`the managed runner isolates storage and stops ${withSearch ? "web and worker" : "web"} processes`, async (t) => {
    const directory = temporary(t);
    const executable = join(directory, "fake-backend.cjs");
    const record = join(directory, "backend-environment.json");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst keys = ['TODO_ENVIRONMENT', 'TODO_DB_PATH', 'TODO_LOG_DB_PATH', 'TODO_WEB_ORIGIN', 'TODO_WEB_ORIGINS', 'TODO_HEALTH_SOCKET', 'TODO_SEARCH_URL', 'TODO_SEARCH_KEY_FILE'];\nconst values = Object.fromEntries(keys.map(key => [key, process.env[key]]));\nfs.writeFileSync(values.TODO_DB_PATH, 'synthetic task database');\nfs.writeFileSync(values.TODO_LOG_DB_PATH, 'synthetic diagnostics database');\nfs.writeFileSync(process.env.GTD_RUNNER_RECORD + (process.argv.includes('--worker') ? '.worker' : ''), JSON.stringify({ ...values, pid: process.pid }));\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    );
    const { child, finished } = subprocess([join(web, "test-server.mjs")], {
      GTD_TEST_EXECUTABLE: executable,
      GTD_TEST_SERVER_ORIGIN: "http://127.0.0.1:18099",
      GTD_RUNNER_RECORD: record,
      TODO_ENVIRONMENT: "production",
      TODO_DB_PATH: join(directory, "must-not-use-tasks.sqlite3"),
      TODO_LOG_DB_PATH: join(directory, "must-not-use-logs.sqlite3"),
      TODO_WEB_ORIGINS: "https://production.invalid",
      TODO_SEARCH_URL: "https://production-search.invalid",
      TODO_SEARCH_KEY_FILE: "/must-not-use-search-key",
      GTD_TEST_SEARCH_URL: withSearch ? "http://127.0.0.1:17700" : "",
      GTD_TEST_SEARCH_KEY_FILE: withSearch ? "/tmp/disposable-test-key" : "",
    });
    t.after(() => child.kill("SIGTERM"));
    const ready = () =>
      existsSync(record) && (!withSearch || existsSync(record + ".worker"));
    for (let attempt = 0; attempt < 100 && !ready(); attempt++) await delay(25);
    assert.ok(ready(), "the synthetic backend processes started");
    const values = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(values.TODO_ENVIRONMENT, "test");
    assert.equal(values.TODO_WEB_ORIGIN, "http://127.0.0.1:18099");
    assert.equal(values.TODO_WEB_ORIGINS, values.TODO_WEB_ORIGIN);
    assert.equal(
      values.TODO_SEARCH_URL,
      withSearch ? "http://127.0.0.1:17700" : undefined,
    );
    assert.equal(
      values.TODO_SEARCH_KEY_FILE,
      withSearch ? "/tmp/disposable-test-key" : undefined,
    );
    const worker = withSearch
      ? JSON.parse(readFileSync(record + ".worker", "utf8"))
      : null;
    if (worker) {
      assert.equal(worker.TODO_DB_PATH, values.TODO_DB_PATH);
      assert.equal(worker.TODO_LOG_DB_PATH, values.TODO_LOG_DB_PATH);
      assert.equal(worker.TODO_ENVIRONMENT, "test");
    }
    assert.notEqual(
      values.TODO_DB_PATH,
      join(directory, "must-not-use-tasks.sqlite3"),
    );
    const storage = dirname(values.TODO_DB_PATH);
    assert.equal(dirname(values.TODO_LOG_DB_PATH), storage);
    assert.equal(dirname(values.TODO_HEALTH_SOCKET), storage);
    assert.equal(existsSync(values.TODO_DB_PATH), true);
    assert.equal(existsSync(values.TODO_LOG_DB_PATH), true);
    assert.equal(
      existsSync(join(directory, "must-not-use-tasks.sqlite3")),
      false,
    );
    assert.equal(
      existsSync(join(directory, "must-not-use-logs.sqlite3")),
      false,
    );
    child.kill("SIGTERM");
    assert.equal((await finished).code, 0);
    assert.equal(existsSync(storage), false);
    assert.throws(() => process.kill(values.pid, 0), { code: "ESRCH" });
    if (worker)
      assert.throws(() => process.kill(worker.pid, 0), { code: "ESRCH" });
  });
