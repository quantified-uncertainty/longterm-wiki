/**
 * Claims Quality Fixer — automated remediation for common claim quality issues
 *
 * Subcommands:
 *   strip-markup    Remove MDX/JSX artifacts from claim text
 *   dedup           Remove duplicate claims (per-entity or global)
 *   normalize-entities  Normalize relatedEntities slugs to canonical form
 *
 * All subcommands default to dry-run. Use --apply to write changes.
 *
 * Usage:
 *   pnpm crux claims fix strip-markup              # dry-run
 *   pnpm crux claims fix strip-markup --apply       # apply changes
 *   pnpm crux claims fix dedup --entity=anthropic   # dedup single entity
 *   pnpm crux claims fix dedup --apply              # dedup all, apply
 *   pnpm crux claims fix normalize-entities --apply # normalize slugs
 *   pnpm crux claims fix --apply                    # run ALL fixers
 */

import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { apiRequest, isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  batchUpdateClaimText,
  batchUpdateRelatedEntities,
  deleteClaimsByIds,
  type ClaimRow,
} from '../lib/wiki-server/claims.ts';
import { isClaimDuplicate, normalizeClaimText } from '../lib/claim-utils.ts';
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
// Fixer: strip-markup — remove MDX/JSX artifacts from claim text
// ---------------------------------------------------------------------------

/** Patterns that indicate MDX/JSX markup leaked into claim text. */
const MARKUP_PATTERNS: Array<{ pattern: RegExp; replacement: string; label: string }> = [
  // <EntityLink id="...">Text</EntityLink> → Text
  { pattern: /<EntityLink\s+id="[^"]*"(?:\s+[^>]*)?>([^<]*)<\/EntityLink>/g, replacement: '$1', label: 'EntityLink' },
  // <F id="..." /> or <F e="..." f="..." /> → empty (canonical fact refs)
  { pattern: /<F\s+[^>]*\/>/g, replacement: '', label: 'F-tag' },
  // <R id="...">Text</R> → Text (resource citation component)
  { pattern: /<R\s+id="[^"]*">[^<]*<\/R>/g, replacement: '', label: 'R-tag' },
  // <Calc>...</Calc> → empty
  { pattern: /<Calc>[^<]*<\/Calc>/g, replacement: '', label: 'Calc' },
  // Remaining self-closing JSX tags: <Foo bar="baz" />
  { pattern: /<\w[\w.]*[^>]*\/>/g, replacement: '', label: 'JSX-self-closing' },
  // Remaining JSX block tags: <Foo>...</Foo> (non-greedy, single-line)
  { pattern: /<(\w[\w.]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g, replacement: '$2', label: 'JSX-block' },
  // Curly brace expressions: {expression}
  { pattern: /\{[^}]+\}/g, replacement: '', label: 'curly-expr' },
  // MDX import/export statements
  { pattern: /^(?:import|export)\s+.*$/gm, replacement: '', label: 'import/export' },
  // Escaped dollar signs from MDX: \$100 → $100
  { pattern: /\\\$/g, replacement: '$', label: 'escaped-dollar' },
  // Escaped angle brackets: \< → <
  { pattern: /\\</g, replacement: '<', label: 'escaped-lt' },
];

