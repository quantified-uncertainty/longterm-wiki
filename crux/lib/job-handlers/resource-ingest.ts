/**
 * Resource Ingest Job Handler
 *
 * Fetches a resource URL, caches content, and persists metadata.
 * Uses the shared source-fetcher for Wayback, Firecrawl, forum APIs, and PDF support.
 *
 * Given a URL, this handler:
 *   1. Fetches via the shared source-fetcher (with domain-aware strategies)
 *   2. Detects soft-404s on top of the fetcher's paywall/dead detection
 *   3. Persists fetch_status + last_fetched_at to the resource record
 *   4. Chains a resource-enrich job for reachable resources
 *
 * Content caching is handled by fetchSource() internally — it writes to
 * citation_content automatically. This handler only needs to persist the
 * resource-level fetch_status.
 *
 * Params:
 *   - resourceId: string (required) — resource stableId
 *   - url: string (required) — URL to ingest
 *   - previousContentHash: string (optional) — hash of previously fetched content
 */

import type { JobHandlerResult, JobHandlerContext } from './types.ts';
import { createHash } from 'crypto';
import { z } from 'zod';
import { isPrivateHost } from '../source-check/source-fetcher.ts';
import { fetchSource, type FetchedSourceStatus } from '../search/source-fetcher.ts';
import { createJob } from '../wiki-server/jobs.ts';
import { updateResourceFetchStatus, findResourcesByContentHash } from '../wiki-server/resources.ts';

// ---------------------------------------------------------------------------
// Params validation
// ---------------------------------------------------------------------------

