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
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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
      cumulativeCost += orchResult.totalCost;

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

  // Results table
  lines.push('| # | Page | Status | Cost | Duration | Gate | Tool Calls |');
  lines.push('|---|------|--------|------|----------|------|------------|');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.status === 'completed' ? 'OK' :
                   r.status === 'failed' ? 'FAIL' :
                   r.status === 'timeout' ? 'TIMEOUT' :
                   r.status === 'budget-exceeded' ? 'BUDGET' : 'SKIP';
    const cost = r.cost ? formatCost(r.cost) : '-';
    const dur = r.duration || '-';
    const gate = r.qualityGatePassed === undefined ? '-' :
                 r.qualityGatePassed ? 'PASS' : 'FAIL';
    const tools = r.toolCallCount ?? '-';
    lines.push(`| ${i + 1} | ${r.pageId} | ${status} | ${cost} | ${dur} | ${gate} | ${tools} |`);
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
