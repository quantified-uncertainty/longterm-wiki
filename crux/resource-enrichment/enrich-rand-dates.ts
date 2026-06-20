/**
 * Resource Enrichment — RAND Corporation Publication Dates
 *
 * Fills in missing published_date for RAND resources by:
 *   1. Extracting dates from URL path patterns (commentary, blog, news)
 *   2. Scraping HTML meta tags from RAND publication pages
 *      - citation_publication_date (most precise, e.g. "2024/8/13")
 *      - rand-teaser-date (fallback, e.g. "20240813")
 *      - DC.Date (year-only fallback, e.g. "2024")
 *   3. Converting PDF URLs to their HTML landing page equivalents
 *
 * Skips non-publication pages (topics, about, homepage) which don't have dates.
 *
 * No API key required — uses plain HTTP with a browser User-Agent.
 */

import { loadResourcesPGFirst, saveResources } from '../resource-io.ts';
import { sleep } from '../resource-utils.ts';
import type { Resource } from '../resource-types.ts';
import type { CommandResult } from '../lib/cli.ts';
import { hostMatches } from '@longterm-wiki/url-utils';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── URL classification ────────────────────────────────────────────────────

/** Pages that don't have publication dates — skip them. */
function isNonPublicationUrl(url: string): boolean {
  return (
    url === 'https://www.rand.org/' ||
    url.includes('/topics/') ||
    url.includes('/about/') ||
    url.includes('/about.html') ||
    url.includes('/centers/') ||
    url.includes('/global-and-emerging-risks/')
  );
}

// ── Date extraction from URL paths ────────────────────────────────────────

/**
 * Extract a date from RAND URL path patterns. Returns YYYY-MM-DD, YYYY-MM,
 * or null if no date is embedded in the URL.
 *
 * Patterns:
 *   /commentary/YYYY/MM/slug.html → YYYY-MM
 *   /articles/YYYY/slug.html      → YYYY
 *   /blog/YYYY/MM/slug.html       → YYYY-MM
 *   /news/press/YYYY/MM/DD.html   → YYYY-MM-DD
 *   /research/projects/YYYY/...   → YYYY
 */
function extractDateFromUrl(url: string): string | null {
  // /commentary/YYYY/MM/ or /blog/YYYY/MM/
  const commentaryMatch = url.match(
    /\/(?:commentary|blog)\/(\d{4})\/(\d{2})\//,
  );
  if (commentaryMatch) {
    return `${commentaryMatch[1]}-${commentaryMatch[2]}-01`;
  }

  // /news/press/YYYY/MM/DD.html
  const pressMatch = url.match(/\/press\/(\d{4})\/(\d{2})\/(\d{2})\.html/);
  if (pressMatch) {
    return `${pressMatch[1]}-${pressMatch[2]}-${pressMatch[3]}`;
  }

  // /articles/YYYY/ or /research/projects/YYYY/
  const yearMatch = url.match(/\/(?:articles|projects)\/(\d{4})\//);
  if (yearMatch) {
    return `${yearMatch[1]}-01-01`;
  }

  return null;
}

// ── HTML meta tag scraping ────────────────────────────────────────────────

/**
 * Convert a RAND PDF URL to its HTML landing page URL.
 *
 * Pattern: /content/dam/rand/pubs/{type}/{group}/{id}/RAND_{id}.pdf
 *       → /pubs/{type}/{id}.html
 */
function pdfUrlToHtmlUrl(url: string): string | null {
  const match = url.match(
    /\/content\/dam\/rand\/pubs\/(\w+)\/\w+\/([^/]+)\/RAND_/,
  );
  if (match) {
    return `https://www.rand.org/pubs/${match[1]}/${match[2]}.html`;
  }
  return null;
}

/**
 * Parse a date from RAND meta tag formats.
 *
 * Handles:
 *   - citation_publication_date: "2024/8/13" or "2024/08/13"
 *   - rand-teaser-date: "20240813" (YYYYMMDD compact)
 *   - DC.Date: "2024" (year only)
 */
function parseRandDate(value: string): string | null {
  // YYYY/M/D or YYYY/MM/DD format (citation_publication_date)
  const slashDate = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashDate) {
    const month = slashDate[2].padStart(2, '0');
    const day = slashDate[3].padStart(2, '0');
    return `${slashDate[1]}-${month}-${day}`;
  }

  // YYYYMMDD compact format (rand-teaser-date)
  const compactDate = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactDate) {
    return `${compactDate[1]}-${compactDate[2]}-${compactDate[3]}`;
  }

  // YYYY year-only (DC.Date)
  const yearOnly = value.match(/^(\d{4})$/);
  if (yearOnly) {
    return `${yearOnly[1]}-01-01`;
  }

  return null;
}

