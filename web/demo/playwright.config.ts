import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../demo-results",
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  failOnFlakyTests: true,
  timeout: 30000,
  reporter: [["list"], ["json", { outputFile: "demo-results/results.json" }]],
  use: {
    baseURL: "http://127.0.0.1:4175",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "node demo/serve.mjs",
    cwd: "..",
    url: "http://127.0.0.1:4175/gtd-ai/website/",
    reuseExistingServer: !process.env.CI,
  },
});
