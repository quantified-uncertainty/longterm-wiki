/**
 * Resource Title Refresh
 *
 * Batch-fetches real page titles from URLs and updates resources
 * whose titles appear to be wrong (anchor text, abbreviations, URLs).
 *
 * Usage:
 *   pnpm crux resources refresh-titles              # Dry-run (report only)
 *   pnpm crux resources refresh-titles --apply       # Apply fixes
 *   pnpm crux resources refresh-titles --limit 100   # Limit to first N
 *   pnpm crux resources refresh-titles --domain arxiv.org  # Single domain
 *   pnpm crux resources refresh-titles --verbose     # Show all comparisons
 */

import type { Resource, ParsedOpts } from './resource-types.ts';
import { loadResourcesPGFirst } from './resource-io.ts';
import { apiRequest } from './lib/wiki-server/client.ts';
import { hostMatches } from '@longterm-wiki/url-utils';
import { decodeHtmlEntities as decodeEntities } from './lib/html-utils.ts';

// ── Configuration ──────────────────────────────────────────────────────────

const CONCURRENCY = 15;          // parallel fetches
const PER_DOMAIN_DELAY_MS = 200; // min ms between requests to same domain
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 200_000;  // only read first 200KB for <title>

// Domains where simple fetch won't work (need JS rendering, auth, etc.)
const SKIP_DOMAINS = new Set([
  'docs.google.com',
  'drive.google.com',
  'twitter.com',
  'x.com',
  't.co',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
]);

// ── Title extraction ───────────────────────────────────────────────────────

