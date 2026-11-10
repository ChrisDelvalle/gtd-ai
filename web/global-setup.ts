import type { FullConfig } from "@playwright/test";
import { assertTestEnvironment } from "./test-environment.mjs";

export default async function globalSetup(config: FullConfig) {
  const origins = new Set(
    config.projects.map((project) => project.use.baseURL),
  );
  for (const origin of origins) {
    if (!origin)
      throw new Error("Browser tests require a verified test-server baseURL.");
    await assertTestEnvironment(origin);
  }
}