const ResourceIngestParamsSchema = z.object({
  resourceId: z.string().min(1),
  url: z.string().url(),
  previousContentHash: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 1_000_000; // 1MB for hash computation
const CONTENT_HASH_PREFIX_LENGTH = 16; // Use first 16 hex chars of SHA-256

/**
 * Heuristic patterns that indicate a soft 404 — a page that returns HTTP 200
 * but actually shows an error or placeholder. Short pages (<5KB) with "404"
 * in the text are strong signals; longer pages might just mention the number.
 */
const SOFT_404_PATTERNS = [
  /page\s+not\s+found/i,
  /this\s+page\s+doesn['']t\s+exist/i,
  /the\s+page\s+you\s+(were\s+looking\s+for|requested)\s+(could\s+not\s+be\s+found|doesn['']t\s+exist|is\s+no\s+longer\s+available)/i,
  /404\s*[-–—:]\s*(not\s+found|error|page)/i,
  /error\s+404/i,
  /content\s+(has\s+been\s+)?removed/i,
  /no\s+longer\s+available/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeContentHash(text: string): string {
  return createHash('sha256')
    .update(text.slice(0, MAX_CONTENT_LENGTH))
    .digest('hex')
    .slice(0, CONTENT_HASH_PREFIX_LENGTH);
}

function detectSoft404(text: string, contentLength: number): boolean {
  if (contentLength > 5000) return false;
  return SOFT_404_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Detect Twitter/X nonexistent profile pages.
 * Twitter returns HTTP 200 with a very short page (~493 chars) for nonexistent
 * profiles. Real profiles include Open Graph meta tags with the user's name.
 */
function detectTwitterSoft404(text: string, contentLength: number, finalUrl: string): boolean {
  try {
    const host = new URL(finalUrl).hostname.replace(/^www\./, '');
    if (host !== 'twitter.com' && host !== 'x.com') return false;
  } catch {
    return false;
  }
  // Nonexistent Twitter profiles return very short pages (~493 chars).
  // Real profiles include og:description with the user's bio and are longer.
  if (contentLength > 1500) return false;
  // Additional signal: real profiles have og:description with actual content
  if (text.includes('og:description')) return false;
  return true;
}

/**
 * Cookie consent / cookie-wall redirect patterns.
 * Sites like nature.com redirect to cookie consent pages instead of serving content.
 */
const COOKIE_CONSENT_URL_PATTERNS = [
  /[?&]error=cookies/i,
  /cookie.consent/i,
  /cookie.policy/i,
  /cookie.notice/i,
  /gdpr.consent/i,
  /consent.manager/i,
  /cookie.wall/i,
];

const COOKIE_CONSENT_CONTENT_PATTERNS = [
  /we\s+use\s+cookies/i,
  /cookie\s+consent/i,
  /accept\s+(all\s+)?cookies/i,
  /cookies?\s+(are\s+)?(not\s+supported|disabled|required)/i,
  /enable\s+cookies/i,
  /this\s+site\s+requires?\s+cookies/i,
  /cookies?\s+must\s+be\s+enabled/i,
];

/**
 * Detect cookie consent pages that replace real article content.
 * Only flags short pages (<10KB) to avoid false positives on real articles
 * that mention cookies in their privacy notice footer.
 */
function detectCookieConsent(text: string, contentLength: number, finalUrl: string): boolean {
  // URL-based detection — redirect to a consent page
  if (COOKIE_CONSENT_URL_PATTERNS.some((p) => p.test(finalUrl))) return true;
  // Content-based detection — only on short pages
  if (contentLength > 10_000) return false;
  return COOKIE_CONSENT_CONTENT_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

type ResourceStatus =
  | 'reachable'
  | 'soft_404'
  | 'not_found'
  | 'error'
  | 'unreachable'
  | 'timeout'
  | 'paywall'
  | 'blocked'
  | 'invalid_url'
  | 'cookie_blocked';

/** Map fetchSource status to our more granular ResourceStatus. */
function mapFetchStatus(fetchStatus: FetchedSourceStatus, httpStatus: number): ResourceStatus {
  switch (fetchStatus) {
    case 'ok': return 'reachable';
    case 'paywall': return 'paywall';
    case 'dead':
      if (httpStatus === 404) return 'not_found';
      if (httpStatus === 0) return 'unreachable';
      return 'error';
    case 'error':
      if (httpStatus === 0) return 'timeout';
      return 'error';
  }
}

/** Map ResourceStatus to the fetch_status enum used by the resources table. */
function toFetchStatus(status: ResourceStatus): 'ok' | 'dead' | 'paywall' | 'error' {
  switch (status) {
    case 'reachable': return 'ok';
    case 'paywall': return 'paywall';
    case 'soft_404':
    case 'not_found':
    case 'unreachable': return 'dead';
    case 'invalid_url': return 'dead';
    case 'error':
    case 'timeout':
    case 'blocked':
    case 'cookie_blocked': return 'error';
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleResourceIngest(
  params: Record<string, unknown>,
  ctx: JobHandlerContext,
): Promise<JobHandlerResult> {
  const parsed = ResourceIngestParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      success: false,
      data: {},
      error: `Invalid params: ${parsed.error.message.slice(0, 300)}`,
    };
  }
  const { resourceId, url, previousContentHash } = parsed.data;

  if (ctx.verbose) {
    console.log(`[resource-ingest] Ingesting ${url} (resource=${resourceId})`);
  }

  const startTime = Date.now();

  try {
    // Validate URL scheme — only HTTPS allowed
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      await persistFetchStatus(resourceId, 'invalid_url', ctx);
      return buildResult(resourceId, url, 'invalid_url', startTime, {
        error: 'Malformed URL',
      });
    }

    if (parsedUrl.protocol !== 'https:') {
      await persistFetchStatus(resourceId, 'invalid_url', ctx);
      return buildResult(resourceId, url, 'invalid_url', startTime, {
        error: `Unsupported protocol: ${parsedUrl.protocol}`,
      });
    }

    // SSRF protection — block private/internal hosts
    if (isPrivateHost(parsedUrl.hostname.toLowerCase())) {
      await persistFetchStatus(resourceId, 'blocked', ctx);
      return buildResult(resourceId, url, 'blocked', startTime, {
        error: 'Private host blocked (SSRF protection)',
      });
    }

    // Fetch using the shared source-fetcher (handles Wayback, Firecrawl, forum
    // APIs, PDF extraction, YouTube transcripts, domain-aware strategies).
    // maxAgeMs: 0 forces a fresh fetch (skip cache — we're ingesting).
    // fetchSource() automatically caches content in citation_content.
    const result = await fetchSource({
      url,
      extractMode: 'full',
      resourceId,
      maxAgeMs: 0,
    });

    // Map fetcher status to our more granular ResourceStatus
    let status = mapFetchStatus(result.status, result.httpStatus);

    // Additional soft-404 detection (fetchSource doesn't check for this)
    if (status === 'reachable' && result.content.length > 0) {
      const finalUrl = result.url || url;
      if (
        detectSoft404(result.content, result.content.length) ||
        detectTwitterSoft404(result.content, result.content.length, finalUrl)
      ) {
        status = 'soft_404';
      } else if (detectCookieConsent(result.content, result.content.length, finalUrl)) {
        status = 'cookie_blocked';
      }
    }

    // Compute content hash for change detection
    const contentHash = result.content.length > 0
      ? computeContentHash(result.content)
      : null;

    const contentChanged = previousContentHash != null && contentHash != null
      ? contentHash !== previousContentHash
      : undefined;

    // Duplicate detection: check for other resources with the same content hash.
    // Log a warning but don't skip ingestion — still persist everything.
    let duplicateOf: string | undefined;
    if (contentHash) {
      try {
        const dupResult = await findResourcesByContentHash(contentHash, resourceId);
        if (dupResult.ok && dupResult.data.resources.length > 0) {
          const existing = dupResult.data.resources[0];
          duplicateOf = existing.id;
          console.warn(
            `[resource-ingest] Duplicate content detected: ${resourceId} has same content hash as ${existing.id} (${existing.url})`,
          );
        }
      } catch (e: unknown) {
        // Best-effort — don't fail ingestion if duplicate check errors
        console.warn(`[resource-ingest] Duplicate check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Persist fetch_status to the resource record.
    // Content caching is already handled by fetchSource() internally.
    await persistFetchStatus(resourceId, status, ctx);

    // Chain: enqueue resource-enrich job for reachable resources with content.
    // Skip if content is empty — fetchSource returns ok but no content for some
    // pages (JS-only shells, empty responses). Enriching without content is wasteful
    // and source-check would still see not_cached.
    if (status === 'reachable' && result.content.length > 0) {
      createJob({
        type: 'resource-enrich',
        params: { resourceId, url },
        priority: 0,
        dedupKey: `resource-enrich:${resourceId}`,
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[resource-ingest] Failed to enqueue enrichment for ${resourceId}: ${msg}`);
      });
    }

    return buildResult(resourceId, url, status, startTime, {
      statusCode: result.httpStatus,
      contentType: result.contentType ?? 'html',
      contentLength: result.content.length,
      contentHash,
      contentChanged,
      previousContentHash: previousContentHash ?? null,
      title: result.title || undefined,
      fetchMethod: result.contentType === 'pdf' ? 'pdf' : result.contentType === 'transcript' ? 'youtube' : 'shared-fetcher',
      duplicateOf: duplicateOf ?? undefined,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      data: { resourceId, url, durationMs: Date.now() - startTime },
      error: error.slice(0, 500),
    };
  }
}

// ---------------------------------------------------------------------------
// Persistence — update resource record
// ---------------------------------------------------------------------------

/**
 * Update the resource's fetch_status. Fire-and-forget — errors are logged
 * but don't fail the job. Content caching is handled by fetchSource().
 */
async function persistFetchStatus(
  resourceId: string,
  status: ResourceStatus,
  ctx: JobHandlerContext,
): Promise<void> {
  try {
    await updateResourceFetchStatus(resourceId, {
      fetchStatus: toFetchStatus(status),
      lastFetchedAt: new Date().toISOString(),
    });
    if (ctx.verbose) {
      console.log(`[resource-ingest] Updated fetch_status=${toFetchStatus(status)} for ${resourceId}`);
    }
  } catch (e: unknown) {
    console.warn(`[resource-ingest] Failed to update fetch_status for ${resourceId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Result builder
// ---------------------------------------------------------------------------

function buildResult(
  resourceId: string,
  url: string,
  status: ResourceStatus,
  startTime: number,
  extra: Record<string, unknown> = {},
): JobHandlerResult {
  return {
    success: true,
    data: {
      resourceId,
      url,
      status,
      durationMs: Date.now() - startTime,
      ...extra,
    },
  };
}
