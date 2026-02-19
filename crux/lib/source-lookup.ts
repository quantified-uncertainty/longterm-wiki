/**
 * Source Lookup — find books/papers online
 *
 * When a citation is a book or paper reference (no URL), this module
 * tries to find it online through various APIs:
 *   - Semantic Scholar (free, good for papers)
 *   - Open Library (free, good for books)
 *   - arXiv (free, good for preprints)
 *
 * Returns the first viable result with fetchable content.
 */

export interface SourceLookupResult {
  url: string;
  title: string;
  abstract?: string;
  source: 'semantic-scholar' | 'open-library' | 'arxiv';
}

export interface CitationRef {
  author?: string;
  year?: string;
  title: string;
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Parse a footnote definition text into structured citation reference.
 * Handles formats like:
 *   - "Author (2024). Title. Publisher."
 *   - "Author, Title, Year"
 *   - "Title by Author (Year)"
 */
export function parseBookReference(footnoteText: string): CitationRef | null {
  if (!footnoteText || footnoteText.trim().length < 5) return null;

  const text = footnoteText.trim();

  // Pattern 1: "Author (Year). Title. ..."
  const pattern1 = text.match(
    /^([^(]+?)\s*\((\d{4})\)\.\s*(.+?)(?:\.\s|$)/,
  );
  if (pattern1) {
    return {
      author: pattern1[1].trim(),
      year: pattern1[2],
      title: pattern1[3].trim().replace(/\.$/, ''),
    };
  }

  // Pattern 2: "Author, "Title", Year" or "Author. "Title." Year"
  const pattern2 = text.match(
    /^(.+?)[,.]?\s*[""](.+?)[""]\s*[,.]?\s*(\d{4})?/,
  );
  if (pattern2) {
    return {
      author: pattern2[1].trim(),
      year: pattern2[3] || undefined,
      title: pattern2[2].trim(),
    };
  }

  // Pattern 3: Just extract year and use the rest as title
  const yearMatch = text.match(/\((\d{4})\)/);
  const year = yearMatch ? yearMatch[1] : undefined;
  const title = text
    .replace(/\(\d{4}\)/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');

  if (title.length >= 5) {
    return { title, year };
  }

  return null;
}

/**
 * Search Semantic Scholar for a paper.
 */
async function searchSemanticScholar(
  ref: CitationRef,
): Promise<SourceLookupResult | null> {
  try {
    const query = encodeURIComponent(
      ref.title + (ref.author ? ` ${ref.author}` : ''),
    );
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&limit=3&fields=title,abstract,url,externalIds`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      data?: Array<{
        title: string;
        abstract?: string;
        url: string;
        externalIds?: { ArXiv?: string; DOI?: string };
      }>;
    };

    if (!data.data || data.data.length === 0) return null;

    // Find best match — check if title is similar
    for (const paper of data.data) {
      const titleLower = ref.title.toLowerCase();
      const paperTitleLower = paper.title.toLowerCase();
      if (
        paperTitleLower.includes(titleLower.slice(0, 30)) ||
        titleLower.includes(paperTitleLower.slice(0, 30))
      ) {
        return {
          url: paper.url,
          title: paper.title,
          abstract: paper.abstract || undefined,
          source: 'semantic-scholar',
        };
      }
    }

    // Fall back to first result
    const first = data.data[0];
    return {
      url: first.url,
      title: first.title,
      abstract: first.abstract || undefined,
      source: 'semantic-scholar',
    };
  } catch {
    return null;
  }
}

/**
 * Search Open Library for a book.
 */
async function searchOpenLibrary(
  ref: CitationRef,
): Promise<SourceLookupResult | null> {
  try {
    const query = encodeURIComponent(
      ref.title + (ref.author ? ` ${ref.author}` : ''),
    );
    const url = `https://openlibrary.org/search.json?q=${query}&limit=3`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      docs?: Array<{
        title: string;
        author_name?: string[];
        first_publish_year?: number;
        key: string;
      }>;
    };

    if (!data.docs || data.docs.length === 0) return null;

    const book = data.docs[0];
    return {
      url: `https://openlibrary.org${book.key}`,
      title: book.title,
      source: 'open-library',
    };
  } catch {
    return null;
  }
}

/**
 * Search arXiv for a preprint.
 */
async function searchArxiv(
  ref: CitationRef,
): Promise<SourceLookupResult | null> {
  try {
    const query = encodeURIComponent(
      `ti:${ref.title}` + (ref.author ? ` AND au:${ref.author.split(' ').pop()}` : ''),
    );
    const url = `https://export.arxiv.org/api/query?search_query=${query}&max_results=3`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const xml = await response.text();

    // Simple XML parsing for arXiv Atom feed
    const entries = xml.split('<entry>').slice(1);
    for (const entry of entries) {
      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
      const abstractMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
      const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);

      if (titleMatch && idMatch) {
        return {
          url: idMatch[1].trim(),
          title: titleMatch[1].trim().replace(/\s+/g, ' '),
          abstract: abstractMatch
            ? abstractMatch[1].trim().replace(/\s+/g, ' ')
            : undefined,
          source: 'arxiv',
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Try to find a source (book/paper) online.
 * Searches multiple APIs in parallel and returns the first viable result.
 */
export async function findSourceOnline(
  ref: CitationRef,
): Promise<SourceLookupResult | null> {
  // Run all searches in parallel
  const results = await Promise.allSettled([
    searchSemanticScholar(ref),
    searchArxiv(ref),
    searchOpenLibrary(ref),
  ]);

  // Return first successful result
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      return result.value;
    }
  }

  return null;
}
