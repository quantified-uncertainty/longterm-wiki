/** Shared author reference used across resource displays. */
export interface AuthorRef {
  name: string;
  href: string | null;
}

/** Unified resource row used by all resource tables/lists. */
export interface ResourceDisplayRow {
  id: string;
  title: string;
  url: string;
  type: string;
  domain: string | null;
  publicationName: string | null;
  credibility: number | null;
  citingPageCount: number;
  publishedDate: string | null;
  authors: AuthorRef[];
  summary: string | null;
  fetchStatus: string | null;
  archiveUrl: string | null;
}

/** Extract bare domain from a URL (no www prefix). Returns null on parse failure. */
export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Extract a publication date from common URL patterns.
 * Returns an ISO date string (YYYY-MM-DD) or null.
 * Only recognizes years in 2000-2030 to avoid false positives from version numbers.
 */
export function extractDateFromUrl(url: string): string | null {
  try {
    const urlPath = new URL(url).pathname;
    const fullDate = urlPath.match(
      /(?:^|\/)(\d{4})[-/](\d{2})[-/](\d{2})(?:\/|$|-)/
    );
    if (fullDate) {
      const [, y, m, d] = fullDate;
      const year = Number(y);
      const month = Number(m);
      const day = Number(d);
      if (
        year >= 2000 &&
        year <= 2030 &&
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= 31
      ) {
        return `${y}-${m}-${d}`;
      }
      // Full date pattern matched but values were invalid — don't fall through
      // to partial date which would incorrectly truncate (e.g. 2024/03/32 → 2024-03-01)
      return null;
    }
    const partialDate = urlPath.match(/(?:^|\/)(\d{4})\/(\d{2})(?:\/|$)/);
    if (partialDate) {
      const [, y, m] = partialDate;
      const year = Number(y);
      const month = Number(m);
      if (year >= 2000 && year <= 2030 && month >= 1 && month <= 12) {
        return `${y}-${m}-01`;
      }
    }
    return null;
  } catch {
    return null;
  }
}
