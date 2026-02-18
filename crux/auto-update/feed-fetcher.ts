/**
 * Feed Fetcher
 *
 * Fetches RSS/Atom feeds and web search results from configured sources.
 * Returns normalized FeedItem[] for downstream digest building.
 *
 * Design:
 * - RSS/Atom feeds are fetched via HTTP and parsed with lightweight regex
 *   (no external XML parser dependency needed for the subset we care about)
 * - Web search sources use the Exa API (EXA_API_KEY) for structured JSON results.
 *   Falls back to the Anthropic web_search tool if Exa is unavailable.
 * - Respects last_fetch_times to only return new items
 * - Handles errors gracefully per-source (one failing source doesn't break others)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { executeWebSearch } from '../authoring/page-improver/api.ts';
import type { NewsSource, SourcesConfig, FeedItem } from './types.ts';

const EXA_API_KEY = process.env.EXA_API_KEY;

const SOURCES_PATH = join(PROJECT_ROOT, 'data/auto-update/sources.yaml');

// ── Source Loading ──────────────────────────────────────────────────────────

export function loadSources(): SourcesConfig {
  const raw = readFileSync(SOURCES_PATH, 'utf-8');
  return parseYaml(raw) as SourcesConfig;
}

/**
 * Persistent state for the auto-update system.
 * Uses a separate state file to avoid stripping comments from sources.yaml.
 *
 * State includes:
 * - last_fetch_times: when each source was last fetched (ISO string)
 * - seen_items: normalized title hashes of items we've already processed,
 *   mapped to the date they were first seen (for pruning old entries)
 */
const STATE_PATH = join(PROJECT_ROOT, 'data/auto-update/state.yaml');

const SEEN_ITEMS_MAX_AGE_DAYS = 90;

interface AutoUpdateState {
  last_fetch_times: Record<string, string>;
  seen_items: Record<string, string>;  // hash → ISO date first seen
}

function loadState(): AutoUpdateState {
  if (!existsSync(STATE_PATH)) {
    return { last_fetch_times: {}, seen_items: {} };
  }
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const data = parseYaml(raw) as Partial<AutoUpdateState>;
    return {
      last_fetch_times: data?.last_fetch_times || {},
      seen_items: data?.seen_items || {},
    };
  } catch {
    return { last_fetch_times: {}, seen_items: {} };
  }
}

function saveState(state: AutoUpdateState): void {
  writeFileSync(STATE_PATH, stringifyYaml(state, { lineWidth: 120 }));
}

export function saveFetchTimes(times: Record<string, string>): void {
  const state = loadState();
  state.last_fetch_times = times;
  saveState(state);
}

export function loadFetchTimes(): Record<string, string> {
  return loadState().last_fetch_times;
}

/**
 * Load previously seen item hashes, pruning entries older than 90 days.
 */
export function loadSeenItems(): Set<string> {
  const state = loadState();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SEEN_ITEMS_MAX_AGE_DAYS);
  const cutoffStr = cutoff.toISOString();

  // Prune old entries while loading
  const pruned: Record<string, string> = {};
  let prunedCount = 0;
  for (const [hash, dateStr] of Object.entries(state.seen_items)) {
    if (dateStr >= cutoffStr) {
      pruned[hash] = dateStr;
    } else {
      prunedCount++;
    }
  }

  // Save back if we pruned anything
  if (prunedCount > 0) {
    state.seen_items = pruned;
    saveState(state);
  }

  return new Set(Object.keys(pruned));
}

/**
 * Record newly seen item hashes (merges with existing).
 */
export function saveSeenItems(newHashes: Record<string, string>): void {
  const state = loadState();
  state.seen_items = { ...state.seen_items, ...newHashes };
  saveState(state);
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

// ── Exa Search ──────────────────────────────────────────────────────────────

interface ExaResult {
  title: string;
  url: string;
  publishedDate?: string;
  text?: string;
}

interface ExaResponse {
  results: ExaResult[];
}

/**
 * Search via the Exa API. Returns structured JSON — no parsing needed.
 *
 * @param query - Search query string
 * @param since - ISO date string; only return results published after this date
 */
async function executeExaSearch(query: string, since: string | null): Promise<ExaResult[]> {
  if (!EXA_API_KEY) throw new Error('EXA_API_KEY not set');

  const body: Record<string, unknown> = {
    query,
    type: 'auto',
    numResults: 10,
    contents: { text: { maxCharacters: 500 } },
  };

  if (since) {
    // Exa expects ISO 8601 date strings for date filtering
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      body.startPublishedDate = sinceDate.toISOString();
    }
  }

  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'x-api-key': EXA_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Exa API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as ExaResponse;
  return data.results || [];
}

