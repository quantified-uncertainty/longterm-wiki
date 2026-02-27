/**
 * Claims Cleanup — Automated Tier 1 data quality fixes
 *
 * Two cleanup operations:
 * 1. Deduplicate exact-match claims within the same entity
 * 2. Strip self-references from relatedEntities
 *
 * Usage:
 *   pnpm crux claims cleanup                     # dry-run (default)
 *   pnpm crux claims cleanup --apply              # actually make changes
 *   pnpm crux claims cleanup --entity=anthropic   # target a specific entity
 */

import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { apiRequest, isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  deleteClaimsByIds,
  batchUpdateRelatedEntities,
  type ClaimRow,
} from '../lib/wiki-server/claims.ts';
import { normalizeClaimText } from '../lib/claim-utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AllClaimsResponse {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

interface DuplicateGroup {
  normalizedText: string;
  claims: ClaimRow[];
  keepId: number;
  deleteIds: number[];
}

interface SelfRefFix {
  claimId: number;
  entityId: string;
  oldRelatedEntities: string[];
  newRelatedEntities: string[];
}

interface EntityCleanupResult {
  entityId: string;
  duplicateGroups: DuplicateGroup[];
  selfRefFixes: SelfRefFix[];
}

// ---------------------------------------------------------------------------
// Fetch claims (paginated via /api/claims/all)
// ---------------------------------------------------------------------------

async function fetchAllClaims(
  opts: { entityId?: string },
): Promise<ClaimRow[]> {
  const PAGE_SIZE = 200;
  const allClaims: ClaimRow[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (opts.entityId) {
      params.set('entityId', opts.entityId);
    }

    const result = await apiRequest<AllClaimsResponse>(
      'GET',
      `/api/claims/all?${params.toString()}`,
      undefined,
      15_000,
    );

    if (!result.ok) {
      throw new Error(`Failed to fetch claims: ${result.message}`);
    }

    allClaims.push(...result.data.claims);

    if (result.data.claims.length < PAGE_SIZE || allClaims.length >= result.data.total) {
      break;
    }

    offset += result.data.claims.length;
  }

  return allClaims;
}

// ---------------------------------------------------------------------------
// Group claims by entity
// ---------------------------------------------------------------------------

