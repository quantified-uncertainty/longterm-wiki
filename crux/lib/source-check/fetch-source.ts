/**
 * Shared source-content fetching utility for source-check commands.
 *
 * Consolidates the duplicated fetchSourceContent() logic from
 * factbase-source-check.ts and records-source-check.ts into a single
 * implementation with comprehensive SSRF protection, caching, paywall
 * detection, and error logging.
 */

import {
  detectPaywall,
  isUnverifiableDomain,
  classifyFetchError,
  type SourceFetchErrorType,
} from '../search/paywall-detection.ts';
import { getCitationContentByUrl } from '../wiki-server/citations.ts';

// ── Constants ─────────────────────────────────────────────────────────

/** Max characters of source content to send to the LLM */
export const MAX_CONTENT_LENGTH = 8000;

/** Default HTTP fetch timeout in milliseconds */
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Default User-Agent header */
const DEFAULT_USER_AGENT = 'LongtermWiki/1.0';

/** Default log prefix for console messages */
const DEFAULT_LOG_PREFIX = '[source-check]';

// ── Types ─────────────────────────────────────────────────────────────

/** Result of fetching source content, with structured error info */
export interface FetchSourceResult {
  content: string | null;
  errorType?: SourceFetchErrorType;
  errorMessage?: string;
}

/** Options for fetchSourceContent */
export interface FetchSourceOptions {
  /** User-Agent header for direct HTTP requests */
  userAgent?: string;
  /** Prefix for log messages (e.g., '[kb-source-check]') */
  logPrefix?: string;
  /** Max characters of content to return (default: 8000) */
  maxContentLength?: number;
  /** HTTP fetch timeout in milliseconds (default: 15000) */
  fetchTimeoutMs?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Check if a hostname is a private/internal host that should be blocked
 * for SSRF protection. Covers IPv4 private ranges, IPv6 private/reserved
 * ranges, and IPv4-mapped IPv6 addresses.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '[::]' ||
    host === '::' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    // IPv4 private ranges
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    // IPv6 private/reserved ranges
    /^fe80:/i.test(host) ||          // link-local
    /^f[cd][0-9a-f]{2}:/i.test(host) || // unique local (fc00::/7)
    /^::ffff:127\./i.test(host) ||   // IPv4-mapped loopback
    /^::ffff:10\./i.test(host) ||    // IPv4-mapped private
    /^::ffff:192\.168\./i.test(host) || // IPv4-mapped private
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./i.test(host) || // IPv4-mapped private
    /^::ffff:169\.254\./i.test(host) // IPv4-mapped link-local
  );
}

/**
 * Convert HTML to plain text by stripping tags and unescaping entities.
 * Uses a 9-replace chain for basic but reliable HTML-to-text conversion.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Main fetch function ───────────────────────────────────────────────

/**
 * Fetch source content for a URL.
 *
 * Resolution order:
 *   1. Reject non-HTTPS URLs (SSRF protection)
 *   2. Block private/internal hosts (SSRF protection)
 *   3. Check for unverifiable domains (social media etc.)
 *   4. Try wiki-server citation_content cache (fullText field)
 *   5. Direct HTTP fetch with HTML tag stripping
 *   6. Detect paywall signals in fetched content
 *
 * Returns structured error types for machine-readable classification.
 */
export async function fetchSourceContent(
  url: string,
  options?: FetchSourceOptions,
): Promise<FetchSourceResult> {
  const prefix = options?.logPrefix ?? DEFAULT_LOG_PREFIX;
  const maxLen = options?.maxContentLength ?? MAX_CONTENT_LENGTH;
  const timeoutMs = options?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;

  // SSRF protection: only allow https:// URLs (no http://, file://, ftp://, etc.)
  if (!url.startsWith('https://')) {
    console.warn(`${prefix} Skipping non-HTTPS URL: ${url}`);
    return { content: null, errorType: 'fetch_error', errorMessage: 'Non-HTTPS URL' };
  }

  // SSRF protection: block private/internal hosts
  try {
    const parsed = new URL(url);
    if (isPrivateHost(parsed.hostname)) {
      console.warn(`${prefix} Blocking private/internal URL: ${url}`);
      return { content: null, errorType: 'access_denied', errorMessage: 'Private/internal host blocked' };
    }
  } catch {
    return { content: null, errorType: 'fetch_error', errorMessage: 'Invalid URL' };
  }

  // Check for unverifiable domains (social media, etc.)
  if (isUnverifiableDomain(url)) {
    console.warn(`${prefix} Unverifiable domain: ${url}`);
    return { content: null, errorType: 'unverifiable_domain', errorMessage: 'Domain blocks automated access' };
  }

  // Try wiki-server citation_content cache first
  try {
    const result = await getCitationContentByUrl(url);
    if (result.ok && result.data) {
      // RPC type inference resolves to `never` because the route can return 400/404.
      // The actual shape includes fullText from the citation_content table row.
      const cached = result.data as Record<string, unknown>;
      const content = cached.fullText as string | null;
      if (content && content.length > 0) {
        // Check for paywall signals even in cached content
        if (detectPaywall(content)) {
          console.warn(`${prefix} Cached content for ${url} appears paywalled`);
          return { content: content.slice(0, maxLen), errorType: 'paywall', errorMessage: 'Cached content appears paywalled' };
        }
        return { content: content.slice(0, maxLen) };
      }
    }
  } catch (e: unknown) {
    // Wiki-server unavailable — fall back to direct fetch
    console.warn(`${prefix} Wiki-server cache miss for ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Direct fetch with timeout
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errorType = classifyFetchError(response.status, null, null, url);
      console.warn(`${prefix} HTTP ${response.status} for ${url}`);
      return { content: null, errorType: errorType ?? 'fetch_error', errorMessage: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const text = htmlToPlainText(html);
    const content = text.slice(0, maxLen);

    // Detect paywall in fetched content
    if (detectPaywall(content)) {
      console.warn(`${prefix} Paywall detected for ${url}`);
      return { content, errorType: 'paywall', errorMessage: 'Content appears paywalled' };
    }

    return { content };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      console.warn(`${prefix} Timeout fetching ${url}`);
      return { content: null, errorType: 'timeout', errorMessage: 'Request timed out' };
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`${prefix} Failed to fetch ${url}: ${msg}`);
    return { content: null, errorType: 'fetch_error', errorMessage: msg };
  }
}
