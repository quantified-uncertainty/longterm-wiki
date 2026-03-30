/**
 * Wayback Machine — shared lookup and content extraction utilities.
 *
 * Used by:
 *   - crux/lib/search/fetch-strategies.ts (source-fetcher domain routing)
 *   - crux/resource-enrichment/fetch-wayback.ts (CLI batch fetcher)
 *   - crux/link-checker/archive.ts (link-checker archive lookup)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WaybackSnapshot {
  /** The Wayback Machine archive URL */
  archiveUrl: string;
  /** Timestamp string from Wayback (14-digit or 'unknown') */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Snapshot Lookup
// ---------------------------------------------------------------------------

const USER_AGENT = 'LongtermWikiBot/1.0 (+https://www.longtermwiki.com)';

/**
 * Look up a Wayback Machine snapshot using two strategies:
 *   1. Availability API (fast but sometimes unreliable)
 *   2. Direct web URL redirect probe (more reliable fallback)
 *
 * Returns null if no snapshot is available.
 */
export async function lookupWaybackSnapshot(url: string): Promise<WaybackSnapshot | null> {
  // Strategy 1: Availability API
  try {
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });

    if (response.ok) {
      const data = await response.json() as {
        archived_snapshots?: { closest?: { url: string; timestamp: string; available: boolean } };
      };
      const snapshot = data?.archived_snapshots?.closest;
      if (snapshot?.available && snapshot.url) {
        return { archiveUrl: snapshot.url, timestamp: snapshot.timestamp };
      }
    }
  } catch {
    // Availability API may be down — fall through to direct URL approach
  }

  // Strategy 2: Direct Wayback URL — follows redirect to closest snapshot
  try {
    const directUrl = `https://web.archive.org/web/2024/${url}`;
    const response = await fetch(directUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (location?.includes('web.archive.org/web/')) {
        const tsMatch = location.match(/\/web\/(\d{14})\//);
        return { archiveUrl: location, timestamp: tsMatch?.[1] ?? 'unknown' };
      }
    }
    if (response.ok) {
      return { archiveUrl: directUrl, timestamp: 'unknown' };
    }
  } catch {
    // Both strategies failed — return null
  }

  return null;
}

// ---------------------------------------------------------------------------
// HTML-to-Text Extraction (Wayback-aware)
// ---------------------------------------------------------------------------

/**
 * Extract title from an HTML string.
 */
export function extractTitleFromHtml(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, ' ').trim();
  if (!raw || raw.length < 2) return null;
  return raw;
}

/**
 * Convert HTML to plain text, stripping tags and decoding entities.
 * Optionally strips the Wayback Machine toolbar injected into archived pages.
 */
export function htmlToPlainText(html: string, options?: { stripWaybackToolbar?: boolean }): string {
  let result = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  if (options?.stripWaybackToolbar) {
    result = result
      .replace(/<!-- BEGIN WAYBACK TOOLBAR[\s\S]*?END WAYBACK TOOLBAR -->/gi, '')
      .replace(/<div id="wm-ipp-base"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');
  }

  return result
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Content Fetching
// ---------------------------------------------------------------------------

export interface WaybackContent {
  title: string | null;
  content: string;
  contentType: string;
  archiveUrl: string;
}

/**
 * Fetch and extract text content from a Wayback Machine archived page.
 * Combines snapshot lookup + HTTP fetch + HTML extraction.
 *
 * Returns null if no snapshot exists, content is non-HTML, or content is too short.
 */
export async function fetchWaybackPageContent(url: string): Promise<WaybackContent | null> {
  const snapshot = await lookupWaybackSnapshot(url);
  if (!snapshot) return null;

  try {
    const response = await fetch(snapshot.archiveUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LongtermWikiBot/1.0; +https://www.longtermwiki.com)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return null;

    const ct = response.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      return null;
    }

    const html = await response.text();
    const title = extractTitleFromHtml(html);
    const content = htmlToPlainText(html, { stripWaybackToolbar: true });

    if (content.length < 100) return null;

    return {
      title,
      content: content.slice(0, 100_000),
      contentType: 'text/html',
      archiveUrl: snapshot.archiveUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wayback] Fetch failed for ${url}: ${msg.slice(0, 200)}`);
    return null;
  }
}
