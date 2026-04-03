/**
 * Wayback Machine Utilities — shared lookup and content fetching.
 *
 * Provides Wayback Machine snapshot lookup and content fetching for use by:
 * - source-check pipeline (dead link fallback)
 * - resource-enrichment/fetch-wayback (batch enrichment)
 * - link-checker/archive (broken link reporting)
 *
 * Rate limit: Wayback Machine has a soft limit of ~15 req/s.
 * Callers are responsible for rate-limiting between calls.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WaybackSnapshot {
  url: string;
  timestamp: string;
}

export interface WaybackContent {
  title: string | null;
  content: string;
  contentType: string;
  archiveUrl: string;
  archiveTimestamp: string;
}

// ── Snapshot lookup ────────────────────────────────────────────────────────────

/**
 * Look up a Wayback Machine snapshot using multiple strategies:
 * 1. Availability API (fast but sometimes unreliable)
 * 2. Direct web URL (follows redirect to closest snapshot — more reliable)
 */
export async function lookupWaybackSnapshot(url: string): Promise<WaybackSnapshot | null> {
  // Strategy 1: Availability API (fast when it works)
  try {
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'LongtermWikiBot/1.0 (+https://www.longtermwiki.com)' },
      signal: AbortSignal.timeout(8_000),
    });

    if (response.ok) {
      const data = await response.json() as {
        archived_snapshots?: { closest?: { url: string; timestamp: string; available: boolean } };
      };
      const snapshot = data?.archived_snapshots?.closest;
      if (snapshot?.available && snapshot.url) {
        return { url: snapshot.url, timestamp: snapshot.timestamp };
      }
    }
  } catch {
    // API may be down — fall through to direct URL approach
  }

  // Strategy 2: Direct web URL — Wayback redirects to closest snapshot
  try {
    const directUrl = `https://web.archive.org/web/2024/${url}`;
    const response = await fetch(directUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': 'LongtermWikiBot/1.0 (+https://www.longtermwiki.com)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (location && location.includes('web.archive.org/web/')) {
        const tsMatch = location.match(/\/web\/(\d{14})\//);
        return {
          url: location,
          timestamp: tsMatch?.[1] || 'unknown',
        };
      }
    }

    if (response.ok) {
      return { url: directUrl, timestamp: 'unknown' };
    }
  } catch {
    // Direct URL also failed
  }

  return null;
}

// ── Content fetching ───────────────────────────────────────────────────────────

function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!-- BEGIN WAYBACK TOOLBAR[\s\S]*?END WAYBACK TOOLBAR -->/gi, '')
    .replace(/<div id="wm-ipp-base"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '')
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "\'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitleFromHtml(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, ' ').trim();
  if (!raw || raw.length < 2) return null;
  return raw;
}

/**
 * Fetch content from a Wayback Machine snapshot URL.
 */
export async function fetchWaybackContent(
  archiveUrl: string,
  archiveTimestamp: string,
): Promise<WaybackContent | null> {
  try {
    const response = await fetch(archiveUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LongtermWikiBot/1.0; +https://www.longtermwiki.com)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return null;

    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      return null;
    }

    const html = await response.text();
    const title = extractTitleFromHtml(html);
    const content = htmlToPlainText(html);

    if (content.length < 100) return null;

    return { title, content, contentType: 'text/html', archiveUrl, archiveTimestamp };
  } catch {
    return null;
  }
}

/**
 * Format a Wayback timestamp (YYYYMMDDHHmmss) into a human-readable date.
 */
export function formatWaybackTimestamp(timestamp: string): string {
  if (!timestamp || timestamp === 'unknown' || timestamp.length < 8) return timestamp;
  const year = timestamp.slice(0, 4);
  const month = timestamp.slice(4, 6);
  const day = timestamp.slice(6, 8);
  return `${year}-${month}-${day}`;
}
