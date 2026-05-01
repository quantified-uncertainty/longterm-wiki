/**
 * Pre-write health-gate guard for the QUA-958 canary (red-team finding #1).
 *
 * Before any policy-stakeholders dual-write happens, we ask the wiki-server
 * "is the latest reconciliation_runs row clean?". If not (the cron last
 * reported divergence on a non-empty entity, OR the cron itself is stalled
 * or erroring) we halt the canary — refuse to add more pipeline_runs writes
 * until the divergence is reconciled.
 *
 * The check is best-effort:
 *   - Wiki-server unreachable → fail-soft (proceed). The dual-write can still
 *     surface its own audit trail; auto-halt is a safety NET, not the only
 *     line of defense.
 *   - Reconciliation summary returns "no completed run" → halt with
 *     `reason: 'cron_never_ran'` so the operator notices the cron is missing.
 *   - Latest run reported divergence → halt with `reason: 'pg_yaml_divergence'`.
 */

import {
  evaluateReconciliation,
  RECONCILIATION_STALE_THRESHOLD_HOURS,
} from "../../pr-patrol/health-scan.ts";
import { getReconciliationSummary } from "../wiki-server/reconciliation-runs.ts";
import { formatApiError } from "../wiki-server/client.ts";

export interface HaltGuardResult {
  /** True when the canary should HALT. */
  halt: boolean;
  reason: string;
  /** Latest run timestamp, if known. */
  lastRunAt: Date | null;
  /** Latest non_empty_diffs count, if known. */
  nonEmptyDiffs: number | null;
}

export interface HaltGuardOptions {
  /** Bypass for emergency canary work; logs but does not halt. */
  bypass?: boolean;
  /** Test seam — replaces the wiki-server fetch. */
  fetchSummary?: typeof getReconciliationSummary;
  now?: Date;
}

export async function checkCanaryHalt(
  options: HaltGuardOptions = {},
): Promise<HaltGuardResult> {
  if (options.bypass) {
    return {
      halt: false,
      reason: 'bypass requested by caller',
      lastRunAt: null,
      nonEmptyDiffs: null,
    };
  }

  const fetchFn = options.fetchSummary ?? getReconciliationSummary;
  let summary: Awaited<ReturnType<typeof getReconciliationSummary>>;
  try {
    summary = await fetchFn({ domain: 'policy_stakeholders' });
  } catch (e) {
    // Network / wiki-server outage. Fail soft so the canary doesn't stall on
    // a dependency outage. The audit row we'll write next is still authoritative.
    return {
      halt: false,
      reason: `reconciliation summary fetch threw: ${e instanceof Error ? e.message : String(e)}`,
      lastRunAt: null,
      nonEmptyDiffs: null,
    };
  }
  if (!summary.ok) {
    return {
      halt: false,
      reason: `reconciliation summary unavailable: ${formatApiError(summary)}`,
      lastRunAt: null,
      nonEmptyDiffs: null,
    };
  }

  const evaluated = evaluateReconciliation(summary.data, options.now);
  if (!evaluated.healthy) {
    return {
      halt: true,
      reason: evaluated.reason,
      lastRunAt: evaluated.latestRunStartedAt,
      nonEmptyDiffs: evaluated.latestNonEmptyDiffsObserved,
    };
  }
  return {
    halt: false,
    reason: evaluated.reason,
    lastRunAt: evaluated.latestRunStartedAt,
    nonEmptyDiffs: evaluated.latestNonEmptyDiffsObserved,
  };
}

/**
 * Marker exported so the dual-write call-site can compare without re-importing
 * the constant from health-scan. Kept as a re-export rather than a duplicate
 * literal so the guard and the gate stay in lockstep.
 */
export { RECONCILIATION_STALE_THRESHOLD_HOURS };

export class CanaryHaltedError extends Error {
  constructor(reason: string) {
    super(`canary halted by health gate: ${reason}`);
    this.name = "CanaryHaltedError";
  }
}
