import { fetchFromWikiServer } from "./wiki-server";

/** Citation quote data from the wiki-server API */
export interface CitationQuote {
  footnote: number;
  url: string | null;
  claimText: string;
  sourceQuote: string | null;
  sourceTitle: string | null;
  quoteVerified: boolean;
  verificationScore: number | null;
  verifiedAt: string | null;
  accuracyVerdict: string | null;
  accuracyScore: number | null;
  accuracyIssues: string | null;
  accuracyCheckedAt: string | null;
}

/** Summary stats for page-level banner */
export interface CitationHealthSummary {
  total: number;
  verified: number;
  accurate: number;
  inaccurate: number;
  unsupported: number;
  minorIssues: number;
  unchecked: number;
}

interface QuotesApiResponse {
  quotes: CitationQuote[];
}

/**
 * Fetch citation verification data for a specific page from the wiki-server.
 * Returns an empty array if the server is unavailable or the page has no data.
 *
 * Revalidates every 10 minutes — citation data changes infrequently.
 */
export async function getCitationQuotes(
  pageId: string
): Promise<CitationQuote[]> {
  const result = await fetchFromWikiServer<QuotesApiResponse>(
    `/api/citations/quotes?page_id=${encodeURIComponent(pageId)}`,
    { revalidate: 600 }
  );

  if (!result?.quotes) return [];

  // Only include quotes that have some verification data worth showing
  return result.quotes.filter(
    (q) => q.quoteVerified || q.accuracyVerdict !== null
  );
}

/**
 * Computes a summary of citation health from the quotes array.
 * Pure function — safe to call from server or client components.
 */
export function computeCitationHealth(
  quotes: CitationQuote[]
): CitationHealthSummary {
  let verified = 0;
  let accurate = 0;
  let inaccurate = 0;
  let unsupported = 0;
  let minorIssues = 0;
  let unchecked = 0;

  for (const q of quotes) {
    if (q.accuracyVerdict) {
      switch (q.accuracyVerdict) {
        case "accurate":
          accurate++;
          break;
        case "inaccurate":
          inaccurate++;
          break;
        case "unsupported":
          unsupported++;
          break;
        case "minor_issues":
          minorIssues++;
          break;
      }
    } else if (q.quoteVerified) {
      verified++;
    } else {
      unchecked++;
    }
  }

  return {
    total: quotes.length,
    verified,
    accurate,
    inaccurate,
    unsupported,
    minorIssues,
    unchecked,
  };
}
