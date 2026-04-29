#!/usr/bin/env node

/**
 * Resource Reference Validation — checks that JSONB reference fields in the
 * resources table point to valid entities and publications.
 *
 * Validates:
 *   - author_entity_ids: each stableId in the JSONB array must exist in the entities table
 *   - publication_id: must match an id in data/publications.yaml
 *
 * Requires wiki-server to be running (queries the API). Advisory — not CI-blocking.
 *
 * Usage:
 *   npx tsx crux/validate/validate-resource-refs.ts              # advisory mode
 *   npx tsx crux/validate/validate-resource-refs.ts --verbose     # show all unresolved refs
 *   npx tsx crux/validate/validate-resource-refs.ts --ci          # JSON output
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";
import {
  apiRequest,
  type ApiResult,
} from "../lib/wiki-server/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single unresolved reference in a resource record. */
export interface UnresolvedResourceRef {
  resourceId: string;
  field: "authorEntityIds" | "publicationId";
  value: string;
}

/** Aggregated validation results. */
export interface ResourceRefStats {
  totalResources: number;
  authorEntityIdRefs: number;
  validAuthorEntityIdRefs: number;
  invalidAuthorEntityIdRefs: number;
  publicationIdRefs: number;
  validPublicationIdRefs: number;
  invalidPublicationIdRefs: number;
  unresolvedList: UnresolvedResourceRef[];
}

// ---------------------------------------------------------------------------
// API helpers
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
 * Build a set of entity stableIds from the entities API.
 */
export async function buildEntityStableIdSet(): Promise<Set<string> | null> {
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

  return new Set(allEntities.map((e) => e.stableId));
}

// ---------------------------------------------------------------------------
// Publication ID lookup
// ---------------------------------------------------------------------------

/**
 * Load publication IDs from data/publications.yaml.
 */
