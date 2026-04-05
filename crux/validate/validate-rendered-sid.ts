#!/usr/bin/env node

/**
 * Rendered SID Validation — last-line-of-defense check for sid_ strings
 * leaking into display positions in built data files.
 *
 * Scans the built output files (database.json, factbase-data.json) for
 * sid_-prefixed stableIds appearing where human-readable text should be.
 * This catches the symptom regardless of cause — whether the leak comes
 * from FactBase, TableBase, the enrichment pipeline, or build-data.
 *
 * Checks:
 *   - Entity titles in database.json (already covered by validate-display-names.ts
 *     for YAML source, but this catches build-time mutations)
 *   - Entity descriptions in database.json
 *   - Record displayName fields in factbase-data.json
 *   - Record field values that look like display names but contain sid_
 *
 * Reads local JSON files only. No wiki-server dependency.
 *
 * Usage:
 *   npx tsx crux/validate/validate-rendered-sid.ts
 *   npx tsx crux/validate/validate-rendered-sid.ts --verbose
 *   npx tsx crux/validate/validate-rendered-sid.ts --ci
 */

import fs from "node:fs";
import path from "node:path";
import { getColors } from "../lib/output.ts";

const APP_DIR = path.resolve(import.meta.dirname, "../../apps/web");
const DATA_DIR = path.join(APP_DIR, "src/data");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidLeak {
  source: "database.json" | "factbase-data.json";
  location: string;
  field: string;
  value: string;
}

export interface ValidationResult {
  passed: boolean;
  leaks: SidLeak[];
  stats: {
    entitiesChecked: number;
    recordsChecked: number;
    factsChecked: number;
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// We use custom patterns instead of isSid() from @longterm-wiki/id-utils because:
// - isSid() only checks startsWith("sid_") — no length validation
// - We need both exact-match (isBareStableId) and substring-match (containsSid)
// - These stricter patterns match the actual sid_ format (prefix + 10 alphanumeric)
const BARE_SID_RE = /^sid_[A-Za-z0-9]{10}$/;
const EMBEDDED_SID_RE = /\bsid_[A-Za-z0-9]{10}\b/;

/** Check if a string IS a bare sid_ (the entire string is just a stableId). */
function isBareStableId(value: unknown): boolean {
  return typeof value === "string" && BARE_SID_RE.test(value.trim());
}

/** Check if a string contains a sid_ anywhere (substring match for displayNames). */
function containsSid(value: unknown): boolean {
  return typeof value === "string" && EMBEDDED_SID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

function scanDatabaseJson(dataDir: string): {
  leaks: SidLeak[];
  entitiesChecked: number;
} {
  const leaks: SidLeak[] = [];
  let entitiesChecked = 0;

  const dbPath = path.join(dataDir, "database.json");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  } catch {
    return { leaks, entitiesChecked };
  }

  // Check typedEntities for sid_ in display fields
  const entities = data.typedEntities;
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      if (!entity || typeof entity !== "object") continue;
      entitiesChecked++;
      const e = entity as Record<string, unknown>;
      const entityId = (e.id as string) || (e.stableId as string) || "(unknown)";

      // Title should never be a bare sid_
      if (isBareStableId(e.title)) {
        leaks.push({
          source: "database.json",
          location: `entity ${entityId}`,
          field: "title",
          value: e.title as string,
        });
      }

      // Description containing a bare sid_ (as the whole value) is suspicious
      if (isBareStableId(e.description)) {
        leaks.push({
          source: "database.json",
          location: `entity ${entityId}`,
          field: "description",
          value: e.description as string,
        });
      }
    }
  }

  return { leaks, entitiesChecked };
}