function groupByEntity(claims: ClaimRow[]): Map<string, ClaimRow[]> {
  const map = new Map<string, ClaimRow[]>();
  for (const claim of claims) {
    const existing = map.get(claim.entityId);
    if (existing) {
      existing.push(claim);
    } else {
      map.set(claim.entityId, [claim]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Find exact-match duplicates within an entity
// ---------------------------------------------------------------------------

function findDuplicateGroups(claims: ClaimRow[]): DuplicateGroup[] {
  // Group by normalized text
  const textMap = new Map<string, ClaimRow[]>();
  for (const claim of claims) {
    const normalized = normalizeClaimText(claim.claimText);
    const existing = textMap.get(normalized);
    if (existing) {
      existing.push(claim);
    } else {
      textMap.set(normalized, [claim]);
    }
  }

  // Only keep groups with 2+ claims (actual duplicates)
  const groups: DuplicateGroup[] = [];
  for (const [normalizedText, groupClaims] of textMap) {
    if (groupClaims.length < 2) continue;

    // Sort by ID ascending -- keep the oldest (lowest ID)
    groupClaims.sort((a, b) => a.id - b.id);
    const keepId = groupClaims[0].id;
    const deleteIds = groupClaims.slice(1).map(c => c.id);

    groups.push({ normalizedText, claims: groupClaims, keepId, deleteIds });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Find self-references in relatedEntities
// ---------------------------------------------------------------------------

function findSelfReferences(claims: ClaimRow[]): SelfRefFix[] {
  const fixes: SelfRefFix[] = [];

  for (const claim of claims) {
    const related = claim.relatedEntities;
    if (!related || !Array.isArray(related) || related.length === 0) continue;

    if (related.includes(claim.entityId)) {
      const filtered = related.filter(e => e !== claim.entityId);
      fixes.push({
        claimId: claim.id,
        entityId: claim.entityId,
        oldRelatedEntities: related,
        newRelatedEntities: filtered,
      });
    }
  }

  return fixes;
}

// ---------------------------------------------------------------------------
// Analyze a single entity
// ---------------------------------------------------------------------------

function analyzeEntity(entityId: string, claims: ClaimRow[]): EntityCleanupResult {
  const duplicateGroups = findDuplicateGroups(claims);
  const selfRefFixes = findSelfReferences(claims);
  return { entityId, duplicateGroups, selfRefFixes };
}

// ---------------------------------------------------------------------------
// Display results
// ---------------------------------------------------------------------------

function displayResults(
  results: EntityCleanupResult[],
  c: ReturnType<typeof getColors>,
): { totalDeletes: number; totalUpdates: number } {
  let totalDeletes = 0;
  let totalUpdates = 0;

  // Filter to entities with actual changes
  const withChanges = results.filter(
    r => r.duplicateGroups.length > 0 || r.selfRefFixes.length > 0,
  );

  if (withChanges.length === 0) {
    console.log(`${c.green}No cleanup needed -- all entities are clean.${c.reset}`);
    return { totalDeletes: 0, totalUpdates: 0 };
  }

  for (const result of withChanges) {
    console.log(`${c.bold}Entity: ${c.cyan}${result.entityId}${c.reset}`);

    // Show duplicate groups
    if (result.duplicateGroups.length > 0) {
      const groupDeleteCount = result.duplicateGroups.reduce(
        (sum, g) => sum + g.deleteIds.length, 0,
      );
      console.log(`  ${c.yellow}Exact duplicates: ${result.duplicateGroups.length} groups found${c.reset}`);

      for (const group of result.duplicateGroups) {
        const textPreview = group.normalizedText.length > 80
          ? group.normalizedText.slice(0, 80) + '...'
          : group.normalizedText;
        const deleteList = group.deleteIds.map(id => `#${id}`).join(', ');
        console.log(
          `    "${textPreview}" (${group.claims.length} copies -> keep #${group.keepId}, delete ${deleteList})`,
        );
      }

      totalDeletes += groupDeleteCount;
    }

    // Show self-references
    if (result.selfRefFixes.length > 0) {
      console.log(`  ${c.yellow}Self-references: ${result.selfRefFixes.length} claims have entityId in relatedEntities${c.reset}`);

      const sampleSize = Math.min(result.selfRefFixes.length, 5);
      for (const fix of result.selfRefFixes.slice(0, sampleSize)) {
        const oldStr = JSON.stringify(fix.oldRelatedEntities);
        const newStr = fix.newRelatedEntities.length > 0
          ? JSON.stringify(fix.newRelatedEntities)
          : '[]';
        console.log(
          `    #${fix.claimId}: relatedEntities ${oldStr} -> ${newStr}`,
        );
      }
      if (result.selfRefFixes.length > sampleSize) {
        console.log(`    ${c.dim}...and ${result.selfRefFixes.length - sampleSize} more${c.reset}`);
      }

      totalUpdates += result.selfRefFixes.length;
    }

    console.log();
  }

  return { totalDeletes, totalUpdates };
}

// ---------------------------------------------------------------------------
// Apply changes
// ---------------------------------------------------------------------------

async function applyChanges(
  results: EntityCleanupResult[],
  c: ReturnType<typeof getColors>,
): Promise<void> {
  // Collect all delete IDs
  const allDeleteIds: number[] = [];
  for (const result of results) {
    for (const group of result.duplicateGroups) {
      allDeleteIds.push(...group.deleteIds);
    }
  }

  // Collect all self-ref fixes
  const allSelfRefFixes: SelfRefFix[] = [];
  for (const result of results) {
    allSelfRefFixes.push(...result.selfRefFixes);
  }

  // Delete duplicates in batches of 500 (API max is 1000)
  if (allDeleteIds.length > 0) {
    console.log(`${c.bold}Deleting ${allDeleteIds.length} duplicate claims...${c.reset}`);
    const BATCH_SIZE = 500;
    let totalDeleted = 0;

    for (let i = 0; i < allDeleteIds.length; i += BATCH_SIZE) {
      const batch = allDeleteIds.slice(i, i + BATCH_SIZE);
      const result = await deleteClaimsByIds(batch);
      if (result.ok) {
        totalDeleted += result.data.deleted;
        process.stdout.write(`  Deleted ${totalDeleted}/${allDeleteIds.length}\r`);
      } else {
        console.error(`  ${c.red}Batch delete error: ${result.message}${c.reset}`);
      }
    }
    console.log(); // clear \r line
    console.log(`  ${c.green}Deleted ${totalDeleted} duplicate claims${c.reset}`);
  }

  // Update self-references in batches of 100
  if (allSelfRefFixes.length > 0) {
    console.log(`${c.bold}Updating ${allSelfRefFixes.length} self-reference claims...${c.reset}`);
    const BATCH_SIZE = 100;
    let totalUpdated = 0;

    for (let i = 0; i < allSelfRefFixes.length; i += BATCH_SIZE) {
      const batch = allSelfRefFixes.slice(i, i + BATCH_SIZE);
      const items = batch.map(fix => ({
        id: fix.claimId,
        relatedEntities: fix.newRelatedEntities.length > 0 ? fix.newRelatedEntities : null,
      }));

      const result = await batchUpdateRelatedEntities(items);
      if (result.ok) {
        totalUpdated += result.data.updated;
        process.stdout.write(`  Updated ${totalUpdated}/${allSelfRefFixes.length}\r`);
      } else {
        console.error(`  ${c.red}Batch update error: ${result.message}${c.reset}`);
      }
    }
    console.log(); // clear \r line
    console.log(`  ${c.green}Updated ${totalUpdated} claims${c.reset}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors();

  const apply = args['apply'] === true;
  const dryRun = !apply;
  const entityFilter = args['entity'] as string | undefined;

  const modeLabel = dryRun ? 'dry-run' : 'APPLY';
  console.log(`${c.bold}Claims Cleanup (${modeLabel})${c.reset}`);
  console.log();

  // Check server availability
  const available = await isServerAvailable();
  if (!available) {
    console.error(`${c.red}Wiki-server is not available. Is it running?${c.reset}`);
    process.exit(1);
  }

  // Fetch claims
  console.log(`${c.dim}Fetching claims${entityFilter ? ` for entity: ${entityFilter}` : ' (all entities)'}...${c.reset}`);
  const claims = await fetchAllClaims({ entityId: entityFilter });
  console.log(`${c.dim}Fetched ${claims.length} claims${c.reset}`);
  console.log();

  // Group by entity
  const entityMap = groupByEntity(claims);
  const entityIds = [...entityMap.keys()].sort();

  console.log(`${c.dim}Processing ${entityIds.length} entities...${c.reset}`);
  console.log();

  // Analyze each entity
  const results: EntityCleanupResult[] = [];
  for (const entityId of entityIds) {
    const entityClaims = entityMap.get(entityId)!;
    results.push(analyzeEntity(entityId, entityClaims));
  }

  // Display results
  const { totalDeletes, totalUpdates } = displayResults(results, c);

  // Summary
  console.log(`${c.bold}Summary:${c.reset} ${totalDeletes} claims to delete, ${totalUpdates} claims to update`);

  if (totalDeletes === 0 && totalUpdates === 0) {
    return;
  }

  if (dryRun) {
    console.log(`  ${c.yellow}Run with --apply to execute.${c.reset}`);
    return;
  }

  // Apply
  console.log();
  await applyChanges(results, c);
  console.log();
  console.log(`${c.green}${c.bold}Cleanup complete.${c.reset}`);
}

main().catch((err) => {
  console.error('Claims cleanup failed:', err);
  process.exit(1);
});
