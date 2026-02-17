/**
 * Feed Fetcher
 *
 * Fetches RSS/Atom feeds and web search results from configured sources.
 * Returns normalized FeedItem[] for downstream digest building.
 *
 * Design:
 * - RSS/Atom feeds are fetched via HTTP and parsed with lightweight regex
 *   (no external XML parser dependency needed for the subset we care about)
 * - Web search sources use the Anthropic web_search tool via the LLM layer
 * - Respects last_fetch_times to only return new items
 * - Handles errors gracefully per-source (one failing source doesn't break others)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { executeWebSearch } from '../authoring/page-improver/api.ts';
import type { NewsSource, SourcesConfig, FeedItem } from './types.ts';

const SOURCES_PATH = join(PROJECT_ROOT, 'data/auto-update/sources.yaml');

// ── Source Loading ──────────────────────────────────────────────────────────

export function loadSources(): SourcesConfig {
  const raw = readFileSync(SOURCES_PATH, 'utf-8');
  return parseYaml(raw) as SourcesConfig;
}

/**
 * Persist last_fetch_times without rewriting the entire YAML file.
 * Uses a separate state file to avoid stripping comments from sources.yaml.
 */
const STATE_PATH = join(PROJECT_ROOT, 'data/auto-update/state.yaml');

export function saveFetchTimes(times: Record<string, string>): void {
  writeFileSync(STATE_PATH, stringifyYaml({ last_fetch_times: times }, { lineWidth: 120 }));
}

export function loadFetchTimes(): Record<string, string> {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const data = parseYaml(raw) as { last_fetch_times?: Record<string, string> };
    return data?.last_fetch_times || {};
  } catch {
    return {};
  }
}

// ── RSS/Atom Parsing ────────────────────────────────────────────────────────

interface RawFeedEntry {
  title: string;
  link: string;
  pubDate: string;
  description: string;
}

/**
 * Parse RSS/Atom XML into normalized entries.
 * Uses regex-based extraction — sufficient for the standard feeds we consume.
 */
function parseFeedXml(xml: string): RawFeedEntry[] {
  const entries: RawFeedEntry[] = [];

  // Try RSS <item> tags first
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const item of rssItems) {
    entries.push({
      title: extractTag(item, 'title'),
      link: extractTag(item, 'link') || extractAttr(item, 'link', 'href'),
      pubDate: extractTag(item, 'pubDate') || extractTag(item, 'dc:date') || extractTag(item, 'published'),
      description: stripHtml(extractTag(item, 'description') || extractTag(item, 'content:encoded') || '').slice(0, 500),
    });
  }

  // If no RSS items, try Atom <entry> tags
  if (entries.length === 0) {
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const entry of atomEntries) {
      entries.push({
        title: extractTag(entry, 'title'),
        link: extractAttr(entry, 'link', 'href') || extractTag(entry, 'link'),
        pubDate: extractTag(entry, 'published') || extractTag(entry, 'updated'),
        description: stripHtml(extractTag(entry, 'summary') || extractTag(entry, 'content') || '').slice(0, 500),
      });
    }
  }

  return entries;
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA
  const cdataPattern = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch) return cdataMatch[1].trim();

  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(pattern);
  return match ? match[1].trim() : '';
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const pattern = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const match = xml.match(pattern);
  return match ? match[1] : '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Feed Fetching ───────────────────────────────────────────────────────────

/**
 * Fetch an RSS/Atom feed and return normalized items.
 */
