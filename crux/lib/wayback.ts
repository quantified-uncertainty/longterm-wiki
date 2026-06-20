/**
 * Wayback Machine Utilities — shared lookup and content fetching.
 */

import { htmlToText } from './html-utils.ts';

const USER_AGENT = 'LongtermWikiBot/1.0 (+https://www.longtermwiki.com)';
/** Pages shorter than this are likely error pages or empty shells. */
const MIN_CONTENT_LENGTH = 100;

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

/**
 * Look up a Wayback Machine snapshot using multiple strategies:
 * 1. Availability API (fast but sometimes unreliable)
 * 2. Direct web URL (follows redirect to closest snapshot — more reliable)
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
        return { url: snapshot.url, timestamp: snapshot.timestamp };
      }
    }
  } catch (e) {
    console.warn(`[wayback] API lookup failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Strategy 2: Direct Wayback URL — follows redirect to closest snapshot
  try {
    const directUrl = `https://web.archive.org/web/${new Date().getFullYear()}/${url}`;
    const response = await fetch(directUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (location && location.includes('web.archive.org/web/')) {
        const tsMatch = location.match(/\/web\/(\d{14})\//);
        return { url: location, timestamp: tsMatch?.[1] || 'unknown' };
      }
    }
    if (response.ok) {
      return { url: directUrl, timestamp: 'unknown' };
    }
  } catch (e) {
    console.warn(`[wayback] Direct URL fallback failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

/** Strip HTML to plain text, removing the Wayback toolbar first. */
function htmlToPlainText(html: string): string {
  // Remove Wayback-specific chrome before the generic strip. The shared
  // htmlToText handles whitespace-tolerant script/style removal, fixed-point
  // tag stripping, and correct entity decoding (`&amp;` decoded last).
  const withoutToolbar = html
    .replace(/<!-- BEGIN WAYBACK TOOLBAR[\s\S]*?END WAYBACK TOOLBAR -->/gi, '')
    .replace(/<div id="wm-ipp-base"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');
  return htmlToText(withoutToolbar);
}

/** Extract <title> text from HTML. */
function extractTitleFromHtml(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, ' ').trim();
  return (!raw || raw.length < 2) ? null : raw;
}

/**
 * Fetch HTML content from a Wayback Machine archive URL.
 * Returns parsed title + plain text content.
 */
export async function fetchWaybackContent(
  archiveUrl: string,
  archiveTimestamp: string,
): Promise<WaybackContent | null> {
  try {
    const response = await fetch(archiveUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return null;
    const html = await response.text();
    const title = extractTitleFromHtml(html);
    const content = htmlToPlainText(html);
    if (content.length < MIN_CONTENT_LENGTH) return null;
    return { title, content, contentType: 'text/html', archiveUrl, archiveTimestamp };
  } catch (e) {
    console.warn(`[wayback] Content fetch failed for ${archiveUrl}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Combined lookup + fetch: find a Wayback snapshot for a URL and fetch its content.
 * Convenience function for callers that just want content for a URL.
 */
export async function lookupAndFetchWayback(url: string): Promise<WaybackContent | null> {
  const snapshot = await lookupWaybackSnapshot(url);
  if (!snapshot) return null;
  return fetchWaybackContent(snapshot.url, snapshot.timestamp);
}

/** Format a 14-digit Wayback timestamp (e.g. 20240315123456) as YYYY-MM-DD. */
export function formatWaybackTimestamp(timestamp: string): string {
  if (!timestamp || timestamp === 'unknown' || timestamp.length < 8) return timestamp;
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
}
