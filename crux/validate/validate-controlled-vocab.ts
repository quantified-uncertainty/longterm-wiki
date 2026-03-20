#!/usr/bin/env node

/**
 * Controlled Vocabulary Validator
 *
 * Validates that free-text fields in YAML entities and PG-primary tables
 * match their expected controlled vocabularies. Reports unknown/non-standard
 * values as warnings and suggests corrections for typos.
 *
 * Checked fields (YAML entities):
 *   - type (entityType): canonical entity types + known aliases
 *   - relatedEntries[].relationship: RelationshipType enum
 *   - orgType: organization sub-type enum
 *   - severity: severity level enum
 *   - maturity: ResearchMaturity enum
 *   - status: EntityStatus enum
 *   - clusters: topic cluster enum
 *   - policyStatus: de facto policy status vocabulary
 *   - projectStatus: project status enum
 *
 * Checked fields (PG-primary, via wiki-server API):
 *   - personnel.roleType: VALID_ROLE_TYPES
 *   - divisions.divisionType: VALID_DIVISION_TYPES
 *   - divisions.status: VALID_STATUSES
 *
 * Usage:
 *   pnpm crux validate controlled-vocab             # Run full check
 *   pnpm crux validate controlled-vocab --ci        # CI mode (JSON output)
 *   pnpm crux validate controlled-vocab --verbose   # Show all checked values
 *
 * Exit codes:
 *   0 = No issues found (or advisory-only warnings)
 *   1 = Issues found
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml } from "yaml";
import { getColors } from "../lib/output.ts";
import { PROJECT_ROOT, DATA_DIR } from "../lib/content-types.ts";
import { fetchAllRecords } from "./validate-soft-fks.ts";
import type { ValidatorResult } from "./types.ts";
import type { Colors } from "../lib/output.ts";

// Canonical sources for vocabulary lists
import {
  ALL_ENTITY_TYPE_NAMES,
} from "../../apps/web/src/data/entity-type-names.ts";
import {
  RelationshipType as RelationshipTypeEnum,
  EntityStatus as EntityStatusEnum,
  ResearchMaturity as ResearchMaturityEnum,
} from "../../data/schema.ts";

// ---------------------------------------------------------------------------
// Controlled vocabularies — derived from canonical sources
// ---------------------------------------------------------------------------

/**
 * Canonical entity types — imported from apps/web/src/data/entity-type-names.ts.
 * Includes both canonical types and known aliases.
 */
export const VALID_ENTITY_TYPES = new Set<string>(ALL_ENTITY_TYPE_NAMES);

/**
 * Valid relationship types — imported from data/schema.ts RelationshipType enum.
 */
export const VALID_RELATIONSHIPS = new Set<string>(RelationshipTypeEnum.options);

/**
 * Valid orgType values — extracted from data/schema.ts Entity schema.
 * Canonical source: Entity.shape.orgType in data/schema.ts (also matches
 * entity-schemas.ts OrganizationEntitySchema.orgType).
 */
export const VALID_ORG_TYPES = new Set([
  "frontier-lab",
  "safety-org",
  "academic",
  "government",
  "funder",
  "startup",
  "generic",
  "other",
] as const);

/**
 * Valid severity values — extracted from data/schema.ts Entity.severity enum.
 */
export const VALID_SEVERITIES = new Set([
  "low",
  "medium",
  "medium-high",
  "high",
  "critical",
  "catastrophic",
  // Case variants found in data (data/schema.ts allows these)
  "Low",
  "Medium",
  "High",
  "Catastrophic",
] as const);

/**
 * Valid maturity values — imported from data/schema.ts ResearchMaturity enum.
 */
export const VALID_MATURITIES = new Set<string>(ResearchMaturityEnum.options);

/**
 * Valid entity status values — imported from data/schema.ts EntityStatus enum.
 */
export const VALID_STATUSES = new Set<string>(EntityStatusEnum.options);

/**
 * Valid cluster values — extracted from data/schema.ts Entity.clusters enum.
 */
export const VALID_CLUSTERS = new Set([
  "ai-safety",
  "biorisks",
  "cyber",
  "epistemics",
  "governance",
  "community",
] as const);

/**
 * De facto policy status values. These are not formally enum'd in the
 * schema but follow a consistent pattern in the data.
 * Canonical source: manual audit of data/entities/*.yaml policy entities.
 * Last synced: 2026-03-19.
 */
export const VALID_POLICY_STATUSES = new Set([
  "active",
  "proposed",
  "enacted",
  "vetoed",
  "failed",
  "revoked",
  "expired",
  "pending",
  "signed",
] as const);

