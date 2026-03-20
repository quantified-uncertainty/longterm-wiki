/**
 * Resource Enrichment — Fetch All URLs
 *
 * Fetches each resource URL, extracts meta tags (og:title, description,
 * publish date, canonical URL), stores content in citation_content table,
 * and updates enrichment_status to 'fetched'.
 *
 * Reuses the source-fetcher infrastructure for consistent caching and
 * paywall/dead-link detection.
 */

import { loadResourcesPGFirst } from '../resource-io.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { fetchSource, type FetchedSource } from '../lib/search/source-fetcher.ts';
import { sleep } from '../resource-utils.ts';
import type { Resource } from '../resource-types.ts';
import type { CommandResult } from '../lib/cli.ts';

// ── Main command ────────────────────────────────────────────────────────────

export async function fetchAllCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const batchSize = (options.batch as number) || 50;
  const concurrency = (options.concurrency as number) || 5;
  const limit = (options.limit as number) || 5000;
  const dryRun = options['dry-run'] as boolean;
  const verbose = options.verbose as boolean;
  const onlyPending = options['only-pending'] !== false; // default true

  console.log('🌐 Resource URL Fetcher\n');
  if (dryRun) console.log('  DRY RUN — no changes will be written\n');
  console.log(`  Batch size: ${batchSize}, Concurrency: ${concurrency}, Limit: ${limit}`);
  console.log(`  Only pending: ${onlyPending}\n`);

  const resources = await loadResourcesPGFirst();

  // Filter to resources that need fetching
  const toFetch = resources.filter((r) => {
    if (!r.url) return false;
    // Skip if already fetched (unless --all flag)
    if (onlyPending && r.enrichment_status && r.enrichment_status !== 'pending') return false;
    // Skip already-fetched resources (by fetched_at)
    if (onlyPending && r.fetched_at) return false;
    return true;
  }).slice(0, limit);

  console.log(`  ${toFetch.length} resources to fetch (of ${resources.length} total)\n`);

  if (toFetch.length === 0) {
    console.log('  ✅ All resources already fetched');
    return { exitCode: 0, output: 'All resources already fetched' };
  }

  let fetched = 0;
  let failed = 0;
  let paywalled = 0;
  let dead = 0;

  // Process in batches with concurrency
  for (let i = 0; i < toFetch.length; i += batchSize) {
    const batch = toFetch.slice(i, i + batchSize);
    console.log(`  Batch ${Math.floor(i / batchSize) + 1}: processing ${batch.length} URLs...`);

    // Process with limited concurrency
    const results = await processWithConcurrency(
      batch,
      concurrency,
      async (r: Resource): Promise<{ resource: Resource; result: FetchedSource | null }> => {
        try {
          const result = await fetchSource({
            url: r.url,
            resourceId: r.id,
            extractMode: 'full',
          });
          return { resource: r, result };
        } catch (err) {
          if (verbose) {
            console.log(`    ✗ ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
          return { resource: r, result: null };
        }
      },
    );

    // Update enrichment status in batch
    const statusUpdates: Array<{
      id: string;
      url: string;
      enrichmentStatus: string;
    }> = [];

    for (const { resource, result } of results) {
      if (!result) {
        failed++;
        continue;
      }

      switch (result.status) {
        case 'ok':
          fetched++;
          statusUpdates.push({
            id: resource.id,
            url: resource.url,
            enrichmentStatus: 'fetched',
          });
          if (verbose) console.log(`    ✓ ${resource.id}: ${resource.title || resource.url}`);
          break;
        case 'paywall':
          paywalled++;
          statusUpdates.push({
            id: resource.id,
            url: resource.url,
            enrichmentStatus: 'fetched',
          });
          break;
        case 'dead':
          dead++;
          statusUpdates.push({
            id: resource.id,
            url: resource.url,
            enrichmentStatus: 'fetched',
          });
          break;
        case 'error':
          failed++;
          break;
      }
    }

    // Write enrichment status updates
    if (!dryRun && statusUpdates.length > 0) {
      const result = await apiRequest(
        'POST',
        '/api/resources/batch',
        { items: statusUpdates },
        30000,
      );
      if (!result.ok) {
        console.error(`    ✗ Status update failed: ${result.message}`);
      }
    }

    // Brief pause between batches
    if (i + batchSize < toFetch.length) {
      await sleep(1000);
    }
  }

  console.log(`\n  Results:`);
  console.log(`    Fetched:   ${fetched}`);
  console.log(`    Paywalled: ${paywalled}`);
  console.log(`    Dead:      ${dead}`);
  console.log(`    Failed:    ${failed}`);

  return { exitCode: 0, output: `Fetched ${fetched} resources` };
}

// ── Concurrency helper ──────────────────────────────────────────────────────

async function processWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
