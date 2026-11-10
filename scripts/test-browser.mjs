import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Preserve each run, including failed runs. Historical docs are promoted manually.
const web = fileURLToPath(new URL("../web/", import.meta.url));
const stamp = new Date().toISOString().replaceAll(":", "-");
const output = join(web, "test-results", `${stamp}-${process.pid}`);
const args = process.argv.slice(2);
if (args.some((arg) => arg === "--output" || arg.startsWith("--output=")))
  throw new Error("This wrapper owns its run-scoped output directory.");
await mkdir(output, { recursive: true });
console.log(`Browser artifacts: ${output}`);
const child = spawn(
  process.execPath,
  [
    join(web, "node_modules/@playwright/test/cli.js"),
    "test",
    ...args,
    "--output",
    output,
  ],
  {
    cwd: web,
    stdio: "inherit",
    env: { ...process.env, GTD_TEST_REPORT: join(output, "results.json") },
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 130 : 1);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