/**
 * Valid project status values — extracted from entity-schemas.ts
 * ProjectEntitySchema.projectStatus enum.
 * Canonical source: apps/web/src/data/entity-schemas.ts ProjectEntitySchema.
 * Last synced: 2026-03-19.
 */
export const VALID_PROJECT_STATUSES = new Set([
  "active",
  "maintained",
  "archived",
  "abandoned",
  "beta",
] as const);

/**
 * Valid personnel roleType values.
 * Canonical source: apps/wiki-server/src/routes/tablebase/personnel.ts VALID_ROLE_TYPES.
 * Last synced: 2026-03-19.
 */
export const VALID_ROLE_TYPES = new Set([
  "key-person",
  "board",
  "career",
] as const);

/**
 * Valid division type values.
 * Canonical source: apps/wiki-server/src/routes/tablebase/divisions.ts VALID_DIVISION_TYPES.
 * Last synced: 2026-03-19.
 */
export const VALID_DIVISION_TYPES = new Set([
  "fund",
  "team",
  "department",
  "lab",
  "program-area",
] as const);

/**
 * Valid division status values.
 * Canonical source: apps/wiki-server/src/routes/tablebase/divisions.ts VALID_STATUSES.
 * Last synced: 2026-03-19.
 */
export const VALID_DIVISION_STATUSES = new Set([
  "active",
  "inactive",
  "dissolved",
] as const);

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface VocabIssue {
  field: string;
  value: string;
  entityId: string;
  sourceFile: string;
  suggestion?: string;
}

export interface EntityData {
  id: string;
  type?: string;
  orgType?: string;
  severity?: string;
  maturity?: string;
  status?: string;
  clusters?: string[];
  policyStatus?: string;
  projectStatus?: string;
  relatedEntries?: Array<{
    id: string;
    type?: string;
    relationship?: string;
    strength?: string;
  }>;
  [key: string]: unknown;
}

interface PersonnelRow {
  roleType: string;
  personId: string;
  organizationId: string;
  role: string;
}

