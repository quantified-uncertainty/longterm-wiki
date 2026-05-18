#!/usr/bin/env node

/**
 * Tablebase Route Completeness Validator
 *
 * Scans all tablebase route files and checks that each route with a /sync
 * endpoint also has the expected companion operations:
 *
 *   1. delete-batch endpoint (POST /delete-batch or POST /delete)
 *   2. things table dual-write (upsertThingsInTx call in sync handler)
 *   3. entity ref validation (validateEntityRefs/findMissingEntityRefs)
 *
 * Routes that accept entity references but don't validate them are flagged.
 * Routes that sync data but can't delete it are flagged.
 *
 * Outputs a coverage grid and returns non-zero if blocking violations exist.
 *
 * Usage: npx tsx crux/validate/validate-tablebase-completeness.ts
 */

import { readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { getColors } from "../lib/output.ts";
import { TABLEBASE_NON_ROUTE_FILES } from "../../apps/wiki-server/src/api-types.ts";

const ROUTES_DIR = "apps/wiki-server/src/routes/tablebase";
const c = getColors(process.env.CI === "true");

// ── Configuration ──────────────────────────────────────────────────────

/**
 * Routes that are exempt from specific checks with documented reasons.
 * Every exemption must have a reason — no silent skips.
 */
const EXEMPTIONS: Record<string, Record<string, string>> = {
  // Infrastructure/meta routes — not domain entity tables
  "things.ts": {
    delete: "Meta-index table; records are managed by domain route sync, not directly deleted",
    thingsSync: "IS the things table — doesn't sync to itself",
  },
  "ids.ts": {
    delete: "ID allocation service, not a domain entity table",
    thingsSync: "Not a domain entity table",
  },
  "record-lookup.ts": {
    delete: "Read-only lookup service across all tables",
    thingsSync: "Read-only, no data to sync",
  },
  "entity-profile.ts": {
    delete: "Aggregated read view across multiple tables",
    thingsSync: "Profile descriptions are entity metadata, not indexed in things",
  },
  "entity-profile-descriptions.ts": {
    delete: "Profile descriptions are regenerated, not individually managed",
    thingsSync: "Computed metadata, not a domain entity",
  },
  "people.ts": {
    delete: "Aggregated person view; actual records deleted via personnel/entities routes",
    thingsSync: "Source records already synced to things by personnel/entities routes",
  },
  "talent-flows.ts": {
    delete: "Computed/derived data, regenerated from personnel",
    thingsSync: "Derived analytics data, not a domain entity",
  },

  // Domain routes with legitimate exemptions from things sync
  "entities.ts": {
    delete: "Has POST /prune for bulk removal + individual entity management",
    entityRefValidation: "Has custom ref validation via checkRefsExist() that strips invalid refs",
  },
  "data-sources.ts": {
    thingsSync: "Data sources are metadata about where data comes from, not indexed entities",
  },
  "website-sources.ts": {
    thingsSync: "Website content snapshots, not domain entities that need search indexing",
  },
  "bluesky.ts": {
    thingsSync: "Social media posts, synced per-account; not domain entities",
  },
  "platform-accounts.ts": {
    thingsSync: "Account links between entities and platforms; the entity itself is already in things",
  },
  "political-scores.ts": {
    thingsSync: "Numeric scores attached to politicians; not independently searchable",
  },
  "political-offices.ts": {
    thingsSync: "Office records (e.g. 'US Senate seat'); referenced by races, not standalone",
  },
  "political-votes.ts": {
    thingsSync: "Individual vote records; too granular for things index",
  },
  "campaign-finance.ts": {
    thingsSync: "Financial transaction records; too granular for things index",
  },
  "prediction-markets.ts": {
    thingsSync: "Market questions are tied to entities; the entity is already in things",
  },
  "secondary-market-prices.ts": {
    thingsSync: "Price time-series data; too granular for things index",
  },
};

// Non-route files are sourced from the canonical list in mount-registry.ts
// so all three consumers (this validator, validate-tablebase-registry.ts,
// and mount-registry.test.ts) share one source of truth.
const NON_ROUTE_FILES = new Set<string>(TABLEBASE_NON_ROUTE_FILES);

// ── Analysis ───────────────────────────────────────────────────────────

interface RouteAnalysis {
  file: string;
  hasSync: boolean;
  hasDelete: boolean;
  /** Number of /sync endpoints (including sub-resource: /questions/sync, etc.) */
  syncCount: number;
  /** Number of delete endpoints (delete-batch, /delete, HTTP DELETE) */
  deleteCount: number;
  hasThingsSync: boolean;
  hasEntityRefValidation: boolean;
  acceptsEntityRefs: boolean;
  /** Which checks this route is exempt from, with reasons */
  exemptions: Record<string, string>;
}

/** Patterns that indicate entity reference fields in sync schemas */
const ENTITY_REF_PATTERNS = [
  /organizationId/,
  /personId/,
  /companyId/,
  /investorId/,
  /holderId/,
  /modelId/,
  /[^.]entityId/,  // avoid matching c.get("entityId") etc.
  /policyEntityId/,
  /politicianEntityId/,
  /legislationEntityId/,
  /candidateEntityId/,
  /pacEntityId/,
  /granteeId/,
  /parentOrgId/,
  /divisionId/,
  /stakeholderEntityId/,
  /publisherEntityId/,
  /entityStableId/,
];

function analyzeRoute(filePath: string): RouteAnalysis {
  const content = readFileSync(filePath, "utf-8");
  const file = basename(filePath);

  // Match /sync, /questions/sync, /snapshots/sync, etc.
  // Use [\w-]+ to support hyphenated sub-paths like /funding-rounds/sync.
  const syncMatches = content.match(/\.post\(["']\/(?:[\w-]+\/)?sync["']/g) ?? [];
  const syncCount = syncMatches.length;
  const hasSync = syncCount > 0;
  // Match POST /delete-batch, POST /delete, POST /questions/delete-batch, or HTTP DELETE methods
  // Exclude drizzle .delete() calls (those are `tx.delete(table)`, not `.delete("/path"`)
  const deleteMatches = [
    ...(content.match(/\.post\(["']\/(?:[\w-]+\/)?delete-batch["']/g) ?? []),
    ...(content.match(/\.post\(["']\/delete["']/g) ?? []),
    ...(content.match(/\.delete\(["']\//g) ?? []),
  ];
  const deleteCount = deleteMatches.length;
  const hasDelete = deleteCount > 0;
  // Routes using createSyncHandler get things sync and entity ref validation
  // via the factory's config (toThing, entityRefs/entityRefFields). The factory
  // calls upsertThingsInTx and validateEntityRefs internally — the route file
  // doesn't need to import them directly.
  const usesFactory = /createSyncHandler/.test(content);
  const hasThingsSync = /upsertThingsInTx/.test(content) ||
    (usesFactory && /toThing/.test(content));
  const hasEntityRefValidation =
    /validateEntityRefs/.test(content) ||
    /findMissingEntityRefs/.test(content) ||
    (usesFactory && (/entityRefs/.test(content) || /entityRefFields/.test(content)));

  // Check if the sync schema references entity ID fields
  const acceptsEntityRefs = ENTITY_REF_PATTERNS.some((p) => p.test(content));

  return {
    file,
    hasSync,
    hasDelete,
    syncCount,
    deleteCount,
    hasThingsSync,
    hasEntityRefValidation,
    acceptsEntityRefs,
    exemptions: EXEMPTIONS[file] ?? {},
  };
}

// ── Violation Detection ────────────────────────────────────────────────

interface Violation {
  file: string;
  check: string;
  message: string;
  blocking: boolean;
}

function findViolations(routes: RouteAnalysis[]): Violation[] {
  const violations: Violation[] = [];

  for (const route of routes) {
    // Only check routes that have a /sync endpoint (domain entity routes)
    if (!route.hasSync) continue;

    // Check 1: Missing delete endpoint
    // Blocking: all pre-existing gaps fixed by the shared delete factory.
    // New routes must include delete-batch or add an exemption with a reason.
    // Scoped: if a file has N sync endpoints, it should have at least N delete endpoints
    // (each synced resource should be deletable).
    if (!route.hasDelete && !route.exemptions.delete) {
      violations.push({
        file: route.file,
        check: "delete",
        message: `Has /sync but no /delete-batch endpoint`,
        blocking: true,
      });
    } else if (route.syncCount > route.deleteCount && !route.exemptions.delete) {
      violations.push({
        file: route.file,
        check: "delete",
        message: `Has ${route.syncCount} /sync endpoints but only ${route.deleteCount} /delete endpoint(s) — some synced resources have no delete`,
        blocking: false, // non-blocking: existing gap, flag for awareness
      });
    }

    // Check 2: Missing things sync
    if (!route.hasThingsSync && !route.exemptions.thingsSync) {
      violations.push({
        file: route.file,
        check: "thingsSync",
        message: `Has /sync but no upsertThingsInTx call — records won't appear in search`,
        blocking: false,
      });
    }

    // Check 3: Accepts entity refs but doesn't validate them
    // Blocking: all pre-existing gaps fixed. New routes with entity refs must validate.
    if (
      route.acceptsEntityRefs &&
      !route.hasEntityRefValidation &&
      !route.exemptions.entityRefValidation
    ) {
      violations.push({
        file: route.file,
        check: "entityRefValidation",
        message: `Accepts entity reference fields but doesn't call validateEntityRefs`,
        blocking: true,
      });
    }
  }

  return violations;
}

// ── Output ─────────────────────────────────────────────────────────────

function printGrid(routes: RouteAnalysis[]) {
  // Only show routes with sync endpoints (domain entity tables)
  const domainRoutes = routes.filter((r) => r.hasSync);

  // Sort: routes with violations first, then alphabetical
  const violations = findViolations(routes);
  const violationFiles = new Set(violations.map((v) => v.file));

  domainRoutes.sort((a, b) => {
    const aHasViolation = violationFiles.has(a.file);
    const bHasViolation = violationFiles.has(b.file);
    if (aHasViolation !== bHasViolation) return aHasViolation ? -1 : 1;
    return a.file.localeCompare(b.file);
  });

  const maxNameLen = Math.max(...domainRoutes.map((r) => r.file.length), 20);

  console.log(
    `\n${c.bold}Tablebase Route Completeness${c.reset}\n`
  );
  console.log(
    `  ${"Route".padEnd(maxNameLen)}  Sync  Delete  Things  EntityRefs`
  );
  console.log(`  ${"─".repeat(maxNameLen)}  ────  ──────  ──────  ──────────`);

  for (const route of domainRoutes) {
    const syncCell = cellValue(route.hasSync, false);
    const deleteCell = cellValue(route.hasDelete, !!route.exemptions.delete);
    const thingsCell = cellValue(
      route.hasThingsSync,
      !!route.exemptions.thingsSync
    );
    const refsCell = route.acceptsEntityRefs
      ? cellValue(
          route.hasEntityRefValidation,
          !!route.exemptions.entityRefValidation
        )
      : `${c.dim}──${c.reset}`;

    console.log(
      `  ${route.file.padEnd(maxNameLen)}  ${syncCell}    ${deleteCell}      ${thingsCell}      ${refsCell}`
    );
  }

  console.log("");
  console.log(
    `  ${c.green}✓${c.reset} = present  ${c.red}✗${c.reset} = missing  ${c.yellow}~${c.reset} = exempt  ${c.dim}──${c.reset} = N/A`
  );
}

function cellValue(present: boolean, exempt: boolean): string {
  if (present) return `${c.green}✓${c.reset} `;
  if (exempt) return `${c.yellow}~${c.reset} `;
  return `${c.red}✗${c.reset} `;
}

function printViolations(violations: Violation[]) {
  const blocking = violations.filter((v) => v.blocking);
  const advisory = violations.filter((v) => !v.blocking);

  if (advisory.length > 0) {
    console.log(`\n${c.yellow}Advisory (${advisory.length}):${c.reset}`);
    for (const v of advisory) {
      console.log(`  ${c.yellow}⚠${c.reset} ${v.file}: ${v.message}`);
    }
  }

  if (blocking.length > 0) {
    console.log(`\n${c.red}Blocking (${blocking.length}):${c.reset}`);
    for (const v of blocking) {
      console.log(`  ${c.red}✗${c.reset} ${v.file}: ${v.message}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────

export function runCheck() {
  const files = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts") && !NON_ROUTE_FILES.has(f))
    .map((f) => join(ROUTES_DIR, f));

  const routes = files.map(analyzeRoute);
  const violations = findViolations(routes);

  printGrid(routes);
  printViolations(violations);

  const blocking = violations.filter((v) => v.blocking);
  const advisory = violations.filter((v) => !v.blocking);

  console.log(
    `\n${blocking.length === 0 ? c.green + "✓" : c.red + "✗"} ${blocking.length} blocking, ${advisory.length} advisory${c.reset}`
  );

  return {
    passed: blocking.length === 0,
    errors: blocking.map((v) => `${v.file}: ${v.message}`),
    violations,
  };
}

// Run standalone
if (process.argv[1]?.endsWith("validate-tablebase-completeness.ts")) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
