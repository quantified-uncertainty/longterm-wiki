/**
 * Wiki Server Entity Assessments Sync
 *
 * Reads data/entity-assessments/*.yaml and syncs to /api/entity-assessments/sync.
 *
 * Each YAML file represents one entity's structured quality/capability ratings
 * (the "Quick Assessment" tables previously embedded in wiki pages):
 *
 *   entityId: sid_xxxxxxxxxx              # FK to entities.stable_id
 *   entityDisplayName: "Anthropic"        # optional fallback display name
 *   assessments:
 *     - dimension: mission-alignment      # kebab-case string (free-form, not enum)
 *       rating: "Public benefit corp"    # short rating value (required)
 *       evidence: "..."                  # optional supporting text
 *       assessor: editorial              # editorial | llm | community | external
 *       assessedAt: "2026-04-24"         # YYYY-MM-DD (optional)
 *       source: "https://..."            # optional URL
 *       notes: "..."                     # optional
 *
 * Item IDs are derived deterministically from (entityId, dimension, assessor) so
 * the sync is idempotent: re-running with the same YAML upserts the same rows.
 * This matches the natural-key uniqueness constraint on the server side
 * (uq_entity_assessment_natural_key).
 *
 * Usage:
 *   pnpm crux sys wiki-server sync-entity-assessments
 *   pnpm crux sys wiki-server sync-entity-assessments --dry-run
 *   pnpm crux sys wiki-server sync-entity-assessments --batch-size=50
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL     - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { contentHash } from "../../packages/factbase/src/ids.ts";
import { waitForHealthy, batchSync } from "./sync-common.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const ASSESSMENTS_DIR = join(PROJECT_ROOT, "data/entity-assessments");

const DEFAULT_BATCH_SIZE = 100;

// Mirror of VALID_ASSESSORS in
// apps/wiki-server/src/routes/tablebase/entity-assessments.ts.
// Keep in sync with that route's Zod schema.
export const VALID_ASSESSORS = [
  "editorial",
  "llm",
  "community",
  "external",
] as const;

type Assessor = (typeof VALID_ASSESSORS)[number];

// Date format for assessedAt: YYYY-MM-DD only (schema allows max 10 chars).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Kebab-case dimensions only. This keeps (entityId, dimension, assessor) keys
// stable across edits and lets the UI format the display label independently
// of storage. Allows lowercase letters, digits, and hyphens.
const DIMENSION_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// --- Types ---

interface RawAssessment {
  dimension?: unknown;
  rating?: unknown;
  evidence?: unknown;
  assessor?: unknown;
  assessedAt?: unknown;
  source?: unknown;
  notes?: unknown;
}

interface RawAssessmentsFile {
  entityId?: unknown;
  entityDisplayName?: unknown;
  assessments?: unknown;
}

export interface SyncEntityAssessment {
  id: string;
  entityId: string;
  entityDisplayName: string | null;
  dimension: string;
  rating: string;
  evidence: string | null;
  assessor: Assessor;
  assessedAt: string | null;
  source: string | null;
  notes: string | null;
}

// --- Loader ---

/**
 * Generate a deterministic 10-char ID from (entityId, dimension, assessor).
 * This mirrors the server-side natural-key uniqueness constraint, so a
 * re-sync upserts the same rows. Editing the rating in-place keeps the ID
 * stable; editing the dimension produces a new row (the old one will
 * linger until cleaned up via /delete-batch).
 */
export function assessmentIdFor(
  entityId: string,
  dimension: string,
  assessor: string,
): string {
  return contentHash(["entity-assessment", entityId, dimension, assessor]);
}

function asString(v: unknown, field: string, file: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`${file}: '${field}' must be a non-empty string`);
  }
  return v;
}

function asOptionalString(v: unknown, field: string, file: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") {
    throw new Error(`${file}: '${field}' must be a string when present`);
  }
  return v;
}

/**
 * Load and validate one entity-assessments YAML file.
 * Throws on malformed input — sync should fail-closed rather than silently skip.
 */
