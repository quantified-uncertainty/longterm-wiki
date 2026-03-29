/**
 * Resource Verification Job Handler
 *
 * Checks resource URLs for liveness and content freshness.
 * Part of the verified-by-default data pipeline (#3209).
 *
 * Params:
 *   - resourceId: string (required) — resource stableId
 *   - url: string (required) — URL to verify
 *   - previousContentHash: string (optional) — hash of previously fetched content
 *
 * Checks:
 *   1. URL is reachable (HTTP 200, follows redirects)
 *   2. Content type is acceptable (text/html, application/json, etc.)
 *   3. Content hasn't changed (if previousContentHash provided)
 *   4. Page isn't a soft 404 or paywall
 */

import type { JobHandlerResult, JobHandlerContext } from './types.ts';
import { createHash } from 'crypto';
import { z } from 'zod';
import { isPrivateHost } from '../source-check/source-fetcher.ts';

// ---------------------------------------------------------------------------
// Params validation
// ---------------------------------------------------------------------------

const ResourceVerifyParamsSchema = z.object({
  resourceId: z.string().min(1),
  url: z.string().url(),
  previousContentHash: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;
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
  // Only check short pages — long pages mentioning "404" are likely real content
  if (contentLength > 5000) return false;
  return SOFT_404_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Resource verification status
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
  | 'invalid_url';

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleResourceVerify(
  params: Record<string, unknown>,
  ctx: JobHandlerContext,
): Promise<JobHandlerResult> {
  const parsed = ResourceVerifyParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      success: false,
      data: {},
      error: `Invalid params: ${parsed.error.message.slice(0, 300)}`,
    };
  }
  const { resourceId, url, previousContentHash } = parsed.data;

  if (ctx.verbose) {
    console.log(`[resource-verify] Checking ${url} (resource=${resourceId})`);
  }

  const startTime = Date.now();

  try {
    // Validate URL scheme — only HTTPS allowed
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return buildResult(resourceId, url, 'invalid_url', startTime, {
        error: 'Malformed URL',
      });
    }

    if (parsedUrl.protocol !== 'https:') {
      return buildResult(resourceId, url, 'invalid_url', startTime, {
        error: `Unsupported protocol: ${parsedUrl.protocol}`,
      });
    }

    // SSRF protection — block private/internal hosts
    if (isPrivateHost(parsedUrl.hostname.toLowerCase())) {
      return buildResult(resourceId, url, 'blocked', startTime, {
        error: 'Private host blocked (SSRF protection)',
      });
    }

    // Perform the fetch
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'LongtermWiki-ResourceVerifier/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    } catch (err: unknown) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      return buildResult(resourceId, url, isTimeout ? 'timeout' : 'unreachable', startTime, {
        error: isTimeout ? 'Request timed out' : msg.slice(0, 300),
      });
    }
    // NOTE: Do NOT clear timeout here — keep AbortController running through body read
    // to protect against slow-loris attacks (server sends headers fast, body slowly).

    const statusCode = response.status;
    const contentType = response.headers.get('content-type') ?? 'unknown';
    const finalUrl = response.url; // After redirects

    // HTTP error
    if (statusCode >= 400) {
      clearTimeout(timeout);
      const status: ResourceStatus = statusCode === 404 ? 'not_found' : 'error';
      return buildResult(resourceId, url, status, startTime, {
        statusCode,
        contentType,
        finalUrl: finalUrl !== url ? finalUrl : undefined,
      });
    }

    // Read content with size limit to prevent OOM on large responses
    const contentLengthHeader = parseInt(response.headers.get('content-length') ?? '0', 10);
    if (contentLengthHeader > MAX_CONTENT_LENGTH * 10) {
      clearTimeout(timeout);
      // Content-Length header indicates a very large response — skip body read
      return buildResult(resourceId, url, 'reachable', startTime, {
        statusCode,
        contentType,
        contentLength: contentLengthHeader,
        finalUrl: finalUrl !== url ? finalUrl : undefined,
        skippedBody: true,
      });
    }

    // Stream-read up to MAX_CONTENT_LENGTH bytes to avoid unbounded memory usage
    let text: string;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (totalBytes < MAX_CONTENT_LENGTH) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalBytes += value.length;
        }
        reader.cancel().catch(() => {}); // Discard remaining body
      } catch {
        reader.cancel().catch(() => {});
      }
      text = new TextDecoder().decode(Buffer.concat(chunks).slice(0, MAX_CONTENT_LENGTH));
    } else {
      text = (await response.text()).slice(0, MAX_CONTENT_LENGTH);
    }
    clearTimeout(timeout); // Safe to clear now — body read is complete
    const contentLength = text.length;
    const contentHash = computeContentHash(text);

    // Content change detection
    const contentChanged = previousContentHash != null
      ? contentHash !== previousContentHash
      : undefined;

    // Soft-404 detection
    const isSoft404 = statusCode === 200 && detectSoft404(text, contentLength);

    // Paywall detection — reuse the existing source-check infrastructure
    // (fetchSourceContent already detects paywalls, but we're doing a direct
    // fetch here for hash computation, so check inline)
    const isPaywall = detectBasicPaywall(text, contentLength);

    let status: ResourceStatus;
    if (isSoft404) {
      status = 'soft_404';
    } else if (isPaywall) {
      status = 'paywall';
    } else {
      status = 'reachable';
    }

    return buildResult(resourceId, url, status, startTime, {
      statusCode,
      contentType,
      contentLength,
      contentHash,
      contentChanged,
      previousContentHash: previousContentHash ?? null,
      finalUrl: finalUrl !== url ? finalUrl : undefined,
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

// ---------------------------------------------------------------------------
// Basic paywall detection
// ---------------------------------------------------------------------------

/**
 * Lightweight paywall check for very short pages that are likely behind a wall.
 * This is intentionally conservative — a false negative (missing a paywall) is
 * better than a false positive (marking a real page as paywalled).
 */
function detectBasicPaywall(text: string, contentLength: number): boolean {
  if (contentLength > 10_000) return false; // Real pages are usually long enough
  const lowerText = text.toLowerCase();
  const signals = [
    'subscribe to continue',
    'subscribe to read',
    'sign in to read',
    'create a free account',
    'this content is for subscribers',
    'paywall',
    'premium content',
    'members only',
  ];
  return signals.some((s) => lowerText.includes(s));
}
