/**
 * Source Fetcher — read cached source documents for source-checking.
 *
 * Shared by factbase-source-check and source-check-orchestrate. This is a
 * **read-only** layer: it reads from the citation_content cache populated by
 * the resource-ingest worker. It does NOT fetch URLs directly.
 *
 * If the cache misses, it returns errorType: 'not_cached' — signaling that the
 * resource pipeline should process this URL first (Discussion #3499).
 *
 * Handles:
 * - SSRF protection (block private/internal hosts)
 * - Unverifiable domain detection
 * - Wiki-server citation content cache lookup
 * - Paywall detection on cached content
 */

import {
  detectPaywall,
  isUnverifiableDomain,
} from '../search/paywall-detection.ts';
import { isDeadFetchStatus } from '../../../apps/wiki-server/src/api-types.ts';
import { getCitationContentByUrl } from '../wiki-server/citations.ts';
import { createJob } from '../wiki-server/jobs.ts';
import { lookupResourceByUrl } from '../wiki-server/resources.ts';
import type { FetchSourceResult } from './types.ts';
import { SOURCE_CHECK_CONSTANTS } from './types.ts';

const { MAX_CONTENT_LENGTH } = SOURCE_CHECK_CONSTANTS;

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
 * Prioritizes <main>, <article>, or role="main" content to avoid
 * nav/header/footer pollution that causes false "unverifiable" verdicts.
 */
export function htmlToText(html: string): string {
  // Try to extract the main content area first to avoid nav/menu noise
  const bodyContent = extractMainContent(html) ?? html;

  return bodyContent
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
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
 * Try to extract the main content from an HTML page.
 * Returns the inner HTML of <main>, <article>, or role="main" element,
 * or null if none found.
 */
function extractMainContent(html: string): string | null {
  // Try <main> tag
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch && mainMatch[1].length > 200) return mainMatch[1];

  // Try role="main"
  const roleMainMatch = html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i);
  if (roleMainMatch && roleMainMatch[1].length > 200) return roleMainMatch[1];

  // Try <article> tag
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch && articleMatch[1].length > 200) return articleMatch[1];

  // No main content area found — fall back to full HTML
  return null;
}

/**
 * Read cached source content for source-checking.
 *
 * Reads from the citation_content cache only — does NOT fetch URLs.
 * If the cache misses, returns errorType: 'not_cached' to signal that the
 * resource-ingest pipeline should process this URL first.
 *
 * @param url - The source URL to look up
 * @param _userAgent - Deprecated, ignored (kept for API compat)
 * @param logPrefix - Prefix for log messages (default: '[source-check]')
 */
export async function fetchSourceContent(
  url: string,
  _userAgent = 'LongtermWiki-SourceChecker/1.0',
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

  // Read from wiki-server citation_content cache (populated by resource-ingest worker)
  try {
    const result = await getCitationContentByUrl(url);
    if (result.ok && result.data) {
      const cached = result.data as Record<string, unknown>;
      const httpStatus = cached.httpStatus as number | null;

      // Detect dead links from cached HTTP status (4xx/5xx)
      if (httpStatus != null && httpStatus >= 400) {
        return {
          content: null,
          errorType: 'dead_link',
          errorMessage: `Source URL returned HTTP ${httpStatus}`,
          httpStatus,
        };
      }

      const content = cached.fullText as string | null;
      if (content && content.length > 0) {
        if (detectPaywall(content)) {
          return { content: content.slice(0, MAX_CONTENT_LENGTH), errorType: 'paywall', errorMessage: 'Cached content appears paywalled' };
        }
        return { content: content.slice(0, MAX_CONTENT_LENGTH) };
      }
    }
  } catch (e: unknown) {
    console.warn(`${logPrefix} Cache lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // No cached content — try Wayback Machine archive URL as fallback.
  // The resources table stores archive_url for dead/moved pages.
  let resourceId: string | null = null;
  try {
    const resource = await lookupResourceByUrl(url);
    if (resource.ok && resource.data) {
      const resourceData = resource.data as { id: string; archiveUrl?: string; fetchStatus?: string | null };
      resourceId = resourceData.id;

      // Detect dead links from resource fetch_status (dead, not_found, timeout, etc.)
      if (isDeadFetchStatus(resourceData.fetchStatus)) {
        return {
          content: null,
          errorType: 'dead_link',
          errorMessage: `Resource fetch status: ${resourceData.fetchStatus}`,
        };
      }

      // Try archive URL if available
      if (resourceData.archiveUrl) {
        console.log(`${logPrefix} Primary URL not cached, trying archive: ${resourceData.archiveUrl}`);
        try {
          const archiveResult = await getCitationContentByUrl(resourceData.archiveUrl);
          if (archiveResult.ok && archiveResult.data) {
            const cached = archiveResult.data as Record<string, unknown>;
            const content = cached.fullText as string | null;
            if (content && content.length > 0) {
              if (detectPaywall(content)) {
                return { content: content.slice(0, MAX_CONTENT_LENGTH), errorType: 'paywall', errorMessage: 'Archive content appears paywalled' };
              }
              return { content: content.slice(0, MAX_CONTENT_LENGTH) };
            }
          }
        } catch (e: unknown) {
          console.warn(`${logPrefix} Archive URL lookup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch (e: unknown) {
    console.warn(`${logPrefix} Resource lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Auto-enqueue a resource-ingest job so the content gets fetched for next time
  // (self-healing pipeline, Discussion #3499 Issue H).
  // Fire-and-forget: don't block the caller or fail the source-check.
  let ingestEnqueued = false;
  if (resourceId) {
    try {
      await createJob({
        type: 'resource-ingest',
        params: { resourceId, url },
        priority: 1, // Slightly elevated — source-check is actively waiting for this
        dedupKey: `ingest:${resourceId}`,
      });
      ingestEnqueued = true;
      console.log(`${logPrefix} Auto-enqueued resource-ingest for ${url}`);
    } catch (e: unknown) {
      // Best-effort — don't fail source-check if enqueue fails
      console.warn(`${logPrefix} Failed to auto-enqueue ingest for ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    content: null,
    errorType: 'not_cached',
    errorMessage: ingestEnqueued
      ? 'Source content not in cache — resource-ingest job enqueued'
      : 'Source content not in cache — run resource-ingest first',
    ingestEnqueued,
  };
}