export function loadPublicationIds(): Set<string> {
  const pubPath = join(PROJECT_ROOT, "data", "publications.yaml");
  if (!existsSync(pubPath)) {
    return new Set();
  }
  const content = readFileSync(pubPath, "utf-8");
  const data = parseYaml(content) as Array<{ id: string }> | null;
  if (!Array.isArray(data)) {
    return new Set();
  }
  return new Set(data.map((p) => p.id));
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

/**
 * Validate resource reference fields against entity and publication lookups.
 */
export function validateResources(
  resources: Array<Record<string, unknown>>,
  entityStableIds: Set<string>,
  publicationIds: Set<string>,
): ResourceRefStats {
  const stats: ResourceRefStats = {
    totalResources: resources.length,
    authorEntityIdRefs: 0,
    validAuthorEntityIdRefs: 0,
    invalidAuthorEntityIdRefs: 0,
    publicationIdRefs: 0,
    validPublicationIdRefs: 0,
    invalidPublicationIdRefs: 0,
    unresolvedList: [],
  };

  for (const resource of resources) {
    const resourceId = resource.id as string;

    // Validate authorEntityIds
    const authorEntityIds = resource.authorEntityIds as string[] | null;
    if (Array.isArray(authorEntityIds) && authorEntityIds.length > 0) {
      for (const entityId of authorEntityIds) {
        stats.authorEntityIdRefs++;
        if (entityStableIds.has(entityId)) {
          stats.validAuthorEntityIdRefs++;
        } else {
          stats.invalidAuthorEntityIdRefs++;
          stats.unresolvedList.push({
            resourceId,
            field: "authorEntityIds",
            value: entityId,
          });
        }
      }
    }

    // Validate publicationId
    const publicationId = resource.publicationId as string | null;
    if (publicationId) {
      stats.publicationIdRefs++;
      if (publicationIds.has(publicationId)) {
        stats.validPublicationIdRefs++;
      } else {
        stats.invalidPublicationIdRefs++;
        stats.unresolvedList.push({
          resourceId,
          field: "publicationId",
          value: publicationId,
        });
      }
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main validation runner
// ---------------------------------------------------------------------------

export async function runValidation(opts: {
  verbose?: boolean;
  ci?: boolean;
}): Promise<{
  passed: boolean;
  stats: ResourceRefStats | null;
}> {
  const { verbose = false, ci = false } = opts;
  const c = getColors(ci);

  // Step 1: Load entity lookup from wiki-server
  if (!ci) {
    console.log(
      `${c.cyan}Loading entities from wiki-server...${c.reset}`
    );
  }

  const entityStableIds = await buildEntityStableIdSet();
  if (!entityStableIds) {
    if (!ci) {
      console.log(
        `${c.red}Failed to load entities from wiki-server. Is the server running?${c.reset}`
      );
    }
    return { passed: true, stats: null };
  }

  if (!ci) {
    console.log(
      `${c.dim}  Loaded ${entityStableIds.size} entity stableIds${c.reset}`
    );
  }

  // Step 2: Load publication IDs from YAML
  const publicationIds = loadPublicationIds();
  if (!ci) {
    console.log(
      `${c.dim}  Loaded ${publicationIds.size} publication IDs from publications.yaml${c.reset}`
    );
  }

  // Step 3: Fetch all resources from wiki-server
  if (!ci) {
    console.log(
      `${c.cyan}Loading resources from wiki-server...${c.reset}`
    );
  }

  const resources = await fetchAllRecords(
    "/api/resources/all",
    "resources",
    200
  );
  if (!resources) {
    if (!ci) {
      console.log(
        `${c.red}Failed to load resources from wiki-server.${c.reset}`
      );
    }
    return { passed: true, stats: null };
  }

  if (!ci) {
    console.log(
      `${c.dim}  Loaded ${resources.length} resources${c.reset}`
    );
  }

  // Step 4: Validate
  const stats = validateResources(
    resources,
    entityStableIds,
    publicationIds
  );

  // Step 5: Report
  const totalRefs = stats.authorEntityIdRefs + stats.publicationIdRefs;
  const totalValid =
    stats.validAuthorEntityIdRefs + stats.validPublicationIdRefs;
  const totalInvalid =
    stats.invalidAuthorEntityIdRefs + stats.invalidPublicationIdRefs;
  const linkRate =
    totalRefs > 0 ? (totalValid / totalRefs) * 100 : 100;

  if (!ci) {
    console.log(
      `\n${c.bold}${c.blue}Resource Reference Validation${c.reset}\n`
    );

    // Table
    console.log(
      "| Field              | Total Refs | Valid | Invalid | Rate    |"
    );
    console.log(
      "|--------------------|------------|-------|---------|---------|"
    );

    const authorRate =
      stats.authorEntityIdRefs > 0
        ? (
            (stats.validAuthorEntityIdRefs / stats.authorEntityIdRefs) *
            100
          ).toFixed(1) + "%"
        : "N/A";
    const pubRate =
      stats.publicationIdRefs > 0
        ? (
            (stats.validPublicationIdRefs / stats.publicationIdRefs) *
            100
          ).toFixed(1) + "%"
        : "N/A";

    console.log(
      `| authorEntityIds    | ${stats.authorEntityIdRefs.toString().padStart(10)} | ${stats.validAuthorEntityIdRefs.toString().padStart(5)} | ${stats.invalidAuthorEntityIdRefs.toString().padStart(7)} | ${authorRate.padStart(7)} |`
    );
    console.log(
      `| publicationId      | ${stats.publicationIdRefs.toString().padStart(10)} | ${stats.validPublicationIdRefs.toString().padStart(5)} | ${stats.invalidPublicationIdRefs.toString().padStart(7)} | ${pubRate.padStart(7)} |`
    );
    console.log(
      "|--------------------|------------|-------|---------|---------|"
    );
    console.log(
      `| TOTAL              | ${totalRefs.toString().padStart(10)} | ${totalValid.toString().padStart(5)} | ${totalInvalid.toString().padStart(7)} | ${(linkRate.toFixed(1) + "%").padStart(7)} |`
    );

    // Print unresolved details
    const authorErrors = stats.unresolvedList.filter(
      (u) => u.field === "authorEntityIds"
    );
    const pubErrors = stats.unresolvedList.filter(
      (u) => u.field === "publicationId"
    );

    if (authorErrors.length > 0) {
      console.log(
        `\n${c.red}Invalid authorEntityIds (entity stableId not found):${c.reset}`
      );
      const toShow = verbose ? authorErrors : authorErrors.slice(0, 10);
      for (const ref of toShow) {
        console.log(
          `  ${c.red}x${c.reset} resource ${ref.resourceId} — authorEntityIds contains "${ref.value}"`
        );
      }
      if (!verbose && authorErrors.length > 10) {
        console.log(
          `  ${c.dim}... and ${authorErrors.length - 10} more (use --verbose)${c.reset}`
        );
      }
    }

    if (pubErrors.length > 0) {
      console.log(
        `\n${c.yellow}Invalid publicationId (not in publications.yaml):${c.reset}`
      );
      const toShow = verbose ? pubErrors : pubErrors.slice(0, 10);
      for (const ref of toShow) {
        console.log(
          `  ${c.yellow}~${c.reset} resource ${ref.resourceId} — publicationId = "${ref.value}"`
        );
      }
      if (!verbose && pubErrors.length > 10) {
        console.log(
          `  ${c.dim}... and ${pubErrors.length - 10} more (use --verbose)${c.reset}`
        );
      }
    }

    // Summary
    console.log("");
    if (totalInvalid === 0) {
      console.log(
        `${c.green}All ${totalRefs} resource references are valid.${c.reset}`
      );
    } else {
      console.log(
        `${c.yellow}${totalInvalid} invalid reference(s) out of ${totalRefs} total (${linkRate.toFixed(1)}% link rate).${c.reset}`
      );
    }
  }

  // CI JSON output
  if (ci) {
    console.log(
      JSON.stringify({
        passed: true, // advisory — always passes
        totalResources: stats.totalResources,
        totalRefs,
        validRefs: totalValid,
        invalidRefs: totalInvalid,
        linkRate: parseFloat(linkRate.toFixed(1)),
        authorEntityIds: {
          total: stats.authorEntityIdRefs,
          valid: stats.validAuthorEntityIdRefs,
          invalid: stats.invalidAuthorEntityIdRefs,
        },
        publicationId: {
          total: stats.publicationIdRefs,
          valid: stats.validPublicationIdRefs,
          invalid: stats.invalidPublicationIdRefs,
        },
        unresolvedDetails: stats.unresolvedList.map((u) => ({
          resourceId: u.resourceId,
          field: u.field,
          value: u.value,
        })),
      })
    );
  }

  return { passed: true, stats };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");

  await runValidation({ verbose, ci });
}

if (process.argv[1]?.includes("validate-resource-refs")) {
  main().catch((err) => {
    console.error("Resource reference validation crashed:", err);
    process.exit(1);
  });
}