function decodeHtmlEntities(text: string): string {
  // Delegate to the shared helper (decodes `&amp;` last, avoiding the
  // double-unescaping bug) then collapse whitespace as before.
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function extractTitleFromHtml(html: string): string | null {
  // Try <title> tag
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const raw = decodeHtmlEntities(m[1]);
  if (!raw || raw.length < 2) return null;
  return raw;
}

// Try og:title as fallback (often cleaner than <title>)
function extractOgTitle(html: string): string | null {
  // Match og:title with possible extra attributes (e.g., data-rh="true") between <meta and property=
  // Use [^"']* instead of [\s\S]*? to prevent spanning across HTML tags
  const m = html.match(/<meta\s+[^>]*?(?:property|name)=["']og:title["']\s+content=["']([^"']*)["']/i)
    || html.match(/<meta\s+[^>]*?content=["']([^"']*)["']\s+(?:property|name)=["']og:title["']/i);
  if (!m) return null;
  const raw = decodeHtmlEntities(m[1]);
  if (!raw || raw.length < 2) return null;
  return raw;
}

// ── Title quality heuristics ───────────────────────────────────────────────

/** Score how "good" a title looks. Higher = better. */
function titleQuality(title: string | null | undefined): number {
  if (!title) return 0;
  const t = title.trim();
  if (!t) return 0;

  let score = 0;

  // Length: sweet spot is 20-100 chars
  if (t.length >= 15 && t.length <= 200) score += 3;
  else if (t.length >= 8) score += 1;

  // Starts with uppercase
  if (/^[A-Z]/.test(t)) score += 2;

  // Contains spaces (real titles have words)
  const wordCount = t.split(/\s+/).length;
  if (wordCount >= 3) score += 2;
  if (wordCount >= 5) score += 1;

  // Penalties
  if (t.startsWith('http')) score -= 5;        // URL as title
  if (t.startsWith('www.')) score -= 5;        // Domain as title
  if (/^\d+%/.test(t)) score -= 4;            // Starts with percentage
  if (/et al\.?$/i.test(t)) score -= 3;       // Citation reference
  if (t.length <= 5) score -= 3;              // Very short
  if (/^[a-z]/.test(t)) score -= 2;           // Starts lowercase
  if (t.endsWith('.pdf') || t.endsWith('.Pdf')) score -= 2; // Filename
  if (hostMatches(t, 'doi.org')) score -= 3;       // DOI URL
  if (t === '(PDF)') score -= 5;              // PDF placeholder
  // Garbage/obfuscated text (long strings with no spaces)
  if (t.length > 30 && !t.includes(' ')) score -= 5;

  return score;
}

/** Does the stored title look like it needs fixing? */
function titleNeedsRefresh(title: string | null | undefined): boolean {
  if (!title) return true;
  return titleQuality(title) < 3;
}

/** Pick the better title between stored and fetched. */
function pickBetterTitle(stored: string | null | undefined, fetched: string | null): {
  winner: 'stored' | 'fetched' | 'skip';
  title: string;
} {
  if (!fetched) return { winner: 'skip', title: stored || '' };
  if (!stored) return { winner: 'fetched', title: fetched };

  const storedScore = titleQuality(stored);
  const fetchedScore = titleQuality(fetched);

  // Clean common suffix patterns from fetched title
  // e.g., "Paper Title | arXiv" → "Paper Title"
  const cleaned = fetched
    .replace(/\s*[|–—-]\s*(?:YouTube|arXiv|Wikipedia|Medium|Substack|GitHub).*$/i, '')
    .replace(/\s*[|–—-]\s*(?:Google|Microsoft|Amazon|Meta|Apple)\s*$/i, '')
    .trim();

  const cleanedScore = titleQuality(cleaned);
  const bestFetched = cleanedScore >= fetchedScore ? cleaned : fetched;
  const bestFetchedScore = Math.max(cleanedScore, fetchedScore);

  // Fetched is clearly better
  if (bestFetchedScore > storedScore + 1) {
    return { winner: 'fetched', title: bestFetched };
  }

  // Stored is good enough
  return { winner: 'stored', title: stored };
}

// ── Fetching ───────────────────────────────────────────────────────────────

const domainLastFetch = new Map<string, number>();

async function fetchTitle(url: string): Promise<string | null> {
  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    return null;
  }

  if (SKIP_DOMAINS.has(domain) || SKIP_DOMAINS.has(domain.replace('www.', ''))) {
    return null;
  }

  // Per-domain rate limiting
  const lastFetch = domainLastFetch.get(domain) || 0;
  const elapsed = Date.now() - lastFetch;
  if (elapsed < PER_DOMAIN_DELAY_MS) {
    await new Promise(r => setTimeout(r, PER_DOMAIN_DELAY_MS - elapsed));
  }
  domainLastFetch.set(domain, Date.now());

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LongtermWikiBot/1.0; +https://www.longtermwiki.com)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!resp.ok) return null;

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      // PDF, image, etc. — can't extract title
      return null;
    }

    // Read only the first chunk for the <title> tag
    const reader = resp.body?.getReader();
    if (!reader) return null;

    let html = '';
    let bytesRead = 0;
    const decoder = new TextDecoder();

    while (bytesRead < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytesRead += value.length;
      // Stop early if we've found the closing </title> tag
      if (html.includes('</title>') || html.includes('</head>')) break;
    }
    reader.cancel().catch(() => {}); // catch-ok: stream cancel after early-exit; failure means reader was already closed by the runtime

    // Try og:title first (often cleaner), fall back to <title>
    const title = extractOgTitle(html) || extractTitleFromHtml(html);
    // Truncate to 500 chars max (DB allows 1000, but real titles shouldn't be this long)
    if (title && title.length > 500) return title.substring(0, 500).trim();
    return title;
  } catch {
    return null;
  }
}

// ── Parallel execution with concurrency limit ──────────────────────────────

async function runParallel<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Main command ───────────────────────────────────────────────────────────

export async function cmdRefreshTitles(opts: ParsedOpts): Promise<void> {
  const apply = !!opts.apply;
  const verbose = !!opts.verbose;
  const limit = opts.limit as number | undefined;
  const domainFilter = opts.domain as string | undefined;
  const forceAll = !!opts['force-all'];

  console.log(`\n📋 Resource Title Refresh ${apply ? '(APPLY MODE)' : '(DRY RUN)'}\n`);

  // Load resources
  const resources = await loadResourcesPGFirst();
  console.log(`  Loaded ${resources.length} resources from database`);

  // Filter to candidates
  let candidates = resources.filter(r => r.url);

  if (domainFilter) {
    candidates = candidates.filter(r => {
      try { return new URL(r.url).hostname.includes(domainFilter); }
      catch { return false; }
    });
    console.log(`  Filtered to ${candidates.length} resources on domain "${domainFilter}"`);
  }

  if (!forceAll) {
    // Only refresh resources with bad-looking titles
    candidates = candidates.filter(r => titleNeedsRefresh(r.title));
    console.log(`  ${candidates.length} resources have titles that need refresh`);
  } else {
    console.log(`  Force-all mode: checking all ${candidates.length} resources`);
  }

  if (limit && candidates.length > limit) {
    candidates = candidates.slice(0, limit);
    console.log(`  Limited to first ${limit} resources`);
  }

  if (candidates.length === 0) {
    console.log('\n  No resources need title refresh. Done.');
    return;
  }

  // Fetch titles
  console.log(`\n  Fetching titles for ${candidates.length} resources (concurrency: ${CONCURRENCY})...\n`);

  let fetched = 0;
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  let unchanged = 0;
  const updates: Resource[] = [];

  const startTime = Date.now();

  await runParallel(candidates, async (resource, idx) => {
    const fetchedTitle = await fetchTitle(resource.url);
    fetched++;

    if (fetched % 100 === 0 || fetched === candidates.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (fetched / ((Date.now() - startTime) / 1000)).toFixed(1);
      process.stdout.write(`\r  Progress: ${fetched}/${candidates.length} (${rate}/s, ${elapsed}s elapsed)`);
    }

    if (!fetchedTitle) {
      failed++;
      if (verbose) {
        console.log(`\n  ✗ ${resource.url.substring(0, 80)} — fetch failed`);
      }
      return;
    }

    const { winner, title } = pickBetterTitle(resource.title, fetchedTitle);

    if (winner === 'fetched') {
      updated++;
      if (verbose || !apply) {
        console.log(`\n  ✓ ${resource.url.substring(0, 70)}`);
        console.log(`    OLD: ${(resource.title || '(none)').substring(0, 80)}`);
        console.log(`    NEW: ${title.substring(0, 80)}`);
      }
      updates.push({ ...resource, title });
    } else if (winner === 'skip') {
      skipped++;
    } else {
      unchanged++;
      if (verbose) {
        console.log(`\n  = ${resource.url.substring(0, 70)}`);
        console.log(`    KEPT: ${resource.title?.substring(0, 80)}`);
        console.log(`    FETCHED: ${fetchedTitle.substring(0, 80)}`);
      }
    }
  }, CONCURRENCY);

  console.log('\n');

  // Summary
  console.log('── Summary ──────────────────────────────────────────');
  console.log(`  Checked:   ${fetched}`);
  console.log(`  To update: ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Skipped:   ${skipped}`);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Time:      ${elapsed}s`);

  if (updates.length === 0) {
    console.log('\n  No updates needed.');
    return;
  }

  if (!apply) {
    console.log(`\n  Run with --apply to save ${updates.length} title updates.`);
    return;
  }

  // Save updates — use individual upserts with rate-limit retry
  console.log(`\n  Saving ${updates.length} title updates to database...`);
  let saved = 0;
  let saveErrors = 0;

  for (let i = 0; i < updates.length; i++) {
    const resource = updates[i];
    let retries = 3;
    let success = false;

    while (retries > 0 && !success) {
      try {
        // typed-client-ok: QUA-770 baseline — resource title refresh script
        const result = await apiRequest<{ id: string }>(
          'POST',
          '/api/resources',
          {
            id: resource.id,
            url: resource.url,
            title: resource.title,
            type: resource.type || null,
            stableId: resource.stable_id || null,
          },
        );
        if (result.ok) {
          saved++;
          success = true;
        } else if (result.message?.includes('429') || result.message?.includes('rate_limit')) {
          retries--;
          await new Promise(r => setTimeout(r, 3000));
        } else {
          saveErrors++;
          console.warn(`  ✗ Failed to save ${resource.id}: ${result.message}`);
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429') || msg.includes('rate_limit')) {
          retries--;
          await new Promise(r => setTimeout(r, 3000));
        } else {
          saveErrors++;
          console.warn(`  ✗ Error saving ${resource.id}: ${msg}`);
          break;
        }
      }
    }
    if (!success && retries === 0) {
      saveErrors++;
    }

    if ((i + 1) % 50 === 0) {
      process.stdout.write(`\r  Saved ${saved}/${i + 1}...`);
    }
  }

  console.log(`\n  ✓ Saved ${saved} titles${saveErrors > 0 ? `, ${saveErrors} errors` : ''}.`);
}
