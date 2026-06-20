/**
 * Resource Enrichment — Crossref API
 *
 * Enriches paper-type resources that Semantic Scholar missed. The Crossref API
 * is free, covers non-CS journals and policy papers, and requires no API key.
 *
 * Lookup strategies:
 *   1. Extract DOI from URL → direct Crossref /works/{doi} lookup
 *   2. Fall back to title search via /works?query={title}&rows=1
 *
 * Writes to the resource_papers sub-table and updates base resource
 * authors/published_date when empty.
 */

import { loadResourcesPGFirst } from '../resource-io.ts';
import { extractDOI, isScholarlyUrl, sleep } from '../resource-utils.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import type { Resource } from '../resource-types.ts';
import type { CommandResult } from '../lib/cli.ts';

// ── Crossref types ──────────────────────────────────────────────────────────

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string; // organizational author
}

interface CrossrefDateParts {
  'date-parts': number[][];
}

interface CrossrefWork {
  DOI: string;
  title: string[];
  author?: CrossrefAuthor[];
  'published-print'?: CrossrefDateParts;
  'published-online'?: CrossrefDateParts;
  issued?: CrossrefDateParts;
  'is-referenced-by-count': number;
  abstract?: string;
  'container-title'?: string[];
  type?: string;
}

interface CrossrefWorksResponse {
  status: string;
  message: CrossrefWork;
}

interface CrossrefSearchResponse {
  status: string;
  message: {
    items: CrossrefWork[];
    'total-results': number;
  };
}

// ── Constants ───────────────────────────────────────────────────────────────

const CROSSREF_BASE = 'https://api.crossref.org';
const USER_AGENT = 'LongtermWiki/1.0 (mailto:contact@longtermwiki.com)';
const REQUEST_DELAY_MS = 200;

// ── Crossref API helpers ────────────────────────────────────────────────────

/**
 * Fetch a single work by DOI from Crossref.
 */
