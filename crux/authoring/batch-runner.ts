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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const STATE_FILE = path.join(ROOT, '.claude/temp/batch-state.json');

const log = createPhaseLogger();

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
// Timeout wrapper
// ---------------------------------------------------------------------------

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
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
  } = options;

  const total = pageIds.length;
  const results: PageResult[] = [];
  let cumulativeCost = 0;
  const batchStartTime = Date.now();

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

    const pageStart = Date.now();
    log('batch', `[${pageNum}/${total}] Improving ${pageId}...`);

    try {
      const orchOpts: OrchestratorOptions = {
        tier,
        directions: directions || '',
        dryRun: !apply,
        grade: grade,
        skipSessionLog: skipSessionLog,
      };

      const orchResult: OrchestratorResult = await withTimeout(
        runOrchestratorPipeline(pageId, orchOpts),
        pageTimeout,
        `Page ${pageId}`,
      );

      const pageDuration = Date.now() - pageStart;
      cumulativeCost += orchResult.totalCost;

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
