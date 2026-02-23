/**
 * Pilot Runner — Run targeted improvements on scanned pages
 *
 * Reads a scan manifest and runs the content improve pipeline with
 * auto-generated directions based on scan findings.
 *
 * Usage:
 *   node --import tsx/esm crux/evals/pilot.ts [options]
 *
 * Options:
 *   --manifest=<path>  Path to scan manifest (default: .claude/temp/scan-manifest.json)
 *   --count=<n>        Number of pages to improve (default: 10)
 *   --tier=<t>         Improvement tier: polish, standard, deep (default: standard)
 *   --engine=<e>       Pipeline engine: v1, v2 (default: v1)
 *   --dry-run          Show what would be run without executing
 *   --apply            Apply changes to disk (default: true)
 *   --skip-session-log Skip session logging
 *   --verbose          Verbose output
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'child_process';
import type { ScanManifest, PageScanResult } from './scan.ts';
import { generateDirections } from './scan.ts';

const ROOT = join(import.meta.dirname ?? process.cwd(), '../..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PilotConfig {
  manifestPath: string;
  count: number;
  tier: string;
  engine: string;
  dryRun: boolean;
  apply: boolean;
  skipSessionLog: boolean;
  verbose: boolean;
}

function parseConfig(): PilotConfig {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=');
      opts[key] = valueParts.length > 0 ? valueParts.join('=') : true;
    }
  }

  return {
    manifestPath: (opts['manifest'] as string) || join(ROOT, '.claude/temp/scan-manifest.json'),
    count: parseInt((opts['count'] as string) || '10', 10),
    tier: (opts['tier'] as string) || 'standard',
    engine: (opts['engine'] as string) || 'v1',
    dryRun: opts['dry-run'] === true,
    apply: opts['apply'] !== false,
    skipSessionLog: opts['skip-session-log'] === true,
    verbose: opts['verbose'] === true,
  };
}

// ---------------------------------------------------------------------------
// Pilot execution
// ---------------------------------------------------------------------------

interface PilotResult {
  pageId: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

async function loadPreviousResults(resultsPath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(resultsPath, 'utf-8');
    const prev = JSON.parse(raw);
    const done = new Set<string>();
    for (const r of prev.results ?? []) {
      if (r.success) done.add(r.pageId);
    }
    return done;
  } catch {
    return new Set();
  }
}

async function runPilot(config: PilotConfig): Promise<void> {
  console.log(`\n[pilot] Loading manifest from ${config.manifestPath}`);

  const raw = await readFile(config.manifestPath, 'utf-8');
  const manifest: ScanManifest = JSON.parse(raw);

  console.log(`[pilot] Manifest: ${manifest.pagesScanned} pages scanned, ${manifest.totalFindings} findings`);

  // Load previous results to skip already-improved pages
  const resultsPath = join(ROOT, '.claude/temp/pilot-results.json');
  const previouslyDone = await loadPreviousResults(resultsPath);
  if (previouslyDone.size > 0) {
    console.log(`[pilot] Skipping ${previouslyDone.size} previously improved pages: ${[...previouslyDone].join(', ')}`);
  }

  // Select top N pages by uncited claims (skip pages with 0 issues and already-done pages)
  const candidates = manifest.pages
    .filter(p => p.uncitedClaimCount > 0 && !previouslyDone.has(p.pageId))
    .slice(0, config.count);

  if (candidates.length === 0) {
    console.log('[pilot] No pages with uncited claims found. Nothing to do.');
    return;
  }

  console.log(`[pilot] Selected ${candidates.length} pages for improvement:\n`);

  // Display plan
  console.log('  Page                                Uncited  Type           Tier');
  console.log('  ' + '─'.repeat(70));
  for (const page of candidates) {
    const id = page.pageId.padEnd(36);
    const uncited = String(page.uncitedClaimCount).padEnd(8);
    const type = (page.entityType || '—').padEnd(14);
    console.log(`  ${id} ${uncited} ${type} ${config.tier}`);
  }
  console.log('');

  if (config.dryRun) {
    console.log('[pilot] Dry run — showing commands that would be executed:\n');
    for (const page of candidates) {
      const directions = generateDirections(page);
      const dirPreview = directions.split('\n\n')[0].slice(0, 120);
      console.log(`  pnpm crux content improve ${page.pageId} --tier=${config.tier} --engine=${config.engine} --apply`);
      console.log(`    --directions="${dirPreview}..."`);
      console.log('');
    }
    return;
  }

  // Execute improvements
  const results: PilotResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const page = candidates[i];
    const directions = generateDirections(page);

    console.log(`\n[pilot] [${i + 1}/${candidates.length}] Improving: ${page.pageId} (${page.uncitedClaimCount} uncited claims)`);

    const pageStart = Date.now();
    const args = [
      '--import', 'tsx/esm', '--no-warnings',
      'crux/authoring/page-improver/index.ts',
      '--', page.pageId,
      '--tier', config.tier,
    ];

    if (config.engine === 'v2') args.push('--engine', 'v2');
    if (config.apply) args.push('--apply');
    if (config.skipSessionLog) args.push('--skip-session-log');

    args.push('--directions', directions);

    try {
      execFileSync('node', args, {
        cwd: ROOT,
        timeout: 30 * 60 * 1000, // 30 min per page
        stdio: config.verbose ? 'inherit' : 'pipe',
        env: { ...process.env },
      });

      const durationMs = Date.now() - pageStart;
      results.push({ pageId: page.pageId, success: true, durationMs });
      console.log(`[pilot] ✓ ${page.pageId} completed (${(durationMs / 1000).toFixed(0)}s)`);
    } catch (err: unknown) {
      const durationMs = Date.now() - pageStart;
      const error = err instanceof Error ? err.message.slice(0, 200) : String(err);
      results.push({ pageId: page.pageId, success: false, durationMs, error });
      console.error(`[pilot] ✗ ${page.pageId} failed (${(durationMs / 1000).toFixed(0)}s): ${error.slice(0, 100)}`);
    }
  }

  // Summary
  const totalDuration = Date.now() - startTime;
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log('\n' + '═'.repeat(60));
  console.log(`  Pilot Complete`);
  console.log('═'.repeat(60));
  console.log(`  Pages improved: ${succeeded}/${candidates.length}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total duration: ${(totalDuration / 1000 / 60).toFixed(1)} minutes`);
  console.log(`  Avg per page: ${(totalDuration / 1000 / candidates.length).toFixed(0)}s`);
  console.log('');

  if (failed > 0) {
    console.log('  Failed pages:');
    for (const r of results.filter(r => !r.success)) {
      console.log(`    ${r.pageId}: ${r.error?.slice(0, 100)}`);
    }
  }

  // Save results — merge with any previous pilot results
  await mkdir(join(resultsPath, '..'), { recursive: true });
  let allResults = results;
  try {
    const prevRaw = await readFile(resultsPath, 'utf-8');
    const prev = JSON.parse(prevRaw);
    if (Array.isArray(prev.results)) {
      // Merge: previous results + new results (deduplicate by pageId, keeping latest)
      const byPage = new Map<string, PilotResult>();
      for (const r of prev.results) byPage.set(r.pageId, r);
      for (const r of results) byPage.set(r.pageId, r);
      allResults = [...byPage.values()];
    }
  } catch { /* no previous results */ }
  const allSucceeded = allResults.filter(r => r.success).length;
  const allFailed = allResults.filter(r => !r.success).length;
  await writeFile(resultsPath, JSON.stringify({
    runAt: new Date().toISOString(),
    config: { ...config, manifestPath: undefined },
    candidates: candidates.map(p => ({ pageId: p.pageId, uncitedClaimCount: p.uncitedClaimCount, entityType: p.entityType })),
    results: allResults,
    summary: { succeeded: allSucceeded, failed: allFailed, totalDurationMs: totalDuration },
  }, null, 2));
  console.log(`  Results: ${resultsPath} (${allResults.length} total, ${allSucceeded} succeeded)`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const config = parseConfig();
runPilot(config).catch(err => {
  console.error(`[pilot] Fatal error: ${err}`);
  process.exit(1);
});
