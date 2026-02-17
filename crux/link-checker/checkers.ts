/**
 * URL checking strategies — domain-aware HTTP/API checks and archive lookups.
 *
 * Supports: direct HTTP, DOI resolution, ArXiv API, forum GraphQL API,
 * plus archive.org fallback lookup for broken URLs.
 */

import https from 'https';
import http from 'http';
import { sleep, extractArxivId } from '../resource-utils.ts';
import type {
  UrlEntry, UrlSource, LinkCache, UrlStatus,
  CheckResult, ArchiveResult, CheckStrategy,
} from './types.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 3000;
const PER_DOMAIN_DELAY_MS = 500;
const CONCURRENCY = 20;

/** Domains that should be checked via DOI resolution. */
const DOI_CHECK_DOMAINS = [
  'nature.com', 'science.org', 'springer.com', 'wiley.com',
  'sciencedirect.com', 'tandfonline.com', 'pnas.org', 'cell.com',
];

/** Domains that block all automated access. */
const UNVERIFIABLE_DOMAINS = [
  'twitter.com', 'x.com', 'linkedin.com', 'facebook.com', 't.co',
];

/** Domains that aggressively rate-limit but are generally reliable. */
const SKIP_DOMAINS = [
  'academic.oup.com', 'pubsonline.informs.org', 'proceedings.neurips.cc',
  'cambridge.org', 'papers.ssrn.com', 'ieee.org', 'dl.acm.org', 'jstor.org',
  'venturebeat.com', 'linearb.io', 'openphilanthropy.org', 'metaculus.com',
  'un.org', 'europarl.europa.eu',
];

// ── Domain Classification ────────────────────────────────────────────────────

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

// ── Strategy Implementations ─────────────────────────────────────────────────

/** Make an HTTP request and return status info. Follows redirects manually. */
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
      res.resume();

      const status = res.statusCode!;

      if (status >= 300 && status < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        } else if (!redirectUrl.startsWith('http')) {
          const basePath = parsedUrl.pathname.replace(/\/[^/]*$/, '/');
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${basePath}${redirectUrl}`;
        }
        resolve({ status, ok: true, redirectUrl, responseTimeMs: elapsed });
        return;
      }

      if (method === 'HEAD' && (status === 405 || status === 403)) {
        httpCheck(url, 'GET').then(resolve);
        return;
      }

      resolve({ status, ok: status >= 200 && status < 400, responseTimeMs: elapsed });
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

/** Check a DOI via doi.org resolution. */
async function doiCheck(url: string): Promise<{ status: number; ok: boolean; error?: string; redirectUrl?: string; responseTimeMs: number }> {
  const doiMatch = url.match(/(10\.\d{4,}\/[^\s"<>]+)/);
  if (!doiMatch) return httpCheck(url);

  const doi = doiMatch[1];
  const doiUrl = `https://doi.org/${encodeURIComponent(doi)}`;
  return httpCheck(doiUrl);
}

/** Check an ArXiv URL via the ArXiv API. */
async function arxivCheck(url: string): Promise<{ status: number; ok: boolean; error?: string; responseTimeMs: number }> {
  const arxivId = extractArxivId(url);
  if (!arxivId) return httpCheck(url);

  const start = Date.now();
  try {
    const apiUrl = `http://export.arxiv.org/api/query?id_list=${arxivId}&max_results=1`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'LongtermWikiLinkChecker/1.0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    const elapsed = Date.now() - start;

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

/** Check a forum URL via GraphQL API. */
async function forumApiCheck(url: string): Promise<{ status: number; ok: boolean; error?: string; responseTimeMs: number }> {
  const postMatch = url.match(/\/posts\/([a-zA-Z0-9]+)/);
  if (!postMatch) return httpCheck(url);

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

// ── Single URL Check ─────────────────────────────────────────────────────────

/** Check a single URL using the appropriate strategy. */
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

  // Retry once on transient failures
  if (!result.ok && (result.status >= 500 || result.error === 'timeout')) {
    await sleep(RETRY_DELAY_MS);
    const retry = await httpCheck(url);
    if (retry.ok) {
      return { ...retry, strategy };
    }
  }

  return { ...result, strategy };
}

// ── Batch Checking ───────────────────────────────────────────────────────────

/** Check URLs with concurrency control and per-domain rate limiting. */
export async function checkUrlsBatch(
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
  const queue = [...toCheck];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      const domain = getDomain(entry.url);

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

// ── Archive.org Lookup ───────────────────────────────────────────────────────

/** Query Wayback Machine for an archived snapshot of a URL. */
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
      return { url, archiveUrl: snapshot.url, timestamp: snapshot.timestamp };
    }

    return { url, archiveUrl: null };
  } catch {
    return { url, archiveUrl: null };
  }
}

/** Look up archive.org snapshots for broken URLs. */
export async function lookupArchiveForBroken(results: CheckResult[]): Promise<void> {
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

    await sleep(200);
  }

  console.log(`\r  Archive.org: ${found}/${broken.length} broken URLs have archived snapshots.${' '.repeat(20)}`);
}
