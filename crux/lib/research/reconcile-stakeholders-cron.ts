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
import { formatApiError } from "../wiki-server/client.ts";

/**
 * Maximum number of policy stakeholder rows we'll page through in a single
 * scan before declaring something is wrong. policy_stakeholders is
 * fundamentally bounded by 151 policies × O(10) stakeholders each — running
 * past 100k means a misbehaving server is paginating forever.
 */
const MAX_PG_ROW_FETCH = 100_000;

/** Cap on how many per-entity diffs we persist into details_json / show in the heartbeat. */
const MAX_DIFFS_IN_DETAILS = 100;
const MAX_DIFFS_IN_COMMENT = 10;

/**
 * Hard cap on `errorMessage` length sent to `/complete`. The wiki-server's
 * Zod schema rejects strings >5000 chars with a 400. Without this guard, a
 * scan error whose `String(e)` blew past the limit (rare but possible — a
 * non-Error thrown value with a huge `toString`) would cause the
 * `/complete` call to 400, losing the audit row entirely.
 *
 * Cap = 5000 (schema limit) − 500 (headroom for the truncation marker, which
 * adds ~35 chars but lets `String(e.length)` grow without us having to
 * recompute the budget). If you tighten the Zod max in the route, lower
 * this constant in lockstep — see
 * `apps/wiki-server/src/routes/operational/reconciliation-runs.ts`'s
 * `CompleteSchema.errorMessage` field.
 */
const MAX_ERROR_MESSAGE_CHARS = 4500;

function truncateForAudit(s: string | null): string | null {
  if (s === null) return null;
  if (s.length <= MAX_ERROR_MESSAGE_CHARS) return s;
  return s.slice(0, MAX_ERROR_MESSAGE_CHARS) + ` …[truncated; original ${s.length} chars]`;
}

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
  // Test seams for the wiki-server calls. Production uses the real clients
  // (default values below). Tests pass mocks so the cron logic can be
  // exercised without a live wiki-server.
  startFn?: typeof startReconciliationRun;
  completeFn?: typeof completeReconciliationRun;
  fetchPgRowsFn?: () => Promise<PgStakeholderRow[]>;
  loadPoliciesFn?: () => PolicyEntityForReconcile[];
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
  // Use the route's `/all` ceiling (raised in policy-stakeholders.ts so the
  // daily cron pays ~5 RTTs instead of ~130 against the 26k-row corpus).
  const PAGE_SIZE = 2000;
  let offset = 0;
  for (;;) {
    const res = await getAllPolicyStakeholders({ limit: PAGE_SIZE, offset });
    if (!res.ok) {
      throw new Error(
        `getAllPolicyStakeholders failed at offset=${offset}: ${formatApiError(res)}`,
      );
    }
    const page = res.data.policyStakeholders as unknown as PgStakeholderRow[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset > MAX_PG_ROW_FETCH) {
      throw new Error(
        `fetchAllPgRows: aborting at offset=${offset} (>${MAX_PG_ROW_FETCH} rows is unexpected for policy_stakeholders)`,
      );
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
  const shown = Math.min(result.diffs.length, MAX_DIFFS_IN_COMMENT);
  lines.push(`⚠ **Divergence detected.** First ${shown} entities:`);
  lines.push("");
  for (const d of result.diffs.slice(0, MAX_DIFFS_IN_COMMENT)) {
    const bits: string[] = [];
    if (d.missingFromPg.length > 0) bits.push(`missing from PG: ${d.missingFromPg.join(", ")}`);
    if (d.missingFromYaml.length > 0) bits.push(`missing from YAML: ${d.missingFromYaml.join(", ")}`);
    if (d.fieldDiffs.length > 0) bits.push(`${d.fieldDiffs.length} field diff(s)`);
    lines.push(`- \`${d.policyEntityId}\` — ${bits.join("; ")}`);
  }
  if (result.diffs.length > MAX_DIFFS_IN_COMMENT) {
    lines.push(`- … and ${result.diffs.length - MAX_DIFFS_IN_COMMENT} more`);
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
  const startFn = options.startFn ?? startReconciliationRun;
  const completeFn = options.completeFn ?? completeReconciliationRun;
  const fetchPgRowsFn = options.fetchPgRowsFn ?? fetchAllPgRows;
  const loadPoliciesFn =
    options.loadPoliciesFn ??
    (() => loadAllEntities(options.entitiesDir) as unknown as PolicyEntityForReconcile[]);

  const startedAt = new Date();
  // Open the run row first so a crash mid-scan still leaves a "running" row
  // (the wiki-server's row sweep can flag it).
  const startRes = await startFn({
    domain: "policy_stakeholders",
    trigger: options.trigger,
    startedAt: startedAt.toISOString(),
  });
  if (!startRes.ok) {
    // Surface the error rather than silently running without an audit row.
    throw new Error(
      `reconcile-stakeholders: failed to open run row: ${formatApiError(startRes)}`,
    );
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
    const policies = loadPoliciesFn().filter((e) => e.type === "policy");
    const pgRows = await fetchPgRowsFn();
    const bucketed = bucketByPolicy(pgRows);
    result = reconcilePolicyStakeholders(policies, bucketed);
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  const completeRes = await completeFn({
    id: runId,
    entitiesScanned: result.entitiesScanned,
    entitiesNonEmpty: result.entitiesNonEmpty,
    diffsDetected: result.entitiesWithDiff,
    nonEmptyDiffsObserved: result.entitiesNonEmptyWithDiff,
    detailsJson: {
      // Cap stored diffs so a runaway pathology doesn't blow up jsonb.
      diffs: result.diffs.slice(0, MAX_DIFFS_IN_DETAILS),
      truncated: result.diffs.length > MAX_DIFFS_IN_DETAILS,
    },
    errorCode: errorMessage ? "scan_error" : null,
    errorMessage: truncateForAudit(errorMessage),
  });
  if (!completeRes.ok) {
    // Don't swallow — the row is the audit trail. We still post a heartbeat
    // below if a ticket is configured, so the operator sees something. But
    // the row didn't close — surface that.
    const msg = formatApiError(completeRes);
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