async function fetchByDOI(doi: string): Promise<CrossrefWork | null> {
  const url = `${CROSSREF_BASE}/works/${encodeURIComponent(doi)}`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as CrossrefWorksResponse;
    if (data.status !== 'ok') return null;
    return data.message;
  } catch (err: unknown) {
    // Network error — treat as not found
    console.warn(`  Crossref DOI fetch error for ${doi}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Search Crossref by title. Returns the top result if it fuzzy-matches.
 */
async function searchByTitle(title: string): Promise<CrossrefWork | null> {
  const query = encodeURIComponent(title);
  const url = `${CROSSREF_BASE}/works?query=${query}&rows=1`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as CrossrefSearchResponse;
    if (data.status !== 'ok' || !data.message.items || data.message.items.length === 0) {
      return null;
    }
    const candidate = data.message.items[0];
    const candidateTitle = candidate.title?.[0];
    if (!candidateTitle) return null;

    // Verify fuzzy match: normalized word overlap > 50%
    if (!isFuzzyTitleMatch(title, candidateTitle)) {
      return null;
    }
    return candidate;
  } catch (err: unknown) {
    console.warn(`  Crossref title search error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Utility helpers ─────────────────────────────────────────────────────────

/**
 * Fuzzy title match: normalize both titles to lowercase words, then check
 * that the ratio of overlapping words to the smaller word set exceeds 50%.
 */
function isFuzzyTitleMatch(a: string, b: string): boolean {
  const wordsA = normalizeToWords(a);
  const wordsB = normalizeToWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  const smaller = Math.min(wordsA.size, wordsB.size);
  return overlap / smaller > 0.5;
}

function normalizeToWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

/**
 * Format a Crossref author object to "Given Family" string.
 */
function formatAuthor(author: CrossrefAuthor): string {
  if (author.name) return author.name;
  const parts: string[] = [];
  if (author.given) parts.push(author.given);
  if (author.family) parts.push(author.family);
  return parts.join(' ');
}

/**
 * Extract the best year from Crossref date fields. Prefers published-print,
 * then published-online, then issued.
 */
function extractYear(work: CrossrefWork): number | null {
  const dateSources = [work['published-print'], work['published-online'], work.issued];
  for (const source of dateSources) {
    if (source?.['date-parts']?.[0]?.[0]) {
      const year = source['date-parts'][0][0];
      if (year >= 1900 && year <= 2100) return year;
    }
  }
  return null;
}

/**
 * Extract a full date string (YYYY-MM-DD or YYYY-MM or YYYY) from Crossref
 * date fields. Returns null if nothing usable.
 */
function extractDateString(work: CrossrefWork): string | null {
  const dateSources = [work['published-print'], work['published-online'], work.issued];
  for (const source of dateSources) {
    const parts = source?.['date-parts']?.[0];
    if (!parts || !parts[0]) continue;
    const year = parts[0];
    if (year < 1900 || year > 2100) continue;
    if (parts[1]) {
      const month = String(parts[1]).padStart(2, '0');
      if (parts[2]) {
        const day = String(parts[2]).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
      return `${year}-${month}-01`;
    }
    return `${year}-01-01`;
  }
  return null;
}

/**
 * Strip JATS/HTML tags from Crossref abstract text.
 */
function cleanAbstract(raw: string): string {
  // Strip tags to a fixed point so spliced-together angle brackets can't
  // re-form a tag after a single pass.
  let out = raw;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, '');
  } while (out !== prev);
  return out
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Main enrichment command ─────────────────────────────────────────────────

export async function enrichCrossrefCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const limit = (options.limit as number) || 200;
  const dryRun = (options['dry-run'] || options['dryRun']) as boolean;
  const verbose = options.verbose as boolean;

  console.log('Crossref Enrichment (Crossref API -> resource_papers)\n');
  if (dryRun) console.log('  DRY RUN -- no changes will be written\n');

  const resources = await loadResourcesPGFirst();

  // Filter to paper-type resources that are NOT already enriched
  const candidates = resources.filter((r) => {
    if (!r.url) return false;
    if (r.enrichment_status === 'enriched') return false;

    // Paper by type or scholarly URL
    if (r.type === 'paper') return true;
    if (extractDOI(r.url)) return true;
    if (isScholarlyUrl(r.url)) return true;
    return false;
  });

  console.log(`  Found ${candidates.length} unenriched paper-like resources (limit: ${limit})`);

  const toProcess = candidates.slice(0, limit);
  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  let doiLookups = 0;
  let titleSearches = 0;

  const paperBatch: Array<{ resourceId: string } & Record<string, unknown>> = [];
  const resourceUpdates: Array<{ id: string; authors?: string[]; publishedDate?: string }> = [];

  for (const r of toProcess) {
    const doi = extractDOI(r.url);

    let work: CrossrefWork | null = null;

    // Strategy 1: DOI lookup
    if (doi) {
      doiLookups++;
      work = await fetchByDOI(doi);
      await sleep(REQUEST_DELAY_MS);
    }

    // Strategy 2: Title search fallback
    if (!work && r.title) {
      titleSearches++;
      work = await searchByTitle(r.title);
      await sleep(REQUEST_DELAY_MS);
    }

    if (!work) {
      skipped++;
      if (verbose) {
        console.log(`  - No Crossref data: ${r.title || r.url}`);
      }
      continue;
    }

    try {
      const year = extractYear(work);
      const authors = work.author?.map(formatAuthor).filter((a) => a.length > 0) ?? [];

      const paperData: Record<string, unknown> = {
        resourceId: r.id,
        doi: work.DOI,
        citationCount: work['is-referenced-by-count'] ?? null,
        year,
      };

      if (work.abstract) {
        paperData.abstract = cleanAbstract(work.abstract);
      }

      if (work['container-title']?.[0]) {
        // Store journal name in categories (truncate to 50 chars — API limit)
        paperData.categories = [work['container-title'][0].slice(0, 50)];
      }

      // Infer methodology from Crossref type
      if (work.type) {
        const typeToMethodology: Record<string, string> = {
          'journal-article': 'peer-reviewed',
          'proceedings-article': 'peer-reviewed',
          'book-chapter': 'book-chapter',
          'monograph': 'book',
          'report': 'report',
          'dissertation': 'dissertation',
        };
        if (typeToMethodology[work.type]) {
          paperData.methodology = typeToMethodology[work.type];
        }
      }

      paperBatch.push(paperData as { resourceId: string } & Record<string, unknown>);

      // Track base resource updates (authors + publishedDate) when currently empty
      const update: { id: string; authors?: string[]; publishedDate?: string } = { id: r.id };
      let needsUpdate = false;

      if ((!r.authors || r.authors.length === 0) && authors.length > 0) {
        update.authors = authors;
        needsUpdate = true;
      }

      const dateStr = extractDateString(work);
      if (!r.published_date && dateStr) {
        update.publishedDate = dateStr;
        needsUpdate = true;
      }

      if (needsUpdate) {
        resourceUpdates.push(update);
      }

      enriched++;

      if (verbose) {
        const authorStr = authors.length > 0 ? ` by ${authors.slice(0, 2).join(', ')}${authors.length > 2 ? ' et al.' : ''}` : '';
        console.log(`  + ${r.title || work.title?.[0] || r.url}${authorStr} (citations: ${work['is-referenced-by-count'] ?? 0})`);
      }
    } catch (err: unknown) {
      failed++;
      if (verbose) {
        console.log(`  ! ${r.title || r.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`\n  Results: ${enriched} enriched, ${skipped} no match, ${failed} failed`);
  console.log(`  Lookups: ${doiLookups} DOI, ${titleSearches} title search`);

  // Write to sub-table via batch-details API
  if (!dryRun && paperBatch.length > 0) {
    console.log(`\n  Writing ${paperBatch.length} paper records to resource_papers...`);

    for (let i = 0; i < paperBatch.length; i += 200) {
      const batch = paperBatch.slice(i, i + 200);
      // typed-client-ok: QUA-770 baseline — resource enrichment pipeline, internal write path
      const result = await apiRequest<{ ok: boolean; upserted: { papers: number } }>(
        'POST',
        '/api/resources/batch-details',
        { papers: batch },
        30000,
      );

      if (result.ok) {
        console.log(`  Batch ${Math.floor(i / 200) + 1}: ${result.data.upserted.papers} papers written`);
      } else {
        console.error(`  Batch ${Math.floor(i / 200) + 1} failed: ${result.message}`);
      }
    }

    // Update enrichment_status and optionally authors/publishedDate on base resources
    const statusBatch = paperBatch.map((p) => {
      const res = resources.find((r) => r.id === p.resourceId);
      const update = resourceUpdates.find((u) => u.id === p.resourceId);
      return {
        id: p.resourceId,
        url: res?.url || '',
        enrichmentStatus: 'enriched',
        ...(update?.authors ? { authors: update.authors } : {}),
        ...(update?.publishedDate ? { publishedDate: update.publishedDate } : {}),
      };
    });

    console.log(`  Updating enrichment_status on ${statusBatch.length} base resources...`);

    for (let i = 0; i < statusBatch.length; i += 200) {
      const batch = statusBatch.slice(i, i + 200);
      const result = await apiRequest(
        'POST',
        '/api/resources/batch',
        { items: batch },
        30000,
      );

      if (!result.ok) {
        console.error(`  Status update batch ${Math.floor(i / 200) + 1} failed: ${result.message}`);
      }
    }

    if (resourceUpdates.length > 0) {
      console.log(`  Updated authors/date on ${resourceUpdates.length} base resources`);
    }
  }

  return { exitCode: 0, output: `Enriched ${enriched} papers via Crossref` };
}
