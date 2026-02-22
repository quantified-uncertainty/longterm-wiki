/**
 * Job Handler Registry
 *
 * Maps job type strings to handler functions. The worker runner uses this
 * to dispatch claimed jobs to the correct handler.
 *
 * Each handler receives job params and a context object, and returns a
 * JobHandlerResult with success/failure status and result data.
 */

import { execFileSync } from 'child_process';
import type { JobHandler } from './types.ts';
import { handlePageImprove } from './page-improve.ts';
import { handlePageCreate } from './page-create.ts';
import { handleBatchCommit } from './batch-commit.ts';
import { handleAutoUpdateDigest } from './auto-update-digest.ts';

// ---------------------------------------------------------------------------
// Handler Registry
// ---------------------------------------------------------------------------

const handlers: Record<string, JobHandler> = {
  // Simple handlers
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

  // Content-modifying handlers
  'page-improve': handlePageImprove,
  'page-create': handlePageCreate,

  // Batch orchestration
  'batch-commit': handleBatchCommit,

  // Auto-update pipeline
  'auto-update-digest': handleAutoUpdateDigest,
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
