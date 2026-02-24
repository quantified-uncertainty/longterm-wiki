/**
 * Batch Runner for V2 Orchestrator
 *
 * Runs the V2 orchestrator on multiple pages with:
 * - Per-page isolation (try/catch — failures don't abort the batch)
 * - Budget tracking (stops when cumulative cost exceeds --batch-budget)
 * - Per-page timeout (default 15 min)
 * - Progress output with cost/time tracking
 * - Resume via batch-state.json (skip already-completed pages)
 * - Summary report at completion
 *
 * Usage (via CLI):
 *   pnpm crux content improve --batch=page1,page2,page3 --engine=v2 --tier=standard
 *   pnpm crux content improve --batch-file=pages.txt --engine=v2 --batch-budget=500
 *   pnpm crux content improve --batch=page1,page2 --engine=v2 --resume
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { runOrchestratorPipeline } from './orchestrator/index.ts';
import type { OrchestratorOptions, OrchestratorResult, OrchestratorTier } from './orchestrator/types.ts';
import { TIER_BUDGETS } from './orchestrator/types.ts';
import { createPhaseLogger } from '../lib/output.ts';
import { loadPages as loadPagesFromRegistry } from '../lib/content-types.ts';
import {
  snapshotFromFile,
  computeDelta,
  generateQualityReport,
  writeJsonReport,
  formatMarkdownReport,
  type PageQualitySnapshot,
  type PageQualityDelta,
} from './batch-quality-report.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const STATE_FILE = path.join(ROOT, '.claude/temp/batch-state.json');

const log = createPhaseLogger();

/** Maximum MDX file size in bytes before a page is skipped. */
const MAX_PAGE_SIZE_BYTES = 50 * 1024; // 50KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BatchOptions {
  /** Page IDs to process. */
  pageIds: string[];
  /** Orchestrator tier (polish/standard/deep). */
  tier: OrchestratorTier;
  /** Free-text improvement directions. */
  directions?: string;
  /** Maximum budget in dollars. Stops when cumulative cost exceeds this. */
  budgetLimit?: number;
  /** Per-page timeout in milliseconds (default: 15 min). */
  pageTimeout?: number;
  /** If true, skip pages already completed in batch-state.json. */
  resume?: boolean;
  /** If true, apply changes (don't just preview). */
  apply?: boolean;
  /** If true, run auto-grading after each page. */
  grade?: boolean;
  /** If true, skip writing session logs. */
  skipSessionLog?: boolean;
  /** Path to write a markdown report file. */
  reportFile?: string;
  /** Path to write the quality report JSON. Defaults to .claude/temp/batch-quality-report.json. */
  qualityReportFile?: string;
}

export interface PageResult {
  pageId: string;
  status: 'completed' | 'failed' | 'skipped' | 'budget-exceeded' | 'timeout';
  duration?: string;
  cost?: number;
  /** Actual cost from API usage data (when available). */
  actualCost?: number;
  qualityGatePassed?: boolean;
  error?: string;
  toolCallCount?: number;
}

interface BatchState {
  startedAt: string;
  tier: string;
  totalBudget: number | null;
  completedPages: Record<string, PageResult>;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadState(): BatchState | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    // Corrupt state file — start fresh
  }
  return null;
}

