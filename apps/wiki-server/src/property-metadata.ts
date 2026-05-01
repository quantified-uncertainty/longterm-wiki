/**
 * Loads metadata about FactBase properties from
 * `packages/factbase/data/properties.yaml`.
 *
 * Currently surfaces only the `verifiable: false` flag, which the sourcing
 * coverage endpoints (QUA-928) need to compute the "checkable" subset of facts
 * — properties marked `verifiable: false` are excluded by design from the
 * sourcing pipeline (e.g. social-media handles, self-referential URLs,
 * unsourced estimates), so coverage against the all-facts denominator is
 * mathematically unreachable and the dashboard splits the metric in two:
 * `checkabilityPercent` and `checkableCoveragePercent`.
 *
 * Read once at first call and cached for the lifetime of the process.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to properties.yaml. From `apps/wiki-server/src/property-metadata.ts`,
 * walk three levels up to the repo root, then descend into the factbase data
 * dir. Works in both dev (workspace) and Docker (`/repo` layout — see
 * `apps/wiki-server/Dockerfile`).
 */
const PROPERTIES_YAML_PATH = resolve(
  __dirname,
  "../../../packages/factbase/data/properties.yaml",
);

let cachedNonVerifiable: ReadonlySet<string> | null = null;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Parse the `verifiable: false` property IDs out of a YAML string. Pure
 * function — exported only for unit tests covering malformed YAML
 * (`getNonVerifiablePropertyIds` reads the canonical workspace file and is
 * harder to exercise with adversarial inputs).
 */
export function parseNonVerifiablePropertyIds(yamlText: string): Set<string> {
  const parsed = parseYaml(yamlText);
  // Empty file or `~`/`null` → no properties at all. Treat as zero
  // non-verifiable properties rather than an error: the production file
  // is populated, but a future minimal-config setup shouldn't fail boot.
  if (parsed === null || parsed === undefined) {
    return new Set();
  }
  if (!isObject(parsed)) {
    throw new Error(
      `properties.yaml: expected an object at the root, got ${typeof parsed}`,
    );
  }
  const properties = parsed.properties;
  if (properties !== undefined && !isObject(properties)) {
    throw new Error(
      `properties.yaml: \`properties\` must be a map, got ${typeof properties}`,
    );
  }
  const ids = new Set<string>();
  for (const [id, def] of Object.entries(properties ?? {})) {
    if (isObject(def) && def.verifiable === false) ids.add(id);
  }
  return ids;
}

/**
 * Returns the set of property IDs that are marked `verifiable: false` in
 * `properties.yaml`. Throws if the file can't be read or parsed — these are
 * load-bearing for sourcing coverage metrics, so a silent empty set would
 * skew dashboards.
 *
 * Read once on first call and cached for the lifetime of the process. Call
 * site is also reachable at server boot (see `index.ts`) so that a missing
 * or malformed file fails the deploy rather than the first request.
 */
export function getNonVerifiablePropertyIds(): ReadonlySet<string> {
  if (cachedNonVerifiable !== null) return cachedNonVerifiable;
  const raw = readFileSync(PROPERTIES_YAML_PATH, "utf-8");
  cachedNonVerifiable = parseNonVerifiablePropertyIds(raw);
  return cachedNonVerifiable;
}

/**
 * Test seam — reset the cache so a different yaml path or content can be
 * exercised. Not exported from production code paths.
 */
export function _resetPropertyMetadataCache(): void {
  cachedNonVerifiable = null;
}
