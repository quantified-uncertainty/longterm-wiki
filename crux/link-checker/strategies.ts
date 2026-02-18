/**
 * URL checking strategies — domain-aware HTTP/API checks.
 *
 * Supports: direct HTTP, DOI resolution, ArXiv API, forum GraphQL API.
 * Each strategy is optimized for its target domain type.
 */

import https from 'https';
import http from 'http';
import { sleep, extractArxivId } from '../resource-utils.ts';
import type { CheckStrategy } from './types.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 3000;

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

export function getCheckStrategy(url: string): CheckStrategy {
  const hostname = getDomain(url);

  if (matchesDomainList(hostname, UNVERIFIABLE_DOMAINS)) return 'unverifiable';
  if (matchesDomainList(hostname, SKIP_DOMAINS)) return 'skip';
  if (matchesDomainList(hostname, DOI_CHECK_DOMAINS)) return 'doi';
  if (hostname.includes('arxiv.org')) return 'arxiv';
  if (hostname.includes('lesswrong.com') || hostname.includes('alignmentforum.org') ||
      hostname.includes('forum.effectivealtruism.org')) return 'forum-api';

  return 'http';
}

/** Extract domain from a URL (exported for batch rate limiting). */
export { getDomain };

// ── Strategy Implementations ─────────────────────────────────────────────────

/** Make an HTTP request and return status info. Follows redirects manually. */
export function httpCheck(url: string, method: 'HEAD' | 'GET' = 'HEAD'): Promise<{
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
export async function checkSingleUrl(url: string): Promise<{
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
