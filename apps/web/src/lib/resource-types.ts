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
