/**
 * Normalize IDs — Fix slug-based entity IDs in PG records.
 *
 * Personnel records may have `personId` or `organizationId` set to slugs
 * (e.g., "center-for-ai-safety") instead of proper stableIds (e.g., "mK9pX3rQ7n").
 * Grant records may have `granteeId` set to slugs similarly.
 *
 * This module loads the entity registry (slug→stableId mapping from YAML files),
 * fetches records from the wiki-server, identifies slug-based IDs, resolves them,
 * and optionally applies fixes via the wiki-server API.
 *
 * Usage (via crux CLI):
 *   pnpm crux tb normalize-ids                      # Dry-run: report what would change
 *   pnpm crux tb normalize-ids --apply              # Apply fixes
 *   WIKI_SERVER_ENV=prod pnpm crux tb normalize-ids  # Target production
 */

import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { loadEntityRegistry } from "../validate/validate-kb-entity-slugs.ts";
import { apiRequest } from "../lib/wiki-server/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersonnelRecord {
  id: string;
  personId: string;
  organizationId: string;
  role?: string;
  [key: string]: unknown;
}

interface GrantRecord {
  id: string;
  granteeId: string | null;
  name: string;
  [key: string]: unknown;
}

interface IdFix {
  recordId: string;
  table: string;
  field: string;
  oldValue: string;
  newValue: string;
  /** Human-readable context (role, grant name, etc.) */
  context: string;
}

// ---------------------------------------------------------------------------
// Detection heuristics
// ---------------------------------------------------------------------------

/**
 * A stableId is a 10-char mixed-case alphanumeric string (e.g., "mK9pX3rQ7n").
 * Some generated IDs may be slightly different but always match this pattern.
 */
function looksLikeStableId(value: string): boolean {
  return /^[A-Za-z0-9]{10}$/.test(value);
}

/**
 * A slug is a lowercase-hyphenated string (e.g., "center-for-ai-safety").
 * We detect slugs as values that contain hyphens, or are all-lowercase and
 * longer than 10 characters. We exclude values that look like stableIds.
 */
