/**
 * Link Rot Detection Script
 *
 * Comprehensive external URL health checker for the wiki. Collects URLs from
 * all sources (resource YAML files, external-links.yaml, MDX content, footnotes),
 * checks them with domain-aware strategies, suggests archive.org fallbacks for
 * dead links, and produces structured reports.
 *
 * Run via: pnpm crux check-links [options]
 *
 * Options:
 *   --source=<type>   Filter by source: resources, external, content, all (default: all)
 *   --report          Generate JSON report to .cache/link-check-report.json
 *   --fix             Query archive.org for dead links and suggest replacements
 *   --limit=<n>       Limit number of URLs to check (for testing)
 *   --verbose         Show detailed per-URL output
 *   --clear-cache     Clear the link check cache before running
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseYaml } from 'yaml';
import https from 'https';
import http from 'http';
import { PROJECT_ROOT, CONTENT_DIR_ABS, DATA_DIR_ABS } from './lib/content-types.ts';
import { loadResources } from './resource-io.ts';
import { findMdxFiles } from './lib/file-utils.ts';
import { isInCodeBlock } from './lib/mdx-utils.ts';
import { parseCliArgs } from './lib/cli.ts';
import { sleep, extractArxivId } from './resource-utils.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

interface UrlEntry {
  url: string;
  sources: UrlSource[];
}

interface UrlSource {
  file: string;
  line?: number;
  context?: string; // link text or resource title
}

interface CacheEntry {
  status: number;
  ok: boolean;
  error?: string;
  redirectUrl?: string;
  checkedAt: number;
  responseTimeMs?: number;
}

type LinkCache = Record<string, CacheEntry>;

type UrlStatus = 'healthy' | 'broken' | 'redirected' | 'unverifiable' | 'skipped' | 'error';

interface CheckResult {
  url: string;
  status: UrlStatus;
  httpStatus?: number;
  error?: string;
  redirectUrl?: string;
  responseTimeMs?: number;
  sources: UrlSource[];
  archiveUrl?: string;
  strategy: string;
}

interface LinkCheckReport {
  timestamp: string;
  summary: {
    total_urls: number;
    checked: number;
    healthy: number;
    broken: number;
    redirected: number;
    unverifiable: number;
    skipped: number;
    errors: number;
  };
  broken: Array<{
    url: string;
    status: number;
    error?: string;
    sources: Array<{ file: string; line?: number }>;
    archive_url?: string;
    last_checked: string;
  }>;
  redirected: Array<{
    url: string;
    redirects_to: string;
    sources: Array<{ file: string; line?: number }>;
  }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CACHE_DIR = join(PROJECT_ROOT, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'link-check-cache.json');
const REPORT_FILE = join(CACHE_DIR, 'link-check-report.json');

// Cache TTLs
const CACHE_TTL_HEALTHY_MS = 14 * 24 * 60 * 60 * 1000;   // 14 days
const CACHE_TTL_BROKEN_MS = 3 * 24 * 60 * 60 * 1000;      // 3 days
const CACHE_TTL_UNVERIFIABLE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Checking configuration
const CONCURRENCY = 20;
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 3000;
const PER_DOMAIN_DELAY_MS = 500; // ~2 req/s per domain

const EXTERNAL_LINKS_FILE = join(DATA_DIR_ABS, 'external-links.yaml');

// Domains that should be checked via DOI resolution instead of direct URL
const DOI_CHECK_DOMAINS = [
  'nature.com',
  'science.org',
  'springer.com',
  'wiley.com',
  'sciencedirect.com',
  'tandfonline.com',
  'pnas.org',
  'cell.com',
];

// Domains that are unverifiable (block all automated access)
const UNVERIFIABLE_DOMAINS = [
  'twitter.com',
  'x.com',
  'linkedin.com',
  'facebook.com',
  't.co',
];

// Domains that aggressively rate-limit but are generally reliable
const SKIP_DOMAINS = [
  'academic.oup.com',
  'pubsonline.informs.org',
  'proceedings.neurips.cc',
  'cambridge.org',
  'papers.ssrn.com',
  'ieee.org',
  'dl.acm.org',
  'jstor.org',
  // Rate-limiters
  'venturebeat.com',
  'linearb.io',
  'openphilanthropy.org',
  'metaculus.com',
  // Government/institutional sites that block bots
  'un.org',
  'europarl.europa.eu',
];

// ─── Cache Management ───────────────────────────────────────────────────────

function loadCache(): LinkCache {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as LinkCache;
    const now = Date.now();
    const fresh: LinkCache = {};
    for (const [url, entry] of Object.entries(data)) {
      // Check special statuses first (unverifiable/skipped have ok:true
      // so must be checked before the ok branch)
      const ttl = entry.status === -1
        ? CACHE_TTL_UNVERIFIABLE_MS   // 30 days for unverifiable domains
        : entry.status === -2
          ? CACHE_TTL_UNVERIFIABLE_MS // 30 days for skipped domains
          : entry.ok
            ? CACHE_TTL_HEALTHY_MS    // 14 days for healthy URLs
            : CACHE_TTL_BROKEN_MS;    // 3 days for broken URLs
      if (now - entry.checkedAt < ttl) {
        fresh[url] = entry;
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

function saveCache(cache: LinkCache): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Non-fatal
  }
}

// ─── URL Collection ─────────────────────────────────────────────────────────

/**
 * Extract URLs from resource YAML files (data/resources/*.yaml)
 */
