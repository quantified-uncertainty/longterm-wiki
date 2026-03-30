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

import { execFileSync } from 'child_process';
import type { JobHandler } from './types.ts';

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
      const output = execFileSync('node', [
        '--import', 'tsx/esm', '--no-warnings',
        'crux/crux.mjs', 'citations', 'verify', pageId, '--json',
      ], {
        cwd: ctx.projectRoot,
        encoding: 'utf-8',
        timeout: 5 * 60 * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
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

  // Claims-first verification (#3253) — lazy to avoid Anthropic SDK cycle
  'claim-verification': lazyHandler(async () =>
    (await import('./claim-verification.ts')).handleClaimVerification),

  // Resource URL liveness checking (#3209) — lazy for consistency
  'resource-verify': lazyHandler(async () =>
    (await import('./resource-verify.ts')).handleResourceVerify),

  // Per-resource LLM enrichment (#3499) — lazy to avoid Anthropic SDK cycle
  'resource-enrich': lazyHandler(async () =>
    (await import('./resource-enrich.ts')).handleResourceEnrich),
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
