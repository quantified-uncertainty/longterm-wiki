/**
 * Phase 2 canary dual-write driver — converts an `applyVerdictsToPolicy`
 * result into a PG sync POST and decides what to do with the response
 * (QUA-958, parent QUA-943).
 *
 * Decision tree:
 *
 *   POST /api/policy-stakeholders/sync?mode=best_effort
 *     ├─ HTTP non-2xx (network, 5xx)              → throw (withPipelineRun → aborted)
 *     ├─ 200 with code: "zod" in rejected[]      → throw (failure_reason: "zod_violation")
 *     ├─ 200 with code: "fk_missing" in rejected → markStatus('partial_failure'), markFollowup
 *     ├─ 200 with other rejection codes          → markStatus('partial_failure'), markFollowup
 *     └─ 200 with empty rejected                 → committed (default)
 *
 * Linear ops-ticket comment (red-team finding routing): fires only on
 * `aborted` and `partial_failure`. Successful runs are silent — the dashboard
 * is the source of truth, comments are for "human, please look".
 *
 * R-A4 (aborted-run semantics): the throw on `code: "zod"` happens BEFORE the
 * apply mutations are saved to disk. `withPipelineRun` re-throws to the
 * caller, so `saveEntity` in `doImproveSingleEntity` is never reached and
 * the on-disk YAML retains pre-iteration state. The next session's gap
 * analyzer reads that fresh state, not the in-memory mutated `apply.entity`.
 */

import { convertAppliedToStakeholderSync } from "./sync-applied.ts";
import type { ApplyResult } from "./apply-verdicts.ts";
import type { PolicyEntity } from "./gap-analyzer.ts";
import { syncPolicyStakeholdersBestEffort } from "../wiki-server/policy-stakeholders.ts";
import type { PipelineRunCtx } from "../pipeline-runs/lifecycle.ts";

export interface DualWriteOptions {
  /** Live pipeline run context — used for markFollowup + markStatus. */
  ctx: PipelineRunCtx;
  /** Policy entity stableId — required by the route as `policyEntityId`. */
  policyEntityId: string;
  /** Result from the in-memory apply step. */
  applyResult: ApplyResult<PolicyEntity>;
  /** Iteration number (for followup_actions provenance). */
  iter: number;
  /** Optional Linear ticket where aborted/partial_failure comments land. */
  opsTicket?: string | null;
  /**
   * Optional comment-poster. Injected so tests run without Linear. Production
   * passes `commentOnIssue`. Failures of the comment are logged but do NOT
   * fail the dual-write — the audit row already captured the outcome.
   */
  postComment?: (ticket: string, body: string) => Promise<void>;
}

export interface DualWriteOutcome {
  /** True when the canary committed everything we tried to write. */
  ok: boolean;
  /** Non-fatal warnings from converter (legacy `position: reform` etc.). */
  conversionWarnings: string[];
  /** Items the route accepted. */
  committedIds: string[];
  /** Items the route rejected with a structured `code`. */
  rejected: Array<{
    idx: number;
    code: string;
    message: string;
    field?: string;
    value?: unknown;
  }>;
  /** When `ok` is false, this names the dispositional reason. */
  reason?: 'no-stakeholder-changes' | 'partial_failure' | 'aborted_zod' | 'http_error';
}

/**
 * Custom error used to signal a Phase 2 abort. `withPipelineRun` reads
 * `error.name` (via `errorCodeFor`) and `error.message` (via `errorReason`),
 * so naming the class precisely matters: it surfaces in
 * `pipeline_runs.error_code` exactly as `"DualWriteZodAbort"`.
 */
export class DualWriteZodAbort extends Error {
  constructor(
    message: string,
    public readonly rejections: DualWriteOutcome['rejected'],
  ) {
    super(message);
    this.name = "DualWriteZodAbort";
  }
}

export class DualWriteHttpError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "DualWriteHttpError";
  }
}