function collectResourceUrls(): UrlEntry[] {
  const entries = new Map<string, UrlEntry>();

  const resources = loadResources();
  for (const r of resources) {
    if (!r.url) continue;
    const url = r.url.trim();
    if (!url.startsWith('http')) continue;

    const source: UrlSource = {
      file: `data/resources/${r._sourceFile || 'unknown'}.yaml`,
      context: r.title,
    };

    if (entries.has(url)) {
      entries.get(url)!.sources.push(source);
    } else {
      entries.set(url, { url, sources: [source] });
    }
  }

  return Array.from(entries.values());
}

/**
 * Extract URLs from data/external-links.yaml
 */
function collectExternalLinkUrls(): UrlEntry[] {
  const entries = new Map<string, UrlEntry>();

  if (!existsSync(EXTERNAL_LINKS_FILE)) return [];

  try {
    const content = readFileSync(EXTERNAL_LINKS_FILE, 'utf-8');
    const data = parseYaml(content) as Array<{ pageId: string; links: Record<string, string> }>;

    if (!Array.isArray(data)) return [];

    for (const entry of data) {
      if (!entry.links) continue;
      for (const [linkType, url] of Object.entries(entry.links)) {
        if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;

        const source: UrlSource = {
          file: 'data/external-links.yaml',
          context: `${entry.pageId} (${linkType})`,
        };

        if (entries.has(url)) {
          entries.get(url)!.sources.push(source);
        } else {
          entries.set(url, { url, sources: [source] });
        }
      }
    }
  } catch {
    console.error('  Warning: Could not parse external-links.yaml');
  }

  return Array.from(entries.values());
}

/**
 * Extract URLs from MDX content files
 */
function collectContentUrls(): UrlEntry[] {
  const entries = new Map<string, UrlEntry>();

  const mdxFiles = findMdxFiles(CONTENT_DIR_ABS);

  for (const filePath of mdxFiles) {
    // Skip internal documentation
    if (filePath.includes('/internal/')) continue;

    const content = readFileSync(filePath, 'utf-8');
    const relPath = relative(PROJECT_ROOT, filePath);

    const extracted = extractUrlsFromContent(content);
    for (const { url, line, text } of extracted) {
      const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
      if (!cleanUrl.startsWith('http')) continue;
      if (isTruncatedUrl(cleanUrl)) continue;

      const source: UrlSource = {
        file: relPath,
        line,
        context: text,
      };

      if (entries.has(cleanUrl)) {
        entries.get(cleanUrl)!.sources.push(source);
      } else {
        entries.set(cleanUrl, { url: cleanUrl, sources: [source] });
      }
    }
  }

  return Array.from(entries.values());
}

/**
 * Check if a URL looks truncated (unbalanced parentheses from markdown parsing).
 * e.g., https://en.wikipedia.org/wiki/P(doom gets truncated from [P(doom)](url)
 */
function isTruncatedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const openParens = (path.match(/\(/g) || []).length;
    const closeParens = (path.match(/\)/g) || []).length;
    return openParens > closeParens;
  } catch {
    return true; // malformed URL
  }
}

