/**
 * Reconciliation cron driver — orchestrates the daily PG-vs-YAML diff for
 * `policy_stakeholders` (QUA-958, parent QUA-943).
 *
 * Pulls all PG rows + all YAML policy entities, runs the pure diff helper,
 * records the run in `reconciliation_runs`, and posts a heartbeat comment
 * to the configured Linear tracking ticket.
 *
 * Heartbeat behavior (red-team finding #2): every run posts a brief comment
 * on the tracking ticket — "0 diffs" still produces output so the absence of
 * a comment unambiguously means the cron is broken (cf QUA-31 auto-update).
 *
 * Phase 4 precondition (red-team finding #4): the `non_empty_diffs_observed`
 * count is what gates QUA-960. Recorded into the run row + summary endpoint.
 */

import { loadAllEntities } from "./entity-loader.ts";
import {
  reconcilePolicyStakeholders,
  type PgStakeholderRow,
  type PolicyEntityForReconcile,
  type ReconcileResult,
} from "./reconcile-stakeholders.ts";
import { getAllPolicyStakeholders } from "../wiki-server/policy-stakeholders.ts";
import {
  startReconciliationRun,
  completeReconciliationRun,
} from "../wiki-server/reconciliation-runs.ts";

export interface RunReconcileOptions {
  /** "scheduled" for cron, "manual" for ad-hoc invocation. */
  trigger: "scheduled" | "manual";
  /** Optional Linear ticket where the heartbeat / divergence comment lands. */
  trackingTicket?: string | null;
  /**
   * Optional callback for posting a Linear comment. Injected so tests can mock
   * without hitting Linear. Production passes `commentOnIssue`.
   */
  postComment?: (ticket: string, body: string) => Promise<void>;
  /** Override the entities directory (test only). */
  entitiesDir?: string;
}

export interface RunReconcileOutput {
  runId: number | null;
  result: ReconcileResult;
  /** True when divergence was found AND the heartbeat comment fired. */
  hadDivergence: boolean;
  /** Linear ticket the comment was posted to (null if no ticket configured). */
  commentedOn: string | null;
  errorMessage: string | null;
}

/**
 * Page through `getAllPolicyStakeholders` until exhausted. The route caps
 * each page at 200 (`MAX_PAGE_SIZE`). Reconciliation needs everything.
 */