async function fetchRssFeed(source: NewsSource, since: string | null): Promise<FeedItem[]> {
  if (!source.url) throw new Error(`Source ${source.id} has no URL`);

  const response = await fetch(source.url, {
    headers: { 'User-Agent': 'longterm-wiki-auto-update/1.0' },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${source.url}`);
  }

  const xml = await response.text();
  const rawEntries = parseFeedXml(xml);
  const sinceDate = since ? new Date(since) : null;
  const items: FeedItem[] = [];

  for (const entry of rawEntries) {
    // Skip items older than our last fetch
    if (sinceDate && entry.pubDate) {
      const entryDate = new Date(entry.pubDate);
      if (!isNaN(entryDate.getTime()) && entryDate <= sinceDate) continue;
    }

    if (!entry.title) continue;

    items.push({
      sourceId: source.id,
      sourceName: source.name,
      title: stripHtml(entry.title),
      url: entry.link,
      publishedAt: entry.pubDate || new Date().toISOString().slice(0, 10),
      summary: entry.description,
      categories: [...source.categories],
      reliability: source.reliability,
    });
  }

  return items;
}

/**
 * Fetch news via web search for a source that doesn't have an RSS feed.
 */
async function fetchWebSearch(source: NewsSource, since: string | null): Promise<FeedItem[]> {
  const query = source.query || source.name;
  const dateRange = since ? `after:${since}` : '';
  const fullQuery = `${query} ${dateRange}`.trim();

  const searchResults = await executeWebSearch(fullQuery);

  // Parse the LLM-formatted search results into structured items
  const items: FeedItem[] = [];
  const lines = searchResults.split('\n');
  let currentTitle = '';
  let currentUrl = '';
  let currentSummary = '';

  for (const line of lines) {
    const urlMatch = line.match(/https?:\/\/[^\s)]+/);
    const titleMatch = line.match(/^\d+\.\s*\*?\*?(.+?)\*?\*?\s*[-–—]/);

    if (titleMatch) {
      // Save previous item if we have one
      if (currentTitle && currentUrl) {
        items.push({
          sourceId: source.id,
          sourceName: source.name,
          title: currentTitle,
          url: currentUrl,
          publishedAt: new Date().toISOString().slice(0, 10),
          summary: currentSummary.slice(0, 500),
          categories: [...source.categories],
          reliability: source.reliability,
        });
      }
      currentTitle = titleMatch[1].trim();
      currentUrl = urlMatch?.[0] || '';
      currentSummary = '';
    } else if (urlMatch && !currentUrl) {
      currentUrl = urlMatch[0];
    } else if (line.trim()) {
      currentSummary += ' ' + line.trim();
    }
  }

  // Don't forget the last item
  if (currentTitle) {
    items.push({
      sourceId: source.id,
      sourceName: source.name,
      title: currentTitle,
      url: currentUrl || '',
      publishedAt: new Date().toISOString().slice(0, 10),
      summary: currentSummary.trim().slice(0, 500),
      categories: [...source.categories],
      reliability: source.reliability,
    });
  }

  return items;
}

// ── Main Export ──────────────────────────────────────────────────────────────

export interface FetchResult {
  items: FeedItem[];
  fetchedSources: string[];
  failedSources: Array<{ id: string; error: string }>;
}

/**
 * Fetch all enabled sources (or a specific subset) and return new items.
 *
 * @param sourceIds - If provided, only fetch these sources. Otherwise fetch all enabled.
 * @param verbose - If true, log progress to console.
 */
export async function fetchAllSources(
  sourceIds?: string[],
  verbose = false,
): Promise<FetchResult> {
  const config = loadSources();
  const lastTimes = loadFetchTimes();
  const now = new Date().toISOString();

  let sources = config.sources.filter(s => s.enabled);
  if (sourceIds && sourceIds.length > 0) {
    sources = sources.filter(s => sourceIds.includes(s.id));
  }

  const allItems: FeedItem[] = [];
  const fetched: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const source of sources) {
    const since = lastTimes[source.id] || null;

    try {
      if (verbose) {
        console.log(`  Fetching ${source.name} (${source.type})...`);
      }

      let items: FeedItem[];
      if (source.type === 'rss' || source.type === 'atom') {
        items = await fetchRssFeed(source, since);
      } else if (source.type === 'web-search') {
        items = await fetchWebSearch(source, since);
      } else {
        throw new Error(`Unknown source type: ${source.type}`);
      }

      allItems.push(...items);
      fetched.push(source.id);

      if (verbose) {
        console.log(`    Found ${items.length} new items`);
      }

      // Update last fetch time
      lastTimes[source.id] = now;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      failed.push({ id: source.id, error: error.message.slice(0, 200) });
      if (verbose) {
        console.log(`    FAILED: ${error.message.slice(0, 100)}`);
      }
    }
  }

  // Persist updated fetch times
  saveFetchTimes(lastTimes);

  return { items: allItems, fetchedSources: fetched, failedSources: failed };
}
