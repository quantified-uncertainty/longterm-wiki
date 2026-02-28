/**
 * Claims Quality Report — per-entity quality breakdown with issue categorization
 *
 * Runs quality checks on all claims and produces a detailed report showing
 * the distribution of quality issues per entity and globally.
 *
 * This is the expanded version of `crux claims audit` — focused on content
 * quality rather than data integrity.
 *
 * Usage:
 *   pnpm crux claims quality-report                     # full report
 *   pnpm crux claims quality-report --entity=anthropic   # single entity
 *   pnpm crux claims quality-report --json               # machine-readable
 *   pnpm crux claims quality-report --top=20             # top 20 entities
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { apiRequest, isServerAvailable } from '../lib/wiki-server/client.ts';
import type { ClaimRow } from '../lib/wiki-server/claims.ts';
import { validateClaim, type ClaimValidationResult } from './validate-claim.ts';
import { isClaimDuplicate } from '../lib/claim-utils.ts';
import { hasMarkup } from '../lib/claim-text-utils.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AllClaimsResponse {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

interface EntityQuality {
  entityId: string;
  entityName: string;
  totalClaims: number;
  cleanClaims: number;
  issues: Record<string, number>;
  duplicateCount: number;
  markupCount: number;
  missingRelatedEntities: number;
  qualityScore: number; // 0-100
}

interface QualityReport {
  timestamp: string;
  totalClaims: number;
  entities: EntityQuality[];
  globalIssues: Record<string, number>;
  globalQualityScore: number;
}

// ---------------------------------------------------------------------------
// Entity name loading
// ---------------------------------------------------------------------------

function loadEntityNames(): Map<string, string> {
  const entitiesDir = path.join(PROJECT_ROOT, 'data/entities');
  const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  const names = new Map<string, string>();

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(entitiesDir, file), 'utf-8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as Array<{ id: string; title: string }> | null;
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (entry?.id && entry?.title) {
          names.set(entry.id, entry.title);
        }
      }
    } catch {
      // Skip malformed files
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Fetch all claims (paginated)
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
// Compute quality per entity
// ---------------------------------------------------------------------------

function computeEntityQuality(
  entityId: string,
  entityName: string,
  claims: ClaimRow[],
): EntityQuality {
  const issues: Record<string, number> = {};
  let cleanClaims = 0;
  let markupCount = 0;
  let missingRelatedEntities = 0;

  // Dedup check
  const sorted = claims.slice().sort((a, b) => a.id - b.id);
  const seen: string[] = [];
  let duplicateCount = 0;

  for (const claim of sorted) {
    const isDup = seen.some(s => isClaimDuplicate(claim.claimText, s));
    if (isDup) {
      duplicateCount++;
    }
    seen.push(claim.claimText);
  }

  for (const claim of claims) {
    // Validation checks
    const result: ClaimValidationResult = validateClaim(claim.claimText, entityId, entityName);
    if (result.issues.length === 0) {
      cleanClaims++;
    } else {
      for (const issue of result.issues) {
        const issueType = issue.split(':')[0];
        issues[issueType] = (issues[issueType] ?? 0) + 1;
      }
    }

    // Markup check
    if (hasMarkup(claim.claimText)) {
      markupCount++;
    }

    // Missing relatedEntities
    if (!claim.relatedEntities || claim.relatedEntities.length === 0) {
      missingRelatedEntities++;
    }
  }

  const totalClaims = claims.length;
  const issueCount = totalClaims - cleanClaims + duplicateCount + markupCount;
  const qualityScore = totalClaims > 0
    ? Math.round(100 * Math.max(0, 1 - issueCount / (totalClaims * 2)))
    : 100;

  return {
    entityId,
    entityName,
    totalClaims,
    cleanClaims,
    issues,
    duplicateCount,
    markupCount,
    missingRelatedEntities,
    qualityScore,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors();

  const jsonOutput = args['json'] === true;
  const entityId = args['entity'] as string | undefined ?? args['entity-id'] as string | undefined;
  const topStr = args['top'] as string | undefined;
  const topN = topStr ? parseInt(topStr, 10) : undefined;

  if (!jsonOutput) {
    console.log(`${c.bold}Claims Quality Report${c.reset}`);
    console.log();
  }

  const available = await isServerAvailable();
  if (!available) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: 'wiki-server not available' }));
    } else {
      console.error(`${c.red}Wiki-server is not available.${c.reset}`);
    }
    process.exit(1);
  }

  if (!jsonOutput) {
    console.log(`${c.dim}Fetching claims...${c.reset}`);
  }
  const claims = await fetchAllClaims({ entityId });
  if (!jsonOutput) {
    console.log(`${c.dim}Fetched ${claims.length} claims${c.reset}`);
  }

  // Load entity names
  const entityNames = loadEntityNames();

  // Group claims by entity
  const byEntity = new Map<string, ClaimRow[]>();
  for (const claim of claims) {
    const list = byEntity.get(claim.entityId) ?? [];
    list.push(claim);
    byEntity.set(claim.entityId, list);
  }

  // Compute quality per entity
  const entityQualities: EntityQuality[] = [];
  for (const [eid, entityClaims] of byEntity) {
    const name = entityNames.get(eid) ?? eid;
    entityQualities.push(computeEntityQuality(eid, name, entityClaims));
  }

  // Sort by total claims descending
  entityQualities.sort((a, b) => b.totalClaims - a.totalClaims);

  // Global aggregation
  const globalIssues: Record<string, number> = {};
  let totalClean = 0;
  let totalDuplicates = 0;
  let totalMarkup = 0;
  let totalMissingRelated = 0;

  for (const eq of entityQualities) {
    totalClean += eq.cleanClaims;
    totalDuplicates += eq.duplicateCount;
    totalMarkup += eq.markupCount;
    totalMissingRelated += eq.missingRelatedEntities;
    for (const [key, count] of Object.entries(eq.issues)) {
      globalIssues[key] = (globalIssues[key] ?? 0) + count;
    }
  }

  const totalClaims = claims.length;
  const globalQualityScore = totalClaims > 0
    ? Math.round(100 * totalClean / totalClaims)
    : 100;

  const report: QualityReport = {
    timestamp: new Date().toISOString(),
    totalClaims,
    entities: topN ? entityQualities.slice(0, topN) : entityQualities,
    globalIssues,
    globalQualityScore,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Pretty print
  console.log();
  console.log(`${c.bold}Global Quality: ${globalQualityScore}%${c.reset} (${totalClean}/${totalClaims} claims clean)`);
  console.log(`  Duplicates:            ${c.yellow}${totalDuplicates}${c.reset}`);
  console.log(`  With markup:           ${c.yellow}${totalMarkup}${c.reset}`);
  console.log(`  Missing relatedEntities: ${c.yellow}${totalMissingRelated}${c.reset}`);
  console.log();

  // Issue breakdown
  if (Object.keys(globalIssues).length > 0) {
    console.log(`${c.bold}Issue Breakdown${c.reset}`);
    const sorted = Object.entries(globalIssues).sort((a, b) => b[1] - a[1]);
    for (const [issue, count] of sorted) {
      const pct = ((count / totalClaims) * 100).toFixed(1);
      console.log(`  ${issue.padEnd(28)} ${c.yellow}${String(count).padStart(5)}${c.reset} (${pct}%)`);
    }
    console.log();
  }

  // Per-entity table
  const display = topN ? entityQualities.slice(0, topN) : entityQualities.slice(0, 30);
  console.log(`${c.bold}Per-Entity Quality${c.reset} (${display.length} of ${entityQualities.length} entities)`);
  console.log(`${'  Entity'.padEnd(32)} ${'Claims'.padStart(7)} ${'Clean'.padStart(7)} ${'Dupes'.padStart(7)} ${'Markup'.padStart(7)} ${'Score'.padStart(7)}`);
  console.log(`${'  ' + '-'.repeat(30)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)}`);

  for (const eq of display) {
    const name = eq.entityId.length > 28 ? eq.entityId.slice(0, 25) + '...' : eq.entityId;
    const scoreColor = eq.qualityScore >= 70 ? c.green : eq.qualityScore >= 40 ? c.yellow : c.red;
    console.log(
      `  ${name.padEnd(30)} ${String(eq.totalClaims).padStart(7)} ${String(eq.cleanClaims).padStart(7)} ${String(eq.duplicateCount).padStart(7)} ${String(eq.markupCount).padStart(7)} ${scoreColor}${String(eq.qualityScore + '%').padStart(7)}${c.reset}`
    );
  }

  if (entityQualities.length > display.length) {
    console.log(`  ${c.dim}...and ${entityQualities.length - display.length} more (use --top=N to show more)${c.reset}`);
  }
}

main().catch((err) => {
  console.error('Quality report failed:', err);
  process.exit(1);
});