function saveState(state: BatchState): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: write to temp file then rename to avoid corruption on crash
  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  try {
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err: unknown) {
    // EXDEV: cross-device link — fall back to copy + unlink
    if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
      fs.copyFileSync(tmpFile, STATE_FILE);
      fs.unlinkSync(tmpFile);
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// File size helper
// ---------------------------------------------------------------------------

/** Cached pages registry (loaded once per process). */
let _cachedPages: Array<{ id: string; path: string; [k: string]: unknown }> | null = null;
function getCachedPages() {
  if (!_cachedPages) _cachedPages = loadPagesFromRegistry() as Array<{ id: string; path: string }>;
  return _cachedPages;
}

/**
 * Resolve the MDX file path for a page ID and return its size in bytes.
 * Returns null if the page or file can't be found.
 */
function getPageFileSize(pageId: string): { filePath: string; sizeBytes: number } | null {
  try {
    const pages = getCachedPages();
    const page = pages.find((p: { id: string }) => p.id === pageId);
    if (!page) return null;
    const pagePath = (page as { path: string }).path.replace(/^\/|\/$/g, '');
    const filePath = path.join(ROOT, 'content/docs', pagePath + '.mdx');
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    return { filePath, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Timeout wrapper with AbortController
// ---------------------------------------------------------------------------

/**
 * Run a promise with a hard timeout. Uses AbortController so the orchestrator
 * can check `signal.aborted` between tool calls (event loop starvation-safe).
 * Also uses setInterval as a secondary watchdog since setInterval re-queues
 * on each event loop tick (more likely to fire than setTimeout under load).
 */
async function withTimeout<T>(
  promiseFactory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const startTime = Date.now();
  let settled = false;

  const makeTimeoutError = (source: string) =>
    new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s${source ? ` (${source})` : ''}`);

  // Primary timeout via setTimeout
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        controller.abort();
        reject(makeTimeoutError(''));
      }
    }, timeoutMs);
  });

  // Secondary watchdog via setInterval (fires on next available event loop tick)
  let watchdog: NodeJS.Timeout;
  const watchdogPromise = new Promise<never>((_, reject) => {
    watchdog = setInterval(() => {
      if (!settled && Date.now() - startTime > timeoutMs) {
        settled = true;
        controller.abort();
        reject(makeTimeoutError('watchdog'));
      }
    }, 5000);
  });

  try {
    const result = await Promise.race([
      promiseFactory(controller.signal),
      timeoutPromise,
      watchdogPromise,
    ]);
    settled = true;
    return result;
  } finally {
    clearTimeout(timer!);
    clearInterval(watchdog!);
  }
}

// ---------------------------------------------------------------------------
// Dry-run types and implementation
// ---------------------------------------------------------------------------

/** Tier cost estimates (midpoint of range in dollars). */
const TIER_COST_ESTIMATES: Record<OrchestratorTier, { low: number; high: number; mid: number }> = {
  polish:   { low: 2, high: 4,  mid: 3 },
  standard: { low: 4, high: 8,  mid: 6 },
  deep:     { low: 8, high: 18, mid: 13 },
};

/** Quality threshold above which a page is considered "already high quality". */
const HIGH_QUALITY_THRESHOLD = 80;

/** Per-page skip reason codes. */
export type SkipReason =
  | 'too-large'
  | 'unknown-page-id'
  | 'high-quality';

/** Result of a dry-run analysis for a single page. */
export interface DryRunPageResult {
  pageId: string;
  /** Whether the page would be processed (not skipped). */
  wouldRun: boolean;
  /** Reason the page would be skipped (null if it would run). */
  skipReason: SkipReason | null;
  /** Tier that would be used. */
  tier: OrchestratorTier;
  /** File size in KB (null if file not found). */
  fileSizeKB: number | null;
  /** Quality score from frontmatter (null if not set). */
  quality: number | null;
  /** Reader importance score (null if not set). */
  readerImportance: number | null;
  /** Citation count from page metrics (null if not available). */
  citationCount: number | null;
  /** Word count from page metrics (null if not available). */
  wordCount: number | null;
  /** Low-end cost estimate in dollars. */
  estimatedCostLow: number;
  /** High-end cost estimate in dollars. */
  estimatedCostHigh: number;
  /** Midpoint cost estimate used for totals. */
  estimatedCostMid: number;
}

/** Summary of a dry-run across all pages. */
export interface DryRunSummary {
  tier: OrchestratorTier;
  totalPages: number;
  wouldRun: number;
  wouldSkip: number;
  skipReasons: Partial<Record<SkipReason, number>>;
  estimatedTotalLow: number;
  estimatedTotalHigh: number;
  estimatedTotalMid: number;
  budgetLimit?: number;
  /** Whether the estimated total exceeds the budget limit. */
  overBudget: boolean;
  pages: DryRunPageResult[];
}

/**
 * Run a dry-run analysis of a batch: loads pages, computes sizes,
 * reads quality data from build artifacts, and estimates costs.
 * No API calls are made; no files are modified.
 */
export async function runBatchDryRun(options: {
  pageIds: string[];
  tier: OrchestratorTier;
  budgetLimit?: number;
  outputFile?: string;
}): Promise<DryRunSummary> {
  const { pageIds, tier, budgetLimit, outputFile } = options;
  const costEstimate = TIER_COST_ESTIMATES[tier];
  const tierBudget = TIER_BUDGETS[tier];

  console.log('\n' + '═'.repeat(70));
  console.log(`  DRY RUN — Batch Improve (V2 Orchestrator)`);
  console.log(`  Pages: ${pageIds.length} | Tier: ${tier} (${tierBudget.estimatedCost}) | Budget: ${budgetLimit ? formatCost(budgetLimit) : 'unlimited'}`);
  console.log('═'.repeat(70) + '\n');
  console.log('  Analyzing pages (no API calls, no cost)...\n');

  const pages = getCachedPages();
  const knownIds = new Set(pages.map((p: { id: string }) => p.id));

  // Build a lookup map for page metadata (cast to access quality fields)
  const pageMetaMap = new Map<string, Record<string, unknown>>();
  for (const p of pages) {
    pageMetaMap.set(p.id, p as unknown as Record<string, unknown>);
  }

  const results: DryRunPageResult[] = [];

  for (const pageId of pageIds) {
    // Check if page ID is known
    if (!knownIds.has(pageId)) {
      results.push({
        pageId,
        wouldRun: false,
        skipReason: 'unknown-page-id',
        tier,
        fileSizeKB: null,
        quality: null,
        readerImportance: null,
        citationCount: null,
        wordCount: null,
        estimatedCostLow: 0,
        estimatedCostHigh: 0,
        estimatedCostMid: 0,
      });
      continue;
    }

    // Get file size
    const fileInfo = getPageFileSize(pageId);
    const fileSizeKB = fileInfo ? Math.round(fileInfo.sizeBytes / 1024 * 10) / 10 : null;

    // Check if too large
    if (fileInfo && fileInfo.sizeBytes > MAX_PAGE_SIZE_BYTES) {
      results.push({
        pageId,
        wouldRun: false,
        skipReason: 'too-large',
        tier,
        fileSizeKB,
        quality: null,
        readerImportance: null,
        citationCount: null,
        wordCount: null,
        estimatedCostLow: 0,
        estimatedCostHigh: 0,
        estimatedCostMid: 0,
      });
      continue;
    }

    // Get quality metadata from build artifacts (no API call)
    const meta = pageMetaMap.get(pageId);
    const quality = typeof meta?.quality === 'number' ? meta.quality as number : null;
    const readerImportance = typeof meta?.readerImportance === 'number' ? meta.readerImportance as number : null;
    const metaMetrics = meta?.metrics as { footnoteCount?: number; wordCount?: number } | undefined;
    const citationCount = typeof metaMetrics?.footnoteCount === 'number' ? metaMetrics.footnoteCount : null;
    const wordCount = typeof metaMetrics?.wordCount === 'number' ? metaMetrics.wordCount
      : typeof meta?.wordCount === 'number' ? meta.wordCount as number : null;

    // Check if already high quality
    if (quality !== null && quality >= HIGH_QUALITY_THRESHOLD) {
      results.push({
        pageId,
        wouldRun: false,
        skipReason: 'high-quality',
        tier,
        fileSizeKB,
        quality,
        readerImportance: typeof readerImportance === 'number' ? readerImportance : null,
        citationCount,
        wordCount: typeof wordCount === 'number' ? wordCount : null,
        estimatedCostLow: 0,
        estimatedCostHigh: 0,
        estimatedCostMid: 0,
      });
      continue;
    }

    // Page would run — use tier cost estimates
    results.push({
      pageId,
      wouldRun: true,
      skipReason: null,
      tier,
      fileSizeKB,
      quality,
      readerImportance: typeof readerImportance === 'number' ? readerImportance : null,
      citationCount,
      wordCount: typeof wordCount === 'number' ? wordCount : null,
      estimatedCostLow: costEstimate.low,
      estimatedCostHigh: costEstimate.high,
      estimatedCostMid: costEstimate.mid,
    });
  }

  // Compute summary
  const wouldRunResults = results.filter(r => r.wouldRun);
  const wouldSkipResults = results.filter(r => !r.wouldRun);
  const skipReasons: Partial<Record<SkipReason, number>> = {};
  for (const r of wouldSkipResults) {
    if (r.skipReason) {
      skipReasons[r.skipReason] = (skipReasons[r.skipReason] ?? 0) + 1;
    }
  }

  const estimatedTotalLow = wouldRunResults.reduce((sum, r) => sum + r.estimatedCostLow, 0);
  const estimatedTotalHigh = wouldRunResults.reduce((sum, r) => sum + r.estimatedCostHigh, 0);
  const estimatedTotalMid = wouldRunResults.reduce((sum, r) => sum + r.estimatedCostMid, 0);
  const overBudget = budgetLimit != null && estimatedTotalMid > budgetLimit;

  const summary: DryRunSummary = {
    tier,
    totalPages: results.length,
    wouldRun: wouldRunResults.length,
    wouldSkip: wouldSkipResults.length,
    skipReasons,
    estimatedTotalLow,
    estimatedTotalHigh,
    estimatedTotalMid,
    budgetLimit,
    overBudget,
    pages: results,
  };

  // Print the table
  printDryRunTable(summary);

  // Write JSON output if requested
  if (outputFile) {
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(summary, null, 2));
    console.log(`\n  Plan written to: ${outputFile}`);
  }

  return summary;
}

/** Print a formatted dry-run table to stdout. */
function printDryRunTable(summary: DryRunSummary): void {
  const { pages, tier, budgetLimit, overBudget } = summary;

  // Header
  console.log('─'.repeat(100));
  console.log(
    '  ' +
    'Page ID'.padEnd(40) +
    'Status'.padEnd(10) +
    'Quality'.padEnd(9) +
    'Importance'.padEnd(11) +
    'Words'.padEnd(8) +
    'Size(KB)'.padEnd(10) +
    'Est. Cost'
  );
  console.log('─'.repeat(100));

  // Rows — would-run pages first, then skipped
  const sorted = [
    ...pages.filter(p => p.wouldRun),
    ...pages.filter(p => !p.wouldRun),
  ];

  for (const p of sorted) {
    const status = p.wouldRun
      ? 'RUN'
      : p.skipReason === 'too-large' ? 'SKIP(size)'
      : p.skipReason === 'high-quality' ? 'SKIP(qual)'
      : p.skipReason === 'unknown-page-id' ? 'SKIP(404)'
      : 'SKIP';

    const quality = p.quality != null ? String(p.quality) : '-';
    const importance = p.readerImportance != null ? String(p.readerImportance) : '-';
    const words = p.wordCount != null ? String(p.wordCount) : '-';
    const size = p.fileSizeKB != null ? String(p.fileSizeKB) : '-';
    const cost = p.wouldRun
      ? `$${p.estimatedCostLow}-${p.estimatedCostHigh}`
      : '-';

    console.log(
      '  ' +
      p.pageId.slice(0, 38).padEnd(40) +
      status.padEnd(10) +
      quality.padEnd(9) +
      importance.padEnd(11) +
      words.padEnd(8) +
      size.padEnd(10) +
      cost
    );
  }

  console.log('─'.repeat(100));

  // Summary
  console.log('');
  console.log(`  Tier: ${tier} (${TIER_BUDGETS[tier].estimatedCost})`);
  console.log(`  Pages: ${summary.totalPages} total | ${summary.wouldRun} would run | ${summary.wouldSkip} would skip`);

  if (summary.wouldSkip > 0) {
    const reasons = Object.entries(summary.skipReasons)
      .map(([r, n]) => `${n} ${r}`)
      .join(', ');
    console.log(`  Skip reasons: ${reasons}`);
  }

  const costRange = summary.wouldRun > 0
    ? `$${summary.estimatedTotalLow.toFixed(0)}-$${summary.estimatedTotalHigh.toFixed(0)} (mid: $${summary.estimatedTotalMid.toFixed(0)})`
    : '$0';
  console.log(`  Estimated total cost: ${costRange}`);

  if (budgetLimit != null) {
    const pct = Math.round((summary.estimatedTotalMid / budgetLimit) * 100);
    const budgetMsg = overBudget
      ? `  ⚠ OVER BUDGET: estimated $${summary.estimatedTotalMid.toFixed(0)} vs limit $${budgetLimit.toFixed(0)} (${pct}%)`
      : `  Budget: $${summary.estimatedTotalMid.toFixed(0)} / $${budgetLimit.toFixed(0)} (${pct}%)`;
    console.log(budgetMsg);
  }

  console.log('');
  console.log('  NOTE: Costs are estimates based on tier ranges. Actual costs may vary.');
  console.log('  Add --apply to run the batch (or remove --dry-run).');
  console.log('═'.repeat(70));
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return mins > 0 ? `${mins}m${remainSecs}s` : `${remainSecs}s`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Main batch runner
// ---------------------------------------------------------------------------

export async function runBatch(options: BatchOptions): Promise<PageResult[]> {
  const {
    pageIds,
    tier,
    directions,
    budgetLimit,
    pageTimeout = 15 * 60 * 1000, // 15 min default
    resume = false,
    apply = false,
    grade,
    skipSessionLog,
    reportFile,
    qualityReportFile,
  } = options;

  const total = pageIds.length;
  const results: PageResult[] = [];
  let cumulativeCost = 0;
  const batchStartTime = Date.now();

  // Quality tracking: pre/post snapshots per page
  const preSnapshots = new Map<string, PageQualitySnapshot>();
  const postSnapshots = new Map<string, PageQualitySnapshot>();

  // ── Load or create state ────────────────────────────────────────────────

  let state: BatchState;
  if (resume) {
    const existing = loadState();
    if (existing) {
      state = existing;
      log('batch', `Resuming batch (${Object.keys(state.completedPages).length} pages already done)`);
      // Carry forward cumulative cost from previous run
      for (const result of Object.values(state.completedPages)) {
        if (result.cost) cumulativeCost += result.cost;
      }
    } else {
      log('batch', 'No previous batch state found — starting fresh');
      state = {
        startedAt: new Date().toISOString(),
        tier,
        totalBudget: budgetLimit ?? null,
        completedPages: {},
      };
    }
  } else {
    state = {
      startedAt: new Date().toISOString(),
      tier,
      totalBudget: budgetLimit ?? null,
      completedPages: {},
    };
  }

  // ── Validate page IDs ───────────────────────────────────────────────────

  if (total === 0) {
    log('batch', '⚠ No page IDs provided — nothing to do. Check --batch or --batch-file args.');
    return [];
  }

  const pages = getCachedPages();
  const knownIds = new Set(pages.map((p: { id: string }) => p.id));
  const unknownIds = pageIds.filter(id => !knownIds.has(id));
  if (unknownIds.length > 0) {
    log('batch', `⚠ ${unknownIds.length} unknown page ID(s) will be skipped: ${unknownIds.join(', ')}`);
  }

  // ── Header ──────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(70));
  console.log(`  BATCH IMPROVE (V2 Orchestrator)`);
  console.log(`  Pages: ${total} | Tier: ${tier} | Budget: ${budgetLimit ? formatCost(budgetLimit) : 'unlimited'}`);
  if (directions) console.log(`  Directions: ${directions}`);
  console.log('═'.repeat(70) + '\n');

  // ── Process each page ───────────────────────────────────────────────────

  for (let i = 0; i < total; i++) {
    const pageId = pageIds[i];
    const pageNum = i + 1;

    // Skip if already completed in a previous run
    if (state.completedPages[pageId]?.status === 'completed') {
      log('batch', `[${pageNum}/${total}] ${pageId}... skipped (already done)`);
      results.push(state.completedPages[pageId]);
      continue;
    }

    // Skip unknown pages early (validated above)
    if (!knownIds.has(pageId)) {
      log('batch', `[${pageNum}/${total}] ${pageId}... skipped (unknown page ID)`);
      results.push({ pageId, status: 'skipped', error: 'Unknown page ID' });
      continue;
    }

    // Check budget before starting
    if (budgetLimit && cumulativeCost >= budgetLimit) {
      log('batch', `[${pageNum}/${total}] ${pageId}... skipped (budget exhausted: ${formatCost(cumulativeCost)}/${formatCost(budgetLimit)})`);
      const budgetResult: PageResult = {
        pageId,
        status: 'budget-exceeded',
      };
      results.push(budgetResult);
      state.completedPages[pageId] = budgetResult;
      saveState(state);
      continue;
    }

    // Warn when approaching budget limit (within 90%)
    if (budgetLimit && cumulativeCost >= budgetLimit * 0.9) {
      log('batch', `⚠ Budget ${Math.round((cumulativeCost / budgetLimit) * 100)}% used (${formatCost(cumulativeCost)}/${formatCost(budgetLimit)}) — next page may cause overage`);
    }

    // Large pages get a shorter timeout since they're more likely to stall
    // due to event loop starvation from sync regex work in enrich-entity-links.
    const pageFile = getPageFileSize(pageId);
    let effectiveTimeout = pageTimeout;
    if (pageFile && pageFile.sizeBytes > MAX_PAGE_SIZE_BYTES) {
      const sizeKB = Math.round(pageFile.sizeBytes / 1024);
      effectiveTimeout = Math.min(pageTimeout, 5 * 60 * 1000); // cap at 5 min for large pages
      log('batch', `[${pageNum}/${total}] ${pageId} is large (${sizeKB}KB) — using ${Math.round(effectiveTimeout / 1000)}s timeout`);
    }

    const pageStart = Date.now();
    log('batch', `[${pageNum}/${total}] Improving ${pageId}...`);

    // Snapshot pre-improvement metrics
    if (pageFile) {
      const pre = snapshotFromFile(pageFile.filePath);
      if (pre) preSnapshots.set(pageId, pre);
    }

    try {
      const orchResult: OrchestratorResult = await withTimeout(
        (signal) => {
          const orchOpts: OrchestratorOptions = {
            tier,
            directions: directions || '',
            dryRun: !apply,
            grade: grade,
            skipSessionLog: skipSessionLog,
            signal,
          };
          return runOrchestratorPipeline(pageId, orchOpts);
        },
        effectiveTimeout,
        `Page ${pageId}`,
      );

      const pageDuration = Date.now() - pageStart;
      // Prefer actual cost for budget tracking when available
      const effectiveCost = orchResult.actualTotalCost ?? orchResult.totalCost;
      cumulativeCost += effectiveCost;

      // Snapshot post-improvement metrics (re-read file after apply)
      if (pageFile && apply) {
        const post = snapshotFromFile(pageFile.filePath);
        if (post) postSnapshots.set(pageId, post);
      }

      const pageResult: PageResult = {
        pageId,
        status: 'completed',
        duration: formatDuration(pageDuration),
        cost: orchResult.totalCost,
        actualCost: orchResult.actualTotalCost ?? undefined,
        qualityGatePassed: orchResult.qualityGatePassed,
        toolCallCount: orchResult.toolCallCount,
      };

      results.push(pageResult);
      state.completedPages[pageId] = pageResult;
      saveState(state);

      log('batch',
        `[${pageNum}/${total}] ${pageId}... done ` +
        `(${formatCost(orchResult.totalCost)}, ${formatDuration(pageDuration)}, ` +
        `gate: ${orchResult.qualityGatePassed ? 'PASS' : 'FAIL'}) | ` +
        `Total: ${formatCost(cumulativeCost)}`
      );

    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const pageDuration = Date.now() - pageStart;
      const isTimeout = error.message.includes('timed out');

      const pageResult: PageResult = {
        pageId,
        status: isTimeout ? 'timeout' : 'failed',
        duration: formatDuration(pageDuration),
        error: error.message.slice(0, 200),
      };

      results.push(pageResult);
      state.completedPages[pageId] = pageResult;
      saveState(state);

      log('batch',
        `[${pageNum}/${total}] ${pageId}... ${isTimeout ? 'TIMEOUT' : 'FAILED'} ` +
        `(${formatDuration(pageDuration)}): ${error.message.slice(0, 100)}`
      );
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  const batchDuration = Date.now() - batchStartTime;
  const completed = results.filter(r => r.status === 'completed');
  const failed = results.filter(r => r.status === 'failed');
  const timedOut = results.filter(r => r.status === 'timeout');
  const skipped = results.filter(r => r.status === 'skipped' || r.status === 'budget-exceeded');
  const gatesPassed = completed.filter(r => r.qualityGatePassed);

  const report = generateReport({
    results,
    tier,
    budgetLimit,
    cumulativeCost,
    batchDuration,
    completed,
    failed,
    timedOut,
    skipped,
    gatesPassed,
  });

  console.log(report);

  if (reportFile) {
    const reportDir = path.dirname(reportFile);
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(reportFile, report);
    log('batch', `Report written to ${reportFile}`);
  }

  // ── Quality report ─────────────────────────────────────────────────────

  if (apply && preSnapshots.size > 0) {
    const deltas: PageQualityDelta[] = [];
    for (const [pageId, pre] of preSnapshots) {
      const post = postSnapshots.get(pageId);
      if (post) {
        deltas.push(computeDelta(pageId, pre, post));
      }
    }

    if (deltas.length > 0) {
      const qualityReport = generateQualityReport(deltas, {
        tier,
        totalCost: cumulativeCost,
        totalDuration: formatDuration(batchDuration),
      });

      // Write JSON report
      const jsonPath = qualityReportFile || path.join(ROOT, '.claude/temp/batch-quality-report.json');
      writeJsonReport(qualityReport, jsonPath);
      log('batch', `Quality report (JSON): ${jsonPath}`);

      // Write markdown report alongside JSON
      const mdPath = jsonPath.endsWith('.json')
        ? jsonPath.replace(/\.json$/, '.md')
        : jsonPath + '.md';
      const mdReport = formatMarkdownReport(qualityReport);
      const mdDir = path.dirname(mdPath);
      if (!fs.existsSync(mdDir)) fs.mkdirSync(mdDir, { recursive: true });
      fs.writeFileSync(mdPath, mdReport);
      log('batch', `Quality report (MD): ${mdPath}`);

      // Print quality summary to console
      const { summary } = qualityReport;
      console.log('');
      console.log('─'.repeat(70));
      console.log('  QUALITY REPORT');
      console.log('─'.repeat(70));
      console.log(`  Pages analyzed: ${summary.totalPages}`);
      console.log(`  Improved: ${summary.pagesImproved} | Unchanged: ${summary.pagesUnchanged} | Degraded: ${summary.pagesDegraded}`);
      console.log(`  Avg word count change: ${summary.averageWordCountChange > 0 ? '+' : ''}${summary.averageWordCountChange}`);
      console.log(`  New citations: +${summary.totalNewCitations} | New tables: +${summary.totalNewTables} | New diagrams: +${summary.totalNewDiagrams}`);
      console.log(`  Avg structural score change: ${summary.averageStructuralScoreChange > 0 ? '+' : ''}${summary.averageStructuralScoreChange}`);

      if (qualityReport.flaggedForReview.length > 0) {
        console.log('');
        console.log(`  ⚠ ${qualityReport.flaggedForReview.length} page(s) flagged for manual review:`);
        for (const pageId of qualityReport.flaggedForReview) {
          const d = deltas.find(dd => dd.pageId === pageId);
          if (d) {
            console.log(`    - ${pageId}: ${d.degradationReasons.join('; ')}`);
          }
        }
      }
      console.log('─'.repeat(70));
    }
  }

  // Write cost-analysis.json with per-page breakdowns
  const costAnalysisPath = path.join(ROOT, '.claude/temp/cost-analysis.json');
  const costAnalysis = {
    generatedAt: new Date().toISOString(),
    tier,
    budgetLimit: budgetLimit ?? null,
    totals: {
      estimatedCost: results.reduce((sum, r) => sum + (r.cost ?? 0), 0),
      actualCost: results.reduce((sum, r) => sum + (r.actualCost ?? 0), 0),
      pages: results.length,
      completed: completed.length,
    },
    pages: results.map(r => ({
      pageId: r.pageId,
      status: r.status,
      estimatedCost: r.cost ?? null,
      actualCost: r.actualCost ?? null,
      duration: r.duration ?? null,
      toolCallCount: r.toolCallCount ?? null,
    })),
  };
  try {
    const costDir = path.dirname(costAnalysisPath);
    if (!fs.existsSync(costDir)) fs.mkdirSync(costDir, { recursive: true });
    fs.writeFileSync(costAnalysisPath, JSON.stringify(costAnalysis, null, 2));
    log('batch', `Cost analysis written to ${costAnalysisPath}`);
  } catch {
    // Non-critical — don't fail the batch
  }

  // Clean up state file on successful full completion (no failures)
  if (failed.length === 0 && timedOut.length === 0 && skipped.filter(r => r.status === 'budget-exceeded').length === 0) {
    try { fs.unlinkSync(STATE_FILE); } catch { /* ok */ }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

interface ReportData {
  results: PageResult[];
  tier: string;
  budgetLimit?: number;
  cumulativeCost: number;
  batchDuration: number;
  completed: PageResult[];
  failed: PageResult[];
  timedOut: PageResult[];
  skipped: PageResult[];
  gatesPassed: PageResult[];
}

function generateReport(data: ReportData): string {
  const {
    results, tier, budgetLimit, cumulativeCost, batchDuration,
    completed, failed, timedOut, skipped, gatesPassed,
  } = data;

  const lines: string[] = [];
  lines.push('');
  lines.push('═'.repeat(70));
  lines.push('  BATCH SUMMARY');
  lines.push('═'.repeat(70));
  lines.push(`  Tier: ${tier}`);
  lines.push(`  Duration: ${formatDuration(batchDuration)}`);
  lines.push(`  Total cost: ${formatCost(cumulativeCost)}${budgetLimit ? ` / ${formatCost(budgetLimit)}` : ''}`);
  lines.push(`  Pages: ${results.length} total, ${completed.length} completed, ${failed.length} failed, ${timedOut.length} timed out, ${skipped.length} skipped`);
  lines.push(`  Quality gate: ${gatesPassed.length}/${completed.length} passed`);
  lines.push('');

  // Check if any results have actual costs
  const hasActualCosts = results.some(r => r.actualCost != null);

  // Results table
  if (hasActualCosts) {
    lines.push('| # | Page | Status | Est. | Actual | Duration | Gate | Tool Calls |');
    lines.push('|---|------|--------|------|--------|----------|------|------------|');
  } else {
    lines.push('| # | Page | Status | Cost | Duration | Gate | Tool Calls |');
    lines.push('|---|------|--------|------|----------|------|------------|');
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.status === 'completed' ? 'OK' :
                   r.status === 'failed' ? 'FAIL' :
                   r.status === 'timeout' ? 'TIMEOUT' :
                   r.status === 'budget-exceeded' ? 'BUDGET' : 'SKIP';
    const cost = r.cost ? formatCost(r.cost) : '-';
    const actualCost = r.actualCost != null ? formatCost(r.actualCost) : '-';
    const dur = r.duration || '-';
    const gate = r.qualityGatePassed === undefined ? '-' :
                 r.qualityGatePassed ? 'PASS' : 'FAIL';
    const tools = r.toolCallCount ?? '-';
    if (hasActualCosts) {
      lines.push(`| ${i + 1} | ${r.pageId} | ${status} | ${cost} | ${actualCost} | ${dur} | ${gate} | ${tools} |`);
    } else {
      lines.push(`| ${i + 1} | ${r.pageId} | ${status} | ${cost} | ${dur} | ${gate} | ${tools} |`);
    }
  }

  // Failures detail
  if (failed.length > 0 || timedOut.length > 0) {
    lines.push('');
    lines.push('Failures:');
    for (const r of [...failed, ...timedOut]) {
      lines.push(`  - ${r.pageId}: ${r.error || 'unknown error'}`);
    }
  }

  lines.push('');
  lines.push('═'.repeat(70));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/**
 * Parse batch page IDs from CLI args.
 * Supports: --batch=page1,page2,page3 or --batch-file=pages.txt
 */
export function parseBatchPageIds(batchArg?: string, batchFileArg?: string): string[] {
  if (batchFileArg) {
    const filePath = path.resolve(batchFileArg);
    if (!fs.existsSync(filePath)) {
      console.error(`Batch file not found: ${filePath}`);
      process.exit(1);
    }
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  }

  if (batchArg) {
    return batchArg.split(',').map(id => id.trim()).filter(Boolean);
  }

  return [];
}