/**
 * Extract URLs from MDX body content (markdown links, bare URLs, HTML hrefs, footnotes)
 */
function extractUrlsFromContent(body: string): Array<{ url: string; line: number; text: string }> {
  const urls: Array<{ url: string; line: number; text: string }> = [];

  // Markdown links: [text](url)
  const mdLinkRegex = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  // Bare URLs in text (not inside markdown link syntax)
  const bareUrlRegex = /(?<!\[)\b(https?:\/\/[^\s<>"\])}]+)/g;
  // HTML href attributes
  const hrefRegex = /href=["'](https?:\/\/[^"']+)["']/g;
  // Footnote citations: [^n]: [text](url) or [^n]: url
  const footnoteUrlRegex = /\[\^[^\]]+\]:\s*(?:\[[^\]]*\]\()?(https?:\/\/[^\s)]+)/g;

  const lines = body.split('\n');
  let position = 0;

  // Track URLs found via markdown links to avoid double-counting with bare URL regex
  const markdownLinkUrls = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!isInCodeBlock(body, position)) {
      let match: RegExpExecArray | null;

      // Markdown links
      mdLinkRegex.lastIndex = 0;
      while ((match = mdLinkRegex.exec(line)) !== null) {
        urls.push({ url: match[2], line: i + 1, text: match[1] });
        markdownLinkUrls.add(match[2]);
      }

      // Bare URLs (skip those already captured as markdown links)
      bareUrlRegex.lastIndex = 0;
      while ((match = bareUrlRegex.exec(line)) !== null) {
        if (!markdownLinkUrls.has(match[1])) {
          urls.push({ url: match[1], line: i + 1, text: '' });
        }
      }

      // HTML href
      hrefRegex.lastIndex = 0;
      while ((match = hrefRegex.exec(line)) !== null) {
        urls.push({ url: match[1], line: i + 1, text: '' });
      }

      // Footnote URLs
      footnoteUrlRegex.lastIndex = 0;
      while ((match = footnoteUrlRegex.exec(line)) !== null) {
        urls.push({ url: match[1], line: i + 1, text: 'footnote' });
      }
    }

    position += line.length + 1;
  }

  return urls;
}

/**
 * Collect all URLs from specified sources, deduplicating by URL
 */
function collectAllUrls(source: string): UrlEntry[] {
  const allEntries = new Map<string, UrlEntry>();

  function mergeEntries(entries: UrlEntry[]): void {
    for (const entry of entries) {
      if (allEntries.has(entry.url)) {
        allEntries.get(entry.url)!.sources.push(...entry.sources);
      } else {
        allEntries.set(entry.url, { ...entry });
      }
    }
  }

  if (source === 'all' || source === 'resources') {
    console.log('  Collecting URLs from resource YAML files...');
    const resourceUrls = collectResourceUrls();
    console.log(`    Found ${resourceUrls.length} unique URLs in resources`);
    mergeEntries(resourceUrls);
  }

  if (source === 'all' || source === 'external') {
    console.log('  Collecting URLs from external-links.yaml...');
    const externalUrls = collectExternalLinkUrls();
    console.log(`    Found ${externalUrls.length} unique URLs in external-links.yaml`);
    mergeEntries(externalUrls);
  }

  if (source === 'all' || source === 'content') {
    console.log('  Collecting URLs from MDX content...');
    const contentUrls = collectContentUrls();
    console.log(`    Found ${contentUrls.length} unique URLs in MDX content`);
    mergeEntries(contentUrls);
  }

  return Array.from(allEntries.values());
}

// ─── Domain Classification ──────────────────────────────────────────────────

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function matchesDomainList(hostname: string, domains: string[]): boolean {
  return domains.some(d => hostname === d || hostname.endsWith('.' + d));
}

type CheckStrategy = 'http' | 'doi' | 'arxiv' | 'forum-api' | 'unverifiable' | 'skip';

function getCheckStrategy(url: string): CheckStrategy {
  const hostname = getDomain(url);

  if (matchesDomainList(hostname, UNVERIFIABLE_DOMAINS)) return 'unverifiable';
  if (matchesDomainList(hostname, SKIP_DOMAINS)) return 'skip';
  if (matchesDomainList(hostname, DOI_CHECK_DOMAINS)) return 'doi';
  if (hostname.includes('arxiv.org')) return 'arxiv';
  if (hostname.includes('lesswrong.com') || hostname.includes('alignmentforum.org') ||
      hostname.includes('forum.effectivealtruism.org')) return 'forum-api';

  return 'http';
}

