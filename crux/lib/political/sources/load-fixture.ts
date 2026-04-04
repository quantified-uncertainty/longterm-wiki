/**
 * Shared fixture loading utility for scorecard/finance source modules.
 *
 * Resolves fixture paths relative to the calling module's `import.meta.url`
 * (which must be passed in, since `import.meta.url` is module-specific).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load and parse a JSON fixture file relative to the caller's directory.
 *
 * @param callerUrl - The calling module's `import.meta.url`
 * @param filename  - Path relative to the caller's directory (e.g. "fixtures/lcv-sample.json")
 */
export function loadFixture<T>(callerUrl: string, filename: string): T {
  const dir = dirname(fileURLToPath(callerUrl));
  return JSON.parse(readFileSync(join(dir, filename), "utf-8")) as T;
}
