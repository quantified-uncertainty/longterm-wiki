import { getLocalCitationQuotes } from "@/data";
import type {
  AccuracyVerdict,
} from "@wiki-server/api-types";
import { fetchDetailed } from "./wiki-server";


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
 * Get citation verification data for a specific page.
 *
 * Content pages always read from the build-time citation bundle in
 * database.json — zero runtime API calls. This avoids rate-limit
 * pressure on the wiki-server.
 *
 * Returns an empty array if no data is available.
 */
export function getCitationQuotes(
  pageId: string
): CitationQuote[] {
  return getLocalCitationQuotesForPage(pageId);
}

/**
 * Read citation quotes for a page from the build-time database.json bundle.
 * Returns an empty array if no data was bundled.
 */
function getLocalCitationQuotesForPage(pageId: string): CitationQuote[] {
  const localQuotes = getLocalCitationQuotes(pageId);
  if (!localQuotes) return [];

  return localQuotes
    .map((q: Record<string, unknown>): CitationQuote => ({
      footnote: q.footnote as number,
      url: q.url as string | null,
      resourceId: q.resourceId as string | null,
      claimText: q.claimText as string,
      sourceQuote: q.sourceQuote as string | null,
      sourceTitle: q.sourceTitle as string | null,
      sourceType: q.sourceType as string | null,
      quoteVerified: q.quoteVerified as boolean,
      verificationScore: q.verificationScore as number | null,
      verifiedAt: q.verifiedAt as string | null,
      accuracyVerdict: toAccuracyVerdict(q.accuracyVerdict as string | null),
      accuracyScore: q.accuracyScore as number | null,
      accuracyIssues: q.accuracyIssues as string | null,
      accuracySupportingQuotes: q.accuracySupportingQuotes as string | null,
      verificationDifficulty: q.verificationDifficulty as string | null,
      accuracyCheckedAt: q.accuracyCheckedAt as string | null,
    }));
}

/** Citation quote with page context */
export interface CrossPageCitationQuote extends CitationQuote {
  pageId: string;
}

// ---------------------------------------------------------------------------
// Unified Source-Check Verdicts
// ---------------------------------------------------------------------------

/**
 * Source-check verdict for a citation, from the unified source_check_verdicts table.
 * Uses the unified verdict vocabulary (confirmed/contradicted/unverifiable/outdated/partial).
 */
export interface SourceCheckCitationVerdict {
  recordId: string;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  lastComputedAt: string | null;
}

/**
 * Fetch unified source-check verdicts for a page's citations.
 *
 * Queries the wiki-server for source_check_verdicts with recordType='citation'
 * and recordId prefix matching the page slug.
 *
 * This is a server-side function — only call from Server Components or
 * server-side data fetching. Returns an empty array if the wiki-server
 * is unavailable.
 */
export async function getSourceCheckVerdicts(
  pageSlug: string,
): Promise<SourceCheckCitationVerdict[]> {
  const result = await fetchDetailed<{
    verdicts: Array<{
      recordType: string;
      recordId: string;
      verdict: string;
      confidence: number | null;
      reasoning: string | null;
      lastComputedAt: string | null;
    }>;
    total: number;
  }>(`/api/verifications/verdicts?record_type=citation&limit=200`);

  if (!result.ok) return [];

  // Filter to verdicts matching this page's citations (recordId starts with "page:<slug>:")
  const prefix = `page:${pageSlug}:`;
  return result.data.verdicts
    .filter((v) => v.recordId.startsWith(prefix))
    .map((v) => ({
      recordId: v.recordId,
      verdict: v.verdict,
      confidence: v.confidence,
      reasoning: v.reasoning,
      lastComputedAt: v.lastComputedAt,
    }));
}

/**
 * Compute citation health summary from unified source-check verdicts.
 *
 * Maps the unified verdict vocabulary back to the CitationHealthSummary shape
 * so the CitationHealthBanner can use either data source.
 */
export function computeHealthFromSourceCheck(
  verdicts: SourceCheckCitationVerdict[],
  totalCitations: number,
): CitationHealthSummary {
  let accurate = 0;
  let inaccurate = 0;
  let unsupported = 0;
  let minorIssues = 0;

  for (const v of verdicts) {
    switch (v.verdict) {
      case "confirmed":
        accurate++;
        break;
      case "contradicted":
        inaccurate++;
        break;
      case "unverifiable":
        unsupported++;
        break;
      case "partial":
        minorIssues++;
        break;
      case "outdated":
        // outdated maps to minor issues for display purposes
        minorIssues++;
        break;
    }
  }

  const checked = accurate + inaccurate + unsupported + minorIssues;
  const unchecked = totalCitations - checked;

  return {
    total: totalCitations,
    verified: 0,
    accurate,
    inaccurate,
    unsupported,
    minorIssues,
    unchecked: Math.max(0, unchecked),
  };
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
