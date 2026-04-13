/**
 * URL-Quality Heuristic — shared module
 *
 * Deterministic, network-free classification of URLs by shape alone. Used by:
 *   - `crux sourcing-audit-urls` — flag homepage-like source URLs in evidence rows
 *   - `crux/resource-enrichment/classify.ts` — fast-path before LLM batch submission
 *   - `crux/lib/job-handlers/resource-enrich.ts` — fast-path before LLM call
 *
 * Confidence is calibrated so that >= FAST_PATH_THRESHOLD (0.8) is "write
 * directly, skip LLM batch submission" — but downstream enrichment (summary,
 * key_points, etc.) still runs because that data isn't shape-derivable.
 *
 * Phase 2 of QUA-113 / Discussion #4221. Extracted from inline implementation
 * in `crux/commands/sourcing-audit-urls.ts` (Phase 1, PR #4222).
 */

// ── Module constants ──

/** Confidence threshold to mark a row "flagged homepage" in audit output. */
export const FLAG_THRESHOLD = 0.7;

/** Confidence threshold to skip LLM classify-step (write directly to PG). */
export const FAST_PATH_THRESHOLD = 0.8;

/** Query parameters that indicate tracking, not data content. */
const TRACKING_PREFIXES = ['utm_', 'mc_', 'oly_'];
const TRACKING_EXACT = new Set(['fbclid', 'gclid', 'yclid', 'msclkid', '_ga']);

/** Query parameters that indicate specific content (force non-homepage classification). */
const DATA_PARAM_KEYS = new Set(['id', 'v', 'q', 'search', 'article', 'item', 'page', 'post']);

/** Known URL shorteners — cannot classify without following the redirect. */
const SHORTENERS = new Set([
  'bit.ly', 't.co', 'goo.gl', 'tinyurl.com', 'ow.ly', 'buff.ly',
  'is.gd', 'shorturl.at', 'rb.gy', 'cutt.ly',
]);

/** Single-segment paths that act as homepages on most sites. */
const HOMEPAGE_PATHS = new Set([
  '/about', '/about-us', '/about_us', '/aboutus',
  '/contact', '/contact-us', '/contactus',
  '/home', '/home.html', '/index', '/index.html', '/index.htm',
  '/welcome', '/main',
]);

// ── Types ──

export interface UrlClassification {
  purpose: 'homepage' | null;
  confidence: number;
  reasons: string[];
}

// ── Public API ──

/**
 * Classify a URL by shape alone. Deterministic, no network.
 *
 * @returns
 *   - `purpose: 'homepage'` with confidence ≥ 0.85 — clearly a landing page
 *   - `purpose: null` with confidence ≥ 0.9 — clearly NOT a homepage (e.g., PDF)
 *   - `purpose: null` with confidence ≤ 0.4 — ambiguous; LLM should decide
 *   - `purpose: null` with confidence 0 — unparseable / unsupported scheme
 */
export function classifyByUrl(raw: string): UrlClassification {
  const reasons: string[] = [];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { purpose: null, confidence: 0, reasons: ['unparseable'] };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { purpose: null, confidence: 0, reasons: ['non-http-scheme'] };
  }

  const host = url.hostname.toLowerCase();

  // Wayback prefix — classify by the inner URL.
  // Note: URL parsing puts any `?query`/`#fragment` from the wrapped target
  // on the outer `url.search`/`url.hash`, so reattach them before classifying.
  if (host === 'web.archive.org' || host === 'archive.org') {
    const match = url.pathname.match(/\/web\/[^/]+\/(.+)$/);
    if (match) {
      const innerPath = match[1] + url.search + url.hash;
      const inner = innerPath.startsWith('http')
        ? innerPath
        : `https://${innerPath}`;
      const innerResult = classifyByUrl(inner);
      return {
        ...innerResult,
        reasons: ['wayback-wrapped', ...innerResult.reasons],
      };
    }
    return { purpose: null, confidence: 0.2, reasons: ['wayback-unresolved'] };
  }

  if (SHORTENERS.has(host)) {
    return { purpose: null, confidence: 0, reasons: ['shortener'] };
  }

  // PDF: never a homepage regardless of path depth
  if (url.pathname.toLowerCase().endsWith('.pdf')) {
    return { purpose: null, confidence: 0.9, reasons: ['pdf'] };
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';
  const depth = path === '/' ? 0 : path.split('/').filter(Boolean).length;

  // Meaningful fragment (e.g., Twitter status ID, deep anchor) — not homepage.
  // Ignore `#`, `#top`, or anything ≤ 4 characters including the leading `#`.
  if (url.hash.length > 4) {
    return { purpose: null, confidence: 0.3, reasons: ['deep-fragment'] };
  }

  // Named data params (?id=, ?q=, ?v=, ...) force NOT-homepage even at root.
  // Tracking-only queries (utm_*, fbclid, ...) are ignored.
  for (const k of url.searchParams.keys()) {
    const keyLower = k.toLowerCase();
    if (DATA_PARAM_KEYS.has(keyLower)) {
      return { purpose: null, confidence: 0.2, reasons: ['query-data-param'] };
    }
  }

  // Depth 0: bare domain or root path (tracking-only query is fine)
  if (depth === 0) {
    reasons.push('root-path');
    return { purpose: 'homepage', confidence: 0.95, reasons };
  }

  if (depth === 1 && HOMEPAGE_PATHS.has(path.toLowerCase())) {
    reasons.push(`homepage-path:${path.toLowerCase()}`);
    return { purpose: 'homepage', confidence: 0.85, reasons };
  }

  // Deep paths (2+ segments) — almost never homepages
  if (depth >= 2) {
    return { purpose: null, confidence: 0.1, reasons: [`depth:${depth}`] };
  }

  // Depth 1 with no matching homepage path — ambiguous
  return { purpose: null, confidence: 0.4, reasons: [`depth:1:${path}`] };
}

/**
 * Canonical URL form for comparing/grouping evidence URLs and resource URLs.
 * Strips: trailing slash, www., fragment, default ports, common tracking
 * params (utm_*, fbclid, gclid). Lowercases host.
 *
 * NOT a replacement for the 9 existing URL normalizers in the codebase —
 * those serve different semantics. This one is for audit-join + domain grouping.
 */
export function normalizeUrlForJoin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim().toLowerCase();
  }

  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  const portSuffix =
    (url.port === '' || (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443'))
      ? ''
      : `:${url.port}`;

  const filteredParams = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    const keyLower = k.toLowerCase();
    if (TRACKING_EXACT.has(keyLower)) continue;
    if (TRACKING_PREFIXES.some((p) => keyLower.startsWith(p))) continue;
    filteredParams.append(k, v);
  }
  const qs = filteredParams.toString();

  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');

  return `${url.protocol}//${host}${portSuffix}${path}${qs ? '?' + qs : ''}`;
}

/** Extract just the host portion, normalized, for domain grouping. */
export function extractHost(raw: string): string {
  try {
    let host = new URL(raw).hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return '(invalid-url)';
  }
}
