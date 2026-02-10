/**
 * Rule: External Link Health Check
 *
 * Validates that external URLs in content are reachable.
 * Collects all external links from MDX files, deduplicates them,
 * makes HTTP HEAD requests with concurrency control, and reports
 * broken links (404s, timeouts, connection errors).
 *
 * Results are cached to avoid re-checking the same URLs across runs.
 * Run via: crux validate external-links
 *
 * This is a global-scope rule (runs once across all files) for
 * efficient batching of HTTP requests.
 */

import { createRule, Issue, Severity } from '../validation-engine.js';
import { isInCodeBlock } from '../mdx-utils.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import https from 'https';
import http from 'http';

const CACHE_DIR = join(process.cwd(), '.claude', 'temp');
const CACHE_FILE = join(CACHE_DIR, 'external-links-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const CONCURRENCY = 10;
const REQUEST_TIMEOUT_MS = 10000;

// Domains to skip (known to block automated requests or be unreliable for HEAD checks)
const SKIP_DOMAINS = [
  'twitter.com',
  'x.com',
  'linkedin.com',
  'facebook.com',
  't.co',
  // Academic publishers that block bots (return 403)
  'science.org',
  'pnas.org',
  'academic.oup.com',
  'pubsonline.informs.org',
  'proceedings.neurips.cc',
  'cambridge.org',
  'papers.ssrn.com',
  'springer.com',
  'wiley.com',
  'sciencedirect.com',
  'jstor.org',
  'nature.com',
  'tandfonline.com',
  'ieee.org',
  'dl.acm.org',
  // Sites that aggressively rate-limit (return 429)
  'alignmentforum.org',
  'venturebeat.com',
  'linearb.io',
  'openphilanthropy.org',
  // Sites that block bots but are generally reliable
  'metaculus.com',
  // Government/institutional sites that block bots
  'un.org',
  'europarl.europa.eu',
];

/**
 * Load cached results, filtering out stale entries
 */
function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    const now = Date.now();
    const fresh = {};
    for (const [url, entry] of Object.entries(data)) {
      if (now - entry.checkedAt < CACHE_TTL_MS) {
        fresh[url] = entry;
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

/**
 * Save cache to disk
 */
function saveCache(cache) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Non-fatal: cache is a performance optimization
  }
}

/**
 * Check a single URL via HTTP HEAD (falling back to GET)
 * Returns { status, ok, error }
 */
function checkUrl(url) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      method: 'HEAD',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)',
        'Accept': '*/*',
      },
    };

    const req = protocol.request(options, (res) => {
      // Some servers return 405 for HEAD — retry with GET
      if (res.statusCode === 405 || res.statusCode === 403) {
        const getOptions = { ...options, method: 'GET' };
        const getReq = protocol.request(getOptions, (getRes) => {
          // Consume response body
          getRes.resume();
          resolve({
            status: getRes.statusCode,
            ok: getRes.statusCode >= 200 && getRes.statusCode < 400,
          });
        });
        getReq.on('error', (err) => resolve({ status: 0, ok: false, error: err.message }));
        getReq.on('timeout', () => {
          getReq.destroy();
          resolve({ status: 0, ok: false, error: 'timeout' });
        });
        getReq.end();
        return;
      }

      // Consume response body
      res.resume();
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 400,
      });
    });

    req.on('error', (err) => resolve({ status: 0, ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, ok: false, error: 'timeout' });
    });
    req.end();
  });
}

/**
 * Run checks with concurrency limit
 */