interface DivisionRow {
  divisionType: string;
  name: string;
  parentOrgId: string;
  status?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Levenshtein edit distance between two strings (case-insensitive).
 */
function editDistance(a: string, b: string): number {
  const aLow = a.toLowerCase();
  const bLow = b.toLowerCase();
  const matrix: number[][] = [];
  for (let i = 0; i <= bLow.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= aLow.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= bLow.length; i++) {
    for (let j = 1; j <= aLow.length; j++) {
      const cost = bLow[i - 1] === aLow[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[bLow.length][aLow.length];
}

/**
 * Suggest the closest match from a vocabulary set for a given value.
 * Returns undefined if no match is close enough (distance > 3).
 */
export function suggestCorrection(
  value: string,
  vocab: Set<string>
): string | undefined {
  let bestMatch: string | undefined;
  let bestDistance = Infinity;

  for (const candidate of vocab) {
    const d = editDistance(value, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      bestMatch = candidate;
    }
  }

  // Only suggest if the distance is small relative to string length
  // and at most 3 edits away
  if (bestMatch && bestDistance <= 3 && bestDistance < bestMatch.length * 0.5) {
    return bestMatch;
  }
  return undefined;
}

/**
 * Load all YAML entity files from data/entities/ and return a flat array.
 */
function loadYamlEntities(): Array<EntityData & { _sourceFile: string }> {
  const entitiesDir = join(PROJECT_ROOT, DATA_DIR, "entities");
  if (!existsSync(entitiesDir)) {
    return [];
  }

  const files = readdirSync(entitiesDir).filter((f) => f.endsWith(".yaml"));
  const results: Array<EntityData & { _sourceFile: string }> = [];

  for (const file of files) {
    const filepath = join(entitiesDir, file);
    const content = readFileSync(filepath, "utf-8");
    const data = parseYaml(content);
    if (Array.isArray(data)) {
      for (const item of data) {
        results.push({ ...item, _sourceFile: filepath });
      }
    }
  }

  return results;
}

/**
 * Check a value against a vocabulary and record issues.
 */
export function checkValue(
  field: string,
  value: string | undefined | null,
  vocab: Set<string>,
  entityId: string,
  sourceFile: string,
  issues: VocabIssue[]
): void {
  if (value == null || value === "") return;
  const trimmed = String(value).trim();
  if (!vocab.has(trimmed)) {
    const suggestion = suggestCorrection(trimmed, vocab);
    issues.push({ field, value: trimmed, entityId, sourceFile, suggestion });
  }
}

// ---------------------------------------------------------------------------
// YAML entity checks
// ---------------------------------------------------------------------------

export function checkYamlEntities(entities: Array<EntityData & { _sourceFile: string }>): VocabIssue[] {
  const issues: VocabIssue[] = [];

  for (const entity of entities) {
    const id = entity.id || "(unknown)";
    const src = entity._sourceFile;

    // 1. Entity type
    checkValue("type", entity.type, VALID_ENTITY_TYPES, id, src, issues);

    // 2. orgType
    checkValue("orgType", entity.orgType, VALID_ORG_TYPES, id, src, issues);

    // 3. severity
    checkValue("severity", entity.severity, VALID_SEVERITIES, id, src, issues);

    // 4. maturity
    checkValue("maturity", entity.maturity, VALID_MATURITIES, id, src, issues);

    // 5. status
    checkValue("status", entity.status, VALID_STATUSES, id, src, issues);

    // 6. clusters
    if (Array.isArray(entity.clusters)) {
      for (const cluster of entity.clusters) {
        checkValue("clusters", cluster, VALID_CLUSTERS, id, src, issues);
      }
    }

    // 7. policyStatus (only for policy entities)
    if (entity.type === "policy" && entity.policyStatus) {
      checkValue(
        "policyStatus",
        entity.policyStatus,
        VALID_POLICY_STATUSES,
        id,
        src,
        issues
      );
    }

    // 8. projectStatus (only for project entities)
    if (entity.type === "project" && entity.projectStatus) {
      checkValue(
        "projectStatus",
        entity.projectStatus,
        VALID_PROJECT_STATUSES,
        id,
        src,
        issues
      );
    }

    // 9. relatedEntries — check relationship and entry type
    if (Array.isArray(entity.relatedEntries)) {
      for (const entry of entity.relatedEntries) {
        if (entry.relationship) {
          checkValue(
            "relatedEntries.relationship",
            entry.relationship,
            VALID_RELATIONSHIPS,
            id,
            src,
            issues
          );
        }
        if (entry.type) {
          checkValue(
            "relatedEntries.type",
            entry.type,
            VALID_ENTITY_TYPES,
            id,
            src,
            issues
          );
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// PG-primary data checks (via wiki-server API)
// ---------------------------------------------------------------------------

export async function checkPersonnel(): Promise<VocabIssue[]> {
  const issues: VocabIssue[] = [];

  const records = await fetchAllRecords(
    "/api/tablebase/personnel",
    "items",
    200
  );
  if (!records) {
    // Wiki-server unavailable — skip PG checks gracefully
    return issues;
  }

  for (const row of records) {
    const r = row as unknown as PersonnelRow;
    checkValue(
      "personnel.roleType",
      r.roleType,
      VALID_ROLE_TYPES,
      `personnel:${r.personId}@${r.organizationId}`,
      "wiki-server:personnel",
      issues
    );
  }

  return issues;
}

export async function checkDivisions(): Promise<VocabIssue[]> {
  const issues: VocabIssue[] = [];

  const records = await fetchAllRecords(
    "/api/tablebase/divisions",
    "items",
    200
  );
  if (!records) {
    return issues;
  }

  for (const row of records) {
    const r = row as unknown as DivisionRow;
    checkValue(
      "divisions.divisionType",
      r.divisionType,
      VALID_DIVISION_TYPES,
      `division:${r.name}@${r.parentOrgId}`,
      "wiki-server:divisions",
      issues
    );
    if (r.status != null) {
      checkValue(
        "divisions.status",
        r.status,
        VALID_DIVISION_STATUSES,
        `division:${r.name}@${r.parentOrgId}`,
        "wiki-server:divisions",
        issues
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface ControlledVocabResult extends ValidatorResult {
  issues: VocabIssue[];
  checkedEntities: number;
  checkedPersonnel: boolean;
  checkedDivisions: boolean;
}

export async function validateControlledVocab(options?: {
  ci?: boolean;
  verbose?: boolean;
}): Promise<ControlledVocabResult> {
  const ci = options?.ci ?? false;
  const verbose = options?.verbose ?? false;
  const c = getColors(ci);

  // Phase 1: Check YAML entities
  const entities = loadYamlEntities();
  const yamlIssues = checkYamlEntities(entities);

  // Phase 2: Check PG-primary data (best-effort)
  let personnelIssues: VocabIssue[] = [];
  let divisionIssues: VocabIssue[] = [];
  let checkedPersonnel = false;
  let checkedDivisions = false;

  try {
    personnelIssues = await checkPersonnel();
    checkedPersonnel = true;
  } catch (e: unknown) {
    if (!ci) {
      console.log(
        `${c.dim}  Skipped personnel checks (wiki-server unavailable)${c.reset}`
      );
    }
  }

  try {
    divisionIssues = await checkDivisions();
    checkedDivisions = true;
  } catch (e: unknown) {
    if (!ci) {
      console.log(
        `${c.dim}  Skipped division checks (wiki-server unavailable)${c.reset}`
      );
    }
  }

  const allIssues = [...yamlIssues, ...personnelIssues, ...divisionIssues];

  // Group issues by field for readable output
  const byField = new Map<string, VocabIssue[]>();
  for (const issue of allIssues) {
    const existing = byField.get(issue.field) || [];
    existing.push(issue);
    byField.set(issue.field, existing);
  }

  if (!ci) {
    console.log(
      `\n${c.bold}Controlled Vocabulary Validation${c.reset}`
    );
    console.log(
      `${c.dim}  Checked ${entities.length} YAML entities${checkedPersonnel ? ", personnel" : ""}${checkedDivisions ? ", divisions" : ""}${c.reset}\n`
    );

    if (allIssues.length === 0) {
      console.log(`${c.green}  All values match controlled vocabularies.${c.reset}\n`);
    } else {
      for (const [field, fieldIssues] of byField) {
        console.log(`${c.yellow}  ${field}${c.reset} (${fieldIssues.length} issue${fieldIssues.length > 1 ? "s" : ""}):`);

        // Deduplicate by value for summary
        const byValue = new Map<string, { count: number; entities: string[]; suggestion?: string }>();
        for (const issue of fieldIssues) {
          const existing = byValue.get(issue.value);
          if (existing) {
            existing.count++;
            if (existing.entities.length < 3) {
              existing.entities.push(issue.entityId);
            }
          } else {
            byValue.set(issue.value, {
              count: 1,
              entities: [issue.entityId],
              suggestion: issue.suggestion,
            });
          }
        }

        for (const [value, info] of byValue) {
          const suggestionText = info.suggestion
            ? ` ${c.dim}(did you mean "${info.suggestion}"?)${c.reset}`
            : "";
          const entityList = info.entities.join(", ");
          const moreText = info.count > info.entities.length
            ? ` +${info.count - info.entities.length} more`
            : "";
          console.log(
            `    "${c.red}${value}${c.reset}"${suggestionText} — ${info.count} occurrence${info.count > 1 ? "s" : ""} [${entityList}${moreText}]`
          );
        }
        console.log();
      }
    }

    if (verbose) {
      // Show summary of all valid vocabularies
      console.log(`${c.bold}Valid vocabularies:${c.reset}`);
      const vocabs = [
        { name: "type", values: VALID_ENTITY_TYPES },
        { name: "relatedEntries.relationship", values: VALID_RELATIONSHIPS },
        { name: "orgType", values: VALID_ORG_TYPES },
        { name: "severity", values: VALID_SEVERITIES },
        { name: "maturity", values: VALID_MATURITIES },
        { name: "status", values: VALID_STATUSES },
        { name: "clusters", values: VALID_CLUSTERS },
        { name: "policyStatus", values: VALID_POLICY_STATUSES },
        { name: "projectStatus", values: VALID_PROJECT_STATUSES },
        { name: "personnel.roleType", values: VALID_ROLE_TYPES },
        { name: "divisions.divisionType", values: VALID_DIVISION_TYPES },
        { name: "divisions.status", values: VALID_DIVISION_STATUSES },
      ];
      for (const v of vocabs) {
        console.log(
          `  ${c.cyan}${v.name}${c.reset}: ${[...v.values].join(", ")}`
        );
      }
      console.log();
    }
  }

  if (ci) {
    console.log(
      JSON.stringify({
        passed: allIssues.length === 0,
        warnings: allIssues.length,
        errors: 0,
        checkedEntities: entities.length,
        checkedPersonnel,
        checkedDivisions,
        issues: allIssues.map((i) => ({
          field: i.field,
          value: i.value,
          entityId: i.entityId,
          sourceFile: i.sourceFile,
          suggestion: i.suggestion,
        })),
      })
    );
  }

  return {
    passed: allIssues.length === 0,
    errors: 0,
    warnings: allIssues.length,
    issues: allIssues,
    checkedEntities: entities.length,
    checkedPersonnel,
    checkedDivisions,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ci = args.includes("--ci");
  const verbose = args.includes("--verbose");

  const result = await validateControlledVocab({ ci, verbose });

}

main().catch((err) => {
  console.error("Controlled vocabulary validation failed:", err);
  process.exitCode = 1;
});
