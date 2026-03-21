/**
 * Fix Enrichment Status — Backfill enrichment_status for resources with cached content
 *
 * After the initial fetch-all run, the batch status update failed for some
 * resources because one batch exceeded the 200-item API limit. This script
 * identifies resources that have content in citation_content but no
 * enrichment_status set, and batch-updates them to 'fetched'.
 *
 * Uses the bulk listing endpoint to avoid 5000+ individual URL lookups.
 */

import { loadResourcesPGFirst } from '../resource-io.ts';
import { listCitationContent } from '../lib/wiki-server/citations.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import type { CommandResult } from '../lib/cli.ts';

const BATCH_SIZE = 200; // API limit (MAX_BATCH_SIZE in api-types.ts)

// ── Main command ────────────────────────────────────────────────────────────

export async function fixEnrichmentStatusCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = !!(options['dry-run'] || options.dryRun);
  const verbose = options.verbose as boolean;

  console.log('🔧 Fix Enrichment Status\n');
  if (dryRun) console.log('  DRY RUN — no changes will be written\n');

  // Step 1: Load all resources from PG
  console.log('  Loading resources...');
  const resources = await loadResourcesPGFirst();
  console.log(`  Loaded ${resources.length} resources\n`);

  // Step 2: Filter to resources missing enrichment_status and fetched_at
  const candidates = resources.filter((r) => {
    if (!r.url) return false;
    if (r.enrichment_status) return false; // already has a status
    if (r.fetched_at) return false; // already marked as fetched
    return true;
  });

  console.log(`  ${candidates.length} resources missing enrichment_status (and no fetched_at)\n`);

  if (candidates.length === 0) {
    console.log('  ✅ All resources already have enrichment_status set');
    return { exitCode: 0, output: 'No resources need fixing' };
  }

  // Step 3: Load all cached URLs from citation_content (paginated)
  console.log('  Loading cached citation content URLs...');
  const cachedUrls = await loadAllCachedUrls(verbose);
  console.log(`  Found ${cachedUrls.size} cached URLs in citation_content\n`);

  // Step 4: Cross-reference — find resources with content but no status
  const toFix = candidates.filter((r) => cachedUrls.has(r.url));

  console.log(`  ${toFix.length} resources have cached content but no enrichment_status\n`);

  if (toFix.length === 0) {
    console.log('  ✅ No resources need fixing');
    return { exitCode: 0, output: 'No resources need fixing' };
  }

  if (verbose) {
    for (const r of toFix.slice(0, 20)) {
      console.log(`    • ${r.id}: ${r.title || r.url}`);
    }
    if (toFix.length > 20) {
      console.log(`    ... and ${toFix.length - 20} more`);
    }
    console.log();
  }

  if (dryRun) {
    console.log(`  Would update ${toFix.length} resources to enrichment_status='fetched'`);
    return { exitCode: 0, output: `Dry run: ${toFix.length} resources would be updated` };
  }

  // Step 5: Batch-update enrichment_status to 'fetched'
  console.log(`  Updating ${toFix.length} resources in batches of ${BATCH_SIZE}...`);
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < toFix.length; i += BATCH_SIZE) {
    const batch = toFix.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toFix.length / BATCH_SIZE);

    const items = batch.map((r) => ({
      id: r.id,
      url: r.url,
      enrichmentStatus: 'fetched',
    }));

    const result = await apiRequest(
      'POST',
      '/api/resources/batch',
      { items },
      30000,
    );

    if (result.ok) {
      updated += batch.length;
      console.log(`    Batch ${batchNum}/${totalBatches}: updated ${batch.length} resources`);
    } else {
      failed += batch.length;
      console.error(`    Batch ${batchNum}/${totalBatches}: FAILED — ${result.message}`);
    }
  }

  // Step 6: Report results
  console.log(`\n  Results:`);
  console.log(`    Updated: ${updated}`);
  if (failed > 0) {
    console.log(`    Failed:  ${failed}`);
  }

  const exitCode = failed > 0 ? 1 : 0;
  return { exitCode, output: `Updated ${updated} resources, ${failed} failed` };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load all cached URLs from citation_content via paginated list endpoint.
 * Returns a Set of URLs for O(1) lookup.
 */
async function loadAllCachedUrls(verbose?: boolean): Promise<Set<string>> {
  const urls = new Set<string>();
  const pageSize = 500;
  let offset = 0;

  // First request to get total count
  const firstResult = await listCitationContent(pageSize, 0);
  if (!firstResult.ok) {
    console.error(`  Failed to load citation content: ${firstResult.message}`);
    return urls;
  }

  const total = firstResult.data.total;
  for (const entry of firstResult.data.entries) {
    urls.add(entry.url);
  }
  offset += firstResult.data.entries.length;

  if (verbose) {
    console.log(`    Total citation content entries: ${total}`);
    console.log(`    Page 1: loaded ${firstResult.data.entries.length} entries`);
  }

  // Paginate through remaining entries
  while (offset < total) {
    const result = await listCitationContent(pageSize, offset);
    if (!result.ok) {
      console.error(`  Failed to load citation content at offset ${offset}: ${result.message}`);
      break;
    }

    const entries = result.data.entries;
    if (entries.length === 0) break;

    for (const entry of entries) {
      urls.add(entry.url);
    }
    offset += entries.length;

    if (verbose) {
      const page = Math.ceil(offset / pageSize);
      console.log(`    Page ${page}: loaded ${entries.length} entries (${offset}/${total})`);
    }
  }

  return urls;
}
