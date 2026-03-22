/**
 * Shared types for verification across records-verify and verify-orchestrate.
 */

import type { SourceFetchErrorType } from '../search/paywall-detection.ts';

/** Result of fetching a source URL's content */
export interface FetchSourceResult {
  content: string | null;
  errorType?: SourceFetchErrorType;
  errorMessage?: string;
}

/** Result of an LLM verification call */
export interface LlmVerificationResult {
  verdict: string;
  confidence: number;
  extractedValue: string;
  reasoning: string;
}

/** Constants shared across verification modules */
export const VERIFICATION_CONSTANTS = {
  MAX_CONTENT_LENGTH: 8000,
  FETCH_TIMEOUT_MS: 15_000,
  /** Estimated cost per LLM verification call in USD */
  ESTIMATED_COST_PER_VERIFICATION: 0.01,
} as const;