// ─── URL Checking ───────────────────────────────────────────────────────────

/**
 * Make an HTTP request and return status info. Follows redirects manually to
 * track the final URL.
 */
function httpCheck(url: string, method: 'HEAD' | 'GET' = 'HEAD'): Promise<{
  status: number;
  ok: boolean;
  error?: string;
  redirectUrl?: string;
  responseTimeMs: number;
}> {
  return new Promise((resolve) => {
    const start = Date.now();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      resolve({ status: 0, ok: false, error: 'invalid URL', responseTimeMs: 0 });
      return;
    }

    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      method,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LongtermWikiLinkChecker/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
    };

    const req = protocol.request(options, (res) => {
      const elapsed = Date.now() - start;
      res.resume(); // consume response body

      const status = res.statusCode!;

      // Track redirects
      if (status >= 300 && status < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        // Resolve relative redirect URLs to absolute
        if (redirectUrl.startsWith('/')) {
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        } else if (!redirectUrl.startsWith('http')) {
          // Relative path without leading slash
          const basePath = parsedUrl.pathname.replace(/\/[^/]*$/, '/');
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${basePath}${redirectUrl}`;
        }
        resolve({
          status,
          ok: true, // redirects are OK, just noteworthy
          redirectUrl,
          responseTimeMs: elapsed,
        });
        return;
      }

      // HEAD returned 405/403 — retry with GET
      if (method === 'HEAD' && (status === 405 || status === 403)) {
        httpCheck(url, 'GET').then(resolve);
        return;
      }

      resolve({
        status,
        ok: status >= 200 && status < 400,
        responseTimeMs: elapsed,
      });
    });

    req.on('error', (err) => {
      resolve({ status: 0, ok: false, error: err.message, responseTimeMs: Date.now() - start });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, ok: false, error: 'timeout', responseTimeMs: Date.now() - start });
    });
    req.end();
  });
}

/**
 * Check a DOI via doi.org resolution
 */
async function doiCheck(url: string): Promise<{ status: number; ok: boolean; error?: string; redirectUrl?: string; responseTimeMs: number }> {
  // Extract DOI from URL
  const doiMatch = url.match(/(10\.\d{4,}\/[^\s"<>]+)/);
  if (!doiMatch) {
    // Fall back to regular HTTP check
    return httpCheck(url);
  }

  const doi = doiMatch[1];
  const doiUrl = `https://doi.org/${encodeURIComponent(doi)}`;
  return httpCheck(doiUrl);
}

/**
 * Check an ArXiv URL via the ArXiv API
 */
async function arxivCheck(url: string): Promise<{ status: number; ok: boolean; error?: string; responseTimeMs: number }> {
  const arxivId = extractArxivId(url);
  if (!arxivId) {
    return httpCheck(url);
  }

  const start = Date.now();
  try {
    const apiUrl = `http://export.arxiv.org/api/query?id_list=${arxivId}&max_results=1`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'LongtermWikiLinkChecker/1.0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    const elapsed = Date.now() - start;

    // ArXiv API returns 200 even for not-found; check for <entry> tag
    if (text.includes('<entry>') && !text.includes('Error')) {
      return { status: 200, ok: true, responseTimeMs: elapsed };
    } else {
      return { status: 404, ok: false, error: 'ArXiv paper not found', responseTimeMs: elapsed };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 0, ok: false, error: message, responseTimeMs: Date.now() - start };
  }
}

/**
 * Check a forum URL via GraphQL API
 */
async function forumApiCheck(url: string): Promise<{ status: number; ok: boolean; error?: string; responseTimeMs: number }> {
  const postMatch = url.match(/\/posts\/([a-zA-Z0-9]+)/);
  if (!postMatch) {
    return httpCheck(url);
  }

  const postId = postMatch[1];
  let apiUrl: string;
  if (url.includes('lesswrong.com')) {
    apiUrl = 'https://www.lesswrong.com/graphql';
  } else if (url.includes('alignmentforum.org')) {
    apiUrl = 'https://www.alignmentforum.org/graphql';
  } else {
    apiUrl = 'https://forum.effectivealtruism.org/graphql';
  }

  const start = Date.now();
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LongtermWikiLinkChecker/1.0',
      },
      body: JSON.stringify({
        query: `query { post(input: {selector: {_id: "${postId}"}}) { result { title } } }`,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const data = await response.json() as { data?: { post?: { result?: { title: string } } } };
    const elapsed = Date.now() - start;
    const post = data?.data?.post?.result;

    if (post) {
      return { status: 200, ok: true, responseTimeMs: elapsed };
    } else {
      return { status: 404, ok: false, error: 'Forum post not found', responseTimeMs: elapsed };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 0, ok: false, error: message, responseTimeMs: Date.now() - start };
  }
}

/**
 * Check a single URL using the appropriate strategy
 */
async function checkSingleUrl(url: string): Promise<{
  status: number;
  ok: boolean;
  error?: string;
  redirectUrl?: string;
  responseTimeMs: number;
  strategy: CheckStrategy;
}> {
  const strategy = getCheckStrategy(url);

  if (strategy === 'unverifiable') {
    return { status: -1, ok: true, responseTimeMs: 0, strategy };
  }

  if (strategy === 'skip') {
    return { status: -2, ok: true, responseTimeMs: 0, strategy };
  }

  let result: { status: number; ok: boolean; error?: string; redirectUrl?: string; responseTimeMs: number };

  switch (strategy) {
    case 'doi':
      result = await doiCheck(url);
      break;
    case 'arxiv':
      result = await arxivCheck(url);
      break;
    case 'forum-api':
      result = await forumApiCheck(url);
      break;
    case 'http':
    default:
      result = await httpCheck(url);
      break;
  }

  // Retry once on transient failures (5xx, timeout) via HTTP fallback
  if (!result.ok && (result.status >= 500 || result.error === 'timeout')) {
    await sleep(RETRY_DELAY_MS);
    const retry = await httpCheck(url);
    if (retry.ok) {
      return { ...retry, strategy };
    }
  }

  return { ...result, strategy };
}

/**
 * Check URLs with concurrency control and per-domain rate limiting
 */
async function checkUrlsBatch(
  entries: UrlEntry[],
  cache: LinkCache,
  options: { limit?: number; verbose?: boolean },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const domainLastCheck = new Map<string, number>();

  // Separate cached and uncached
  const uncached: UrlEntry[] = [];
  for (const entry of entries) {
    if (cache[entry.url]) {
      const cached = cache[entry.url];
      const status: UrlStatus = cached.status === -1
        ? 'unverifiable'
        : cached.status === -2
          ? 'skipped'
          : cached.ok
            ? cached.redirectUrl ? 'redirected' : 'healthy'
            : 'broken';

      results.push({
        url: entry.url,
        status,
        httpStatus: cached.status,
        error: cached.error,
        redirectUrl: cached.redirectUrl,
        responseTimeMs: cached.responseTimeMs,
        sources: entry.sources,
        strategy: 'cached',
      });
    } else {
      uncached.push(entry);
    }
  }

  const toCheck = options.limit ? uncached.slice(0, options.limit) : uncached;

  // Skip any beyond the limit
  if (options.limit && uncached.length > options.limit) {
    for (const entry of uncached.slice(options.limit)) {
      results.push({
        url: entry.url,
        status: 'skipped',
        sources: entry.sources,
        strategy: 'limit-exceeded',
      });
    }
  }

  if (toCheck.length === 0) return results;

  let checked = 0;

  // Work queue: each worker synchronously pulls the next item before awaiting.
  // This prevents the race where two workers read the same index after an await.
  const queue = [...toCheck];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      // Synchronous pull — safe because JS is single-threaded at this point
      // (no await between the length check and shift)
      const entry = queue.shift()!;
      const domain = getDomain(entry.url);

      // Per-domain rate limiting
      const lastCheck = domainLastCheck.get(domain) || 0;
      const elapsed = Date.now() - lastCheck;
      if (elapsed < PER_DOMAIN_DELAY_MS) {
        await sleep(PER_DOMAIN_DELAY_MS - elapsed);
      }

      domainLastCheck.set(domain, Date.now());

      const result = await checkSingleUrl(entry.url);
      checked++;

      if (checked % 50 === 0 || options.verbose) {
        process.stdout.write(`\r  Checked ${checked}/${toCheck.length} URLs...`);
      }

      // Map to check result
      const status: UrlStatus = result.strategy === 'unverifiable'
        ? 'unverifiable'
        : result.strategy === 'skip'
          ? 'skipped'
          : result.ok
            ? result.redirectUrl ? 'redirected' : 'healthy'
            : result.error
              ? 'error'
              : 'broken';

      const checkResult: CheckResult = {
        url: entry.url,
        status,
        httpStatus: result.status,
        error: result.error,
        redirectUrl: result.redirectUrl,
        responseTimeMs: result.responseTimeMs,
        sources: entry.sources,
        strategy: result.strategy,
      };

      results.push(checkResult);

      // Update cache
      cache[entry.url] = {
        status: result.status,
        ok: result.ok,
        error: result.error,
        redirectUrl: result.redirectUrl,
        checkedAt: Date.now(),
        responseTimeMs: result.responseTimeMs,
      };

      if (options.verbose && !result.ok && result.strategy !== 'unverifiable' && result.strategy !== 'skip') {
        const detail = result.error || `HTTP ${result.status}`;
        console.log(`\n    BROKEN: ${entry.url} (${detail})`);
      }
    }
  }

  // Launch concurrent workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(CONCURRENCY, toCheck.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (checked > 0) {
    console.log(`\r  Checked ${checked}/${toCheck.length} URLs.${' '.repeat(20)}`);
  }

  return results;
}

// ─── Archive.org Lookup ─────────────────────────────────────────────────────

interface ArchiveResult {
  url: string;
  archiveUrl: string | null;
  timestamp?: string;
}

/**
 * Query Wayback Machine for an archived snapshot of a URL
 */
async function lookupArchive(url: string): Promise<ArchiveResult> {
  try {
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'LongtermWikiLinkChecker/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { url, archiveUrl: null };
    }

    const data = await response.json() as {
      archived_snapshots?: {
        closest?: { url: string; timestamp: string; available: boolean };
      };
    };

    const snapshot = data?.archived_snapshots?.closest;
    if (snapshot?.available && snapshot.url) {
      return {
        url,
        archiveUrl: snapshot.url,
        timestamp: snapshot.timestamp,
      };
    }

    return { url, archiveUrl: null };
  } catch {
    return { url, archiveUrl: null };
  }
}

