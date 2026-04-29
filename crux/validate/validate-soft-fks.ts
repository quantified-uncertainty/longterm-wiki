#!/usr/bin/env node

/**
 * Soft FK Validation — checks that legacy text FK fields in PG tables
 * resolve to actual entities.
 *
 * PG tables like personnel, grants, investments, divisions, etc. have legacy
 * text fields (personId, organizationId, investorId, etc.) that reference
 * entities by slug or display name. Some also have newer resolved FK columns
 * (personEntityId, orgEntityId) that are NULL when unresolved. This validator
 * detects records where the legacy field does not resolve to any known entity.
 *
 * Requires wiki-server to be running (queries the API). Advisory — not CI-blocking.
 *
 * Usage:
 *   npx tsx crux/validate/validate-soft-fks.ts              # advisory mode
 *   npx tsx crux/validate/validate-soft-fks.ts --verbose     # show all unresolved refs
 *   npx tsx crux/validate/validate-soft-fks.ts --ci          # JSON output
 */

import { getColors } from "../lib/output.ts";
import {
  apiRequest,
  type ApiResult,
} from "../lib/wiki-server/client.ts";
import { isSid } from '../../packages/id-utils/src/index.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single unresolved soft FK reference. */
export interface UnresolvedRef {
  table: string;
  recordId: string;
  field: string;
  value: string;
  /** Whether a resolved entityId FK column exists and is NULL for this record. */
  resolvedFkNull: boolean;
}

/** Stats for a single table. */
export interface TableStats {
  table: string;
  totalRecords: number;
  totalRefs: number;
  resolvedRefs: number;
  unresolvedRefs: number;
  unresolvedList: UnresolvedRef[];
}

/** Per-table soft FK field specification. */
export interface SoftFkFieldSpec {
  /** The legacy text field that holds the slug/display name. */
  legacyField: string;
  /** The resolved entityId FK column (NULL when unresolved). If absent, we look up against entity set. */
  resolvedField?: string;
  /** Expected entity type (optional — for logging). */
  entityType?: string;
}

/** Table specification for validation. */
export interface TableSpec {
  /** API path to fetch all records, e.g. "/api/personnel/all". */
  apiPath: string;
  /** Response JSON key containing the array of records. */
  responseKey: string;
  /** Soft FK fields to validate. */
  fields: SoftFkFieldSpec[];
  /** Maximum records per request (uses limit query param). */
  maxLimit?: number;
}

// ---------------------------------------------------------------------------
// Table definitions — which soft FK fields to check in each PG table
// ---------------------------------------------------------------------------

