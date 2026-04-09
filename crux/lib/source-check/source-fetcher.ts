/**
 * Source Fetcher — read cached source documents for source-checking.
 *
 * Shared by factbase-source-check and source-check-orchestrate. This is a
 * **read-only** layer: it reads from the citation_content cache populated by
 * the resource-ingest worker. It does NOT fetch URLs directly — except for
 * the Wayback Machine fallback, which fetches archived copies of dead links.
 *
 * If the cache misses, it returns errorType: 'not_cached' — signaling that the
 * resource pipeline should process this URL first (Discussion #3499).
 *
 * Handles:
 * - SSRF protection (block private/internal hosts)
 * - Unverifiable domain detection
 * - Wiki-server citation content cache lookup
 * - Paywall detection on cached content
 * - Wayback Machine fallback for dead links (configurable via WAYBACK_FALLBACK_ENABLED)
 */

import {
  detectPaywall,
  isUnverifiableDomain,
} from '../search/paywall-detection.ts';
import { isDeadFetchStatus } from './types.ts';
import { getCitationContentByUrl } from '../wiki-server/citations.ts';
import { createJob } from '../wiki-server/jobs.ts';
import { lookupResourceByUrl } from '../wiki-server/resources.ts';
import { lookupWaybackSnapshot, fetchWaybackContent, formatWaybackTimestamp } from '../wayback.ts';
import { isPrivateHost } from '../url-utils.ts';
import { htmlToText } from '../html-utils.ts';
import type { FetchSourceResult } from './types.ts';
import { SOURCE_CHECK_CONSTANTS } from './types.ts';

const { MAX_CONTENT_LENGTH } = SOURCE_CHECK_CONSTANTS;

// Re-export shared utilities for backward compatibility with existing callers
export { isPrivateHost } from '../url-utils.ts';
export { htmlToText } from '../html-utils.ts';

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

  // Whether the Wayback Machine fallback is enabled (default: true).
  // Set WAYBACK_FALLBACK_ENABLED=false to disable.
  const waybackEnabled = process.env.WAYBACK_FALLBACK_ENABLED !== 'false';

  // Track whether the primary URL is a dead link so we can try Wayback fallback
  let isDeadLink = false;
  let deadLinkMessage = '';
  let deadLinkHttpStatus: number | null = null;

  // Read from wiki-server citation_content cache (populated by resource-ingest worker)
  try {
    const result = await getCitationContentByUrl(url);
    if (result.ok && result.data) {
      const cached = result.data as Record<string, unknown>;
      const httpStatus = cached.httpStatus as number | null;

      // Detect dead links from cached HTTP status (4xx/5xx)
      if (httpStatus != null && httpStatus >= 400) {
        isDeadLink = true;
        deadLinkMessage = `Source URL returned HTTP ${httpStatus}`;
        deadLinkHttpStatus = httpStatus;
        // Don't return immediately — try Wayback fallback below
      } else {
        const content = cached.fullText as string | null;
        if (content && content.length > 0) {
          if (detectPaywall(content)) {
            return { content: content.slice(0, MAX_CONTENT_LENGTH), errorType: 'paywall', errorMessage: 'Cached content appears paywalled', sourceOrigin: 'live' };
          }
          return { content: content.slice(0, MAX_CONTENT_LENGTH), sourceOrigin: 'live' };
        }
      }
    }
  } catch (e: unknown) {
    console.warn(`${logPrefix} Cache lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // No cached content — try existing archive URL from resources table.
  let resourceId: string | null = null;
  try {
    const resource = await lookupResourceByUrl(url);
    if (resource.ok && resource.data) {
      const resourceData = resource.data as { id: string; archiveUrl?: string; fetchStatus?: string | null };
      resourceId = resourceData.id;

      // Detect dead links from resource fetch_status (dead, not_found, timeout, etc.)
      if (!isDeadLink && isDeadFetchStatus(resourceData.fetchStatus)) {
        isDeadLink = true;
        deadLinkMessage = `Resource fetch status: ${resourceData.fetchStatus}`;
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
                return { content: content.slice(0, MAX_CONTENT_LENGTH), errorType: 'paywall', errorMessage: 'Archive content appears paywalled', sourceOrigin: 'archive' };
              }
              return { content: content.slice(0, MAX_CONTENT_LENGTH), sourceOrigin: 'archive' };
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

  // ── Wayback Machine live fallback ──────────────────────────────────────────────────
  // If the URL is dead and we have no cached archive content, query Wayback
  // Machine directly and fetch the archived page.
  if (isDeadLink && waybackEnabled) {
    console.log(`${logPrefix} Dead link detected, querying Wayback Machine for: ${url}`);
    try {
      const snapshot = await lookupWaybackSnapshot(url);
      if (snapshot) {
        console.log(`${logPrefix} Wayback snapshot found (${formatWaybackTimestamp(snapshot.timestamp)}), fetching content...`);
        const archived = await fetchWaybackContent(snapshot.url, snapshot.timestamp);
        if (archived && archived.content.length > 0) {
          const archiveDate = formatWaybackTimestamp(snapshot.timestamp);
          console.log(`${logPrefix} Wayback content retrieved (${(archived.content.length / 1024).toFixed(0)}KB, archived ${archiveDate})`);
          if (detectPaywall(archived.content)) {
            return {
              content: archived.content.slice(0, MAX_CONTENT_LENGTH),
              errorType: 'paywall',
              errorMessage: `Archive content appears paywalled (archived ${archiveDate})`,
              sourceOrigin: 'archive',
              archiveDate,
            };
          }
          return {
            content: archived.content.slice(0, MAX_CONTENT_LENGTH),
            sourceOrigin: 'archive',
            archiveDate,
          };
        }
        console.log(`${logPrefix} Wayback snapshot exists but content could not be extracted`);
      } else {
        console.log(`${logPrefix} No Wayback snapshot found for ${url}`);
      }
    } catch (e: unknown) {
      // Best-effort: Wayback failure should not block the source-check pipeline
      console.warn(`${logPrefix} Wayback lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // If the URL was confirmed dead and Wayback couldn't help, return dead_link
  if (isDeadLink) {
    return {
      content: null,
      errorType: 'dead_link',
      errorMessage: deadLinkMessage,
      httpStatus: deadLinkHttpStatus,
    };
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
