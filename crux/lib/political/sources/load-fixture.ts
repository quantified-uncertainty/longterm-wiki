import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load and parse a JSON fixture file from the `fixtures/` directory
 * adjacent to the calling module.
 *
 * @param callerUrl - Pass `import.meta.url` from the calling module
 * @param filename  - Fixture filename (e.g. "fec-sample.json")
 */
export function loadFixture<T>(callerUrl: string, filename: string): T {
  const dir = dirname(fileURLToPath(callerUrl));
  return JSON.parse(readFileSync(join(dir, "fixtures", filename), "utf-8"));
}
