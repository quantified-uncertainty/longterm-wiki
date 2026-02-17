/**
 * Link Rot Detection — CLI entry point.
 *
 * Orchestrates URL collection, checking, archive lookup, and reporting.
 *
 * Run via: pnpm crux check-links [options]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { parseCliArgs } from '../lib/cli.ts';
import type { LinkCache } from './types.ts';
import { collectAllUrls } from './collectors.ts';
import { checkUrlsBatch, lookupArchiveForBroken } from './checkers.ts';
import { generateReport, printSummary } from './report.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const CACHE_DIR = join(PROJECT_ROOT, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'link-check-cache.json');
const REPORT_FILE = join(CACHE_DIR, 'link-check-report.json');

// Cache TTLs
const CACHE_TTL_HEALTHY_MS = 14 * 24 * 60 * 60 * 1000;      // 14 days
const CACHE_TTL_BROKEN_MS = 3 * 24 * 60 * 60 * 1000;         // 3 days
const CACHE_TTL_UNVERIFIABLE_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

// ── Cache Management ─────────────────────────────────────────────────────────

function loadCache(): LinkCache {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as LinkCache;
    const now = Date.now();
    const fresh: LinkCache = {};
    for (const [url, entry] of Object.entries(data)) {
      const ttl = entry.status === -1
        ? CACHE_TTL_UNVERIFIABLE_MS
        : entry.status === -2
          ? CACHE_TTL_UNVERIFIABLE_MS
          : entry.ok
            ? CACHE_TTL_HEALTHY_MS
            : CACHE_TTL_BROKEN_MS;
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

// ── Main ─────────────────────────────────────────────────────────────────────

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
