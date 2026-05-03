/**
 * Wiki Server Entity Assessments Sync
 *
 * Reads data/entity-assessments/*.yaml and syncs to /api/entity-assessments/sync.
 *
 * Each YAML file represents one entity's structured quality/capability ratings
 * (the "Quick Assessment" tables previously embedded in wiki pages):
 *
 *   entityId: sid_xxxxxxxxxx              # FK to entities.stable_id
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

import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { contentHash } from "../../packages/factbase/src/ids.ts";
import { truncate } from "../lib/text-utils.ts";
import { batchSync } from "./sync-common.ts";
import {
  asString,
  asOptionalString,
  assertPlainObject,
  loadYamlDir,
  runSyncMain,
} from "./sync-yaml-helpers.ts";

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

interface RawAssessmentsFile {
  entityId?: unknown;
  assessments?: unknown;
}

export interface SyncEntityAssessment {
  id: string;
  entityId: string;
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

  if (!Array.isArray(parsed.assessments)) {
    throw new Error(`${filePath}: 'assessments' must be an array`);
  }

  const out: SyncEntityAssessment[] = [];
  // Within-file uniqueness on (dimension, assessor) — duplicates here would
  // also trigger the natural-key constraint server-side, but catching here
  // gives a clearer error naming the offending pair.
  const seenInFile = new Set<string>();

  for (let i = 0; i < parsed.assessments.length; i++) {
    const where = `${filePath} assessments[${i}]`;
    const rawItem = parsed.assessments[i];
    assertPlainObject(rawItem, where);
    const a = rawItem;

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
  const { items, files } = loadYamlDir<SyncEntityAssessment>({
    dir,
    loadFile: loadAssessmentsFile,
    kindLabel: "assessment",
    describe: (a) => `${a.entityId}, ${a.dimension}, ${a.assessor}`,
    dedupHint: "Adjust dimension or assessor to disambiguate.",
  });
  return { assessments: items, files };
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
  await runSyncMain<SyncEntityAssessment>({
    dir: ASSESSMENTS_DIR,
    label: "entity assessments",
    loadAll: (d) => {
      const { assessments, files } = loadAllAssessments(d);
      return { items: assessments, files };
    },
    getEntityId: (a) => a.entityId,
    formatDryRun: (a) =>
      `${a.entityId} [${a.assessor}] ${a.dimension}: ${truncate(a.rating, 61)}`,
    sync: syncEntityAssessments,
    defaultBatchSize: DEFAULT_BATCH_SIZE,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Entity assessments sync failed:", err);
    process.exit(1);
  });
}
