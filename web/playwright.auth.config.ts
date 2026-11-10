import { defineConfig } from "@playwright/test";
const origin = `http://127.0.0.1:${process.env.GTD_AUTH_PORT || "18108"}`;
export default defineConfig({
  testDir: "./auth-tests", outputDir: "./auth-test-results", workers: 1, timeout: 90000,
  webServer: process.env.GTD_AUTH_EXTERNAL === "1" ? undefined : { command: "node test-server.mjs", env: { GTD_TEST_AUTH: "1", GTD_TEST_SERVER_ORIGIN: origin }, url: origin + "/api/auth/session", reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 10000 } },
  use: { baseURL: origin, browserName: process.env.GTD_AUTH_BROWSER === "webkit" ? "webkit" : "chromium", viewport: { width: 1440, height: 1000 } },
  reporter: "list",
});