/**
 * Look up archive.org snapshots for broken URLs
 */
async function lookupArchiveForBroken(results: CheckResult[]): Promise<void> {
  const broken = results.filter(r =>
    r.status === 'broken' || (r.status === 'error' && r.httpStatus === 0),
  );

  if (broken.length === 0) {
    console.log('  No broken URLs to look up on archive.org.');
    return;
  }

  console.log(`  Looking up ${broken.length} broken URLs on archive.org...`);

  let found = 0;
  for (let i = 0; i < broken.length; i++) {
    const result = broken[i];
    const archive = await lookupArchive(result.url);

    if (archive.archiveUrl) {
      result.archiveUrl = archive.archiveUrl;
      found++;
    }

    if ((i + 1) % 10 === 0) {
      process.stdout.write(`\r  Looked up ${i + 1}/${broken.length}...`);
    }

    await sleep(200); // Be polite to archive.org
  }

  console.log(`\r  Archive.org: ${found}/${broken.length} broken URLs have archived snapshots.${' '.repeat(20)}`);
}

// ─── Report Generation ──────────────────────────────────────────────────────

function generateReport(results: CheckResult[]): LinkCheckReport {
  const summary = {
    total_urls: results.length,
    checked: 0,
    healthy: 0,
    broken: 0,
    redirected: 0,
    unverifiable: 0,
    skipped: 0,
    errors: 0,
  };

  for (const r of results) {
    switch (r.status) {
      case 'healthy': summary.healthy++; summary.checked++; break;
      case 'broken': summary.broken++; summary.checked++; break;
      case 'redirected': summary.redirected++; summary.checked++; break;
      case 'unverifiable': summary.unverifiable++; break;
      case 'skipped': summary.skipped++; break;
      case 'error': summary.errors++; summary.checked++; break;
    }
  }

  const broken = results
    .filter(r => r.status === 'broken' || r.status === 'error')
    .map(r => ({
      url: r.url,
      status: r.httpStatus || 0,
      error: r.error,
      sources: r.sources.map(s => ({ file: s.file, line: s.line })),
      archive_url: r.archiveUrl,
      last_checked: new Date().toISOString().split('T')[0],
    }));

  const redirected = results
    .filter(r => r.status === 'redirected' && r.redirectUrl)
    .map(r => ({
      url: r.url,
      redirects_to: r.redirectUrl!,
      sources: r.sources.map(s => ({ file: s.file, line: s.line })),
    }));

  return {
    timestamp: new Date().toISOString(),
    summary,
    broken,
    redirected,
  };
}

