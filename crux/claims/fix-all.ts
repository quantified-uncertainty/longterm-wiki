/**
 * Claims Fix-All — one-command quality remediation
 *
 * Runs all 4 quality fixers in the correct order, re-fetching between steps
 * since earlier fixers modify data that later fixers depend on:
 *
 *   1. strip-markup     — Clean MDX/JSX artifacts from claim text
 *   2. backfill-entities — Scan (cleaned) text for entity name mentions
 *   3. normalize-entities — Normalize relatedEntities slugs to canonical form
 *   4. dedup            — Remove duplicate claims (after normalization catches more)
 *
 * Supports --apply (dry-run by default) and --entity=<slug> filter.
 *
 * Usage:
 *   pnpm crux claims fix-all              # dry-run all fixers
 *   pnpm crux claims fix-all --apply      # apply all fixers
 *   pnpm crux claims fix-all --entity=anthropic --apply  # single entity
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { apiRequest, isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  batchUpdateClaimText,
  batchUpdateRelatedEntities,
  deleteClaimsByIds,
  type ClaimRow,
} from '../lib/wiki-server/claims.ts';
import { stripMarkup, escapeRegex } from '../lib/claim-text-utils.ts';
import { isClaimDuplicate } from '../lib/claim-utils.ts';
import { loadEntitySlugs, buildNormalizationMap, normalizeEntitySlug } from '../lib/normalize-entity-slugs.ts';
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

interface FixResult {
  name: string;
  scanned: number;
  fixed: number;
  details: string[];
}

interface EntityEntry {
  id: string;
  title: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// Fetch all claims (paginated)
// ---------------------------------------------------------------------------

async function fetchAllClaims(
  opts: { entityId?: string; limit?: number },
): Promise<ClaimRow[]> {
  const PAGE_SIZE = 200;
  const allClaims: ClaimRow[] = [];
  let offset = 0;
  const maxClaims = opts.limit ?? Infinity;

  while (allClaims.length < maxClaims) {
    const batchLimit = Math.min(PAGE_SIZE, maxClaims - allClaims.length);
    const params = new URLSearchParams({
      limit: String(batchLimit),
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

    if (result.data.claims.length < batchLimit || allClaims.length >= result.data.total) {
      break;
    }
    offset += result.data.claims.length;
  }

  return allClaims;
}

// ---------------------------------------------------------------------------
// Step 1: strip-markup — remove MDX/JSX artifacts from claim text
// ---------------------------------------------------------------------------

function stripMarkupFromText(text: string): { cleaned: string; strippedLabels: string[] } {
  const { cleaned, labels } = stripMarkup(text);
  return { cleaned, strippedLabels: labels };
}

async function fixStripMarkup(
  claims: ClaimRow[],
  apply: boolean,
  c: ReturnType<typeof getColors>,
): Promise<FixResult> {
  const updates: Array<{ id: number; claimText: string; labels: string[] }> = [];

  for (const claim of claims) {
    const { cleaned, strippedLabels } = stripMarkupFromText(claim.claimText);
    if (strippedLabels.length > 0 && cleaned !== claim.claimText && cleaned.length >= 10) {
      updates.push({ id: claim.id, claimText: cleaned, labels: strippedLabels });
    }
  }

  const details: string[] = [];
  const sampleSize = Math.min(updates.length, 10);
  for (const upd of updates.slice(0, sampleSize)) {
    details.push(`  #${upd.id}: [${upd.labels.join(',')}] -> "${upd.claimText.slice(0, 100)}..."`);
  }
  if (updates.length > sampleSize) {
    details.push(`  ...and ${updates.length - sampleSize} more`);
  }

  if (apply && updates.length > 0) {
    const BATCH_SIZE = 100;
    let totalUpdated = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      const result = await batchUpdateClaimText(
        batch.map(u => ({ id: u.id, claimText: u.claimText })),
      );
      if (result.ok) {
        totalUpdated += result.data.updated;
      } else {
        details.push(`  ${c.red}Batch error: ${result.message}${c.reset}`);
      }
    }
    details.push(`  ${c.green}Updated ${totalUpdated} claims${c.reset}`);
  }

  return { name: 'strip-markup', scanned: claims.length, fixed: updates.length, details };
}

// ---------------------------------------------------------------------------
// Step 2: backfill-entities — scan claim text for entity name mentions
// ---------------------------------------------------------------------------

const SHORT_NAME_WHITELIST = new Set([
  'fhi', 'arc', 'agi', 'gpi', 'cea', 'sff',
]);

function loadEntityNameMap(): Map<string, string> {
  const entitiesDir = path.join(PROJECT_ROOT, 'data/entities');
  const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  const nameMap = new Map<string, string>();

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(entitiesDir, file), 'utf-8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as EntityEntry[] | null;
      if (!Array.isArray(parsed)) continue;

      for (const entry of parsed) {
        if (!entry?.id || !entry?.title) continue;

        const titleLower = entry.title.toLowerCase();
        if (titleLower.length >= 4 || SHORT_NAME_WHITELIST.has(titleLower)) {
          nameMap.set(titleLower, entry.id);
        }

        const slugAsWords = entry.id.replace(/-/g, ' ');
        if ((slugAsWords.length >= 4 || SHORT_NAME_WHITELIST.has(slugAsWords)) && slugAsWords !== titleLower) {
          nameMap.set(slugAsWords, entry.id);
        }
      }
    } catch {
      // Skip malformed YAML files
    }
  }

  return nameMap;
}

function loadEntityIds(): Set<string> {
  const entitiesDir = path.join(PROJECT_ROOT, 'data/entities');
  const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  const ids = new Set<string>();

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(entitiesDir, file), 'utf-8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as EntityEntry[] | null;
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (entry?.id) ids.add(entry.id);
      }
    } catch {
      // Skip malformed files
    }
  }

  return ids;
}

function findEntityMentions(
  claimText: string,
  nameMap: Map<string, string>,
  validIds: Set<string>,
): string[] {
  const textLower = claimText.toLowerCase();
  const found = new Set<string>();

  for (const [name, slug] of nameMap) {
    if (!textLower.includes(name)) continue;

    const escaped = escapeRegex(name);
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(claimText)) {
      if (validIds.has(slug)) {
        found.add(slug);
      }
    }
  }

  return [...found].sort();
}

async function fixBackfillEntities(
  claims: ClaimRow[],
  apply: boolean,
  c: ReturnType<typeof getColors>,
): Promise<FixResult> {
  const nameMap = loadEntityNameMap();
  const validIds = loadEntityIds();

  const updates: Array<{ id: number; newEntities: string[]; addedCount: number }> = [];

  for (const claim of claims) {
    const mentions = findEntityMentions(claim.claimText, nameMap, validIds);
    const filtered = mentions.filter(m => m !== claim.entityId);
    const existing = (claim.relatedEntities ?? []).slice().sort();
    const merged = [...new Set([...existing, ...filtered])].sort();
    const addedEntities = merged.filter(e => !existing.includes(e));

    if (addedEntities.length === 0) continue;

    updates.push({ id: claim.id, newEntities: merged, addedCount: addedEntities.length });
  }

  const details: string[] = [];
  const sampleSize = Math.min(updates.length, 10);
  for (const upd of updates.slice(0, sampleSize)) {
    details.push(`  #${upd.id}: +${upd.addedCount} entities -> [${upd.newEntities.slice(0, 3).join(', ')}${upd.newEntities.length > 3 ? '...' : ''}]`);
  }
  if (updates.length > sampleSize) {
    details.push(`  ...and ${updates.length - sampleSize} more`);
  }

  if (apply && updates.length > 0) {
    const BATCH_SIZE = 100;
    let totalUpdated = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      const items = batch.map(u => ({
        id: u.id,
        relatedEntities: u.newEntities.length > 0 ? u.newEntities : null,
      }));
      const result = await batchUpdateRelatedEntities(items);
      if (result.ok) {
        totalUpdated += result.data.updated;
      } else {
        details.push(`  ${c.red}Batch error: ${result.message}${c.reset}`);
      }
    }
    details.push(`  ${c.green}Updated ${totalUpdated} claims${c.reset}`);
  }

  return { name: 'backfill-entities', scanned: claims.length, fixed: updates.length, details };
}

// ---------------------------------------------------------------------------
// Step 3: normalize-entities — normalize relatedEntities slugs
// ---------------------------------------------------------------------------

async function fixNormalizeEntities(
  claims: ClaimRow[],
  apply: boolean,
  c: ReturnType<typeof getColors>,
): Promise<FixResult> {
  const entitySlugs = loadEntitySlugs(PROJECT_ROOT);
  const normMap = buildNormalizationMap(PROJECT_ROOT);

  const updates: Array<{ id: number; oldEntities: string[]; newEntities: string[] }> = [];

  for (const claim of claims) {
    const existing = claim.relatedEntities ?? [];
    if (existing.length === 0) continue;

    const normalized = existing
      .map(slug => normalizeEntitySlug(slug, entitySlugs, normMap))
      .filter(slug => slug !== claim.entityId)
      .filter(slug => entitySlugs.has(slug));

    const deduped = [...new Set(normalized)].sort();
    const oldSorted = existing.slice().sort();

    if (JSON.stringify(deduped) !== JSON.stringify(oldSorted)) {
      updates.push({ id: claim.id, oldEntities: existing, newEntities: deduped });
    }
  }

  const details: string[] = [];
  const sampleSize = Math.min(updates.length, 10);
  for (const upd of updates.slice(0, sampleSize)) {
    const removed = upd.oldEntities.filter(e => !upd.newEntities.includes(e));
    const added = upd.newEntities.filter(e => !upd.oldEntities.includes(e));
    const changes: string[] = [];
    if (removed.length > 0) changes.push(`-${removed.join(',')}`);
    if (added.length > 0) changes.push(`+${added.join(',')}`);
    details.push(`  #${upd.id}: ${changes.join(' ')}`);
  }
  if (updates.length > sampleSize) {
    details.push(`  ...and ${updates.length - sampleSize} more`);
  }

  if (apply && updates.length > 0) {
    const BATCH_SIZE = 100;
    let totalUpdated = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      const items = batch.map(u => ({
        id: u.id,
        relatedEntities: u.newEntities.length > 0 ? u.newEntities : null,
      }));
      const result = await batchUpdateRelatedEntities(items);
      if (result.ok) {
        totalUpdated += result.data.updated;
      } else {
        details.push(`  ${c.red}Batch error: ${result.message}${c.reset}`);
      }
    }
    details.push(`  ${c.green}Updated ${totalUpdated} claims${c.reset}`);
  }

  return { name: 'normalize-entities', scanned: claims.length, fixed: updates.length, details };
}

// ---------------------------------------------------------------------------
// Step 4: dedup — remove duplicate claims within each entity
// ---------------------------------------------------------------------------

async function fixDedup(
  claims: ClaimRow[],
  apply: boolean,
  c: ReturnType<typeof getColors>,
): Promise<FixResult> {
  const byEntity = new Map<string, ClaimRow[]>();
  for (const claim of claims) {
    const list = byEntity.get(claim.entityId) ?? [];
    list.push(claim);
    byEntity.set(claim.entityId, list);
  }

  const toDelete: number[] = [];
  const details: string[] = [];

  for (const [entityId, entityClaims] of byEntity) {
    const sorted = entityClaims.slice().sort((a, b) => a.id - b.id);
    const seen: Array<{ id: number; text: string }> = [];

    for (const claim of sorted) {
      const isDup = seen.some(s => isClaimDuplicate(claim.claimText, s.text));
      if (isDup) {
        toDelete.push(claim.id);
        if (toDelete.length <= 10) {
          details.push(`  #${claim.id} [${entityId}]: "${claim.claimText.slice(0, 80)}..."`);
        }
      } else {
        seen.push({ id: claim.id, text: claim.claimText });
      }
    }
  }

  if (toDelete.length > 10) {
    details.push(`  ...and ${toDelete.length - 10} more duplicates`);
  }

  if (apply && toDelete.length > 0) {
    const BATCH_SIZE = 500;
    let totalDeleted = 0;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = toDelete.slice(i, i + BATCH_SIZE);
      const result = await deleteClaimsByIds(batch);
      if (result.ok) {
        totalDeleted += result.data.deleted;
      } else {
        details.push(`  ${c.red}Batch error: ${result.message}${c.reset}`);
      }
    }
    details.push(`  ${c.green}Deleted ${totalDeleted} duplicate claims${c.reset}`);
  }

  return { name: 'dedup', scanned: claims.length, fixed: toDelete.length, details };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const FIXER_STEPS = [
  { name: 'strip-markup', fn: fixStripMarkup, mutatesText: true },
  { name: 'backfill-entities', fn: fixBackfillEntities, mutatesText: false },
  { name: 'normalize-entities', fn: fixNormalizeEntities, mutatesText: false },
  { name: 'dedup', fn: fixDedup, mutatesText: false },
] as const;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = parseCliArgs(rawArgs);
  const c = getColors();

  const apply = args['apply'] === true;
  const entityId = args['entity'] as string | undefined ?? args['entity-id'] as string | undefined;

  console.log(`${c.bold}Claims Fix-All — One-Command Quality Remediation${c.reset}`);
  console.log(`${c.dim}Steps: ${FIXER_STEPS.map(s => s.name).join(' -> ')}${c.reset}`);
  console.log(`${c.dim}Mode: ${apply ? 'APPLY — will modify database' : 'DRY RUN (use --apply to write)'}${c.reset}`);
  if (entityId) console.log(`${c.dim}Entity filter: ${entityId}${c.reset}`);
  console.log();

  // Check server availability
  const available = await isServerAvailable();
  if (!available) {
    console.error(`${c.red}Wiki-server is not available. Is it running?${c.reset}`);
    process.exit(1);
  }

  // Run fixers in sequence, re-fetching after steps that modify data
  const results: FixResult[] = [];
  let claims: ClaimRow[] | null = null;
  let needsRefetch = true;

  for (let i = 0; i < FIXER_STEPS.length; i++) {
    const step = FIXER_STEPS[i];
    const stepNum = i + 1;

    // Fetch (or re-fetch) claims when needed
    if (needsRefetch || claims === null) {
      console.log(`${c.dim}Fetching claims from wiki-server...${c.reset}`);
      claims = await fetchAllClaims({ entityId });
      console.log(`${c.dim}Fetched ${claims.length} claims${c.reset}`);
      needsRefetch = false;
    }

    console.log();
    console.log(`${c.bold}[${stepNum}/${FIXER_STEPS.length}] ${step.name}${c.reset}`);

    const result = await step.fn(claims, apply, c);
    results.push(result);

    for (const detail of result.details) {
      console.log(detail);
    }

    // If this step modified data and actually applied changes, re-fetch for next step
    if (apply && result.fixed > 0) {
      needsRefetch = true;
    }
  }

  // Summary report
  console.log();
  console.log(`${c.bold}${'='.repeat(50)}${c.reset}`);
  console.log(`${c.bold}Summary Report${c.reset}`);
  console.log(`${'='.repeat(50)}`);

  let totalFixed = 0;
  for (const result of results) {
    const icon = result.fixed === 0
      ? `${c.green}ok${c.reset}`
      : apply
        ? `${c.green}fixed${c.reset}`
        : `${c.yellow}found${c.reset}`;
    const countStr = result.fixed > 0
      ? `${result.fixed} issues (of ${result.scanned} scanned)`
      : 'no issues';
    console.log(`  [${icon}] ${result.name.padEnd(20)} ${countStr}`);
    totalFixed += result.fixed;
  }

  console.log(`${'='.repeat(50)}`);
  console.log(`  Total: ${totalFixed} issues across ${results.length} fixers`);

  if (totalFixed > 0 && !apply) {
    console.log();
    console.log(`${c.yellow}Dry run -- no changes written. Use --apply to fix all.${c.reset}`);
  } else if (totalFixed > 0 && apply) {
    console.log();
    console.log(`${c.green}All fixes applied successfully.${c.reset}`);
  } else {
    console.log();
    console.log(`${c.green}No issues found. Claims data is clean.${c.reset}`);
  }
}

main().catch((err) => {
  console.error('Claims fix-all failed:', err);
  process.exit(1);
});
