/**
 * Shared helpers for YAML-per-entity sync scripts.
 *
 * Used by sync-entity-events.ts and sync-entity-assessments.ts (and any
 * future script with the same shape: one YAML file per entity containing
 * an array of structured child records, synced via a deterministic-ID
 * upsert endpoint).
 *
 * Contents:
 *   - asString / asOptionalString — field-level YAML validators
 *   - assertPlainObject            — null/primitive guard for array items
 *   - loadYamlDir                  — dir walk + cross-file duplicate-ID detection
 *   - runSyncMain                  — CLI scaffolding (env check, dry-run, health, report)
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { waitForHealthy } from "./sync-common.ts";

// --- Field-level validators ---

export function asString(v: unknown, field: string, file: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`${file}: '${field}' must be a non-empty string`);
  }
  return v;
}

export function asOptionalString(
  v: unknown,
  field: string,
  file: string,
): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") {
    throw new Error(`${file}: '${field}' must be a string when present`);
  }
  return v;
}

/**
 * Ensure a value is a plain object (not null, array, or primitive). Throws
 * with a location-prefixed error if the shape is wrong. Use this on each
 * element of a parsed YAML array before treating it as a record.
 */
export function assertPlainObject(
  v: unknown,
  where: string,
): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${where}: must be an object`);
  }
}

// --- Directory loading + cross-file dup detection ---

export interface LoadYamlDirOptions<T extends { id: string }> {
  /** Absolute path to the directory of YAML files. */
  dir: string;
  /** Loader for a single file — throws on validation errors. */
  loadFile: (filePath: string) => T[];
  /**
   * Short noun describing a single item — used in the duplicate-ID error
   * message: `Duplicate ${kindLabel} ID <id> from (...) and (...).`
   */
  kindLabel: string;
  /** Formats an item's natural-key tuple for the duplicate-ID error. */
  describe: (item: T) => string;
  /**
   * Hint appended to duplicate-ID errors telling the author which field to
   * change. Default: "Adjust one field to disambiguate."
   */
  dedupHint?: string;
}

/**
 * Walk a directory, load every *.yaml / *.yml with `loadFile`, flatten the
 * results, and throw on any duplicate item IDs across files. Returns an
 * empty result when the directory does not exist.
 *
 * Exists so sync-entity-events and sync-entity-assessments don't each
 * hand-roll the same dir walk + dup-detection loop.
 */
export function loadYamlDir<T extends { id: string }>(
  options: LoadYamlDirOptions<T>,
): { items: T[]; files: string[] } {
  const {
    dir,
    loadFile,
    kindLabel,
    describe,
    dedupHint = "Adjust one field to disambiguate.",
  } = options;

  if (!existsSync(dir)) {
    return { items: [], files: [] };
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const all: T[] = [];
  for (const f of files) {
    all.push(...loadFile(join(dir, f)));
  }

  const seen = new Map<string, T>();
  for (const item of all) {
    const prev = seen.get(item.id);
    if (prev) {
      throw new Error(
        `Duplicate ${kindLabel} ID ${item.id} from (${describe(prev)}) and ` +
          `(${describe(item)}). ${dedupHint}`,
      );
    }
    seen.set(item.id, item);
  }

  return { items: all, files };
}

// --- Main / CLI scaffolding ---

export interface RunSyncMainOptions<T> {
  /** Directory containing the YAML files (printed in the banner). */
  dir: string;
  /** Plural human label, e.g. "entity events". Used in log messages. */
  label: string;
  /** Loads every item from `dir`. */
  loadAll: (dir: string) => { items: T[]; files: string[] };
  /** Extracts the entity ID for the per-entity count summary. */
  getEntityId: (item: T) => string;
  /** Formats one item as a single-line dry-run preview. */
  formatDryRun: (item: T) => string;
  /**
   * Runs the actual sync against the server. Must return a summary with
   * `upserted` and `errors` counts. Typically wraps `batchSync`.
   */
  sync: (
    serverUrl: string,
    items: T[],
    batchSize: number,
  ) => Promise<{ upserted: number; errors: number }>;
  /** Default batch size when --batch-size is not passed. */
  defaultBatchSize?: number;
}

/**
 * Run a sync script end-to-end: parse CLI, check env vars, load YAML,
 * print per-entity counts, handle --dry-run, health-check, call sync,
 * print a final report, and `process.exit(1)` on batch errors.
 *
 * Extracted from sync-entity-events.ts and sync-entity-assessments.ts —
 * each now passes its loader + sync function + formatters here.
 */
export async function runSyncMain<T>(
  options: RunSyncMainOptions<T>,
): Promise<void> {
  const {
    dir,
    label,
    loadAll,
    getEntityId,
    formatDryRun,
    sync,
    defaultBatchSize = 100,
  } = options;

  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || defaultBatchSize;

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_URL environment variable is required",
    );
    process.exit(1);
  }
  if (!apiKey) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_API_KEY environment variable is required",
    );
    process.exit(1);
  }

  console.log(`Reading ${label} from: ${dir}`);
  const { items, files } = loadAll(dir);
  console.log(`  Found ${files.length} files, ${items.length} ${label}`);

  if (items.length === 0) {
    console.log("Nothing to sync.");
    return;
  }

  const byEntity = new Map<string, number>();
  for (const item of items) {
    const eid = getEntityId(item);
    byEntity.set(eid, (byEntity.get(eid) ?? 0) + 1);
  }
  for (const [entityId, count] of [...byEntity.entries()].sort()) {
    console.log(`  ${entityId}: ${count} ${label}`);
  }

  if (dryRun) {
    console.log(`\n[dry-run] Would sync these ${label} (showing first 10):`);
    for (const item of items.slice(0, 10)) {
      console.log(`  ${formatDryRun(item)}`);
    }
    if (items.length > 10) {
      console.log(`  ... and ${items.length - 10} more`);
    }
    return;
  }

  console.log("\nChecking server health...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error(
      `Error: Server at ${serverUrl} is not healthy. Aborting sync.`,
    );
    process.exit(1);
  }

  console.log(
    `\nSyncing ${items.length} ${label} (batch size: ${batchSize})...`,
  );
  const result = await sync(serverUrl, items, batchSize);

  console.log(`\nSync complete:`);
  console.log(`  Upserted: ${result.upserted}`);
  if (result.errors > 0) {
    console.log(`  Errors:   ${result.errors}`);
    console.error(`\nSync failed with ${result.errors} ${label} errors.`);
    process.exit(1);
  }
}
