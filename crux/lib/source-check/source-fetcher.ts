/**
 * Source Fetcher — fetch and cache source documents for source-checking.
 *
 * Shared by factbase-source-check and source-check-orchestrate. Handles:
 * - SSRF protection (block private/internal hosts)
 * - Unverifiable domain detection
 * - Wiki-server citation content cache lookup
 * - Direct HTTP fetch with HTML-to-text stripping
 * - Paywall detection
 */

import {
  detectPaywall,
  isUnverifiableDomain,
  classifyFetchError,
} from '../search/paywall-detection.ts';
import { getCitationContentByUrl } from '../wiki-server/citations.ts';
import type { FetchSourceResult } from './types.ts';
import { SOURCE_CHECK_CONSTANTS } from './types.ts';

const { MAX_CONTENT_LENGTH, FETCH_TIMEOUT_MS } = SOURCE_CHECK_CONSTANTS;

/**
 * Check if a hostname is a private/internal address that should be blocked (SSRF protection).
 */
export function isPrivateHost(host: string): boolean {
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
    host === '::1' || host === '0.0.0.0' || host === '[::]' || host === '::' ||
    host.endsWith('.local') || host.endsWith('.internal') ||
    /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^fe80:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^::ffff:127\./i.test(host) || /^::ffff:10\./i.test(host) ||
    /^::ffff:192\.168\./i.test(host) ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./i.test(host) ||
    /^::ffff:169\.254\./i.test(host)
  );
}

/**
 * Strip HTML tags and entities from raw HTML, returning plain text.
 */
export function htmlToText(html: string): string {
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

/**
 * Fetch source content from a URL for source-checking.
 *
 * Attempts in order:
 * 1. Wiki-server citation content cache
 * 2. Direct HTTP fetch
 *
 * Applies SSRF protection, unverifiable domain detection, and paywall detection.
 *
 * @param url - The source URL to fetch
 * @param userAgent - User-Agent string for direct HTTP fetches
 * @param logPrefix - Prefix for log messages (default: '[source-check]')
 */
export async function fetchSourceContent(
  url: string,
  userAgent = 'LongtermWiki-SourceChecker/1.0',
  logPrefix = '[source-check]',
): Promise<FetchSourceResult> {
  if (!url.startsWith('https://')) {
    return { content: null, errorType: 'fetch_error', errorMessage: 'Non-HTTPS URL' };
  }

  // SSRF protection
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (isPrivateHost(host)) {
      return { content: null, errorType: 'access_denied', errorMessage: 'Private host blocked' };
    }
  } catch {
    return { content: null, errorType: 'fetch_error', errorMessage: 'Invalid URL' };
  }

  if (isUnverifiableDomain(url)) {
    return { content: null, errorType: 'unverifiable_domain', errorMessage: 'Domain blocks automated access' };
  }

  // Try wiki-server citation_content cache
  try {
    const result = await getCitationContentByUrl(url);
    if (result.ok && result.data) {
      const cached = result.data as Record<string, unknown>;
      const content = cached.fullText as string | null;
      if (content && content.length > 0) {
        if (detectPaywall(content)) {
          return { content: content.slice(0, MAX_CONTENT_LENGTH), errorType: 'paywall', errorMessage: 'Cached content appears paywalled' };
        }
        return { content: content.slice(0, MAX_CONTENT_LENGTH) };
      }
    }
  } catch (e: unknown) {
    console.warn(`${logPrefix} Cache miss: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Direct fetch
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
      return { content: null, errorType: errorType ?? 'fetch_error', errorMessage: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const text = htmlToText(html).slice(0, MAX_CONTENT_LENGTH);

    if (detectPaywall(text)) {
      return { content: text, errorType: 'paywall', errorMessage: 'Content appears paywalled' };
    }

    return { content: text };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { content: null, errorType: 'timeout', errorMessage: 'Request timed out' };
    }
    return { content: null, errorType: 'fetch_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }
}
