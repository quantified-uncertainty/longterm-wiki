/**
 * Backfill relatedEntities on claims by scanning claim text for entity names.
 *
 * Many claims (62.5% as of 2026-02) have null/empty relatedEntities. This
 * script scans each claim's text for known entity names (from data/entities/
 * YAML files) and updates the field via the API.
 *
 * Usage:
 *   pnpm crux claims backfill-related-entities              # dry-run (default)
 *   pnpm crux claims backfill-related-entities --apply       # actually update
 *   pnpm crux claims backfill-related-entities --limit=100   # process first N claims
 *   pnpm crux claims backfill-related-entities --entity-id=anthropic  # single entity
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { apiRequest, isServerAvailable } from '../lib/wiki-server/client.ts';
import { batchUpdateRelatedEntities, type ClaimRow } from '../lib/wiki-server/claims.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntityEntry {
  id: string;      // slug, e.g. "anthropic"
  title: string;   // display name, e.g. "Anthropic"
  type?: string;
}

interface AllClaimsResponse {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

interface BackfillChange {
  claimId: number;
  entityId: string;
  claimTextPreview: string;
  oldRelatedEntities: string[] | null;
  newRelatedEntities: string[];
  addedEntities: string[];
  removedSelfRefs: string[];
}

// ---------------------------------------------------------------------------
// Entity Loading
// ---------------------------------------------------------------------------

// Short entity names (< 4 chars) that are important enough to match despite
// the higher false-positive risk. These are well-known acronyms in the AI
// safety ecosystem. Add entries here when a prominent entity with a short
// name is being missed by the backfill.
const SHORT_NAME_WHITELIST = new Set([
  'fhi',  // Future of Humanity Institute
  'arc',  // Alignment Research Center
  'agi',  // Artificial General Intelligence (concept entity)
  'gpi',  // Global Priorities Institute
  'cea',  // Centre for Effective Altruism
  'sff',  // Survival and Flourishing Fund
]);

/**
 * Load all entity names and slugs from data/entities/ YAML files.
 * Returns a map of lowercase name/title -> entity slug (id).
 *
 * We match on:
 *   - Entity title (e.g. "Anthropic" -> "anthropic")
 *   - Entity id/slug if it's multi-word (e.g. "open-philanthropy" -> match "Open Philanthropy")
 *
 * Names shorter than 4 characters are excluded to avoid false positives
 * (e.g. matching "AI" inside "said"), except for entries in SHORT_NAME_WHITELIST.
 */
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

        // Map title -> slug (case-insensitive)
        const titleLower = entry.title.toLowerCase();
        if (titleLower.length >= 4 || SHORT_NAME_WHITELIST.has(titleLower)) {
          nameMap.set(titleLower, entry.id);
        }

        // Also map slug with hyphens replaced by spaces
        // e.g. "open-philanthropy" -> "open philanthropy"
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

/**
 * Load the set of all valid entity IDs (slugs) for validation.
 */
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

// ---------------------------------------------------------------------------
// Entity Matching
// ---------------------------------------------------------------------------

/**
 * Scan claim text for entity name mentions (case-insensitive).
 * Returns array of entity slugs found in the text.
 */