export function loadAssessmentsFile(filePath: string): SyncEntityAssessment[] {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw) as RawAssessmentsFile | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath}: top-level YAML must be an object`);
  }

  const entityId = asString(parsed.entityId, "entityId", filePath);
  const entityDisplayName = asOptionalString(
    parsed.entityDisplayName,
    "entityDisplayName",
    filePath,
  );

  if (!Array.isArray(parsed.assessments)) {
    throw new Error(`${filePath}: 'assessments' must be an array`);
  }

  const out: SyncEntityAssessment[] = [];
  // Within-file uniqueness on (dimension, assessor) — duplicates here would
  // also trigger the natural-key constraint server-side, but catching here
  // gives a clearer error naming the offending pair.
  const seenInFile = new Set<string>();

  for (let i = 0; i < parsed.assessments.length; i++) {
    const a = parsed.assessments[i] as RawAssessment;
    const where = `${filePath} assessments[${i}]`;

    const dimension = asString(a.dimension, "dimension", where);
    if (!DIMENSION_RE.test(dimension)) {
      throw new Error(
        `${where}: 'dimension' must be kebab-case (lowercase letters, digits, hyphens; got "${dimension}")`,
      );
    }

    const rating = asString(a.rating, "rating", where);

    let assessor: Assessor = "editorial";
    if (a.assessor !== undefined && a.assessor !== null && a.assessor !== "") {
      const candidate = asString(a.assessor, "assessor", where) as Assessor;
      if (!(VALID_ASSESSORS as readonly string[]).includes(candidate)) {
        throw new Error(
          `${where}: 'assessor' must be one of ${VALID_ASSESSORS.join("|")} (got "${candidate}")`,
        );
      }
      assessor = candidate;
    }

    let assessedAt: string | null = null;
    if (a.assessedAt !== undefined && a.assessedAt !== null && a.assessedAt !== "") {
      const candidate = asString(a.assessedAt, "assessedAt", where);
      if (!DATE_RE.test(candidate)) {
        throw new Error(
          `${where}: 'assessedAt' must be YYYY-MM-DD (got "${candidate}")`,
        );
      }
      assessedAt = candidate;
    }

    const dedupKey = `${dimension}::${assessor}`;
    if (seenInFile.has(dedupKey)) {
      throw new Error(
        `${where}: duplicate (dimension, assessor) within file — ${dimension} / ${assessor}`,
      );
    }
    seenInFile.add(dedupKey);

    out.push({
      id: assessmentIdFor(entityId, dimension, assessor),
      entityId,
      entityDisplayName,
      dimension,
      rating,
      evidence: asOptionalString(a.evidence, "evidence", where),
      assessor,
      assessedAt,
      source: asOptionalString(a.source, "source", where),
      notes: asOptionalString(a.notes, "notes", where),
    });
  }

  return out;
}

/**
 * Load all *.yaml / *.yml files from data/entity-assessments/ and return the
 * flattened assessment list. Returns an empty array if the directory does
 * not exist.
 */
export function loadAllAssessments(dir: string = ASSESSMENTS_DIR): {
  assessments: SyncEntityAssessment[];
  files: string[];
} {
  if (!existsSync(dir)) {
    return { assessments: [], files: [] };
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const all: SyncEntityAssessment[] = [];
  for (const f of files) {
    const assessments = loadAssessmentsFile(join(dir, f));
    all.push(...assessments);
  }

  // Detect duplicate IDs across files — would surface as a silent overwrite
  // server-side, so catch it here with the offending pair named.
  const seen = new Map<string, SyncEntityAssessment>();
  for (const a of all) {
    const prev = seen.get(a.id);
    if (prev) {
      throw new Error(
        `Duplicate assessment ID ${a.id} from (${prev.entityId}, ${prev.dimension}, ${prev.assessor}) and ` +
          `(${a.entityId}, ${a.dimension}, ${a.assessor}). Adjust dimension or assessor to disambiguate.`,
      );
    }
    seen.set(a.id, a);
  }

  return { assessments: all, files };
}

// --- Sync ---

export async function syncEntityAssessments(
  serverUrl: string,
  assessments: SyncEntityAssessment[],
  batchSize: number,
  options: { _sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ upserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/entity-assessments/sync`,
    assessments,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "entity assessments",
      _sleep: options._sleep,
    },
  );
  return { upserted: result.count, errors: result.errors };
}

// --- Main ---

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || DEFAULT_BATCH_SIZE;

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

  console.log(`Reading entity assessments from: ${ASSESSMENTS_DIR}`);
  const { assessments, files } = loadAllAssessments();
  console.log(`  Found ${files.length} files, ${assessments.length} assessments`);

  if (assessments.length === 0) {
    console.log("Nothing to sync.");
    return;
  }

  // Per-entity counts for visibility
  const byEntity = new Map<string, number>();
  for (const a of assessments) {
    byEntity.set(a.entityId, (byEntity.get(a.entityId) ?? 0) + 1);
  }
  for (const [entityId, count] of [...byEntity.entries()].sort()) {
    console.log(`  ${entityId}: ${count} assessments`);
  }

  if (dryRun) {
    console.log("\n[dry-run] Would sync these assessments (showing first 10):");
    for (const a of assessments.slice(0, 10)) {
      console.log(
        `  ${a.entityId} [${a.assessor}] ${a.dimension}: ${a.rating.slice(0, 60)}${a.rating.length > 60 ? "…" : ""}`,
      );
    }
    if (assessments.length > 10) {
      console.log(`  ... and ${assessments.length - 10} more`);
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
    `\nSyncing ${assessments.length} entity assessments (batch size: ${batchSize})...`,
  );
  const result = await syncEntityAssessments(serverUrl, assessments, batchSize);

  console.log(`\nSync complete:`);
  console.log(`  Upserted: ${result.upserted}`);
  if (result.errors > 0) {
    console.log(`  Errors:   ${result.errors}`);
    console.error(`\nSync failed with ${result.errors} assessment errors.`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Entity assessments sync failed:", err);
    process.exit(1);
  });
}
