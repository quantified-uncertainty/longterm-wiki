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

/** @deprecated Use LlmSourceCheckResult */
export type LlmVerificationResult = LlmSourceCheckResult;

/** Constants shared across source-check modules */
export const SOURCE_CHECK_CONSTANTS = {
  MAX_CONTENT_LENGTH: 8000,
  FETCH_TIMEOUT_MS: 15_000,
  /** Estimated cost per LLM source-check call in USD */
  ESTIMATED_COST_PER_VERIFICATION: 0.01,
} as const;

/** @deprecated Use SOURCE_CHECK_CONSTANTS */
export const VERIFICATION_CONSTANTS = SOURCE_CHECK_CONSTANTS;
