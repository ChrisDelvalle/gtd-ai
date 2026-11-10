import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { testOrigin } from "./test-environment.mjs";

const externalServer = !!process.env.GTD_BASE_URL;
const port = process.env.GTD_TEST_PORT || "18081";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw new Error("GTD_TEST_PORT must be a port between 1 and 65535.");
const baseURL = testOrigin(
  process.env.GTD_BASE_URL || `http://127.0.0.1:${port}`,
);
// Existing request helpers and the browser must use the same normalized origin.
process.env.GTD_BASE_URL = baseURL;

export default defineConfig({
  testDir: join(import.meta.dirname, "tests"),
  globalSetup: join(import.meta.dirname, "global-setup.ts"),
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  failOnFlakyTests: true,
  webServer: externalServer
    ? undefined
    : {
        command: "node test-server.mjs",
        cwd: import.meta.dirname,
        env: { GTD_TEST_SERVER_ORIGIN: baseURL },
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
        timeout: 30000,
      },
  use: {
    baseURL,
    trace: process.env.CI ? "retain-on-failure" : "off",
    browserName: process.env.GTD_TEST_BROWSER === "webkit" ? "webkit" : "chromium",
    viewport: { width: 1440, height: 1000 },
  },
  reporter: process.env.GTD_TEST_REPORT
    ? [["list"], ["json", { outputFile: process.env.GTD_TEST_REPORT }]]
    : "list",
  timeout: 45000,
});
