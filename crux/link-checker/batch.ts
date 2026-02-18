/**
 * Batch URL checking — concurrent URL validation with per-domain rate limiting.
 *
 * Manages a work queue of URLs, applies caching, and coordinates
 * concurrent workers with domain-aware throttling.
 */

import { sleep } from '../resource-utils.ts';
import type { UrlEntry, LinkCache, UrlStatus, CheckResult } from './types.ts';
import { getDomain, checkSingleUrl } from './strategies.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const PER_DOMAIN_DELAY_MS = 500;
const CONCURRENCY = 20;

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
