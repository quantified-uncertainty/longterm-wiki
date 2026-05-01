/**
 * withPipelineRun — lifecycle wrapper for pipeline executions (QUA-954).
 *
 * Wraps a pipeline body so the run is registered in `pipeline_runs`
 * before it begins, heartbeated every 30s while it's running, and
 * finalized with status + error context regardless of how it exits.
 *
 * ## Behavior
 *
 * - **Fail-closed by default**: if the wiki-server `/start` call fails,
 *   we throw — the body never runs and the caller exits non-zero. This
 *   prevents silent skip of the audit trail.
 * - **`allowOffline: true`**: degrades to a no-op `runCtx`. Used by
 *   genuinely-offline scenarios (early-init scripts, agent slots before
 *   the prod URL is known). Logs a warning.
 * - **Heartbeat**: a `setInterval` from inside the helper (NOT just
 *   on entry/exit) bumps `heartbeat_at` every 30s while the body
 *   runs, including during long polling loops. Fixes red-team finding
 *   R-B9 from the QUA-954 spec.
 * - **End status mapping**:
 *   - body resolves: `committed` (default; caller can override via
 *     `runCtx.markStatus`).
 *   - body throws: `aborted`, with `errorCode` derived from the error
 *     name and `errorPayload` capturing the message + stack.
 *
 * ## Usage
 *
 * ```ts
 * import { withPipelineRun } from 'crux/lib/pipeline-runs/lifecycle.ts';
 *
 * await withPipelineRun(
 *   { pipelineName: 'improve-page', entityId: 'E42', shape: 'standard' },
 *   async (run) => {
 *     // ... do work, optionally:
 *     run.markFollowup({ kind: 'retry', attempt: 1 });
 *     run.markStatus('partial_failure', { reason: 'phase2_abort' });
 *   },
 * );
 * ```
 */

import { randomUUID } from 'crypto';
import {
  startPipelineRun,
  heartbeatPipelineRun,
  endPipelineRun,
  type PipelineRunEndStatus,
} from '../wiki-server/pipeline-runs.ts';

// Crux libs log via console (validate-no-console-log only blocks server
// code under apps/wiki-server). Structured fields are stringified into
// the message body so dashboards can grep for runId / pipelineName.
function warn(message: string, fields: Record<string, unknown>): void {
  console.warn(`[pipeline-runs] ${message} ${JSON.stringify(fields)}`);
}

