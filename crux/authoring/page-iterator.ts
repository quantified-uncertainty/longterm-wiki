#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Page Iterator — Closed-loop improve-review-fix pipeline.
 *
 * Repeatedly runs the content improve pipeline until quality stabilizes,
 * issues drop below a threshold, or the maximum round count is reached.
 *
 * Each round:
 * 1. Runs `content improve` with the given tier and optional directions
 * 2. Runs `fix escaping` and `fix markdown` on the output
 * 3. Reads pipeline-results.json to check quality score and issue count
 * 4. If issues > threshold and rounds remain, composes targeted directions
 *    from the review issues and loops
 *
 * Usage:
 *   pnpm crux content iterate <pageId> [options]
 *   pnpm crux content iterate --pages=a,b,c [options]
 */

import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { PipelineResults } from './page-improver/types.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── Types ────────────────────────────────────────────────────────────────────

interface IterateOptions {
  maxRounds: number;
  tier: string;
  directions: string;
  apply: boolean;
  gapAnalysis: boolean;
  timeoutMinutes: number;
}

interface RoundResult {
  round: number;
  qualityScore: number | undefined;
  issueCount: number;
  issues: string[];
  stoppedEarly: boolean;
  stopReason?: string;
}

interface PageIterationResult {
  pageId: string;
  rounds: RoundResult[];
  finalQuality: number | undefined;
  finalIssueCount: number;
  totalRounds: number;
}

// ── Argument parser ──────────────────────────────────────────────────────────

interface ParsedArgs {
  _positional: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const opts: ParsedArgs = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') continue;
    if (argv[i].startsWith('--')) {
      const raw = argv[i].slice(2);
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        opts[raw.slice(0, eqIdx)] = raw.slice(eqIdx + 1);
      } else {
        const key = raw;
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
      }
    } else {
      (opts._positional as string[]).push(argv[i]);
    }
  }
  return opts;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Stop iterating when issues are at or below this threshold. */
const ISSUE_THRESHOLD = 3;

/** Maximum number of review issues to include in targeted directions. */
const MAX_ISSUES_IN_DIRECTIONS = 5;

// ── Core logic ───────────────────────────────────────────────────────────────

function runImprove(pageId: string, options: IterateOptions): void {
  const args = [
    '--import', 'tsx/esm', '--no-warnings',
    'crux/authoring/page-improver/index.ts',
    '--', pageId,
    `--tier=${options.tier}`,
  ];

  if (options.apply) {
    args.push('--apply');
  }

  if (options.directions) {
    args.push(`--directions=${options.directions}`);
  }

  if (options.gapAnalysis) {
    args.push('--gap-analysis');
  }

  // Skip session logging for intermediate rounds; the last round logs naturally
  args.push('--skip-session-log');

  execFileSync('node', args, { cwd: ROOT, stdio: 'inherit', timeout: options.timeoutMinutes * 60 * 1000 });
}

function runFix(fixType: 'escaping' | 'markdown'): void {
  execFileSync('node', [
    '--import', 'tsx/esm', '--no-warnings',
    'crux/crux.mjs', 'fix', fixType,
  ], { cwd: ROOT, stdio: 'inherit', timeout: 2 * 60 * 1000 });
}