/**
 * Fetch a RAND page and extract the publication date from HTML meta tags.
 *
 * Priority:
 *   1. citation_publication_date (most precise)
 *   2. rand-teaser-date (YYYYMMDD)
 *   3. DC.Date (year-only fallback)
 */
async function fetchDateFromPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;

    // Only read the head of the HTML — we don't need the full page body.
    // Meta tags are always in <head> which is at the top of the document.
    const text = await response.text();
    // Limit parsing to first 10KB for safety
    const head = text.slice(0, 10000);

    // Try meta tags in priority order
    const citationDate = head.match(
      /name="citation_publication_date"\s+content="([^"]+)"/,
    );
    if (citationDate) {
      const parsed = parseRandDate(citationDate[1]);
      if (parsed) return parsed;
    }

    const teaserDate = head.match(
      /name="rand-teaser-date"\s+content="([^"]+)"/,
    );
    if (teaserDate) {
      const parsed = parseRandDate(teaserDate[1]);
      if (parsed) return parsed;
    }

    const dcDate = head.match(/name="DC\.Date"\s+content="([^"]+)"/);
    if (dcDate) {
      const parsed = parseRandDate(dcDate[1]);
      if (parsed) return parsed;
    }

    return null;
  } catch (err: unknown) {
    // Network error, timeout, etc. — not fatal
    return null;
  }
}

// ── Main command ──────────────────────────────────────────────────────────

export async function enrichRandDatesCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = !!(options['dry-run'] || options.dryRun);
  const verbose = !!(options.verbose);
  const limit = (options.limit as number) || 200;

  console.log('RAND Corporation Date Enrichment\n');
  if (dryRun) console.log('  DRY RUN -- no changes will be written\n');

  const resources = await loadResourcesPGFirst();
  const rand = resources.filter(
    (r) =>
      r.url &&
      hostMatches(r.url, 'rand.org') &&
      !r.published_date &&
      !isNonPublicationUrl(r.url),
  );

  const skippedNonPub = resources.filter(
    (r) =>
      r.url &&
      hostMatches(r.url, 'rand.org') &&
      !r.published_date &&
      isNonPublicationUrl(r.url),
  ).length;

  console.log(
    `  ${rand.length} RAND publications without dates (${skippedNonPub} non-publication pages skipped)`,
  );

  const toProcess = rand.slice(0, limit);
  if (toProcess.length === 0) {
    console.log('  All RAND publications already have dates');
    return { exitCode: 0, output: 'All RAND publications already have dates' };
  }

  let fromUrl = 0;
  let fromScrape = 0;
  let failed = 0;
  const updated: Resource[] = [];

  for (const r of toProcess) {
    // Strategy 1: Extract from URL pattern
    const urlDate = extractDateFromUrl(r.url);
    if (urlDate) {
      r.published_date = urlDate;
      fromUrl++;
      updated.push(r);
      if (verbose) console.log(`  URL: ${urlDate} | ${r.title || r.url}`);
      continue;
    }

    // Strategy 2: For PDF URLs, derive the HTML page URL first
    let pageUrl = r.url;
    if (r.url.endsWith('.pdf')) {
      const htmlUrl = pdfUrlToHtmlUrl(r.url);
      if (htmlUrl) {
        pageUrl = htmlUrl;
      } else {
        failed++;
        if (verbose) console.log(`  SKIP (PDF, no HTML mapping): ${r.url}`);
        continue;
      }
    }

    // Strategy 3: Scrape HTML meta tags
    const scraped = await fetchDateFromPage(pageUrl);
    if (scraped) {
      r.published_date = scraped;
      fromScrape++;
      updated.push(r);
      if (verbose)
        console.log(`  META: ${scraped} | ${r.title || r.url}`);
    } else {
      failed++;
      if (verbose) console.log(`  FAIL: ${r.title || r.url}`);
    }

    // Be polite to RAND servers
    await sleep(500);
  }

  console.log(`\n  Results:`);
  console.log(`    From URL pattern: ${fromUrl}`);
  console.log(`    From HTML scrape: ${fromScrape}`);
  console.log(`    Failed:           ${failed}`);
  console.log(`    Total updated:    ${updated.length}`);

  if (!dryRun && updated.length > 0) {
    await saveResources(updated);
    console.log(`\n  Saved ${updated.length} resources to PG`);
  }

  return {
    exitCode: 0,
    output: `Updated ${updated.length} RAND resources with dates`,
  };
}
