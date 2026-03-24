/**
 * Shared types for source-checking across factbase-source-check and source-check-orchestrate.
 */

import type { SourceFetchErrorType } from '../search/paywall-detection.ts';

/** Result of fetching a source URL's content */
export interface FetchSourceResult {
  content: string | null;
  errorType?: SourceFetchErrorType;
  errorMessage?: string;
}

/** Result of an LLM source-check call */
export interface LlmSourceCheckResult {
  verdict: string;
  confidence: number;
  extractedValue: string;
  reasoning: string;
}

/** Category of a wiki page verification item */
export type WikiPageVerifyCategory =
  | 'sourced-claim'
  | 'unfootnoted-claim'
  | 'cross-ref-claim'
  | 'stale-temporal-claim';

/**
 * A verification item extracted from a wiki page's prose content.
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

/** Constants shared across source-check modules */
export const SOURCE_CHECK_CONSTANTS = {
  MAX_CONTENT_LENGTH: 8000,
  FETCH_TIMEOUT_MS: 15_000,
  /** Estimated cost per LLM source-check call in USD */
  ESTIMATED_COST_PER_VERIFICATION: 0.01,
} as const;
