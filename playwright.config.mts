// Keep repository-root invocations on the same guarded suite and fixture paths.
import { fileURLToPath } from "node:url";
import config from "./web/playwright.config.ts";

process.chdir(fileURLToPath(new URL("./web", import.meta.url)));
export default config;
