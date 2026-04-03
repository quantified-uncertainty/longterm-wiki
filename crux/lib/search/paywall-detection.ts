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

/**
 * Negative signals — patterns that indicate the page is NOT paywalled,
 * even if paywall-like phrases appear (e.g., a blog post about newsletters).
 */
export const NEGATIVE_PAYWALL_SIGNALS = [
  'comments section', 'share this article', 'related articles',
  'about the author', 'table of contents', 'references',
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
  | 'unverifiable_domain'
  | 'not_cached'
  | 'dead_link';

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
 * For longer content (>= 500 chars):
 *   1. At least 2 paywall signals must appear in the first 2000 chars
 *   2. Those 2 signals must appear within a 500-character window of each other
 *      (proximity check) to reduce false positives from articles that merely
 *      mention paywalls in different contexts
 *   3. If enough negative signals are present (indicating real article content),
 *      the detection is suppressed
 */
export function detectPaywall(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  // Short content (< 500 chars) plus at least one paywall signal
  if (content.length < 500) {
    return PAYWALL_SIGNALS.some(s => lower.includes(s));
  }
  // Longer content: paywall signals must appear early (first 2000 chars)
  const early = lower.slice(0, 2000);

  // Find positions of all matching paywall signals in the early content
  const signalPositions: number[] = [];
  for (const signal of PAYWALL_SIGNALS) {
    const idx = early.indexOf(signal);
    if (idx !== -1) {
      signalPositions.push(idx);
    }
  }

  // Need at least 2 distinct signals
  if (signalPositions.length < 2) {
    return false;
  }

  // Proximity check: at least 2 signals must appear within a 500-char window
  signalPositions.sort((a, b) => a - b);
  let hasProximity = false;
  for (let i = 0; i < signalPositions.length - 1; i++) {
    if (signalPositions[i + 1] - signalPositions[i] <= 500) {
      hasProximity = true;
      break;
    }
  }

  if (!hasProximity) {
    return false;
  }

  // Negative signal check: if the content has multiple indicators of a real
  // article body, suppress the paywall detection. Count negative signals
  // across the full content (not just early), since article markers like
  // "about the author" and "references" tend to appear at the end.
  const negativeCount = NEGATIVE_PAYWALL_SIGNALS.filter(s => lower.includes(s)).length;
  if (negativeCount >= 3) {
    return false;
  }

  return true;
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

  // Timeout — match specific patterns to avoid false positives on unrelated substrings
  if (errorMessage) {
    const lowerMsg = errorMessage.toLowerCase();
    if (lowerMsg.includes('timeout') || lowerMsg.includes('aborterror') || lowerMsg.includes('aborted') || lowerMsg === 'abort') {
      return 'timeout';
    }
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
// Twitter/X soft-404 detection (#3521)
// ---------------------------------------------------------------------------

/** Domains that serve HTTP 200 for nonexistent profiles with very short pages. */
const TWITTER_DOMAINS = ['twitter.com', 'x.com'];

/**
 * Detect Twitter/X soft-404: nonexistent profiles return HTTP 200 with a very
 * short page (~493 chars). Normal Twitter pages with real content are much longer.
 *
 * @param url - The original or final (post-redirect) URL
 * @param contentLength - Length of the fetched content
 * @param httpStatus - HTTP status code (only 200 triggers detection)
 */
export function detectTwitterSoft404(
  url: string,
  contentLength: number,
  httpStatus: number,
): boolean {
  if (httpStatus !== 200) return false;
  if (contentLength > 1000) return false;
  const domain = getDomain(url);
  return TWITTER_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

// ---------------------------------------------------------------------------
// Cookie consent page detection (#3522)
// ---------------------------------------------------------------------------

/** URL query parameters that indicate a cookie consent redirect. */
const COOKIE_REDIRECT_PATTERNS = [
  'error=cookies_not_supported',
  'error=cookies',
  'cookies_not_supported',
  'cookie-consent',
  'cookieconsent',
  'consent-required',
];

/** Content signals for pages that are only a cookie consent/error page. */
const COOKIE_CONSENT_SIGNALS = [
  'cookies are required',
  'cookies must be enabled',
  'enable cookies to continue',
  'cookies are disabled',
  'cookies_not_supported',
  'please enable cookies',
  'this site requires cookies',
  'accept cookies to continue',
  'cookie consent required',
  'cookies need to be enabled',
];

/**
 * Detect cookie consent redirect pages — sites that redirect to a cookie
 * error/consent page instead of serving the actual article (#3522).
 *
 * Checks both the final URL (for redirect query params) and the page content
 * (for cookie consent messaging). Only flags short pages (< 10KB) to avoid
 * false positives on real articles that mention cookies in a banner.
 *
 * @param finalUrl - The URL after following redirects
 * @param content - The page content
 * @param originalUrl - The originally requested URL
 */
export function detectCookieConsent(
  finalUrl: string,
  content: string,
  originalUrl: string,
): boolean {
  // Check URL patterns — most reliable signal
  const lowerFinalUrl = finalUrl.toLowerCase();
  if (COOKIE_REDIRECT_PATTERNS.some(p => lowerFinalUrl.includes(p))) {
    return true;
  }

  // Content check only for short pages (cookie consent pages are typically short)
  if (!content || content.length > 10_000) return false;

  // Only check if the URL actually changed (redirect happened) or content is very short
  const redirected = finalUrl !== originalUrl;
  const veryShort = content.length < 2000;
  if (!redirected && !veryShort) return false;

  const lower = content.toLowerCase();
  return COOKIE_CONSENT_SIGNALS.some(s => lower.includes(s));
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
