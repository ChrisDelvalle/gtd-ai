import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testOrigin } from "./test-environment.mjs";

const web = dirname(fileURLToPath(import.meta.url));
const origin = testOrigin(
  process.env.GTD_TEST_SERVER_ORIGIN || "http://127.0.0.1:18081",
);
const url = new URL(origin);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
  throw new Error(
    "The disposable server must bind an explicit port on http://127.0.0.1.",
  );
}
const environment = { ...process.env };
delete environment.TODO_SEARCH_URL;
delete environment.TODO_SEARCH_KEY_FILE;
const searchURL = process.env.GTD_TEST_SEARCH_URL;
const searchKey = process.env.GTD_TEST_SEARCH_KEY_FILE;
if (!!searchURL !== !!searchKey) {
  throw new Error(
    "Set both GTD_TEST_SEARCH_URL and GTD_TEST_SEARCH_KEY_FILE for a disposable search service.",
  );
}
if (searchURL && searchKey) {
  const search = new URL(testOrigin(searchURL));
  if (
    search.protocol !== "http:" ||
    search.hostname !== "127.0.0.1" ||
    !search.port
  ) {
    throw new Error(
      "The disposable search service must use an explicit port on http://127.0.0.1.",
    );
  }
  environment.TODO_SEARCH_URL = search.origin;
  environment.TODO_SEARCH_KEY_FILE = searchKey;
}
const directory = mkdtempSync(join(tmpdir(), "gtd-browser-test-"));
const auth = process.env.GTD_TEST_AUTH === "1";
if (auth) writeFileSync(join(directory, "credentials.json"), JSON.stringify({ username: "owner", password_hash: "$2a$04$UuTkLRZZ6QofpDOlMz32MuuxEHA43WOemOYHPz6.SjsVsyO1tDU96" }), { mode: 0o600 });
for (const key of ["TODO_WEB_AUTH_FILE", "TODO_WEB_SESSION_DB", "TODO_WEB_AUTH_TEST_BYPASS", "TODO_WEB_AUTH_TEST_HTTP"]) delete environment[key];
const executable =
  process.env.GTD_TEST_EXECUTABLE || resolve(web, "../target/debug/todo-mcp");
const options = {
  cwd: resolve(web, ".."),
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...environment,
    TODO_ENVIRONMENT: "test",
    ...(auth ? {
      TODO_WEB_AUTH_FILE: join(directory, "credentials.json"),
      TODO_WEB_SESSION_DB: join(directory, "sessions.sqlite3"),
      TODO_WEB_AUTH_TEST_HTTP: "1",
    } : { TODO_WEB_AUTH_TEST_BYPASS: "1" }),
    TODO_DB_PATH: join(directory, "tasks.sqlite3"),
    TODO_LOG_DB_PATH: join(directory, "diagnostics.sqlite3"),
    TODO_WEB_DIR: join(web, "dist"),
    TODO_WEB_ORIGIN: origin,
    TODO_WEB_ORIGINS: origin,
    TODO_HEALTH_SOCKET: join(directory, "unused-tunnel.sock"),
  },
};
const children = new Set();
let stopping = false;
let force;
let exitCode = 0;
function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  force = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5000);
  force.unref();
}
function launch(args) {
  const child = spawn(executable, args, options);
  children.add(child);
  child.once("error", (error) => {
    console.error(`Disposable test process could not start: ${error.message}`);
  });
  child.once("close", (code) => {
    children.delete(child);
    if (!stopping) stop(code || 1);
    if (children.size) return;
    clearTimeout(force);
    rmSync(directory, { recursive: true, force: true });
    process.exitCode = exitCode;
  });
}
launch(["--web", "--listen", `127.0.0.1:${url.port}`]);
if (searchURL) launch(["--worker"]);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop(0));
}