function buildOpsCommentBody(
  reason: 'aborted_zod' | 'partial_failure' | 'http_error',
  policyEntityId: string,
  iter: number,
  payload: {
    committedIds?: string[];
    rejected?: DualWriteOutcome['rejected'];
    httpMessage?: string;
  },
): string {
  const lines: string[] = [];
  lines.push(`## Stakeholder dual-write — \`${reason}\``);
  lines.push("");
  lines.push(`- **Policy entity:** \`${policyEntityId}\``);
  lines.push(`- **Iteration:** ${iter}`);
  if (payload.committedIds && payload.committedIds.length > 0) {
    lines.push(`- **Committed (already in PG):** ${payload.committedIds.length} item(s) — ${payload.committedIds.slice(0, 5).join(", ")}${payload.committedIds.length > 5 ? ", …" : ""}`);
  }
  if (payload.rejected && payload.rejected.length > 0) {
    lines.push(`- **Rejected:** ${payload.rejected.length} item(s)`);
    lines.push("");
    lines.push("```");
    for (const r of payload.rejected.slice(0, 10)) {
      lines.push(`[idx=${r.idx}] code=${r.code}${r.field ? ` field=${r.field}` : ""}${r.value !== undefined ? ` value=${JSON.stringify(r.value)}` : ""}`);
      lines.push(`        ${r.message}`);
    }
    lines.push("```");
  }
  if (payload.httpMessage) {
    lines.push(`- **HTTP error:** \`${payload.httpMessage}\``);
  }
  return lines.join("\n");
}

async function tryComment(
  options: DualWriteOptions,
  reason: 'aborted_zod' | 'partial_failure' | 'http_error',
  payload: Parameters<typeof buildOpsCommentBody>[3],
): Promise<void> {
  if (!options.opsTicket || !options.postComment) return;
  const body = buildOpsCommentBody(reason, options.policyEntityId, options.iter, payload);
  try {
    await options.postComment(options.opsTicket, body);
  } catch (e) {
    console.warn(
      `dual-write: ops-ticket comment to ${options.opsTicket} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Run the dual-write step for a single iteration.
 *
 * Throws `DualWriteZodAbort` on `code: "zod"` rejections (caller should not
 * catch — it's caught by `withPipelineRun` and marked aborted). Throws
 * `DualWriteHttpError` on transport errors. Returns normally on partial
 * success or full success.
 */
export async function dualWriteStakeholders(
  options: DualWriteOptions,
): Promise<DualWriteOutcome> {
  const { ctx, policyEntityId, applyResult, iter } = options;

  const conversion = convertAppliedToStakeholderSync({
    policyEntityId,
    applyResult,
  });

  // Empty payload — nothing this iteration touched in PG-eligible terms.
  if (conversion.items.length === 0) {
    return {
      ok: true,
      conversionWarnings: conversion.warnings,
      committedIds: [],
      rejected: [],
      reason: 'no-stakeholder-changes',
    };
  }

  const res = await syncPolicyStakeholdersBestEffort(conversion.items);

  if (!res.ok) {
    // HTTP-level failure (5xx, network, parse). Treat as aborted — the
    // canary's safety contract is "if we can't validate the write, don't
    // write the YAML side either".
    const errMsg =
      (res as { error?: string; message?: string }).error ??
      (res as { message?: string }).message ??
      'unknown HTTP error';
    await tryComment(options, 'http_error', {
      httpMessage: errMsg,
    });
    ctx.markStatus('aborted', { reason: 'sync_http_error', errorCode: 'DualWriteHttpError' });
    throw new DualWriteHttpError(`policy-stakeholders sync failed: ${errMsg}`);
  }

  const data = res.data;
  const rejected = data.rejected ?? [];
  const committed = data.committed ?? [];

  // Look for any code:"zod" rejection — that's an abort signal per spec §5.
  const hasZodAbort = rejected.some((r) => r.code === 'zod' || r.code === 'enum_violation');

  if (hasZodAbort) {
    ctx.markFollowup({
      kind: 'phase2_zod_abort',
      iter,
      policyEntityId,
      committed,
      rejected,
    });
    await tryComment(options, 'aborted_zod', {
      committedIds: committed,
      rejected,
    });
    // Set status BEFORE throwing so `withPipelineRun`'s catch path keeps the
    // override (vs writing 'aborted' with a generic error name).
    ctx.markStatus('aborted', {
      reason: 'zod_violation',
      errorCode: 'DualWriteZodAbort',
    });
    throw new DualWriteZodAbort(
      `policy-stakeholders sync rejected ${rejected.length} item(s) with code='zod' (or enum_violation)`,
      rejected,
    );
  }

  if (rejected.length > 0) {
    // Partial — record + continue.
    ctx.markStatus('partial_failure', { reason: 'fk_missing_or_other_partial' });
    ctx.markFollowup({
      kind: 'phase2_partial',
      iter,
      policyEntityId,
      committed,
      rejected,
    });
    await tryComment(options, 'partial_failure', {
      committedIds: committed,
      rejected,
    });
    return {
      ok: false,
      conversionWarnings: conversion.warnings,
      committedIds: committed,
      rejected,
      reason: 'partial_failure',
    };
  }

  // Full commit. Status stays 'committed' (the withPipelineRun default).
  return {
    ok: true,
    conversionWarnings: conversion.warnings,
    committedIds: committed,
    rejected: [],
  };
}
