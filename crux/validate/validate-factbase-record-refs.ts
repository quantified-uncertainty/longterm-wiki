#!/usr/bin/env node

/**
 * FactBase Record Reference Validation — checks that entity references in
 * FactBase record fields resolve to known entities.
 *
 * FactBase records (personnel, grants, funding rounds, etc.) contain fields
 * that reference entities by stableId (sid_*) or legacy 10-char alphanumeric
 * IDs. If these references don't resolve, the raw ID strings appear in the UI
 * instead of human-readable entity names.
 *
 * This validator scans factbase-data.json record fields and cross-references
 * them against the entity registry in database.json.
 *
 * - sid_* values that don't resolve → ERROR (CI-blocking)
 * - Legacy 10-char IDs that don't resolve → WARNING (informational)
 *
 * Reads local JSON files only (no wiki-server dependency).
 *
 * Usage:
 *   npx tsx crux/validate/validate-factbase-record-refs.ts
 *   npx tsx crux/validate/validate-factbase-record-refs.ts --verbose
 *   npx tsx crux/validate/validate-factbase-record-refs.ts --ci
 */

import fs from "fs";
import path from "path";
import { getColors } from "../lib/output.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordRefError {
  entityId: string;
  collection: string;
  recordKey: string;
  fieldName: string;
  rawValue: string;
  kind: "sid" | "legacy";
}

export interface ValidationResult {
  passed: boolean;
  errors: RecordRefError[];
  warnings: RecordRefError[];
  totalRecords: number;
  totalFieldsChecked: number;
}

interface RecordEntry {
  key: string;
  schema: string;
  ownerEntityId: string;
  fields: Record<string, unknown>;
  displayName?: string;
}

type RecordsMap = Record<string, Record<string, RecordEntry[]>>;

interface IdRegistry {
  stableIdToSlug?: Record<string, string>;
  stableIdBySlug?: Record<string, string>;
  byStableId?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Check if a string is a sid_-prefixed stableId (mirrors isSid from @longterm-wiki/id-utils). */
export function isSidRef(value: string): boolean {
  return value.startsWith("sid_");
}

/**
 * Check if a string looks like a legacy 10-char alphanumeric entity ID.
 * Must be exactly 10 chars, alphanumeric. Matches the ENTITY_ID_RE pattern
 * used by the UI rendering code in ref-detection.ts — the validator must
 * detect the same values that the rendering code treats as potential refs.
 */
export function isLegacyIdRef(value: string): boolean {
  return /^[A-Za-z0-9]{10}$/.test(value);
}

// ---------------------------------------------------------------------------
// Entity lookup
// ---------------------------------------------------------------------------

export interface EntityLookup {
  hasSid: (sid: string) => boolean;
  hasSlug: (slug: string) => boolean;
}

/**
 * Build a fast entity lookup from database.json data.
 */
export function buildEntityLookup(database: {
  idRegistry?: IdRegistry;
  typedEntities?: Array<{ id: string; stableId?: string }>;
}): EntityLookup {
  const stableIds = new Set<string>();
  const slugs = new Set<string>();

  // From idRegistry
  if (database.idRegistry?.stableIdToSlug) {
    for (const sid of Object.keys(database.idRegistry.stableIdToSlug)) {
      stableIds.add(sid);
    }
  }
  if (database.idRegistry?.byStableId) {
    for (const sid of Object.keys(database.idRegistry.byStableId)) {
      stableIds.add(sid);
    }
  }
  if (database.idRegistry?.stableIdBySlug) {
    for (const slug of Object.keys(database.idRegistry.stableIdBySlug)) {
      slugs.add(slug);
    }
  }

  // From typedEntities (backup — covers entities that might not be in idRegistry)
  if (database.typedEntities) {
    for (const entity of database.typedEntities) {
      if (entity.id) slugs.add(entity.id);
      if (entity.stableId) stableIds.add(entity.stableId);
    }
  }

  return {
    hasSid: (sid) => stableIds.has(sid),
    hasSlug: (slug) => slugs.has(slug),
  };
}

// ---------------------------------------------------------------------------
// Field scanning
// ---------------------------------------------------------------------------

/** Fields that are known to NOT be entity references (skip them). */
const NON_ENTITY_FIELDS = new Set([
  "title",
  "role",
  "name",
  "notes",
  "source",
  "start",
  "end",
  "date",
  "period",
  "status",
  "amount",
  "raised",
  "valuation",
  "instrument",
  "background",
  "appointed",
  "departed",
  "appointed_by",
  "is_founder",
  "percentage",
  "share_type",
  "description",
  "website",
  "focus_area",
  "budget",
  "acceptance_rate",
  "deadline",
  "type",
  "event_type",
  "significance",
  "scope",
  "assessment_type",
  "confidence",
  "rating",
  "summary",
  "methodology",
  "citation",
  "doi",
  "url",
  "journal",
  "year",
  "abstract",
  "venue",
  "pages",
  "volume",
  "issue",
]);

/**
 * Check if a string field value looks like an entity reference.
 * Returns the kind ('sid' | 'legacy') or null if it's not a ref.
 */
export function classifyFieldValue(
  value: unknown,
  fieldName: string,
): "sid" | "legacy" | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;

