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
import type { Resource } from '../resource-types.ts';
import type { CommandResult } from '../lib/cli.ts';

// ── Wayback Machine lookup ────────────────────────────────────────────────────

interface WaybackSnapshot {
  url: string;
  timestamp: string;
}

/**
 * Look up a Wayback Machine snapshot using multiple strategies:
 * 1. Availability API (fast but often unreliable)
 * 2. Direct web URL (follows redirect to closest snapshot — more reliable)
 */
async function lookupWayback(url: string): Promise<WaybackSnapshot | null> {
  // Strategy 1: Availability API (fast when it works)
  try {
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'LongtermWikiBot/1.0 (+https://www.longtermwiki.com)' },
      signal: AbortSignal.timeout(8_000),
    });

    if (response.ok) {
      const data = await response.json() as {
        archived_snapshots?: { closest?: { url: string; timestamp: string; available: boolean } };
      };
      const snapshot = data?.archived_snapshots?.closest;
      if (snapshot?.available && snapshot.url) {
        return { url: snapshot.url, timestamp: snapshot.timestamp };
      }
    }
  } catch {
    // API may be down — fall through to direct URL approach
  }

  // Strategy 2: Direct web URL — Wayback redirects to closest snapshot
  // GET https://web.archive.org/web/2024/https://example.com → 302 → actual snapshot
  try {
    const directUrl = `https://web.archive.org/web/2024/${url}`;
    const response = await fetch(directUrl, {
      redirect: 'manual', // Don't follow — we want the redirect URL
      headers: { 'User-Agent': 'LongtermWikiBot/1.0 (+https://www.longtermwiki.com)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (location && location.includes('web.archive.org/web/')) {
        // Extract timestamp from URL like /web/20240315123456/https://...
        const tsMatch = location.match(/\/web\/(\d{14})\//);
        return {
          url: location,
          timestamp: tsMatch?.[1] || 'unknown',
        };
      }
    }

    // 200 means we got the page directly (no redirect)
    if (response.ok) {
      return { url: directUrl, timestamp: 'unknown' };
    }
  } catch {
    // Direct URL also failed
  }

  return null;
}

// ── Content extraction ───────────────────────────────────────────────────────

function extractTitleFromHtml(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, ' ').trim();
  if (!raw || raw.length < 2) return null;
  return raw;
}

function htmlToPlainText(html: string): string {
  return html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remove Wayback Machine toolbar
    .replace(/<!-- BEGIN WAYBACK TOOLBAR[\s\S]*?END WAYBACK TOOLBAR -->/gi, '')
    .replace(/<div id="wm-ipp-base"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '')
    // Convert block elements to newlines
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchWaybackContent(
  archiveUrl: string,
): Promise<{ title: string | null; content: string; contentType: string } | null> {
  try {
    const response = await fetch(archiveUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LongtermWikiBot/1.0; +https://www.longtermwiki.com)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return null;

    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      // PDF or other binary — skip for now
      return null;
    }

    const html = await response.text();
    const title = extractTitleFromHtml(html);
    const content = htmlToPlainText(html);

    if (content.length < 100) return null; // Too little content

    return { title, content, contentType: 'text/html' };
  } catch {
    return null;
  }
}

// ── Main command ─────────────────────────────────────────────────────────────

export async function fetchWaybackCommand(
  args: string[],
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
      const snapshot = await lookupWayback(r.url);
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
      const result = await fetchWaybackContent(snapshot.url);
      if (!result || result.content.length < 100) {
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
        if (verbose) {
          console.log(`  ✗ Save failed: ${r.title || r.url}: ${err instanceof Error ? err.message : String(err)}`);
        }
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
