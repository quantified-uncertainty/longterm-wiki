/**
 * Resource Enrichment — Wayback Machine Fallback Fetcher
 *
 * Retries failed/dead resources by fetching archived snapshots from
 * the Wayback Machine (web.archive.org). Stores content in citation_content
 * with fetchMethod='wayback'.
 *
 * Usage:
 *   pnpm crux resources fetch-wayback --dry-run        # Preview
 *   pnpm crux resources fetch-wayback --limit=50       # Fetch up to 50
 *   pnpm crux resources fetch-wayback --verbose         # Show details
 */

import { loadResourcesPGFirst } from '../resource-io.ts';
import { upsertCitationContent } from '../lib/wiki-server/citations.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { sleep } from '../resource-utils.ts';
import { lookupWaybackSnapshot, fetchWaybackContent } from '../lib/wayback.ts';
import type { CommandResult } from '../lib/cli.ts';

// ── Main command ─────────────────────────────────────────────────────────────

export async function fetchWaybackCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const limit = (options.limit as number) || 200;
  const dryRun = options['dry-run'] as boolean;
  const verbose = options.verbose as boolean;
  const concurrency = (options.concurrency as number) || 3;

  console.log(`🕰️  Wayback Machine Fallback Fetcher${dryRun ? ' (DRY RUN)' : ''}\n`);

  const resources = await loadResourcesPGFirst();
  const domainFilter = options.domain as string | undefined;

  // Domains known to be dead/unreachable (primary Wayback targets)
  const DEAD_DOMAINS = new Set([
    'www.fhi.ox.ac.uk', 'fhi.ox.ac.uk',
    'ftxfuturefund.org', 'www.ftxfuturefund.org',
    'safesecureai.org', 'www.safesecureai.org',
    'maliciousaireport.com', 'www.maliciousaireport.com',
    'www.thefilterbubble.com',
    'www.redqueenbio.com',
    'saferai.uk', 'www.saferai.uk',
    'www.apollo-research.ai',
    'www.sparprogram.org',
    'www.gryphonscientific.com',
    'www.deepfakedetectionchallenge.com',
  ]);

  // Paywalled domains where Wayback may have pre-paywall snapshots
  const PAYWALLED_DOMAINS = new Set([
    'www.nytimes.com',
    'www.cnbc.com',
    'www.wsj.com',
    'www.ft.com',
  ]);

  const targetDomains = new Set([...DEAD_DOMAINS, ...PAYWALLED_DOMAINS]);

  const candidates = resources.filter((r) => {
    if (!r.url) return false;
    try {
      const hostname = new URL(r.url).hostname;
      if (domainFilter) return hostname.includes(domainFilter);
      return targetDomains.has(hostname);
    } catch {
      return false;
    }
  });

  const deadCount = candidates.filter((r) => {
    try { return DEAD_DOMAINS.has(new URL(r.url).hostname); } catch { return false; }
  }).length;
  const paywalledCount = candidates.length - deadCount;

  console.log(`  ${candidates.length} resources on target domains (${deadCount} dead, ${paywalledCount} paywalled)\n`);

  const toProcess = candidates.slice(0, limit);
  if (toProcess.length === 0) {
    console.log('  ✅ All resources already have cached content');
    return { exitCode: 0, output: 'All resources have content' };
  }

  console.log(`  Looking up Wayback Machine snapshots for ${toProcess.length} URLs (concurrency: ${concurrency})...\n`);

  let found = 0;
  let fetched = 0;
  let noSnapshot = 0;
  let fetchFailed = 0;
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < toProcess.length) {
      const i = idx++;
      const r = toProcess[i];

      // Step 1: Look up Wayback snapshot
      const snapshot = await lookupWaybackSnapshot(r.url);
      if (!snapshot) {
        noSnapshot++;
        if (verbose) console.log(`  ✗ No snapshot: ${r.title || r.url}`);
        await sleep(200); // Rate limit Wayback API
        continue;
      }

      found++;

      if (dryRun) {
        if (verbose) console.log(`  ✓ Found: ${r.title || r.url} → ${snapshot.timestamp}`);
        await sleep(200);
        continue;
      }

      // Step 2: Fetch content from Wayback
      const result = await fetchWaybackContent(snapshot.url, snapshot.timestamp);
      if (!result) {
        fetchFailed++;
        if (verbose) console.log(`  ✗ Fetch failed: ${r.title || r.url}`);
        await sleep(500);
        continue;
      }

      // Step 3: Store in citation_content
      try {
        await upsertCitationContent({
          url: r.url,
          resourceId: r.id,
          fetchedAt: new Date().toISOString(),
          httpStatus: 200,
          contentType: result.contentType,
          pageTitle: result.title,
          fullText: result.content.slice(0, 5_000_000), // 5MB limit
          contentLength: result.content.length,
          fetchMethod: 'wayback',
        });
        fetched++;
        if (verbose) {
          console.log(`  ✓ Fetched: ${r.title || r.url} (${(result.content.length / 1024).toFixed(0)}KB, ${snapshot.timestamp})`);
        }
      } catch (err) {
        fetchFailed++;
        console.warn(`  ✗ Save failed: ${r.title || r.url}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Update enrichment status
      // Fire-and-forget: enrichment status update is best-effort; failure
      // should not block wayback batch processing.
      await apiRequest('POST', '/api/resources/batch', {
        items: [{ id: r.id, url: r.url, enrichmentStatus: 'fetched' }],
      }).catch((e: unknown) => {
        console.warn(`Failed to update enrichment status for ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
      });

      if ((fetched + fetchFailed) % 20 === 0) {
        process.stdout.write(`\r  Progress: ${i + 1}/${toProcess.length} checked, ${fetched} fetched, ${found} snapshots found`);
      }

      await sleep(500); // Be polite to Wayback Machine
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, toProcess.length) },
    () => worker(),
  );
  await Promise.all(workers);

  console.log(`\n\n  Results:`);
  console.log(`    Snapshots found: ${found}`);
  console.log(`    Content fetched: ${fetched}`);
  console.log(`    No snapshot:     ${noSnapshot}`);
  console.log(`    Fetch failed:    ${fetchFailed}`);

  return { exitCode: 0, output: `Fetched ${fetched} resources from Wayback Machine` };
}
