/**
 * Job Handler Registry
 *
 * Maps job type strings to handler functions. The worker runner uses this
 * to dispatch claimed jobs to the correct handler.
 *
 * Each handler receives job params and a context object, and returns a
 * JobHandlerResult with success/failure status and result data.
 *
 * Handlers are loaded lazily (on first dispatch) to avoid pulling in heavy
 * dependencies (Anthropic SDK, dotenv, etc.) at module evaluation time.
 * This prevents ESM/CJS circular dependency errors on Node 22, where
 * require(esm) cycle detection is strict.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { JobHandler } from './types.ts';

// Async (non-blocking) child execution. We deliberately avoid execFileSync:
// the worker is a single Node process that also serves the /healthz liveness
// endpoint, and a synchronous spawn blocks the event loop for the whole job.
// On a multi-minute job that starves /healthz, Kubernetes' liveness probe
// fails and restarts the pod mid-job (the job is then re-claimed and
// eventually exhausts its retries). promisify(execFile) keeps the event loop
// free so /healthz keeps answering. On non-zero exit the returned promise
// rejects with an Error carrying .stdout/.stderr.
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Lazy handler loaders — each returns the handler on first call, then caches
// ---------------------------------------------------------------------------

function lazyHandler(loader: () => Promise<JobHandler>): JobHandler {
  let cached: JobHandler | undefined;
  return async (params, ctx) => {
    if (!cached) {
      cached = await loader();
    }
    return cached(params, ctx);
  };
}

// ---------------------------------------------------------------------------
// Handler Registry
// ---------------------------------------------------------------------------

const handlers: Record<string, JobHandler> = {
  // Simple handlers (no heavy deps — defined inline)
  ping: async (_params, ctx) => {
    return {
      success: true,
      data: { ok: true, worker: ctx.workerId, timestamp: new Date().toISOString() },
    };
  },

  'citation-verify': async (params, ctx) => {
    const pageId = params.pageId as string | undefined;
    if (!pageId) {
      return { success: false, data: {}, error: 'Missing required param: pageId' };
    }

    try {
      const { stdout: output } = await execFileAsync('node', [
        '--import', 'tsx/esm', '--no-warnings',
        'crux/crux.mjs', 'citations', 'verify', pageId, '--json',
      ], {
        cwd: ctx.projectRoot,
        encoding: 'utf-8',
        timeout: 5 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      });

      try {
        const result = JSON.parse(output);
        return { success: true, data: result };
      } catch {
        return { success: true, data: { output } };
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, data: { pageId }, error: error.slice(0, 500) };
    }
  },

  'backfill-sources': async (params, ctx) => {
    const limit = typeof params.limit === 'number' ? String(params.limit) : '100';
    const maxCost =
      typeof params.maxCost === 'number' ? String(params.maxCost) : '5';
    const args = [
      '--import',
      'tsx/esm',
      '--no-warnings',
      'crux/crux.mjs',
      'tb',
      'backfill-sources',
      '--apply',
      `--limit=${limit}`,
      `--max-cost=${maxCost}`,
    ];
    if (typeof params.table === 'string' && params.table.length > 0) {
      args.push(`--table=${params.table}`);
    }

    try {
      const { stdout: output } = await execFileAsync('node', args, {
        cwd: ctx.projectRoot,
        encoding: 'utf-8',
        timeout: 60 * 60 * 1000, // 1h — full prod sweep is ~30-50 min
        maxBuffer: 16 * 1024 * 1024,
      });

      // Tail of stdout is enough to summarise outcomes; the full report is
      // written to backfill-unmatched-*.json in the OS temp dir on the worker
      // pod (override with --unmatched-out).
      const tail = output.slice(-2000);
      return { success: true, data: { limit, maxCost, table: params.table ?? null, output: tail } };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: { limit, maxCost, table: params.table ?? null },
        error: error.slice(0, 500),
      };
    }
  },

  // Content-modifying handlers (lazy — depend on full monorepo)
  'page-improve': lazyHandler(async () =>
    (await import('./page-improve.ts')).handlePageImprove),
  'page-create': lazyHandler(async () =>
    (await import('./page-create.ts')).handlePageCreate),

  // Batch orchestration
  'batch-commit': lazyHandler(async () =>
    (await import('./batch-commit.ts')).handleBatchCommit),

  // Auto-update pipeline
  'auto-update-digest': lazyHandler(async () =>
    (await import('./auto-update-digest.ts')).handleAutoUpdateDigest),

  // Claims-first sourcing (#3253) — lazy to avoid Anthropic SDK cycle
  'claim-sourcing': lazyHandler(async () =>
    (await import('./claim-sourcing.ts')).handleClaimSourcing),

  // Resource ingestion: fetch, cache content, persist metadata (#3209)
  'resource-ingest': lazyHandler(async () =>
    (await import('./resource-ingest.ts')).handleResourceIngest),

  // Per-resource LLM enrichment (#3499) — lazy to avoid Anthropic SDK cycle
  'resource-enrich': lazyHandler(async () =>
    (await import('./resource-enrich.ts')).handleResourceEnrich),

  // Legacy alias: resource-verify → resource-ingest
  'resource-verify': lazyHandler(async () =>
    (await import('./resource-ingest.ts')).handleResourceIngest),
};

/**
 * Get the handler for a job type.
 * Returns undefined if no handler is registered for the type.
 */
export function getHandler(type: string): JobHandler | undefined {
  return handlers[type];
}

/**
 * Get all registered job type names.
 */
export function getRegisteredTypes(): string[] {
  return Object.keys(handlers);
}

/**
 * Check if a job type has a registered handler.
 */
export function isKnownType(type: string): boolean {
  return type in handlers;
}

export type { JobHandler, JobHandlerResult, JobHandlerContext } from './types.ts';
