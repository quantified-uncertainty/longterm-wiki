import { fetchFromWikiServer } from "./wiki-server";
import type { CitationQuote } from "@components/wiki/CitationOverlay";

interface QuotesApiResponse {
  quotes: Array<{
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
  }>;
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