async function fetchAllPgRows(): Promise<PgStakeholderRow[]> {
  const all: PgStakeholderRow[] = [];
  const PAGE_SIZE = 200;
  let offset = 0;
  for (;;) {
    const res = await getAllPolicyStakeholders({ limit: PAGE_SIZE, offset });
    if (!res.ok) {
      throw new Error(
        `getAllPolicyStakeholders failed at offset=${offset}: ${
          (res as { error?: string; message?: string }).error ??
          (res as { message?: string }).message ??
          "unknown error"
        }`,
      );
    }
    const page = res.data.policyStakeholders as unknown as PgStakeholderRow[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    // Safety cap so a misbehaving server can't pull us into an infinite loop.
    if (offset > 100_000) {
      throw new Error(`fetchAllPgRows: aborting at offset=${offset} (>100k rows is unexpected for policy_stakeholders)`);
    }
  }
  return all;
}

function bucketByPolicy(rows: PgStakeholderRow[]): Map<string, PgStakeholderRow[]> {
  const m = new Map<string, PgStakeholderRow[]>();
  for (const r of rows) {
    const list = m.get(r.policyEntityId);
    if (list) list.push(r);
    else m.set(r.policyEntityId, [r]);
  }
  return m;
}

function buildHeartbeatBody(
  result: ReconcileResult,
  trigger: "scheduled" | "manual",
): string {
  const lines: string[] = [];
  lines.push(`## Reconciliation cron — \`policy_stakeholders\``);
  lines.push("");
  lines.push(`- Trigger: \`${trigger}\``);
  lines.push(`- Entities scanned: ${result.entitiesScanned}`);
  lines.push(`- Entities with non-empty YAML stakeholders: ${result.entitiesNonEmpty}`);
  lines.push(`- Diffs detected: ${result.entitiesWithDiff}`);
  lines.push(`- Diffs on non-empty entities (Phase 4 precondition): ${result.entitiesNonEmptyWithDiff}`);
  lines.push("");
  if (result.entitiesWithDiff === 0) {
    lines.push(`✅ Steady state — PG and YAML agree across all ${result.entitiesScanned} policy entities.`);
    return lines.join("\n");
  }
  lines.push(`⚠ **Divergence detected.** First ${Math.min(result.diffs.length, 10)} entities:`);
  lines.push("");
  for (const d of result.diffs.slice(0, 10)) {
    const bits: string[] = [];
    if (d.missingFromPg.length > 0) bits.push(`missing from PG: ${d.missingFromPg.join(", ")}`);
    if (d.missingFromYaml.length > 0) bits.push(`missing from YAML: ${d.missingFromYaml.join(", ")}`);
    if (d.fieldDiffs.length > 0) bits.push(`${d.fieldDiffs.length} field diff(s)`);
    lines.push(`- \`${d.policyEntityId}\` — ${bits.join("; ")}`);
  }
  if (result.diffs.length > 10) {
    lines.push(`- … and ${result.diffs.length - 10} more`);
  }
  return lines.join("\n");
}

/**
 * Run a single reconciliation pass end-to-end.
 *
 * Returns a structured result. On exception, the reconciliation_runs row is
 * still completed (with `errorCode` set) so the heartbeat surface stays
 * consistent — the cron is "alive but failing" rather than "absent".
 */
export async function runReconcile(
  options: RunReconcileOptions,
): Promise<RunReconcileOutput> {
  const startedAt = new Date();
  // Open the run row first so a crash mid-scan still leaves a "running" row
  // (the wiki-server's row sweep can flag it).
  const startRes = await startReconciliationRun({
    domain: "policy_stakeholders",
    trigger: options.trigger,
    startedAt: startedAt.toISOString(),
  });
  if (!startRes.ok) {
    // Surface the error rather than silently running without an audit row.
    const msg =
      (startRes as { error?: string; message?: string }).error ??
      (startRes as { message?: string }).message ??
      "unknown error";
    throw new Error(`reconcile-stakeholders: failed to open run row: ${msg}`);
  }
  const runId = startRes.data.id;

  let errorMessage: string | null = null;
  let result: ReconcileResult = {
    entitiesScanned: 0,
    entitiesNonEmpty: 0,
    entitiesWithDiff: 0,
    entitiesNonEmptyWithDiff: 0,
    diffs: [],
  };

  try {
    const policies = (
      loadAllEntities(options.entitiesDir) as unknown as PolicyEntityForReconcile[]
    ).filter((e) => e.type === "policy");
    const pgRows = await fetchAllPgRows();
    const bucketed = bucketByPolicy(pgRows);
    result = reconcilePolicyStakeholders(policies, bucketed);
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  const completeRes = await completeReconciliationRun({
    id: runId,
    entitiesScanned: result.entitiesScanned,
    entitiesNonEmpty: result.entitiesNonEmpty,
    diffsDetected: result.entitiesWithDiff,
    nonEmptyDiffsObserved: result.entitiesNonEmptyWithDiff,
    detailsJson: {
      // Cap stored diffs so a runaway pathology doesn't blow up jsonb.
      diffs: result.diffs.slice(0, 100),
      truncated: result.diffs.length > 100,
    },
    errorCode: errorMessage ? "scan_error" : null,
    errorMessage,
  });
  if (!completeRes.ok) {
    // Don't swallow — the row is the audit trail.
    const msg =
      (completeRes as { error?: string; message?: string }).error ??
      (completeRes as { message?: string }).message ??
      "unknown error";
    // We still post a heartbeat below if a ticket is configured, so the
    // operator sees something. But the row didn't close — surface that.
    errorMessage = errorMessage
      ? `${errorMessage}; complete failed: ${msg}`
      : `complete failed: ${msg}`;
  }

  let commentedOn: string | null = null;
  const trackingTicket = options.trackingTicket ?? null;
  if (trackingTicket && options.postComment) {
    const body = errorMessage
      ? `## Reconciliation cron — \`policy_stakeholders\`\n\n❌ Run failed: \`${errorMessage}\``
      : buildHeartbeatBody(result, options.trigger);
    try {
      await options.postComment(trackingTicket, body);
      commentedOn = trackingTicket;
    } catch (e) {
      // Comment failure is non-fatal — the row is the source of truth.
      // Surface to logs so the operator can re-post manually if needed.
      console.warn(
        `reconcile-stakeholders: heartbeat comment to ${trackingTicket} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    runId,
    result,
    hadDivergence: result.entitiesWithDiff > 0,
    commentedOn,
    errorMessage,
  };
}
