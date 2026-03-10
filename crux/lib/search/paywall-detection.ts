/**
 * Paywall & Unverifiable Domain Detection
 *
 * Shared module for detecting paywalled content and unverifiable domains.
 * Used by both source-fetcher.ts (citation verification) and kb-verify.ts
 * (KB fact verification).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Domains that block all automated access — skip fetch */
export const UNVERIFIABLE_DOMAINS = [
  'twitter.com', 'x.com', 'linkedin.com', 'facebook.com', 't.co',
  'instagram.com', 'tiktok.com',
];

/** Keywords indicating a paywall or login wall */
export const PAYWALL_SIGNALS = [
  'subscribe to read', 'sign in to read', 'create a free account',
  'this content is for subscribers', 'subscriber-only', 'paywall',
  'to continue reading', 'unlimited access', 'login required',
  'please sign in', 'register to read',
];

// ---------------------------------------------------------------------------
// Structured error types for source fetch failures
// ---------------------------------------------------------------------------

/**
 * Structured error types for source fetch failures.
 * Used in verification notes to provide machine-readable error classification.
 */
export type SourceFetchErrorType =
  | 'paywall'
  | 'access_denied'
  | 'timeout'
  | 'not_found'
  | 'fetch_error'
  | 'unverifiable_domain';

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

/**
 * Check if a URL belongs to a domain that blocks automated access.
 */
export function isUnverifiableDomain(url: string): boolean {
  const domain = getDomain(url);
  return UNVERIFIABLE_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

/**
 * Detect paywall signals in page content.
 *
 * For short content (< 500 chars), a single paywall signal is enough.
 * For longer content, at least 2 signals must appear in the first 2000 chars
 * to avoid false positives from pages that merely mention paywalls.
 */
export function detectPaywall(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  // Short content (< 500 chars) plus at least one paywall signal
  if (content.length < 500) {
    return PAYWALL_SIGNALS.some(s => lower.includes(s));
  }
  // Longer content: paywall signal must appear early (first 2000 chars)
  const early = lower.slice(0, 2000);
  const signalCount = PAYWALL_SIGNALS.filter(s => early.includes(s)).length;
  return signalCount >= 2;
}

/**
 * Classify a fetch failure into a structured error type.
 *
 * @param httpStatus - The HTTP status code (0 if no response received)
 * @param errorMessage - The error message from the fetch attempt (if any)
 * @param content - The page content (if any was received)
 * @param url - The URL that was fetched
 * @returns The structured error type, or null if the fetch was successful
 */
export function classifyFetchError(
  httpStatus: number,
  errorMessage: string | null,
  content: string | null,
  url: string,
): SourceFetchErrorType | null {
  // Check unverifiable domain first
  if (isUnverifiableDomain(url)) {
    return 'unverifiable_domain';
  }

  // Timeout
  if (errorMessage && (errorMessage.includes('abort') || errorMessage.includes('timeout') || errorMessage.includes('AbortError'))) {
    return 'timeout';
  }

  // HTTP error codes
  if (httpStatus === 403 || httpStatus === 401) {
    return 'access_denied';
  }
  if (httpStatus === 404 || httpStatus === 410) {
    return 'not_found';
  }
  if (httpStatus >= 400) {
    return 'fetch_error';
  }

  // Paywall detection on content
  if (content && detectPaywall(content)) {
    return 'paywall';
  }

  // Generic fetch error (no HTTP response at all)
  if (errorMessage && httpStatus === 0) {
    return 'fetch_error';
  }

  // No error
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
