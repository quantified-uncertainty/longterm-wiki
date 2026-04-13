/**
 * Shared types for sourcing across factbase-sourcing and sourcing-orchestrate.
 */

import type { SourceFetchErrorType } from '../search/paywall-detection.ts';

/** Result of fetching a source URL's content */
export interface FetchSourceResult {
  content: string | null;
  errorType?: SourceFetchErrorType;
  errorMessage?: string;
  /** True if a resource-ingest job was auto-enqueued on cache miss */
  ingestEnqueued?: boolean;
  /** HTTP status code from citation_content or resource fetch_status, if available */
  httpStatus?: number | null;
  /** Where the content was sourced from: 'live' (primary URL cache), 'archive' (Wayback Machine) */
  sourceOrigin?: 'live' | 'archive';
  /** ISO date string of the Wayback Machine snapshot, if sourceOrigin is 'archive' */
  archiveDate?: string;
}

/** Result of an LLM sourcing call */
export interface LlmSourcingResult {
  verdict: string;
  confidence: number;
  extractedValue: string;
  reasoning: string;
}

/** Category of a wiki page sourcing item */
export type WikiPageVerifyCategory =
  | 'sourced-claim'
  | 'unfootnoted-claim'
  | 'cross-ref-claim'
  | 'stale-temporal-claim';

/**
 * A sourcing item extracted from a wiki page's prose content.
 *
 * Each item represents a factual claim that can be verified in some way:
 * - sourced-claim: Has a footnote URL, can be checked against the source
 * - unfootnoted-claim: Factual assertion without any citation
 * - cross-ref-claim: Claim value appears to conflict with FactBase data
 * - stale-temporal-claim: References a date/year that may be outdated
 */
export interface WikiPageVerifyItem {
  pageSlug: string;
  claimText: string;
  claimType: string;  // ExtractedClaim.type
  category: WikiPageVerifyCategory;
  sourceUrl?: string;        // For sourced claims
  footnoteNumber?: number;   // For sourced claims
  factId?: string;           // For cross-ref claims
  factValue?: string;        // For cross-ref claims
  sourceContext: string;     // Original text around the claim
  priority: number;          // Higher = more important to verify
}

/** Fetch statuses that indicate a dead/unreachable resource */
export const DEAD_FETCH_STATUSES = ["dead", "soft_404", "not_found", "timeout", "unreachable"] as const;

/** Check if a fetch_status value indicates a dead/unreachable resource. */
export function isDeadFetchStatus(status: string | null | undefined): boolean {
  return status != null && (DEAD_FETCH_STATUSES as readonly string[]).includes(status);
}

/** Constants shared across sourcing modules */
export const SOURCE_CHECK_CONSTANTS = {
  /** Max chars of source text to retain after fetching (before LLM truncation).
   *  Set high — fetching is cheap, and full text enables future improvements
   *  (smarter extraction, search within page). DB stores unlimited text. */
  MAX_CONTENT_LENGTH: 500_000,
  FETCH_TIMEOUT_MS: 15_000,
  /**
   * Max chars of source text to include in LLM sourcing prompts.
   * 30K ≈ 7-8K Haiku input tokens. QUA-342 investigation found stuck
   * verdicts were dominated by content truncation — the relevant section of
   * long documents (SEC proxies, arXiv, long Wikipedia articles) sat past
   * the previous 12K/4K cutoffs. Sources beyond this still need chunking.
   */
  PROMPT_CONTENT_LENGTH: 30_000,
  /** Estimated cost per LLM sourcing call in USD */
  ESTIMATED_COST_PER_VERIFICATION: 0.01,
} as const;