function printSummary(report: LinkCheckReport): void {
  const { summary } = report;

  console.log('\n' + '='.repeat(60));
  console.log('  Link Check Results');
  console.log('='.repeat(60));
  console.log(`  Total URLs:    ${summary.total_urls}`);
  console.log(`  Checked:       ${summary.checked}`);
  console.log(`  Healthy:       ${summary.healthy}`);
  console.log(`  Broken:        ${summary.broken}`);
  console.log(`  Redirected:    ${summary.redirected}`);
  console.log(`  Unverifiable:  ${summary.unverifiable}`);
  console.log(`  Skipped:       ${summary.skipped}`);
  console.log(`  Errors:        ${summary.errors}`);
  console.log('='.repeat(60));

  if (report.broken.length > 0) {
    console.log(`\n  Broken URLs (${report.broken.length}):\n`);
    for (const item of report.broken.slice(0, 50)) {
      const detail = item.error || `HTTP ${item.status}`;
      console.log(`  - ${item.url}`);
      console.log(`    Status: ${detail}`);
      for (const src of item.sources.slice(0, 3)) {
        const loc = src.line ? `${src.file}:${src.line}` : src.file;
        console.log(`    Source: ${loc}`);
      }
      if (item.sources.length > 3) {
        console.log(`    ... and ${item.sources.length - 3} more sources`);
      }
      if (item.archive_url) {
        console.log(`    Archive: ${item.archive_url}`);
      }
      console.log();
    }
    if (report.broken.length > 50) {
      console.log(`  ... and ${report.broken.length - 50} more broken URLs`);
    }
  }

  if (report.redirected.length > 0) {
    console.log(`\n  Redirected URLs (${report.redirected.length}):\n`);
    for (const item of report.redirected.slice(0, 20)) {
      console.log(`  - ${item.url}`);
      console.log(`    -> ${item.redirects_to}`);
    }
    if (report.redirected.length > 20) {
      console.log(`  ... and ${report.redirected.length - 20} more redirected URLs`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));

  const source = (opts.source as string) || 'all';
  const generateReport_ = opts.report === true;
  const doFix = opts.fix === true;
  const limit = opts.limit ? parseInt(opts.limit as string, 10) : undefined;
  const verbose = opts.verbose === true;
  const clearCache = opts['clear-cache'] === true;

  console.log('Link Rot Detection\n');
  console.log(`  Source: ${source}`);
  if (limit) console.log(`  Limit: ${limit} URLs`);
  console.log();

  // Load or clear cache
  let cache: LinkCache;
  if (clearCache) {
    console.log('  Cache cleared.\n');
    cache = {};
  } else {
    cache = loadCache();
    const cacheSize = Object.keys(cache).length;
    if (cacheSize > 0) {
      console.log(`  Loaded ${cacheSize} cached results.\n`);
    }
  }

  // Collect URLs
  console.log('Phase 1: Collecting URLs\n');
  const allUrls = collectAllUrls(source);
  console.log(`\n  Total unique URLs: ${allUrls.length}\n`);

  if (allUrls.length === 0) {
    console.log('  No URLs found. Nothing to check.');
    return;
  }

  // Check URLs
  console.log('Phase 2: Checking URLs\n');
  const results = await checkUrlsBatch(allUrls, cache, { limit, verbose });

  // Save cache
  saveCache(cache);

  // Archive.org lookup for broken URLs
  if (doFix) {
    console.log('\nPhase 3: Looking up archive.org snapshots\n');
    await lookupArchiveForBroken(results);
  }

  // Generate report
  const report = generateReport(results);
  printSummary(report);

  // Save JSON report
  if (generateReport_) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`\n  Report saved to: ${REPORT_FILE}`);
  }

  // Exit with error code if broken links found
  if (report.summary.broken > 0 || report.summary.errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
