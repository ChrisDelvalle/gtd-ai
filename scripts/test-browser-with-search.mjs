// Local deterministic integration tests; never imports a deployed configuration.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "gtd-search-test-"));
const key = randomBytes(24).toString("hex");
const keyFile = join(directory, "key"),
  envFile = join(directory, "container.env");
await writeFile(keyFile, key, { mode: 0o600 });
await writeFile(
  envFile,
  `MEILI_MASTER_KEY=${key}\nMEILI_NO_ANALYTICS=true\nMEILI_MAX_INDEXING_MEMORY=128Mb\nMEILI_MAX_INDEXING_THREADS=1\n`,
  { mode: 0o600 },
);
let container, child, stopping;
async function stop() {
  return (stopping ??= (async () => {
    child?.kill("SIGTERM");
    if (container)
      await exec("docker", ["rm", "-f", container], { timeout: 15000 }).catch(
        () => {},
      );
    await rm(directory, { recursive: true, force: true });
  })());
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    process.exitCode = 130;
    void stop();
  });
const timer = setTimeout(
  () => {
    process.exitCode = 1;
    void stop();
  },
  20 * 60 * 1000,
);
timer.unref();
try {
  // No downloads, volumes, existing containers, public listeners or production keys.
  container = (
    await exec(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--label",
        "gtd.disposable-test=true",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "128",
        "--tmpfs",
        "/meili_data:rw,size=256m",
        "--publish",
        "127.0.0.1::7700",
        "--env-file",
        envFile,
        "getmeili/meilisearch:v1.54.3@sha256:e68913ab7d6f5b159529e472cfd362ce3c741fafd3c127961b2142abbe41b3c9",
      ],
      { timeout: 30000 },
    )
  ).stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(container))
    throw Error("Unexpected disposable container identity");
  const port = (
    await exec("docker", ["port", container, "7700/tcp"], { timeout: 5000 })
  ).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(port))
    throw Error("Search must bind loopback only");
  const origin = "http://" + port;
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(origin + "/health", {
        signal: AbortSignal.timeout(500),
      });
      healthy = r.ok;
    } catch {}
    if (healthy) break;
    await delay(250);
  }
  if (!healthy) throw Error("Disposable search did not become healthy");
  child = spawn(
    process.execPath,
    ["scripts/test-browser.mjs", ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        GTD_TEST_SEARCH_URL: origin,
        GTD_TEST_SEARCH_KEY_FILE: keyFile,
      },
    },
  );
  process.exitCode = await new Promise((yes, no) => {
    child.once("error", no);
    child.once("close", (code) => yes(code ?? 1));
  });
} finally {
  clearTimeout(timer);
  await stop();
}
