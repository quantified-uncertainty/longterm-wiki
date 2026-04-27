/**
 * Fetch + hash + Wayback helpers for frontier safety frameworks
 * (QUA-691 Phase 4).
 *
 * Wraps `fetchSource()` to compute a normalized-text content hash and
 * best-effort push to web.archive.org (skipped in tests). Returns a
 * `FetchResult` ready to be persisted to `safety_framework_versions`.
 *
 * Framework sources are high-stakes for archival because:
 *   - Anthropic's CDN URL is content-hashed — the canonical URL
 *     tomorrow ≠ yesterday's v3.0 PDF.
 *   - OpenAI / DeepMind / Meta have silently edited blog-post pages
 *     without version bumps.
 * Our `pdfArchiveUrl` is the primary archive; Wayback is the redundancy
 * layer + third-party verifiability.
 */

import { createHash } from 'crypto';
import { fetchSource } from '../lib/search/source-fetcher.ts';

/**
 * SSRF defense-in-depth for framework URLs (QUA-711 review feedback).
 *
 * Today the URLs come from a PR-reviewed YAML (`data/frameworks/*.yaml`),
 * so the practical attack surface is small. But adding this guard now
 * means the architecture is safe to evolve: any future move of these URLs
 * into a database column, an enrichment proposal, or a webhook-driven
 * surface inherits the defense automatically. Cloud-metadata (IMDS at
 * 169.254.169.254) and internal-cluster RFC1918 services are the
 * highest-value SSRF pivots and are explicitly rejected here.
 *
 * Tested against: loopback (127.x), all RFC1918 ranges (10.x, 172.16-31,
 * 192.168.x), link-local (169.254.x), multicast (224+), 0.0.0.0,
 * `localhost` and `*.localhost`, IPv6 loopback (::1), IPv6 unique-local
 * (fc00::/7), IPv6 link-local (fe80::/10), and non-http(s) protocols
 * (file://, ftp://). Returns the parsed URL on success.
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`framework URL is not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `framework URL must be http(s), got ${parsed.protocol} for ${rawUrl}`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  // IPv4 literal — explicit private / loopback / link-local / multicast / 0.x ranges.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const oct1 = Number(v4[1]);
    const oct2 = Number(v4[2]);
    if (
      oct1 === 0 ||
      oct1 === 10 ||
      oct1 === 127 ||
      oct1 >= 224 ||
      (oct1 === 172 && oct2 >= 16 && oct2 <= 31) ||
      (oct1 === 192 && oct2 === 168) ||
      (oct1 === 169 && oct2 === 254)
    ) {
      throw new Error(
        `framework URL resolves to a private/loopback IPv4 address (${host}): ${rawUrl}`,
      );
    }
  }
  // Hostname-literal loopback / IPv6 loopback / unique-local / link-local.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host.startsWith('[::1') ||
    host.startsWith('[fc') ||
    host.startsWith('[fd') ||
    host.startsWith('[fe80')
  ) {
    throw new Error(
      `framework URL resolves to a loopback/private host (${host}): ${rawUrl}`,
    );
  }
  return parsed;
}

export interface FetchOptions {
  url: string;
  /** Max chars to include in the content hash / text payload. Default 200k. */
  maxChars?: number;
  /** Skip the Wayback push. Useful for tests. */
  skipWayback?: boolean;
  /** Override the Wayback pusher (for tests). */
  pushWayback?: (url: string) => Promise<string | null>;
}

export interface FetchResult {
  /** Full raw text, sliced to `maxChars`. */
  sourceText: string;
  contentLengthChars: number;
  contentHash: string;
  contentType: 'pdf' | 'html' | 'markdown' | 'missing';
  httpStatus: number | null;
  /** Normalized URL we actually fetched (may differ from input after redirects). */
  canonicalUrl: string;
  /** The Wayback snapshot URL, if the push succeeded. */
  waybackSnapshotUrl: string | null;
  /** Free-form note explaining any fallback state. */
  note?: string;
}

/** Normalize whitespace + lowercase for hash input — catches trivial re-renders. */
function normalizeForHash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Push a URL to the Wayback Machine's "Save Page Now" endpoint. Returns
 * the snapshot URL on success, `null` on any failure.
 *
 * Best-effort: network timeouts, rate limits, and 5xx are all expected and
 * quietly produce a null (logged by the caller, never thrown).
 */
export async function pushToWayback(url: string): Promise<string | null> {
  try {
    const saveUrl = `https://web.archive.org/save/${url}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(saveUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeoutId);
    if (!res || !res.ok) return null;
    // The Save Page Now endpoint responds with the snapshot URL in the
    // `content-location` header (sometimes as the final redirected URL).
    // Fall back to computing the timestamp from the response URL.
    const location = res.headers.get('content-location') ?? res.url;
    if (location && location.includes('/web/')) {
      return new URL(location, 'https://web.archive.org').toString();
    }
    return null;
  } catch {
    return null;
  }
}

function mapContentType(
  ct: string | undefined,
  url: string,
): 'pdf' | 'html' | 'markdown' | 'missing' {
  if (!ct) return 'missing';
  if (ct === 'pdf') return 'pdf';
  const lower = url.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (ct === 'html') return 'html';
  return 'html';
}

/**
 * Fetch a framework URL and compute the canonical hash / Wayback snapshot.
 */
export async function fetchFramework(options: FetchOptions): Promise<FetchResult> {
  const { url, maxChars = 200_000, skipWayback = false, pushWayback = pushToWayback } = options;

  // Reject private/loopback URLs before fetchSource() ever sees them — it
  // calls Node fetch() directly and will happily walk into IMDS or
  // RFC1918 internal services if a hostile URL ever lands in the YAML
  // (or in any future source we add).
  assertPublicHttpUrl(url);

  const fetched = await fetchSource({ url, extractMode: 'full' });
  if (fetched.status !== 'ok' || !fetched.content) {
    throw new Error(
      `framework fetch failed: url=${url} status=${fetched.status} httpStatus=${fetched.httpStatus}`,
    );
  }

  const sourceText = fetched.content.slice(0, maxChars);
  const contentLengthChars = sourceText.length;
  const normalized = normalizeForHash(sourceText);
  const contentHash = createHash('sha256').update(normalized).digest('hex');
  const contentType = mapContentType(fetched.contentType ?? undefined, url);

  let waybackSnapshotUrl: string | null = null;
  let note: string | undefined;
  if (!skipWayback) {
    waybackSnapshotUrl = await pushWayback(url);
    if (!waybackSnapshotUrl) {
      note = 'Wayback push failed or returned no snapshot';
    }
  } else {
    note = 'Wayback push skipped (skipWayback=true)';
  }

  return {
    sourceText,
    contentLengthChars,
    contentHash,
    contentType,
    httpStatus: fetched.httpStatus ?? null,
    canonicalUrl: url,
    waybackSnapshotUrl,
    note,
  };
}

/**
 * Compare a fresh fetch against the latest known content hash for the
 * same framework. Used by the silent-update detector.
 */
export type IngestStatus =
  | 'new_version' // first time we've seen this (framework_id, content_hash)
  | 'unchanged' // same hash as latest known → no action
  | 'silent_update_detected' // hash differs but lab did not bump the version label
  | 'fetch_failed';

export function classifyIngest(
  latestKnownHash: string | null,
  newHash: string | null,
  latestVersionLabelSeen: boolean,
): IngestStatus {
  if (!newHash) return 'fetch_failed';
  if (!latestKnownHash) return 'new_version';
  if (latestKnownHash === newHash) return 'unchanged';
  return latestVersionLabelSeen ? 'silent_update_detected' : 'new_version';
}