function findEntityMentions(
  claimText: string,
  nameMap: Map<string, string>,
  validIds: Set<string>,
): string[] {
  const textLower = claimText.toLowerCase();
  const found = new Set<string>();

  for (const [name, slug] of nameMap) {
    if (!textLower.includes(name)) continue;

    // Verify the match is at a word boundary to reduce false positives.
    // Build a regex with word-boundary checks. Escape special regex chars.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(claimText)) {
      // Only include if the slug is a valid entity
      if (validIds.has(slug)) {
        found.add(slug);
      }
    }
  }

  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Fetch All Claims (paginated)
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
      15_000, // 15s timeout for paginated fetches
    );

    if (!result.ok) {
      throw new Error(`Failed to fetch claims: ${result.message}`);
    }

    allClaims.push(...result.data.claims);

    // Check if we've fetched everything
    if (result.data.claims.length < batchLimit || allClaims.length >= result.data.total) {
      break;
    }

    offset += result.data.claims.length;
  }

  return allClaims;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors();

  const apply = args['apply'] === true;
  const dryRun = !apply;
  const limitStr = args['limit'] as string | undefined;
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;
  const entityIdFilter = args['entity-id'] as string | undefined;

  console.log(`${c.bold}Backfill relatedEntities on Claims${c.reset}`);
  console.log(`${c.dim}Mode: ${dryRun ? 'DRY RUN (use --apply to write)' : 'APPLY — will update database'}${c.reset}`);
  console.log();

  // Check server availability
  const available = await isServerAvailable();
  if (!available) {
    console.error(`${c.red}Wiki-server is not available. Is it running?${c.reset}`);
    process.exit(1);
  }

  // Load entity data
  console.log(`${c.dim}Loading entity names from data/entities/ YAML files...${c.reset}`);
  const nameMap = loadEntityNameMap();
  const validIds = loadEntityIds();
  console.log(`${c.dim}Loaded ${nameMap.size} name mappings across ${validIds.size} entities${c.reset}`);

  // Fetch all claims
  console.log(`${c.dim}Fetching claims from wiki-server...${c.reset}`);
  const claims = await fetchAllClaims({ entityId: entityIdFilter, limit });
  console.log(`${c.dim}Fetched ${claims.length} claims${c.reset}`);
  console.log();

  // Process claims
  const changes: BackfillChange[] = [];
  let selfRefsStripped = 0;
  let alreadyCorrect = 0;
  let noMentions = 0;

  for (const claim of claims) {
    const mentions = findEntityMentions(claim.claimText, nameMap, validIds);

    // Remove self-references (the claim's own entityId)
    const selfRefs = mentions.filter(m => m === claim.entityId);
    const filtered = mentions.filter(m => m !== claim.entityId);

    if (selfRefs.length > 0) {
      selfRefsStripped += selfRefs.length;
    }

    // Compare with existing relatedEntities
    const existing = (claim.relatedEntities ?? []).slice().sort();
    const proposed = filtered.slice().sort();

    // Check if already correct
    if (JSON.stringify(existing) === JSON.stringify(proposed)) {
      if (proposed.length > 0) {
        alreadyCorrect++;
      } else {
        noMentions++;
      }
      continue;
    }

    // Merge: keep existing entities and add newly found ones
    const merged = [...new Set([...existing, ...filtered])].sort();

    // Only record if there's actually something new to add
    const addedEntities = merged.filter(e => !existing.includes(e));
    const removedSelfRefs = (claim.relatedEntities ?? []).filter(e => e === claim.entityId);

    if (addedEntities.length === 0 && removedSelfRefs.length === 0) {
      alreadyCorrect++;
      continue;
    }

    changes.push({
      claimId: claim.id,
      entityId: claim.entityId,
      claimTextPreview: claim.claimText.slice(0, 120),
      oldRelatedEntities: claim.relatedEntities,
      newRelatedEntities: merged.length > 0 ? merged : [],
      addedEntities,
      removedSelfRefs,
    });
  }

  // Report
  console.log(`${c.bold}Results${c.reset}`);
  console.log(`  Total claims scanned:  ${claims.length}`);
  console.log(`  Claims to update:      ${c.yellow}${changes.length}${c.reset}`);
  console.log(`  Already correct:       ${c.green}${alreadyCorrect}${c.reset}`);
  console.log(`  No entity mentions:    ${c.dim}${noMentions}${c.reset}`);
  console.log(`  Self-refs stripped:    ${selfRefsStripped}`);
  console.log();

  // Show sample changes
  const sampleSize = Math.min(changes.length, 20);
  if (sampleSize > 0) {
    console.log(`${c.bold}Sample changes (${sampleSize} of ${changes.length}):${c.reset}`);
    for (const change of changes.slice(0, sampleSize)) {
      console.log(`  ${c.cyan}#${change.claimId}${c.reset} [${change.entityId}]`);
      console.log(`    ${c.dim}${change.claimTextPreview}...${c.reset}`);
      if (change.addedEntities.length > 0) {
        console.log(`    ${c.green}+ ${change.addedEntities.join(', ')}${c.reset}`);
      }
      if (change.removedSelfRefs.length > 0) {
        console.log(`    ${c.red}- self-ref: ${change.removedSelfRefs.join(', ')}${c.reset}`);
      }
    }
    if (changes.length > sampleSize) {
      console.log(`  ${c.dim}...and ${changes.length - sampleSize} more${c.reset}`);
    }
    console.log();
  }

  if (changes.length === 0) {
    console.log(`${c.green}No changes needed.${c.reset}`);
    return;
  }

  if (dryRun) {
    console.log(`${c.yellow}Dry run — no changes written. Use --apply to update.${c.reset}`);
    return;
  }

  // Apply changes in batches of 100
  console.log(`${c.bold}Applying ${changes.length} updates...${c.reset}`);
  const BATCH_SIZE = 100;
  let totalUpdated = 0;
  let totalErrors = 0;

  for (let i = 0; i < changes.length; i += BATCH_SIZE) {
    const batch = changes.slice(i, i + BATCH_SIZE);
    const items = batch.map(ch => ({
      id: ch.claimId,
      relatedEntities: ch.newRelatedEntities.length > 0 ? ch.newRelatedEntities : null,
    }));

    const result = await batchUpdateRelatedEntities(items);
    if (result.ok) {
      totalUpdated += result.data.updated;
      process.stdout.write(`  Updated ${totalUpdated}/${changes.length}\r`);
    } else {
      totalErrors += batch.length;
      console.error(`  ${c.red}Batch error: ${result.message}${c.reset}`);
    }
  }

  console.log(); // Clear the \r line
  console.log();
  console.log(`${c.bold}Done${c.reset}`);
  console.log(`  ${c.green}Updated: ${totalUpdated}${c.reset}`);
  if (totalErrors > 0) {
    console.log(`  ${c.red}Errors: ${totalErrors}${c.reset}`);
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