function scanFactbaseDataJson(dataDir: string): {
  leaks: SidLeak[];
  recordsChecked: number;
  factsChecked: number;
} {
  const leaks: SidLeak[] = [];
  let recordsChecked = 0;
  let factsChecked = 0;

  const fbPath = path.join(dataDir, "factbase-data.json");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(fbPath, "utf-8"));
  } catch {
    return { leaks, recordsChecked, factsChecked };
  }

  // Check records for sid_ in displayName fields
  const records = data.records;
  if (records && typeof records === "object" && !Array.isArray(records)) {
    for (const [entityId, collections] of Object.entries(records as Record<string, unknown>)) {
      if (!collections || typeof collections !== "object" || Array.isArray(collections)) continue;
      for (const [collection, entries] of Object.entries(collections as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries as Array<Record<string, unknown>>) {
          if (!entry || typeof entry !== "object") continue;
          recordsChecked++;
          // Check displayName field
          if (containsSid(entry.displayName)) {
            leaks.push({
              source: "factbase-data.json",
              location: `${entityId}/${collection}/${entry.key ?? "(no key)"}`,
              field: "displayName",
              value: entry.displayName as string,
            });
          }

          // Check named fields that are display-oriented
          const fields = entry.fields as Record<string, unknown> | undefined;
          if (fields) {
            for (const [fieldName, fieldValue] of Object.entries(fields)) {
              // Only check fields that look like they should have display names
              // (name, title, person, member, lead, etc.)
              const isDisplayField =
                fieldName === "name" ||
                fieldName === "title" ||
                fieldName === "person_name" ||
                fieldName === "display_name";
              if (isDisplayField && isBareStableId(fieldValue)) {
                leaks.push({
                  source: "factbase-data.json",
                  location: `${entityId}/${collection}/${entry.key ?? "(no key)"}`,
                  field: `fields.${fieldName}`,
                  value: fieldValue as string,
                });
              }
            }
          }
        }
      }
    }
  }

  // Check facts for sid_ leaking into text display values
  const facts = data.facts;
  if (facts && typeof facts === "object" && !Array.isArray(facts)) {
    for (const [entityId, entityFacts] of Object.entries(facts as Record<string, unknown>)) {
      if (!Array.isArray(entityFacts)) continue;
      for (const fact of entityFacts as Array<Record<string, unknown>>) {
        factsChecked++;
        const value = fact.value as Record<string, unknown> | undefined;
        if (!value) continue;

        // Text-type fact values that are bare stableIds are data pipeline bugs
        if (value.type === "text" && isBareStableId(value.value)) {
          leaks.push({
            source: "factbase-data.json",
            location: `${entityId}/facts/${fact.id ?? "(no id)"}`,
            field: "value.value",
            value: value.value as string,
          });
        }
      }
    }
  }

  return { leaks, recordsChecked, factsChecked };
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

export function runValidation(opts: {
  verbose?: boolean;
  ci?: boolean;
  dataDir?: string;
}): ValidationResult {
  const { verbose = false, ci = false, dataDir = DATA_DIR } = opts;
  const c = getColors(ci);

  if (!ci) {
    console.log(
      `\n${c.bold}${c.blue}Rendered SID Validation — Checking built data for sid_ leaks${c.reset}\n`,
    );
  }

  const dbResult = scanDatabaseJson(dataDir);
  const fbResult = scanFactbaseDataJson(dataDir);

  // Warn if no data was found — the check is vacuous without build artifacts
  if (dbResult.entitiesChecked === 0 && fbResult.factsChecked === 0) {
    if (!ci) {
      console.log(
        `${c.yellow}Warning: No built data files found — run pnpm build-data first.${c.reset}`,
      );
      console.log(
        `${c.dim}This check is only meaningful after build-data generates database.json and factbase-data.json.${c.reset}\n`,
      );
    }
  }

  const allLeaks = [...dbResult.leaks, ...fbResult.leaks];
  const passed = allLeaks.length === 0;

  if (!ci) {
    console.log(
      `${c.dim}  Entities checked: ${dbResult.entitiesChecked}${c.reset}`,
    );
    console.log(
      `${c.dim}  Records checked: ${fbResult.recordsChecked}${c.reset}`,
    );
    console.log(
      `${c.dim}  Facts checked: ${fbResult.factsChecked}${c.reset}`,
    );

    if (allLeaks.length > 0) {
      console.log(
        `\n${c.red}sid_ values found in display positions (${allLeaks.length}):${c.reset}`,
      );
      const toShow = verbose ? allLeaks : allLeaks.slice(0, 15);
      for (const leak of toShow) {
        console.log(
          `  ${c.red}x${c.reset} ${leak.source} → ${leak.location}`,
        );
        console.log(
          `    ${c.dim}${leak.field} = "${leak.value}"${c.reset}`,
        );
      }
      if (!verbose && allLeaks.length > 15) {
        console.log(
          `  ${c.dim}... and ${allLeaks.length - 15} more (use --verbose)${c.reset}`,
        );
      }
    }

    console.log("");
    if (passed) {
      console.log(
        `${c.green}No sid_ leaks found in built data. Clean.${c.reset}`,
      );
    } else {
      console.log(
        `${c.red}${allLeaks.length} sid_ leak(s) found in built data.${c.reset}`,
      );
    }
  }

  if (ci) {
    console.log(
      JSON.stringify({
        passed,
        leakCount: allLeaks.length,
        entitiesChecked: dbResult.entitiesChecked,
        recordsChecked: fbResult.recordsChecked,
        factsChecked: fbResult.factsChecked,
        leaks: allLeaks,
      }),
    );
  }

  return {
    passed,
    leaks: allLeaks,
    stats: {
      entitiesChecked: dbResult.entitiesChecked,
      recordsChecked: fbResult.recordsChecked,
      factsChecked: fbResult.factsChecked,
    },
  };
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

if (process.argv[1]?.includes("validate-rendered-sid")) {
  try {
    main();
  } catch (err) {
    console.error("Rendered SID validation crashed:", err);
    process.exit(1);
  }
}
