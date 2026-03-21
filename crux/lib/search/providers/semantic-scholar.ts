/**
 * Semantic Scholar Discovery Provider — finds academic papers and author profiles.
 *
 * Distinct from `source-lookup.ts` (which resolves specific known citations).
 * This provider does topic discovery: "find papers about X" or "find author Y's work".
 *
 * API: https://api.semanticscholar.org/graph/v1
 * No auth required (free API, 100 requests per 5 minutes).
 */

import type { SearchProvider, SearchHit } from './types.ts';

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

interface S2Paper {
  paperId: string;
  title: string;
  abstract?: string | null;
  year?: number | null;
  citationCount?: number | null;
  url: string;
  authors?: Array<{ authorId: string; name: string }>;
}

interface S2PaperSearchResponse {
  total: number;
  data: S2Paper[];
}

interface S2Author {
  authorId: string;
  name: string;
  url: string;
  paperCount?: number;
  citationCount?: number;
  hIndex?: number;
  affiliations?: string[];
}

interface S2AuthorSearchResponse {
  total: number;
  data: S2Author[];
}

// ---------------------------------------------------------------------------
// Rate limiting (100 req / 5 min = ~20/min)
// ---------------------------------------------------------------------------

const REQUEST_DELAY_MS = 350; // ~170 req/min theoretical, leaves headroom
let lastRequestTime = 0;

async function rateLimitDelay(): Promise<void> {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const S2_PAPER_FIELDS = 'title,abstract,year,citationCount,url,authors';
const S2_AUTHOR_FIELDS = 'name,url,paperCount,citationCount,hIndex,affiliations';

async function s2Fetch<T>(path: string): Promise<T> {
  await rateLimitDelay();

  const response = await fetch(`${S2_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Semantic Scholar API error ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Search strategies
// ---------------------------------------------------------------------------

function paperToHit(paper: S2Paper): SearchHit {
  const authorNames = paper.authors?.slice(0, 3).map(a => a.name).join(', ') ?? '';
  return {
    url: paper.url,
    title: paper.title,
    snippet: [
      paper.year ? `(${paper.year})` : null,
      authorNames || null,
      paper.citationCount != null ? `${paper.citationCount} citations` : null,
      paper.abstract?.slice(0, 200) ?? null,
    ].filter(Boolean).join(' — '),
    provider: 'semantic-scholar',
  };
}

async function searchPapers(query: string, maxResults: number): Promise<SearchHit[]> {
  const encoded = encodeURIComponent(query);
  const data = await s2Fetch<S2PaperSearchResponse>(
    `/paper/search?query=${encoded}&limit=${maxResults}&fields=${S2_PAPER_FIELDS}`,
  );

  return data.data
    .filter(p => p.title && p.url)
    .map(paperToHit);
}

async function searchAuthors(query: string, maxResults: number): Promise<S2Author[]> {
  const encoded = encodeURIComponent(query);
  const data = await s2Fetch<S2AuthorSearchResponse>(
    `/author/search?query=${encoded}&limit=${maxResults}&fields=${S2_AUTHOR_FIELDS}`,
  );

  return data.data;
}

async function getAuthorPapers(authorId: string, maxResults: number): Promise<SearchHit[]> {
  const data = await s2Fetch<{ data: S2Paper[] }>(
    `/author/${authorId}/papers?limit=${maxResults}&fields=${S2_PAPER_FIELDS}`,
  );

  return data.data
    .filter(p => p.title && p.url)
    .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))
    .slice(0, maxResults)
    .map(paperToHit);
}

// ---------------------------------------------------------------------------
// Public provider
// ---------------------------------------------------------------------------

/**
 * Create a Semantic Scholar search provider.
 *
 * Strategy varies by entity type:
 * - person: author search first, then fetch their top papers
 * - concept / approach / ai-model: paper search by topic
 * - organization: paper search with institution name
 * - benchmark: paper search by benchmark name
 */
export function createSemanticScholarProvider(): SearchProvider {
  return {
    name: 'semantic-scholar',

    isAvailable(): boolean {
      // No API key required — always available
      return true;
    },

    async search(query: string, maxResults: number, entityType?: string): Promise<SearchHit[]> {
      const hits: SearchHit[] = [];

      if (entityType === 'person') {
        // Search for the author first
        const authors = await searchAuthors(query, 3);

        if (authors.length > 0) {
          // Add author profile as a hit
          const topAuthor = authors[0];
          hits.push({
            url: topAuthor.url,
            title: topAuthor.name,
            snippet: [
              topAuthor.affiliations?.join(', ') ?? null,
              topAuthor.paperCount != null ? `${topAuthor.paperCount} papers` : null,
              topAuthor.citationCount != null ? `${topAuthor.citationCount} citations` : null,
              topAuthor.hIndex != null ? `h-index: ${topAuthor.hIndex}` : null,
            ].filter(Boolean).join(' — '),
            provider: 'semantic-scholar',
          });

          // Fetch their top papers
          const papers = await getAuthorPapers(topAuthor.authorId, maxResults - 1);
          hits.push(...papers);
        }

        // If author search didn't yield enough, supplement with paper search
        if (hits.length < maxResults) {
          const papers = await searchPapers(query, maxResults - hits.length);
          const existingUrls = new Set(hits.map(h => h.url));
          for (const paper of papers) {
            if (!existingUrls.has(paper.url)) {
              hits.push(paper);
            }
          }
        }
      } else {
        // concept, approach, ai-model, benchmark, organization: paper search
        const papers = await searchPapers(query, maxResults);
        hits.push(...papers);
      }

      return hits.slice(0, maxResults);
    },
  };
}