function readPipelineResults(pageId: string): PipelineResults | null {
  const resultsPath = path.join(ROOT, '.claude/temp/page-improver', pageId, 'pipeline-results.json');
  if (!fs.existsSync(resultsPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as PipelineResults;
  } catch {
    return null;
  }
}

function composeDirectionsFromIssues(issues: string[]): string {
  const selected = issues.slice(0, MAX_ISSUES_IN_DIRECTIONS);
  const issueList = selected.map((issue) => `- ${issue}`).join('\n');
  return `Fix the following review issues from the previous improvement round:\n${issueList}`;
}

async function iteratePage(
  pageId: string,
  options: IterateOptions,
): Promise<PageIterationResult> {
  const rounds: RoundResult[] = [];
  let previousQuality: number | undefined;
  let currentDirections = options.directions;

  for (let round = 1; round <= options.maxRounds; round++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Iteration ${round}/${options.maxRounds} for ${pageId}`);
    console.log('='.repeat(60));

    // 1. Run improve pipeline
    const roundOptions: IterateOptions = {
      ...options,
      directions: currentDirections,
      // Only run gap analysis on the first round
      gapAnalysis: round === 1 && options.gapAnalysis,
    };

    try {
      runImprove(pageId, roundOptions);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`\nImprove pipeline failed in round ${round}: ${error.message}`);
      rounds.push({
        round,
        qualityScore: undefined,
        issueCount: 0,
        issues: [],
        stoppedEarly: true,
        stopReason: `Pipeline error: ${error.message}`,
      });
      break;
    }

    // 2. Run escaping and markdown fixes (only if applying changes)
    if (options.apply) {
      try {
        runFix('escaping');
        runFix('markdown');
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.warn(`Warning: fix step failed: ${error.message}`);
      }
    }

    // 3. Read pipeline results
    const results = readPipelineResults(pageId);
    if (!results) {
      console.log('No pipeline results found. Stopping iteration.');
      rounds.push({
        round,
        qualityScore: undefined,
        issueCount: 0,
        issues: [],
        stoppedEarly: true,
        stopReason: 'No pipeline results found',
      });
      break;
    }

    const quality = results.review?.qualityScore;
    const issues = results.review?.issues || [];
    const issueCount = issues.length;

    console.log(`\nRound ${round} results:`);
    console.log(`  Quality score: ${quality ?? 'N/A'}`);
    console.log(`  Issue count:   ${issueCount}`);
    if (issues.length > 0) {
      console.log('  Top issues:');
      issues.slice(0, 3).forEach((issue) => console.log(`    - ${issue.slice(0, 100)}`));
    }

    rounds.push({
      round,
      qualityScore: quality,
      issueCount,
      issues,
      stoppedEarly: false,
    });

    // 4. Decide whether to continue

    // Stop condition: issues are acceptable
    if (issueCount <= ISSUE_THRESHOLD) {
      console.log(`\nQuality acceptable (<= ${ISSUE_THRESHOLD} issues). Stopping iteration.`);
      rounds[rounds.length - 1].stoppedEarly = true;
      rounds[rounds.length - 1].stopReason = `Issues <= ${ISSUE_THRESHOLD}`;
      break;
    }

    // Stop condition: quality did not improve from previous round
    if (previousQuality !== undefined && quality !== undefined && quality <= previousQuality) {
      console.log(`\nQuality did not improve (${previousQuality} -> ${quality}). Stopping iteration.`);
      rounds[rounds.length - 1].stoppedEarly = true;
      rounds[rounds.length - 1].stopReason = 'Quality stagnated';
      break;
    }

    // Stop condition: last round
    if (round >= options.maxRounds) {
      console.log(`\nMax rounds (${options.maxRounds}) reached. Stopping iteration.`);
      rounds[rounds.length - 1].stopReason = 'Max rounds reached';
      break;
    }

    // Prepare targeted directions for next round
    previousQuality = quality;
    currentDirections = composeDirectionsFromIssues(issues);
    console.log('\nComposed targeted directions for next round.');
  }

  const lastRound = rounds[rounds.length - 1];
  return {
    pageId,
    rounds,
    finalQuality: lastRound?.qualityScore,
    finalIssueCount: lastRound?.issueCount ?? 0,
    totalRounds: rounds.length,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (argv.length === 0 || opts.help || opts.h) {
    console.log(`
Page Iterator — Closed-loop improve-review-fix pipeline

Repeatedly runs the content improve pipeline, checks review results,
and re-runs with targeted directions until quality stabilizes.

Usage:
  pnpm crux content iterate <pageId> [options]
  pnpm crux content iterate --pages=a,b,c [options]

Options:
  --max-rounds=N     Maximum improvement rounds (default: 3)
  --tier=T           Base tier for improvements (default: standard)
  --directions=D     Initial directions for the first round
  --apply            Apply changes (default: dry-run preview)
  --gap-analysis     Run claims gap analysis on the first round
  --timeout=M        Per-round timeout in minutes (default: 30)
  --pages=a,b,c      Multiple pages (comma-separated, run sequentially)

Stop conditions:
  - Review issues <= ${ISSUE_THRESHOLD}
  - Quality score does not improve between rounds
  - Maximum rounds reached

Examples:
  pnpm crux content iterate anthropic --apply
  pnpm crux content iterate anthropic --max-rounds=5 --tier=deep --apply
  pnpm crux content iterate --pages=anthropic,miri,far-ai --apply
  pnpm crux content iterate anthropic --directions="Focus on 2025 developments" --apply
`);
    return;
  }

  // Parse options
  const maxRounds = Math.max(1, parseInt(opts['max-rounds'] as string, 10) || 3);
  const tier = (opts.tier as string) || 'standard';
  const directions = (opts.directions as string) || '';
  const apply = opts.apply === true;
  const gapAnalysis = opts['gap-analysis'] === true;
  const timeoutMinutes = Math.max(5, parseInt(opts.timeout as string, 10) || 30);

  // Determine page list
  let pageIds: string[] = [];
  const pagesOpt = opts.pages as string | undefined;
  if (pagesOpt && typeof pagesOpt === 'string') {
    pageIds = pagesOpt.split(',').map((id) => id.trim()).filter(Boolean);
  }

  const positional = (opts._positional as string[]).filter((a) => !a.startsWith('-'));
  if (positional.length > 0) {
    pageIds = [...positional, ...pageIds];
  }

  if (pageIds.length === 0) {
    console.error('Error: No page ID provided.');
    console.error('Usage: pnpm crux content iterate <pageId> [options]');
    process.exit(1);
  }

  // Deduplicate
  pageIds = [...new Set(pageIds)];

  const iterateOptions: IterateOptions = {
    maxRounds,
    tier,
    directions,
    apply,
    gapAnalysis,
    timeoutMinutes,
  };

  console.log('Page Iterator');
  console.log('='.repeat(60));
  console.log(`Pages:      ${pageIds.join(', ')}`);
  console.log(`Max rounds: ${maxRounds}`);
  console.log(`Tier:       ${tier}`);
  console.log(`Timeout:    ${timeoutMinutes}m`);
  console.log(`Apply:      ${apply}`);
  if (directions) console.log(`Directions: ${directions}`);
  if (gapAnalysis) console.log(`Gap analysis: enabled (first round only)`);
  console.log('='.repeat(60));

  const allResults: PageIterationResult[] = [];

  // Run pages sequentially to avoid API rate limits
  for (const pageId of pageIds) {
    if (pageIds.length > 1) {
      console.log(`\n${'#'.repeat(60)}`);
      console.log(`# Processing page: ${pageId}`);
      console.log(`${'#'.repeat(60)}`);
    }

    const result = await iteratePage(pageId, iterateOptions);
    allResults.push(result);
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Iteration Summary');
  console.log('='.repeat(60));

  for (const result of allResults) {
    const lastRound = result.rounds[result.rounds.length - 1];
    const stopReason = lastRound?.stopReason || 'completed';
    console.log(`\n  ${result.pageId}:`);
    console.log(`    Rounds:    ${result.totalRounds}`);
    console.log(`    Quality:   ${result.finalQuality ?? 'N/A'}`);
    console.log(`    Issues:    ${result.finalIssueCount}`);
    console.log(`    Stop:      ${stopReason}`);
  }

  // Write summary to temp directory
  const summaryPath = path.join(ROOT, '.claude/temp/page-improver/iteration-summary.json');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(allResults, null, 2));
  console.log(`\nSummary written to: ${summaryPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