export const TABLE_SPECS: TableSpec[] = [
  {
    apiPath: "/api/personnel/all",
    responseKey: "personnel",
    fields: [
      {
        legacyField: "personId",
        resolvedField: "personEntityId",
        entityType: "person",
      },
      {
        legacyField: "organizationId",
        resolvedField: "orgEntityId",
        entityType: "organization",
      },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/grants/all",
    responseKey: "grants",
    fields: [
      {
        legacyField: "organizationId",
        resolvedField: "orgEntityId",
        entityType: "organization",
      },
      {
        legacyField: "granteeId",
        resolvedField: "granteeEntityId",
        entityType: "organization",
      },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/funding-rounds/all",
    responseKey: "fundingRounds",
    fields: [
      {
        legacyField: "companyId",
        resolvedField: "companyEntityId",
        entityType: "organization",
      },
      {
        legacyField: "leadInvestor",
        resolvedField: "leadInvestorEntityId",
        entityType: "organization",
      },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/investments/all",
    responseKey: "investments",
    fields: [
      {
        legacyField: "companyId",
        resolvedField: "companyEntityId",
        entityType: "organization",
      },
      {
        legacyField: "investorId",
        resolvedField: "investorEntityId",
        entityType: "organization",
      },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/equity-positions/all",
    responseKey: "equityPositions",
    fields: [
      {
        legacyField: "companyId",
        resolvedField: "companyEntityId",
        entityType: "organization",
      },
      {
        legacyField: "holderId",
        resolvedField: "holderEntityId",
        entityType: "organization",
      },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/divisions/all",
    responseKey: "divisions",
    fields: [
      {
        legacyField: "parentOrgId",
        entityType: "organization",
      },
      {
        legacyField: "lead",
        entityType: "person",
      },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/division-personnel/all",
    responseKey: "divisionPersonnel",
    fields: [
      {
        legacyField: "divisionId",
        // This references divisions.id, not entities — validated separately
      },
      {
        legacyField: "personId",
        entityType: "person",
      },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/funding-programs/all",
    responseKey: "fundingPrograms",
    fields: [
      {
        legacyField: "orgId",
        entityType: "organization",
      },
      {
        legacyField: "divisionId",
        // This references divisions.id, not entities — validated separately
      },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/benchmark-results/all",
    responseKey: "benchmarkResults",
    fields: [
      {
        legacyField: "modelId",
        entityType: "ai-model",
      },
    ],
    maxLimit: 200,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all records from a paginated endpoint.
 * Follows offset pagination until all records are retrieved.
 */
export async function fetchAllRecords(
  apiPath: string,
  responseKey: string,
  maxLimit: number = 200,
): Promise<Record<string, unknown>[] | null> {
  const allRecords: Record<string, unknown>[] = [];
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const url = `${apiPath}${separator}limit=${maxLimit}&offset=${offset}`;
    const result: ApiResult<Record<string, unknown>> = await apiRequest("GET", url);

    if (!result.ok) {
      return null;
    }

    const records = result.data[responseKey] as Record<string, unknown>[] | undefined;
    if (!records || !Array.isArray(records)) {
      return null;
    }

    allRecords.push(...records);

    const total = result.data.total as number | undefined;
    if (total === undefined || allRecords.length >= total) {
      break;
    }

    offset += maxLimit;
  }

  return allRecords;
}

/**
 * Build entity lookup sets from the entities API.
 * Returns sets of entity slugs, stableIds, and a combined set.
 */
export async function buildEntityLookup(): Promise<{
  slugs: Set<string>;
  stableIds: Set<string>;
  combined: Set<string>;
} | null> {
  const allEntities: Array<{ id: string; stableId: string }> = [];
  let offset = 0;
  const limit = 500;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // typed-client-ok: QUA-770 baseline — validator script, direct typing acceptable for ad-hoc integrity queries
    const result = await apiRequest<{
      entities: Array<{ id: string; stableId: string }>;
      total: number;
    }>("GET", `/api/entities?limit=${limit}&offset=${offset}`);

    if (!result.ok) return null;

    allEntities.push(...result.data.entities);
    if (allEntities.length >= result.data.total) break;
    offset += limit;
  }

  const slugs = new Set(allEntities.map((e) => e.id));
  const stableIds = new Set(allEntities.map((e) => e.stableId));
  const combined = new Set([...slugs, ...stableIds]);

  return { slugs, stableIds, combined };
}

/**
 * Build a set of division IDs for validating divisionId references.
 */
export async function buildDivisionIdSet(): Promise<Set<string> | null> {
  const records = await fetchAllRecords("/api/divisions/all", "divisions", 200);
  if (!records) return null;
  return new Set(records.map((r) => r.id as string));
}

/**
 * Determine if a reference value is "intentionally unresolvable" — e.g. it's
 * a display name like "John Smith" rather than a slug/stableId reference.
 * Display names contain spaces or start with "new:".
 */
function isDisplayName(value: string): boolean {
  if (value.startsWith("new:")) return true;
  // Display names typically contain spaces or are very long
  if (value.includes(" ")) return true;
  return false;
}

/**
 * Validate soft FK fields in a single table.
 */
export async function validateTable(
  spec: TableSpec,
  entityLookup: Set<string>,
  divisionIds: Set<string>,
): Promise<TableStats> {
  const records = await fetchAllRecords(spec.apiPath, spec.responseKey, spec.maxLimit);

  const stats: TableStats = {
    table: spec.responseKey,
    totalRecords: 0,
    totalRefs: 0,
    resolvedRefs: 0,
    unresolvedRefs: 0,
    unresolvedList: [],
  };

  if (!records) {
    return stats;
  }

  stats.totalRecords = records.length;

  for (const record of records) {
    const recordId = record.id as string;

    for (const fieldSpec of spec.fields) {
      const value = record[fieldSpec.legacyField];
      if (value === null || value === undefined || value === "") {
        continue; // Nullable field with no value — skip
      }

      const strValue = String(value);
      stats.totalRefs++;

      // Strategy 1: If there's a resolved FK field, check that
      if (fieldSpec.resolvedField) {
        const resolvedValue = record[fieldSpec.resolvedField];
        if (resolvedValue !== null && resolvedValue !== undefined && resolvedValue !== "") {
          stats.resolvedRefs++;
          continue;
        }
      }

      // Strategy 2: Check if the legacy value resolves against entity lookup
      // Division references are checked against division IDs
      if (fieldSpec.legacyField === "divisionId") {
        if (divisionIds.has(strValue)) {
          stats.resolvedRefs++;
          continue;
        }
      } else if (entityLookup.has(strValue)) {
        stats.resolvedRefs++;
        continue;
      }

      // If it looks like a stableId pattern but didn't resolve, it's dangling
      // If it looks like a display name, it's a softer issue but still unresolved
      const isStableIdLike = isSid(strValue);
      const isDisplayNameVal = isDisplayName(strValue);

      // Count as unresolved if:
      // 1. It's a stableId pattern that didn't match (definitely broken)
      // 2. It's a slug-like string that didn't match
      // Display names are still counted but flagged differently
      if (!isDisplayNameVal || isStableIdLike) {
        stats.unresolvedRefs++;
        stats.unresolvedList.push({
          table: spec.responseKey,
          recordId,
          field: fieldSpec.legacyField,
          value: strValue,
          resolvedFkNull: fieldSpec.resolvedField
            ? (record[fieldSpec.resolvedField] === null || record[fieldSpec.resolvedField] === undefined)
            : true,
        });
      } else {
        // Display name — still counts as unresolved but is expected in many cases
        stats.unresolvedRefs++;
        stats.unresolvedList.push({
          table: spec.responseKey,
          recordId,
          field: fieldSpec.legacyField,
          value: strValue,
          resolvedFkNull: fieldSpec.resolvedField
            ? (record[fieldSpec.resolvedField] === null || record[fieldSpec.resolvedField] === undefined)
            : true,
        });
      }
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runValidation(opts: {
  verbose?: boolean;
  ci?: boolean;
}): Promise<{
  passed: boolean;
  stats: TableStats[];
  totalRefs: number;
  resolvedRefs: number;
  unresolvedRefs: number;
  linkRate: number;
}> {
  const { verbose = false, ci = false } = opts;
  const c = getColors(ci);

  // Step 1: Build entity lookup
  if (!ci) {
    console.log(`${c.cyan}Loading entities from wiki-server...${c.reset}`);
  }

  const entityLookup = await buildEntityLookup();
  if (!entityLookup) {
    if (!ci) {
      console.log(
        `${c.red}Failed to load entities from wiki-server. Is the server running?${c.reset}`
      );
    }
    return {
      passed: true, // advisory — don't fail if server unavailable
      stats: [],
      totalRefs: 0,
      resolvedRefs: 0,
      unresolvedRefs: 0,
      linkRate: 100,
    };
  }

  if (!ci) {
    console.log(
      `${c.dim}  Loaded ${entityLookup.slugs.size} entity slugs, ${entityLookup.stableIds.size} stableIds${c.reset}`
    );
  }

  // Step 2: Build division ID set for division FK validation
  const divisionIds = await buildDivisionIdSet();
  if (!ci && divisionIds) {
    console.log(`${c.dim}  Loaded ${divisionIds.size} division IDs${c.reset}`);
  }

  // Step 3: Validate each table
  if (!ci) {
    console.log(`\n${c.bold}${c.blue}Soft FK Validation — PG Table Entity References${c.reset}\n`);
  }

  const allStats: TableStats[] = [];

  for (const spec of TABLE_SPECS) {
    if (!ci) {
      process.stdout.write(`${c.dim}  Checking ${spec.responseKey}...${c.reset}`);
    }
    const stats = await validateTable(spec, entityLookup.combined, divisionIds ?? new Set());
    allStats.push(stats);
    if (!ci) {
      if (stats.totalRecords === 0) {
        console.log(` ${c.dim}(empty or unreachable)${c.reset}`);
      } else if (stats.unresolvedRefs === 0) {
        console.log(
          ` ${c.green}${stats.resolvedRefs}/${stats.totalRefs} resolved${c.reset}`
        );
      } else {
        console.log(
          ` ${c.yellow}${stats.unresolvedRefs} unresolved${c.reset} of ${stats.totalRefs}`
        );
      }
    }
  }

  // Step 4: Aggregate stats
  let totalRefs = 0;
  let resolvedRefs = 0;
  let unresolvedRefs = 0;

  for (const stats of allStats) {
    totalRefs += stats.totalRefs;
    resolvedRefs += stats.resolvedRefs;
    unresolvedRefs += stats.unresolvedRefs;
  }

  const linkRate = totalRefs > 0 ? (resolvedRefs / totalRefs) * 100 : 100;

  // Step 5: Print report
  if (!ci) {
    console.log(
      `\n${"─".repeat(76)}`
    );
    console.log(
      "| Table                  | Records | Refs  | Resolved | Unresolved | Rate    |"
    );
    console.log(
      "|------------------------|---------|-------|----------|------------|---------|"
    );

    for (const stats of allStats) {
      const rate =
        stats.totalRefs > 0
          ? ((stats.resolvedRefs / stats.totalRefs) * 100).toFixed(1) + "%"
          : "N/A";
      const table = stats.table.padEnd(22);
      const rec = stats.totalRecords.toString().padStart(7);
      const refs = stats.totalRefs.toString().padStart(5);
      const res = stats.resolvedRefs.toString().padStart(8);
      const unres = stats.unresolvedRefs.toString().padStart(10);
      const rateStr = rate.padStart(7);
      console.log(
        `| ${table} | ${rec} | ${refs} | ${res} | ${unres} | ${rateStr} |`
      );
    }

    console.log(
      "|------------------------|---------|-------|----------|------------|---------|"
    );
    const totalTable = "TOTAL".padEnd(22);
    const totalRec = allStats
      .reduce((s, t) => s + t.totalRecords, 0)
      .toString()
      .padStart(7);
    const totalRefsStr = totalRefs.toString().padStart(5);
    const totalRes = resolvedRefs.toString().padStart(8);
    const totalUnres = unresolvedRefs.toString().padStart(10);
    const totalRate = (linkRate.toFixed(1) + "%").padStart(7);
    console.log(
      `| ${totalTable} | ${totalRec} | ${totalRefsStr} | ${totalRes} | ${totalUnres} | ${totalRate} |`
    );
    console.log("─".repeat(76));

    // Print unresolved details
    const allUnresolved = allStats.flatMap((s) => s.unresolvedList);
    const danglingFks = allUnresolved.filter(
      (u) => isSid(u.value)
    );
    const displayNames = allUnresolved.filter(
      (u) => isDisplayName(u.value) && !isSid(u.value)
    );
    const slugLike = allUnresolved.filter(
      (u) => !isSid(u.value) && !isDisplayName(u.value)
    );

    if (danglingFks.length > 0) {
      console.log(
        `\n${c.red}Dangling stableId references (entity not found):${c.reset}`
      );
      const toShow = verbose ? danglingFks : danglingFks.slice(0, 10);
      for (const ref of toShow) {
        console.log(
          `  ${c.red}x${c.reset} ${ref.table}.${ref.field} = "${ref.value}" (record ${ref.recordId})`
        );
      }
      if (!verbose && danglingFks.length > 10) {
        console.log(
          `  ${c.dim}... and ${danglingFks.length - 10} more (use --verbose)${c.reset}`
        );
      }
    }

    if (slugLike.length > 0) {
      console.log(
        `\n${c.yellow}Unresolved slug references:${c.reset}`
      );
      const toShow = verbose ? slugLike : slugLike.slice(0, 10);
      for (const ref of toShow) {
        console.log(
          `  ${c.yellow}~${c.reset} ${ref.table}.${ref.field} = "${ref.value}" (record ${ref.recordId})`
        );
      }
      if (!verbose && slugLike.length > 10) {
        console.log(
          `  ${c.dim}... and ${slugLike.length - 10} more (use --verbose)${c.reset}`
        );
      }
    }

    if (displayNames.length > 0 && verbose) {
      console.log(
        `\n${c.dim}Unresolved display names (expected — no entity created yet):${c.reset}`
      );
      const toShow = displayNames.slice(0, 20);
      for (const ref of toShow) {
        console.log(
          `  ${c.dim}-${c.reset} ${ref.table}.${ref.field} = "${ref.value}" (record ${ref.recordId})`
        );
      }
      if (displayNames.length > 20) {
        console.log(
          `  ${c.dim}... and ${displayNames.length - 20} more${c.reset}`
        );
      }
    }

    // Summary
    console.log("");
    if (unresolvedRefs === 0) {
      console.log(
        `${c.green}All ${totalRefs} soft FK references resolve to known entities.${c.reset}`
      );
    } else {
      console.log(
        `${c.yellow}${unresolvedRefs} unresolved reference(s) out of ${totalRefs} total (${linkRate.toFixed(1)}% link rate).${c.reset}`
      );
      console.log(
        `${c.dim}  Dangling stableIds: ${danglingFks.length} | Unresolved slugs: ${slugLike.length} | Display names: ${displayNames.length}${c.reset}`
      );
    }
  }

  // CI JSON output
  if (ci) {
    console.log(
      JSON.stringify({
        passed: true, // Always advisory
        totalRefs,
        resolvedRefs,
        unresolvedRefs,
        linkRate: parseFloat(linkRate.toFixed(1)),
        byTable: Object.fromEntries(
          allStats.map((s) => [
            s.table,
            {
              records: s.totalRecords,
              refs: s.totalRefs,
              resolved: s.resolvedRefs,
              unresolved: s.unresolvedRefs,
              rate:
                s.totalRefs > 0
                  ? parseFloat(
                      ((s.resolvedRefs / s.totalRefs) * 100).toFixed(1)
                    )
                  : 100,
            },
          ])
        ),
        unresolvedDetails: allStats.flatMap((s) =>
          s.unresolvedList.map((u) => ({
            table: u.table,
            recordId: u.recordId,
            field: u.field,
            value: u.value,
            resolvedFkNull: u.resolvedFkNull,
          }))
        ),
      })
    );
  }

  return {
    passed: true, // advisory — always passes
    stats: allStats,
    totalRefs,
    resolvedRefs,
    unresolvedRefs,
    linkRate,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");

  await runValidation({ verbose, ci });
}

if (process.argv[1]?.includes("validate-soft-fks")) {
  main().catch((err) => {
    console.error("Soft FK validation crashed:", err);
    process.exit(1);
  });
}
