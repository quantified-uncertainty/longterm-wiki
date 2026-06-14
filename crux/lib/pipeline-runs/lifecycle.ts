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
import { CostTracker } from '../cost-tracker.ts';
import { runWithAmbientTracker } from '../llm-usage/ambient-tracker.ts';
import { getCachedAuditSessionId } from '../wiki-server/audit-context.ts';
import { parseAgentSessionId } from './agent-session-id.ts';

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
  /**
   * Optional CostTracker. When provided, totals are snapshotted after
   * the body returns/throws and forwarded to the /end call so the
   * pipeline_runs row records cost + token spend (QUA-1013 / QUA-1038).
   *
   * `allowOffline + tracker`: if `/start` fails and `allowOffline=true`,
   * the body runs in no-op mode and the tracker is NOT persisted (no
   * run row exists to attach the totals to). A warning is logged when
   * a tracker is dropped this way so the silent loss is visible.
   */
  tracker?: CostTracker;
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
  // Resolve the cost tracker. When the caller doesn't supply one we create a
  // tracker so that LLM calls made inside the body still get attributed to
  // this flow automatically (recorded via the ambient tracker below and
  // persisted to pipeline_runs on /end). Callers that pass their own tracker
  // keep the existing behavior — and that same instance becomes the ambient
  // one, so un-wired calls accumulate into it rather than being lost.
  const callerProvidedTracker = options.tracker !== undefined;
  const tracker = options.tracker ?? new CostTracker();
  // Snapshot the tracker's entry count BEFORE the body runs so each
  // pipeline_runs row only records what its body added — not entries the
  // caller already accumulated. Required for nested wraps (e.g.
  // improve-entity → research-agent, sharing one tracker) so the inner
  // row doesn't double-count parent spend.
  const trackerStartIndex = tracker.entries.length;

  // Start the run. Fail-closed by default.
  // Defaults `agentSessionId` to the cached audit session id when callers
  // don't pass one — covers the common case (a CLI command running inside
  // an agent session) without duplicating the same coercion at every site.
  // Tests and explicit callers can still override.
  const startResult = await startPipelineRun({
    runId,
    pipelineName: options.pipelineName,
    entityId: options.entityId ?? null,
    shape: options.shape ?? null,
    agentSessionId:
      options.agentSessionId === undefined
        ? parseAgentSessionId(getCachedAuditSessionId())
        : options.agentSessionId,
  });

  if (!startResult.ok) {
    if (options.allowOffline) {
      warn('withPipelineRun: /start failed; running offline (allowOffline=true)', {
        runId,
        pipelineName: options.pipelineName,
        err: startResult.message,
      });
      if (options.tracker) {
        warn(
          'withPipelineRun: tracker totals will NOT be persisted — no run row exists in offline mode',
          { runId, pipelineName: options.pipelineName },
        );
      }
      return runWithAmbientTracker(tracker, () => body(makeOfflineCtx(runId)));
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
  //
  // Overlap guard: if the previous heartbeat is still in flight when
  // the next interval fires (e.g. wiki-server is responding slowly),
  // we skip rather than stack pending requests. Prevents unbounded
  // queue growth during prod incidents.
  let heartbeatInFlight = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void heartbeatPipelineRun(runId)
      .then(
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
      )
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, heartbeatIntervalMs);
  // Don't keep the event loop alive on the heartbeat alone — if the
  // body returns and the end call is in flight, we still want the
  // process to be able to exit.
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  try {
    const result = await runWithAmbientTracker(tracker, () => body(ctx));
    clearInterval(heartbeatTimer);
    await finalize({
      runId,
      pipelineName: options.pipelineName,
      status: overrideStatus ?? 'committed',
      failureReason: overrideReason,
      errorCode: overrideErrorCode,
      errorPayload: null,
      followups,
      costTotals: trackerTotals(tracker, trackerStartIndex, {
        omitWhenEmpty: !callerProvidedTracker,
      }),
    });
    return result;
  } catch (err: unknown) {
    clearInterval(heartbeatTimer);
    // CRITICAL: the original `err` from the body must reach the caller
    // even if `finalize` itself throws. Wrapping finalize in its own
    // try/catch ensures the audit-trail failure is logged but never
    // replaces the actionable exception.
    try {
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
        costTotals: trackerTotals(tracker, trackerStartIndex, {
          omitWhenEmpty: !callerProvidedTracker,
        }),
      });
    } catch (finalizeErr: unknown) {
      error(
        'withPipelineRun: finalize threw after body abort — audit trail lost; rethrowing original body error',
        {
          runId,
          pipelineName: options.pipelineName,
          finalizeErr:
            finalizeErr instanceof Error
              ? finalizeErr.message
              : String(finalizeErr),
          originalErr: err instanceof Error ? err.message : String(err),
        },
      );
    }
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

interface CostTotals {
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
}

/**
 * Snapshot the tracker's current totals (delta from `startIndex`). Returns
 * null when no tracker is configured so `finalize` can omit the cost
 * fields entirely (preserving the typed-client semantic that omitted ≠
 * null — see QUA-1012 comment in `EndPipelineRunInput`).
 *
 * `startIndex` is the snapshot of `tracker.entries.length` taken before
 * the body ran. Only entries added after that index are summed, so a
 * pipeline_run row records cost added by *this* body — not any cost the
 * caller's tracker already carried in. Required for nested
 * withPipelineRun calls that share a single tracker.
 *
 * `costUsd` is rounded to 4 decimal places. The pricing module produces
 * costs like `0.006196500000000001` from per-token math + FP imprecision,
 * which fail the server's `.multipleOf(0.0001)` Zod validator and would
 * cause /end to 422 mid-flight. The numeric(10,4) PG column would also
 * silently truncate, so rounding client-side keeps caller-side and
 * persisted values equal.
 */
function trackerTotals(
  tracker: CostTracker | undefined,
  startIndex: number,
  opts?: { omitWhenEmpty?: boolean },
): CostTotals | null {
  if (!tracker) return null;
  // When the tracker was auto-created (caller passed none) and the body
  // recorded no LLM calls, omit cost fields so the /end client preserves any
  // existing values rather than overwriting with 0. A caller-supplied tracker
  // keeps the old contract: explicit zeros are sent even when empty.
  if (opts?.omitWhenEmpty && tracker.entries.length <= startIndex) return null;
  let costUsd = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  for (let i = startIndex; i < tracker.entries.length; i++) {
    const entry = tracker.entries[i];
    costUsd += entry.cost;
    tokensInput += entry.inputTokens;
    tokensOutput += entry.outputTokens;
    tokensCacheRead += entry.cacheReadInputTokens;
    tokensCacheWrite += entry.cacheCreationInputTokens;
  }
  return {
    costUsd: Math.round(costUsd * 10000) / 10000,
    tokensInput,
    tokensOutput,
    tokensCacheRead,
    tokensCacheWrite,
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
  costTotals: CostTotals | null;
}

async function finalize(args: FinalizeArgs): Promise<void> {
  const result = await endPipelineRun(args.runId, {
    status: args.status,
    failureReason: args.failureReason,
    errorCode: args.errorCode,
    errorPayload: args.errorPayload,
    followupActions: args.followups,
    ...(args.costTotals ?? {}),
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