/**
 * Fetch news via web search for a source that doesn't have an RSS feed.
 *
 * Uses Exa API as primary (structured JSON, date-filtered, cheaper).
 * Falls back to the Anthropic web_search tool if Exa is unavailable.
 */
async function fetchWebSearch(source: NewsSource, since: string | null): Promise<FeedItem[]> {
  const query = source.query || source.name;

  // ── Try Exa first ──────────────────────────────────────────────────────────
  if (EXA_API_KEY) {
    try {
      const results = await executeExaSearch(query, since);
      return results
        .filter(r => r.title && r.url)
        .map(r => ({
          sourceId: source.id,
          sourceName: source.name,
          title: r.title,
          url: r.url,
          publishedAt: r.publishedDate
            ? new Date(r.publishedDate).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10),
          summary: (r.text || '').slice(0, 500),
          categories: [...source.categories],
          reliability: source.reliability,
        }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Log but fall through to Anthropic fallback
      console.warn(`  Exa search failed for "${source.id}", falling back to LLM search: ${message}`);
    }
  }

  // ── Fallback: Anthropic web_search tool ───────────────────────────────────
  const dateRange = since ? `after:${since}` : '';
  const fullQuery = `${query} ${dateRange}`.trim();

  const searchResults = await executeWebSearch(fullQuery);

  // Parse the LLM-formatted search results into structured items.
  // The LLM returns markdown with various formats:
  //   "### 1. Title" or "1. **Title**" or "**1. Title** —" etc.
  //   URLs in "**URL:** [url](url)" or inline markdown links or bare URLs
  //   Descriptions in "**Description:**" lines or plain text
  const items: FeedItem[] = [];
  const lines = searchResults.split('\n');
  let currentTitle = '';
  let currentUrl = '';
  let currentSummary = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Match numbered item headers in various formats:
    //   "### 1. 🏛️ Title Here"
    //   "1. **Title Here** — description"
    //   "**1. Title Here**"
    const titleMatch = trimmed.match(
      /^(?:#{1,4}\s+)?(\d+)\.\s*(?:[\p{Emoji}\p{Emoji_Presentation}\u200d\ufe0f]+\s*)?(?:\*\*)?(.+?)(?:\*\*)?$/u
    ) || trimmed.match(
      /^(\d+)\.\s*\*?\*?(.+?)\*?\*?\s*[-–—]/
    );

    // Match explicit URL lines: "**URL:** [text](url)" or "**URL:** url"
    const explicitUrlMatch = trimmed.match(/^\*\*URL:?\*\*:?\s*(?:\[.*?\]\()?(https?:\/\/[^\s)]+)/i);

    if (titleMatch && titleMatch[2]) {
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
      // Clean title: remove trailing markdown artifacts
      currentTitle = titleMatch[2]
        .replace(/\*\*/g, '')
        .replace(/\[.*?\]\(.*?\)/g, '')
        .trim();
      // Check if title line also contains a URL
      const inlineUrl = trimmed.match(/https?:\/\/[^\s)]+/);
      currentUrl = inlineUrl?.[0] || '';
      currentSummary = '';
    } else if (explicitUrlMatch) {
      currentUrl = explicitUrlMatch[1];
    } else if (!currentUrl && trimmed.match(/^https?:\/\//)) {
      // Bare URL line
      currentUrl = trimmed.match(/https?:\/\/[^\s)]+/)?.[0] || '';
    } else if (trimmed.startsWith('**Description:**') || trimmed.startsWith('**Source:**')) {
      // Extract description text, stripping the label
      const descText = trimmed.replace(/^\*\*(Description|Source):\*\*\s*/, '');
      currentSummary += ' ' + descText;
    } else if (trimmed && !trimmed.startsWith('---') && !trimmed.startsWith('|') && !trimmed.startsWith('🔑')) {
      // Regular text contributes to summary (skip separators and tables)
      currentSummary += ' ' + trimmed;
    }
  }

  // Don't forget the last item
  if (currentTitle && currentUrl) {
    items.push({
      sourceId: source.id,
      sourceName: source.name,
      title: currentTitle,
      url: currentUrl,
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
