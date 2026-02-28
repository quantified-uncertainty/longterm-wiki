import { fetchFromWikiServer } from "./wiki-server";
import type {
  CitationHealthResult,
  ClaimsByPageResult,
  ClaimsBySourceUrlResult,
} from "@wiki-server/api-response-types";
import type {
  AccuracyVerdict,
} from "@wiki-server/api-types";

/**
 * Valid accuracy verdict values — mirrors ACCURACY_VERDICTS from api-types.
 * Inlined here to avoid a runtime import of @wiki-server/api-types
 * (vitest can't resolve it as a runtime dependency).
 */
const ACCURACY_VERDICTS: readonly string[] = [
  "accurate",
  "inaccurate",
  "unsupported",
  "minor_issues",
  "not_verifiable",
];

// Re-export the server type for consumers
export type { CitationHealthResult } from "@wiki-server/api-response-types";

/**
 * Citation quote data from the wiki-server API.
 *
 * This is the subset of CitationQuoteRow fields that the frontend needs.
 * Kept as a standalone interface (rather than importing CitationQuoteRow)
 * because the server returns all DB columns while the frontend only
 * consumes a projection, and the field naming differs for timestamps
 * (server returns Date objects, frontend receives ISO strings via JSON).
 */
export interface CitationQuote {
  footnote: number;
  url: string | null;
  resourceId: string | null;
  claimText: string;
  sourceQuote: string | null;
  sourceTitle: string | null;
  sourceType: string | null;
  quoteVerified: boolean;
  verificationScore: number | null;
  verifiedAt: string | null;
  accuracyVerdict: AccuracyVerdict | null;
  accuracyScore: number | null;
  accuracyIssues: string | null;
  accuracySupportingQuotes: string | null;
  verificationDifficulty: string | null;
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

/**
 * Narrow a string | null to AccuracyVerdict | null at runtime.
 * Returns null for unrecognized values instead of silently mis-typing them.
 */
function toAccuracyVerdict(value: string | null): AccuracyVerdict | null {
  if (value === null) return null;
  return (ACCURACY_VERDICTS as readonly string[]).includes(value)
    ? (value as AccuracyVerdict)
    : null;
}

/**
 * Fetch citation verification data for a specific page from the wiki-server.
 * Returns an empty array if the server is unavailable or the page has no data.
 *
 * Reads from the claims system (claims + claim_page_references + claim_sources)
 * via the /api/claims/by-page endpoint, which replaced the deprecated
 * /api/citations/quotes endpoint (#1311).
 *
 * Revalidates every 10 minutes — citation data changes infrequently.
 */
export async function getCitationQuotes(
  pageId: string
): Promise<CitationQuote[]> {
  const result = await fetchFromWikiServer<ClaimsByPageResult>(
    `/api/claims/by-page?page_id=${encodeURIComponent(pageId)}`,
    { revalidate: 600 }
  );

  if (!result?.quotes) return [];

  // Only include quotes that have some verification data worth showing.
  // Map server rows to CitationQuote, narrowing accuracyVerdict from string to the union type.
  return result.quotes
    .filter((q) => q.quoteVerified || q.accuracyVerdict !== null)
    .map((q): CitationQuote => ({
      footnote: q.footnote,
      url: q.url,
      resourceId: q.resourceId,
      claimText: q.claimText,
      sourceQuote: q.sourceQuote,
      sourceTitle: q.sourceTitle,
      sourceType: q.sourceType,
      quoteVerified: q.quoteVerified,
      verificationScore: q.verificationScore,
      verifiedAt: q.verifiedAt,
      accuracyVerdict: toAccuracyVerdict(q.accuracyVerdict),
      accuracyScore: q.accuracyScore,
      accuracyIssues: q.accuracyIssues,
      accuracySupportingQuotes: q.accuracySupportingQuotes,
      verificationDifficulty: q.verificationDifficulty,
      accuracyCheckedAt: q.accuracyCheckedAt,
    }));
}

/** Citation quote with page context — returned by by-source-url endpoint */
export interface CrossPageCitationQuote extends CitationQuote {
  pageId: string;
}

/**
 * Fetch all claims across all pages for a given source URL.
 * Used by /source/[id] pages to show cross-page citation data.
 *
 * Reads from the claims system via the /api/claims/by-source-url endpoint,
 * which replaced the deprecated /api/citations/quotes-by-url endpoint (#1311).
 */
export async function getCitationQuotesByUrl(
  url: string
): Promise<ClaimsBySourceUrlResult | null> {
  return fetchFromWikiServer<ClaimsBySourceUrlResult>(
    `/api/claims/by-source-url?url=${encodeURIComponent(url)}`,
    { revalidate: 600 }
  );
}

/**
 * Computes a summary of citation health from the quotes array.
 * Pure function — safe to call from server or client components.
 *
 * Uses the canonical ACCURACY_VERDICTS from api-types to ensure
 * all verdict values are handled consistently.
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
        case "not_verifiable":
          // not_verifiable is a valid verdict but doesn't count as
          // accurate or inaccurate — tracked separately if needed
          break;
        default:
          // Exhaustive check: if a new verdict is added to AccuracyVerdict,
          // TypeScript will flag this as an error.
          q.accuracyVerdict satisfies never;
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