async function checkUrlsWithConcurrency(urls, cache) {
  const results = {};
  const unchecked = urls.filter((url) => !cache[url]);
  let index = 0;

  async function worker() {
    while (index < unchecked.length) {
      const url = unchecked[index++];
      try {
        const result = await checkUrl(url);
        results[url] = { ...result, checkedAt: Date.now() };
      } catch (err) {
        results[url] = { status: 0, ok: false, error: err.message, checkedAt: Date.now() };
      }
    }
  }

  // Launch workers
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, unchecked.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

/**
 * Extract external URLs from content body
 */
function extractExternalUrls(body) {
  const urls = [];

  // Markdown links: [text](url)
  const mdLinkRegex = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  // Bare URLs in text
  const bareUrlRegex = /(?<!\[)\b(https?:\/\/[^\s<>"\])\}]+)/g;
  // HTML href attributes
  const hrefRegex = /href=["'](https?:\/\/[^"']+)["']/g;

  const lines = body.split('\n');
  let position = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!isInCodeBlock(body, position)) {
      // Markdown links
      let match;
      mdLinkRegex.lastIndex = 0;
      while ((match = mdLinkRegex.exec(line)) !== null) {
        urls.push({ url: match[2], line: i + 1, text: match[1] });
      }

      // HTML href
      hrefRegex.lastIndex = 0;
      while ((match = hrefRegex.exec(line)) !== null) {
        urls.push({ url: match[1], line: i + 1, text: '' });
      }
    }

    position += line.length + 1;
  }

  return urls;
}

/**
 * Check if URL domain should be skipped
 */
function shouldSkip(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Skip known problematic domains
    if (SKIP_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d))) {
      return true;
    }

    // Skip URLs that look truncated (unbalanced parentheses from markdown parsing)
    // e.g., https://en.wikipedia.org/wiki/P(doom gets truncated from [P(doom)](url)
    const path = parsed.pathname;
    const openParens = (path.match(/\(/g) || []).length;
    const closeParens = (path.match(/\)/g) || []).length;
    if (openParens > closeParens) {
      return true;
    }

    return false;
  } catch {
    return true; // Skip malformed URLs
  }
}

export const externalLinksRule = createRule({
  id: 'external-links',
  name: 'External Link Health Check',
  description: 'Check that external URLs are reachable (HTTP HEAD/GET)',
  scope: 'global',

  async check(allContent, engine) {
    const issues = [];

    // Collect all external URLs with their source locations
    const urlLocations = new Map(); // url → [{file, line, text}]

    for (const content of allContent) {
      // Skip internal documentation
      if (content.relativePath.includes('/internal/')) continue;

      const extracted = extractExternalUrls(content.body);
      for (const { url, line, text } of extracted) {
        // Clean URL (remove trailing punctuation that got captured)
        const cleanUrl = url.replace(/[.,;:!?)]+$/, '');

        if (shouldSkip(cleanUrl)) continue;

        if (!urlLocations.has(cleanUrl)) {
          urlLocations.set(cleanUrl, []);
        }
        urlLocations.get(cleanUrl).push({
          file: content.path,
          line,
          text,
        });
      }
    }

    const uniqueUrls = Array.from(urlLocations.keys());

    if (uniqueUrls.length === 0) return issues;

    // Load cache and check uncached URLs
    const cache = loadCache();
    const cachedCount = uniqueUrls.filter((u) => cache[u]).length;

    console.log(
      `  Checking ${uniqueUrls.length} unique external URLs (${cachedCount} cached, ${uniqueUrls.length - cachedCount} to check)...`
    );

    const freshResults = await checkUrlsWithConcurrency(uniqueUrls, cache);

    // Merge fresh results into cache
    const mergedCache = { ...cache, ...freshResults };
    saveCache(mergedCache);

    // Report broken URLs
    for (const [url, locations] of urlLocations) {
      const result = mergedCache[url];
      if (!result) continue; // Shouldn't happen, but defensive

      if (!result.ok) {
        const detail = result.error
          ? `error: ${result.error}`
          : `HTTP ${result.status}`;

        // Report on every file that uses this broken URL
        for (const loc of locations) {
          issues.push(
            new Issue({
              rule: this.id,
              file: loc.file,
              line: loc.line,
              message: `Broken external link: ${url} (${detail})`,
              severity: Severity.WARNING,
            })
          );
        }
      }
    }

    const brokenCount = issues.length;
    const checkedCount = uniqueUrls.length - cachedCount;
    if (checkedCount > 0) {
      console.log(
        `  Checked ${checkedCount} URLs: ${checkedCount - Object.values(freshResults).filter((r) => !r.ok).length} ok, ${Object.values(freshResults).filter((r) => !r.ok).length} broken`
      );
    }

    return issues;
  },
});

export default externalLinksRule;