  // Skip known non-entity fields regardless of content
  if (NON_ENTITY_FIELDS.has(fieldName)) return null;

  if (isSidRef(value)) return "sid";
  if (isLegacyIdRef(value)) return "legacy";

  return null;
}

// ---------------------------------------------------------------------------
// Core validation logic
// ---------------------------------------------------------------------------

/**
 * Validate all FactBase record fields for unresolvable entity references.
 * Exported for testing.
 */
export function validateRecordRefs(
  records: RecordsMap,
  lookup: EntityLookup,
): ValidationResult {
  const errors: RecordRefError[] = [];
  const warnings: RecordRefError[] = [];
  let totalRecords = 0;
  let totalFieldsChecked = 0;

  for (const [entityId, collections] of Object.entries(records)) {
    for (const [collectionName, entries] of Object.entries(collections)) {
      for (const entry of entries) {
        totalRecords++;
        for (const [fieldName, fieldValue] of Object.entries(entry.fields)) {
          const kind = classifyFieldValue(fieldValue, fieldName);
          if (!kind) continue;

          totalFieldsChecked++;
          const value = fieldValue as string;

          // Check if the reference resolves
          const resolved =
            lookup.hasSid(value) || lookup.hasSlug(value);

          if (!resolved) {
            const issue: RecordRefError = {
              entityId,
              collection: collectionName,
              recordKey: entry.key,
              fieldName,
              rawValue: value,
              kind,
            };

            if (kind === "sid") {
              errors.push(issue);
            } else {
              warnings.push(issue);
            }
          }
        }
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    totalRecords,
    totalFieldsChecked,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const APP_DIR = path.resolve(import.meta.dirname, "../../apps/web");
const DATA_DIR = path.join(APP_DIR, "src/data");

export function runValidation(opts: {
  verbose?: boolean;
  ci?: boolean;
  dataDir?: string;
}): ValidationResult {
  const { verbose = false, ci = false, dataDir = DATA_DIR } = opts;
  const c = getColors(ci);

  if (!ci) {
    console.log(
      `\n${c.bold}${c.blue}FactBase Record Ref Validation — Checking for unresolvable entity references in record fields${c.reset}\n`,
    );
  }

  // Load factbase-data.json
  const factbasePath = path.join(dataDir, "factbase-data.json");
  let factbaseRaw: Record<string, unknown>;
  try {
    factbaseRaw = JSON.parse(fs.readFileSync(factbasePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!ci) {
      console.log(
        `${c.yellow}Could not read factbase-data.json: ${msg}${c.reset}`,
      );
      console.log(`${c.dim}Run pnpm build-data first.${c.reset}\n`);
    }
    return { passed: true, errors: [], warnings: [], totalRecords: 0, totalFieldsChecked: 0 };
  }

  // Extract records map
  const records = (factbaseRaw as { records?: RecordsMap }).records;
  if (!records || Object.keys(records).length === 0) {
    if (!ci) {
      console.log(
        `${c.dim}No records found in factbase-data.json (wiki-server may not have been available during build-data).${c.reset}`,
      );
      console.log(
        `${c.green}Nothing to validate — passing.${c.reset}\n`,
      );
    }
    return { passed: true, errors: [], warnings: [], totalRecords: 0, totalFieldsChecked: 0 };
  }

  // Load database.json for entity registry
  const databasePath = path.join(dataDir, "database.json");
  let database: {
    idRegistry?: IdRegistry;
    typedEntities?: Array<{ id: string; stableId?: string }>;
  };
  try {
    database = JSON.parse(fs.readFileSync(databasePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!ci) {
      console.log(
        `${c.red}Could not read database.json: ${msg}${c.reset}`,
      );
    }
    return { passed: false, errors: [], warnings: [], totalRecords: 0, totalFieldsChecked: 0 };
  }

  const lookup = buildEntityLookup(database);

  if (!ci) {
    const entityCount = Object.keys(records).length;
    const collectionCount = new Set(
      Object.values(records).flatMap((c) => Object.keys(c)),
    ).size;
    console.log(
      `${c.dim}  Scanning ${entityCount} entities across ${collectionCount} collection types...${c.reset}`,
    );
  }

  const result = validateRecordRefs(records, lookup);

  // Print results
  if (!ci) {
    console.log(
      `\n${c.dim}  Checked ${result.totalRecords} records, ${result.totalFieldsChecked} entity-reference fields${c.reset}`,
    );

    if (result.errors.length > 0) {
      console.log(
        `\n${c.red}Unresolvable sid_ references (ERROR):${c.reset}`,
      );
      const toShow = verbose ? result.errors : result.errors.slice(0, 15);
      for (const err of toShow) {
        console.log(
          `  ${c.red}x${c.reset} ${err.entityId} / ${err.collection} / ${err.fieldName} = "${err.rawValue}" (record ${err.recordKey})`,
        );
      }
      if (!verbose && result.errors.length > 15) {
        console.log(
          `  ${c.dim}... and ${result.errors.length - 15} more (use --verbose)${c.reset}`,
        );
      }
    }

    if (result.warnings.length > 0) {
      console.log(
        `\n${c.yellow}Possible legacy ID references (WARNING):${c.reset}`,
      );
      const toShow = verbose
        ? result.warnings
        : result.warnings.slice(0, 15);
      for (const warn of toShow) {
        console.log(
          `  ${c.yellow}~${c.reset} ${warn.entityId} / ${warn.collection} / ${warn.fieldName} = "${warn.rawValue}" (record ${warn.recordKey})`,
        );
      }
      if (!verbose && result.warnings.length > 15) {
        console.log(
          `  ${c.dim}... and ${result.warnings.length - 15} more (use --verbose)${c.reset}`,
        );
      }
    }

    // Summary
    console.log("");
    if (result.passed && result.warnings.length === 0) {
      console.log(
        `${c.green}All entity references in FactBase records resolve. Clean.${c.reset}`,
      );
    } else if (result.passed) {
      console.log(
        `${c.green}No unresolvable sid_ references.${c.reset} ${c.yellow}${result.warnings.length} legacy ID warning(s).${c.reset}`,
      );
    } else {
      console.log(
        `${c.red}${result.errors.length} unresolvable sid_ reference(s) found in FactBase records.${c.reset}`,
      );
      if (result.warnings.length > 0) {
        console.log(
          `${c.yellow}${result.warnings.length} legacy ID warning(s).${c.reset}`,
        );
      }
    }
  }

  // CI JSON output
  if (ci) {
    console.log(
      JSON.stringify({
        passed: result.passed,
        totalRecords: result.totalRecords,
        totalFieldsChecked: result.totalFieldsChecked,
        errorCount: result.errors.length,
        warningCount: result.warnings.length,
        errors: result.errors,
        warnings: result.warnings,
      }),
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");

  const result = runValidation({ verbose, ci });

  if (!result.passed) {
    process.exit(1);
  }
}

if (process.argv[1]?.includes("validate-factbase-record-refs")) {
  try {
    main();
  } catch (err) {
    console.error("FactBase record ref validation crashed:", err);
    process.exit(1);
  }
}