function looksLikeSlug(value: string): boolean {
  if (looksLikeStableId(value)) return false;
  // Contains a hyphen → almost certainly a slug
  if (value.includes("-")) return true;
  // All lowercase and longer than 10 chars → likely a slug
  if (value === value.toLowerCase() && value.length > 10) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Fetching helpers
// ---------------------------------------------------------------------------

async function fetchAllPersonnel(): Promise<PersonnelRecord[]> {
  const all: PersonnelRecord[] = [];
  let offset = 0;

  while (true) {
    const r = await apiRequest<{
      personnel: PersonnelRecord[];
      total: number;
    }>("GET", `/api/personnel/all?limit=200&offset=${offset}`);

    if (!r.ok) {
      throw new Error(`Failed to fetch personnel: ${r.message}`);
    }

    all.push(...r.data.personnel);
    if (all.length >= r.data.total) break;
    offset += 200;
  }

  return all;
}

async function fetchAllGrantIds(): Promise<GrantRecord[]> {
  const r = await apiRequest<{
    grants: GrantRecord[];
    total: number;
  }>("GET", "/api/grants/all-grantee-ids");

  if (!r.ok) {
    throw new Error(`Failed to fetch grants: ${r.message}`);
  }

  return r.data.grants;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export interface NormalizeResult {
  fixes: IdFix[];
  unresolved: Array<{
    table: string;
    field: string;
    recordId: string;
    value: string;
    context: string;
  }>;
  applied: number;
  personnelChecked: number;
  grantsChecked: number;
}

export async function normalizeIds(
  apply: boolean,
  options?: { quiet?: boolean }
): Promise<NormalizeResult> {
  const log = options?.quiet ? (() => {}) : console.log.bind(console);
  // 1. Load entity registry
  const entitiesDir = join(PROJECT_ROOT, "data", "entities");
  const { slugToStableId } = loadEntityRegistry(entitiesDir);

  log(
    `Entity registry loaded: ${slugToStableId.size} slug→stableId mappings\n`
  );

  const fixes: IdFix[] = [];
  const unresolved: NormalizeResult["unresolved"] = [];

  // 2. Check personnel records
  log("Fetching personnel records...");
  const personnel = await fetchAllPersonnel();
  log(`  ${personnel.length} personnel records fetched\n`);

  for (const rec of personnel) {
    const context = `role: ${rec.role ?? "(none)"}, org: ${rec.organizationId}`;

    // Check personId
    if (rec.personId && looksLikeSlug(rec.personId)) {
      const stableId = slugToStableId.get(rec.personId);
      if (stableId) {
        fixes.push({
          recordId: rec.id,
          table: "personnel",
          field: "personId",
          oldValue: rec.personId,
          newValue: stableId,
          context,
        });
      } else {
        unresolved.push({
          table: "personnel",
          field: "personId",
          recordId: rec.id,
          value: rec.personId,
          context,
        });
      }
    }

    // Check organizationId
    if (rec.organizationId && looksLikeSlug(rec.organizationId)) {
      const stableId = slugToStableId.get(rec.organizationId);
      if (stableId) {
        fixes.push({
          recordId: rec.id,
          table: "personnel",
          field: "organizationId",
          oldValue: rec.organizationId,
          newValue: stableId,
          context: `role: ${rec.role ?? "(none)"}, person: ${rec.personId}`,
        });
      } else {
        unresolved.push({
          table: "personnel",
          field: "organizationId",
          recordId: rec.id,
          value: rec.organizationId,
          context: `role: ${rec.role ?? "(none)"}, person: ${rec.personId}`,
        });
      }
    }
  }

  // 3. Check grant records
  log("Fetching grant records...");
  const grants = await fetchAllGrantIds();
  log(`  ${grants.length} grant records fetched\n`);

  for (const grant of grants) {
    if (grant.granteeId && looksLikeSlug(grant.granteeId)) {
      const stableId = slugToStableId.get(grant.granteeId);
      if (stableId) {
        fixes.push({
          recordId: grant.id,
          table: "grants",
          field: "granteeId",
          oldValue: grant.granteeId,
          newValue: stableId,
          context: `grant: ${grant.name}`,
        });
      } else {
        unresolved.push({
          table: "grants",
          field: "granteeId",
          recordId: grant.id,
          value: grant.granteeId,
          context: `grant: ${grant.name}`,
        });
      }
    }
  }

  // 4. Report
  const personnelFixes = fixes.filter((f) => f.table === "personnel");
  const grantFixes = fixes.filter((f) => f.table === "grants");

  log("=== Normalize IDs Report ===\n");
  log(`Personnel records checked: ${personnel.length}`);
  log(`Grant records checked:     ${grants.length}`);
  log(
    `Slug-based IDs found:      ${fixes.length} (${personnelFixes.length} personnel, ${grantFixes.length} grants)`
  );
  log(`Unresolved slugs:          ${unresolved.length}\n`);

  if (fixes.length > 0) {
    log("\x1b[1mFixes:\x1b[0m");
    for (const fix of fixes) {
      const action = apply ? "\x1b[32m  FIX" : "\x1b[33m  WOULD FIX";
      log(
        `${action}\x1b[0m [${fix.table}.${fix.field}] record ${fix.recordId}: "${fix.oldValue}" -> "${fix.newValue}" (${fix.context})`
      );
    }
    log("");
  }

  if (unresolved.length > 0) {
    log("\x1b[31m\x1b[1mUnresolved (no stableId in registry):\x1b[0m");
    for (const u of unresolved) {
      log(
        `  \x1b[31mx\x1b[0m [${u.table}.${u.field}] record ${u.recordId}: "${u.value}" (${u.context})`
      );
    }
    log("");
  }

  // 5. Apply fixes if requested
  let applied = 0;

  if (apply && fixes.length > 0) {
    // Apply personnel fixes via /api/personnel/sync
    if (personnelFixes.length > 0) {
      log(
        `Applying ${personnelFixes.length} personnel fixes...`
      );

      // Build a map of recordId → fixed record
      const fixMap = new Map<string, Partial<PersonnelRecord>>();
      for (const fix of personnelFixes) {
        if (!fixMap.has(fix.recordId)) {
          // Find the original record
          const original = personnel.find((p) => p.id === fix.recordId);
          if (original) {
            fixMap.set(fix.recordId, { ...original });
          }
        }
        const rec = fixMap.get(fix.recordId);
        if (rec) {
          (rec as Record<string, unknown>)[fix.field] = fix.newValue;
        }
      }

      // Send in batches
      const items = [...fixMap.values()];
      const BATCH_SIZE = 100;
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const r = await apiRequest<{ upserted: number }>(
          "POST",
          "/api/personnel/sync?skipEntityValidation=true",
          { items: batch }
        );
        if (r.ok) {
          applied += r.data.upserted;
          log(
            `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${r.data.upserted} records updated`
          );
        } else {
          console.error(
            `  \x1b[31mBatch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${r.message}\x1b[0m`
          );
        }
      }
    }

    // Apply grant fixes via /api/grants/batch-update-grantee
    if (grantFixes.length > 0) {
      log(`\nApplying ${grantFixes.length} grant fixes...`);

      const grantItems = grantFixes.map((fix) => ({
        id: fix.recordId,
        granteeId: fix.newValue,
      }));

      const BATCH_SIZE = 200;
      for (let i = 0; i < grantItems.length; i += BATCH_SIZE) {
        const batch = grantItems.slice(i, i + BATCH_SIZE);
        const r = await apiRequest<{ updated: number }>(
          "PATCH",
          "/api/grants/batch-update-grantee",
          { items: batch }
        );
        if (r.ok) {
          applied += r.data.updated;
          log(
            `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${r.data.updated} grants updated`
          );
        } else {
          console.error(
            `  \x1b[31mBatch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${r.message}\x1b[0m`
          );
        }
      }
    }

    log(`\n\x1b[32m✓ Applied ${applied} fixes total\x1b[0m`);
  } else if (!apply && fixes.length > 0) {
    log(
      "\x1b[2mRun with --apply to fix these records.\x1b[0m"
    );
  } else if (fixes.length === 0) {
    log("\x1b[32m✓ No slug-based IDs found. All records use proper stableIds.\x1b[0m");
  }

  return {
    fixes,
    unresolved,
    applied,
    personnelChecked: personnel.length,
    grantsChecked: grants.length,
  };
}