function error(message: string, fields: Record<string, unknown>): void {
  console.error(`[pipeline-runs] ${message} ${JSON.stringify(fields)}`);
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface WithPipelineRunOptions {
  pipelineName: string;
  entityId?: string | null;
  shape?: string | null;
  agentSessionId?: number | null;
  /** When true, fall back to a no-op runCtx if /start fails. Default false. */
  allowOffline?: boolean;
  /** Override the heartbeat interval (ms). Test-only. */
  heartbeatIntervalMs?: number;
}

export interface PipelineRunCtx {
  /** The minted run id. Stable for the lifetime of the run. */
  runId: string;
  /** Mark a non-default end status (overrides the success-→committed default). */
  markStatus(status: PipelineRunEndStatus, info?: { reason?: string; errorCode?: string }): void;
  /** Append an entry to followup_actions (written on end). */
  markFollowup(action: Record<string, unknown>): void;
  /** True when the lifecycle is operating offline (no-op mode). */
  readonly offline: boolean;
}

/**
 * Run `body(ctx)` inside a registered pipeline_run lifecycle.
 *
 * Re-throws any error thrown by `body` after recording the abort. The
 * caller still gets the original exception; the audit trail is a
 * side-effect.
 */
export async function withPipelineRun<T>(
  options: WithPipelineRunOptions,
  body: (ctx: PipelineRunCtx) => Promise<T>,
): Promise<T> {
  const runId = randomUUID();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

  // Start the run. Fail-closed by default.
  const startResult = await startPipelineRun({
    runId,
    pipelineName: options.pipelineName,
    entityId: options.entityId ?? null,
    shape: options.shape ?? null,
    agentSessionId: options.agentSessionId ?? null,
  });

  if (!startResult.ok) {
    if (options.allowOffline) {
      warn('withPipelineRun: /start failed; running offline (allowOffline=true)', {
        runId,
        pipelineName: options.pipelineName,
        err: startResult.message,
      });
      return body(makeOfflineCtx(runId));
    }

    throw new Error(
      `withPipelineRun: failed to register run for pipeline=${options.pipelineName} runId=${runId}: ${startResult.message}`,
    );
  }

  // Mutable end-state — body callbacks can override.
  let overrideStatus: PipelineRunEndStatus | null = null;
  let overrideReason: string | null = null;
  let overrideErrorCode: string | null = null;
  const followups: Array<Record<string, unknown>> = [];

  const ctx: PipelineRunCtx = {
    runId,
    offline: false,
    markStatus(status, info) {
      overrideStatus = status;
      if (info?.reason !== undefined) overrideReason = info.reason;
      if (info?.errorCode !== undefined) overrideErrorCode = info.errorCode;
    },
    markFollowup(action) {
      followups.push(action);
    },
  };

  // Heartbeat timer — fires on a fixed interval regardless of whether
  // the body is awaiting a long network call. Errors are best-effort:
  // a failed heartbeat doesn't kill the body, but we log so silent
  // outages are visible.
  const heartbeatTimer = setInterval(() => {
    void heartbeatPipelineRun(runId).then(
      (res) => {
        if (!res.ok) {
          warn('withPipelineRun: heartbeat failed (non-fatal)', {
            runId,
            pipelineName: options.pipelineName,
            err: res.message,
          });
        }
      },
      (err: unknown) => {
        warn('withPipelineRun: heartbeat threw (non-fatal)', {
          runId,
          pipelineName: options.pipelineName,
          err: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }, heartbeatIntervalMs);
  // Don't keep the event loop alive on the heartbeat alone — if the
  // body returns and the end call is in flight, we still want the
  // process to be able to exit.
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  try {
    const result = await body(ctx);
    clearInterval(heartbeatTimer);
    await finalize({
      runId,
      pipelineName: options.pipelineName,
      status: overrideStatus ?? 'committed',
      failureReason: overrideReason,
      errorCode: overrideErrorCode,
      errorPayload: null,
      followups,
    });
    return result;
  } catch (err: unknown) {
    clearInterval(heartbeatTimer);
    await finalize({
      runId,
      pipelineName: options.pipelineName,
      // overrideStatus wins so a body that did `markStatus('partial_failure')`
      // and then threw still records the more specific status.
      status: overrideStatus ?? 'aborted',
      failureReason: overrideReason ?? errorReason(err),
      errorCode: overrideErrorCode ?? errorCodeFor(err),
      errorPayload: errorPayload(err),
      followups,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function makeOfflineCtx(runId: string): PipelineRunCtx {
  return {
    runId,
    offline: true,
    markStatus: () => {},
    markFollowup: () => {},
  };
}

interface FinalizeArgs {
  runId: string;
  pipelineName: string;
  status: PipelineRunEndStatus;
  failureReason: string | null;
  errorCode: string | null;
  errorPayload: Record<string, unknown> | null;
  followups: Array<Record<string, unknown>>;
}

async function finalize(args: FinalizeArgs): Promise<void> {
  const result = await endPipelineRun(args.runId, {
    status: args.status,
    failureReason: args.failureReason,
    errorCode: args.errorCode,
    errorPayload: args.errorPayload,
    followupActions: args.followups,
  });
  if (!result.ok) {
    // End-call failure is non-fatal: we already swallowed the body's
    // result/exception above and the caller is past their try-block.
    // Log loudly so audit-trail loss is detectable.
    error(
      'withPipelineRun: /end failed — pipeline_runs row will linger as `running`',
      {
        runId: args.runId,
        pipelineName: args.pipelineName,
        err: result.message,
        attemptedStatus: args.status,
      },
    );
  }
}

function errorCodeFor(err: unknown): string | null {
  if (err instanceof Error) {
    return err.name || 'Error';
  }
  return null;
}

function errorReason(err: unknown): string | null {
  if (err instanceof Error) {
    // Cap to something sane for the failure_reason text column.
    return err.message.slice(0, 200);
  }
  return null;
}

function errorPayload(err: unknown): Record<string, unknown> | null {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 20).join('\n'),
    };
  }
  return { value: String(err) };
}