function stripMarkupFromText(text: string): { cleaned: string; strippedLabels: string[] } {
  let cleaned = text;
  const strippedLabels: string[] = [];

  for (const { pattern, replacement, label } of MARKUP_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(cleaned)) {
      strippedLabels.push(label);
      pattern.lastIndex = 0;
      cleaned = cleaned.replace(pattern, replacement);
    }
  }

  // Collapse multiple spaces and trim
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  return { cleaned, strippedLabels };
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

  // Show samples
  const sampleSize = Math.min(updates.length, 10);
  for (const upd of updates.slice(0, sampleSize)) {
    details.push(`  #${upd.id}: [${upd.labels.join(',')}] → "${upd.claimText.slice(0, 100)}..."`);
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
// Fixer: dedup — remove duplicate claims within each entity
// ---------------------------------------------------------------------------

async function fixDedup(
  claims: ClaimRow[],
  apply: boolean,
  c: ReturnType<typeof getColors>,
): Promise<FixResult> {
  // Group claims by entityId
  const byEntity = new Map<string, ClaimRow[]>();
  for (const claim of claims) {
    const list = byEntity.get(claim.entityId) ?? [];
    list.push(claim);
    byEntity.set(claim.entityId, list);
  }

  const toDelete: number[] = [];
  const details: string[] = [];

  for (const [entityId, entityClaims] of byEntity) {
    // Sort by ID ascending so we keep the oldest claim
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
// Fixer: normalize-entities — normalize relatedEntities slugs
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

    // Normalize each slug and remove self-references
    const normalized = existing
      .map(slug => normalizeEntitySlug(slug, entitySlugs, normMap))
      .filter(slug => slug !== claim.entityId) // remove self-refs
      .filter(slug => entitySlugs.has(slug));  // remove invalid slugs

    // Deduplicate
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
// Main
// ---------------------------------------------------------------------------

const FIXERS = {
  'strip-markup': fixStripMarkup,
  'dedup': fixDedup,
  'normalize-entities': fixNormalizeEntities,
} as const;

type FixerName = keyof typeof FIXERS;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = parseCliArgs(rawArgs);
  const c = getColors();

  const apply = args['apply'] === true;
  const entityId = args['entity'] as string | undefined ?? args['entity-id'] as string | undefined;
  const limitStr = args['limit'] as string | undefined;
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  // Parse subcommand from positional args
  const positional = rawArgs.filter(a => !a.startsWith('--'));
  const subcommand = positional[0] as FixerName | undefined;

  // Determine which fixers to run
  const fixerNames: FixerName[] = subcommand && subcommand in FIXERS
    ? [subcommand]
    : (Object.keys(FIXERS) as FixerName[]);

  console.log(`${c.bold}Claims Quality Fixer${c.reset}`);
  console.log(`${c.dim}Fixers: ${fixerNames.join(', ')}${c.reset}`);
  console.log(`${c.dim}Mode: ${apply ? 'APPLY — will modify database' : 'DRY RUN (use --apply to write)'}${c.reset}`);
  if (entityId) console.log(`${c.dim}Entity filter: ${entityId}${c.reset}`);
  console.log();

  // Check server availability
  const available = await isServerAvailable();
  if (!available) {
    console.error(`${c.red}Wiki-server is not available. Is it running?${c.reset}`);
    process.exit(1);
  }

  // Fetch all claims
  console.log(`${c.dim}Fetching claims from wiki-server...${c.reset}`);
  const claims = await fetchAllClaims({ entityId, limit });
  console.log(`${c.dim}Fetched ${claims.length} claims${c.reset}`);
  console.log();

  // Run selected fixers
  const results: FixResult[] = [];
  for (const name of fixerNames) {
    const fixer = FIXERS[name];
    console.log(`${c.bold}Running: ${name}${c.reset}`);
    const result = await fixer(claims, apply, c);
    results.push(result);

    for (const detail of result.details) {
      console.log(detail);
    }
    console.log();
  }

  // Summary
  console.log(`${c.bold}Summary${c.reset}`);
  for (const result of results) {
    const icon = result.fixed === 0
      ? `${c.green}✓${c.reset}`
      : apply
        ? `${c.green}✓${c.reset}`
        : `${c.yellow}⚠${c.reset}`;
    console.log(`  ${icon} ${result.name}: ${result.fixed} issues${result.fixed > 0 ? ` (of ${result.scanned} scanned)` : ''}`);
  }

  const totalFixed = results.reduce((sum, r) => sum + r.fixed, 0);
  if (totalFixed > 0 && !apply) {
    console.log();
    console.log(`${c.yellow}Dry run — no changes written. Use --apply to fix.${c.reset}`);
  }
}

main().catch((err) => {
  console.error('Claims fix failed:', err);
  process.exit(1);
});
