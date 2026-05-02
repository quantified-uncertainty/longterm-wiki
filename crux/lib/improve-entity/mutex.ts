/**
 * Single-instance mutex for `improve-entity` and `improve-entity-suite`
 * (QUA-1032, parent QUA-1011).
 *
 * Two parallel suite runs is never what a user wants — they're either redundant
 * or fighting for the same entity row. A coordinator session triggered
 * improve-entity-suite twice on 2026-05-01 (output buffering hid the first run;
 * second started in parallel) and both ran for ~10 minutes spending $5–10 each.
 *
 * This helper queries the existing `pipeline_runs` API for any matching
 * `running` rows with a fresh heartbeat (≤30 min), and refuses to start if
 * one is found unless `--force` is passed.
 *
 * ## Design choices
 *
 * - **Check happens *before* `withPipelineRun`.** That way the helper's own
 *   pending row doesn't appear in the conflict list — if we checked from
 *   inside the lifecycle, we'd self-detect.
 * - **Freshness gate via `heartbeatAt`, not `startedAt`.** A run with
 *   `status='running'` but `heartbeatAt` older than 30 min has crashed
 *   (the lifecycle helper bumps every 30s). Without freshness filtering,
 *   we'd block on stale rows forever — the pipeline-runs lifecycle has no
 *   auto-sweep for crashed runs. The 30-min threshold matches the
 *   `agent_sessions` stale-sweep cutoff for consistency.
 * - **Fail-open on API error.** If the wiki-server is unreachable, the
 *   mutex check can't run. Erring on "let the user proceed" rather than
 *   "block all improve-entity runs because the server is down" matches
 *   how `agent-checklist init --allow-offline` behaves.
 * - **TOCTOU window.** Two concurrent agents could both pass the check
 *   within ~50ms before either inserts its `pipeline_runs` row. The spec
 *   accepts this — the wins from blocking the typical "ran the suite twice
 *   in two terminals" case are the goal, not strict locking.
 */

import { listPipelineRuns } from '../wiki-server/pipeline-runs.ts';
import type { PipelineRunRow } from '../wiki-server/pipeline-runs.ts';
import type { ApiResult } from '../wiki-server/client.ts';

export const IMPROVE_ENTITY_PIPELINE_NAME = 'improve-entity' as const;
export const IMPROVE_ENTITY_SUITE_PIPELINE_NAME = 'improve-entity-suite' as const;

export type ImproveEntityPipelineName =
  | typeof IMPROVE_ENTITY_PIPELINE_NAME
  | typeof IMPROVE_ENTITY_SUITE_PIPELINE_NAME;

/** Default 30-min freshness window for "running" rows. Matches the
 *  `agent_sessions` stale-sweep cutoff and the heartbeat cadence
 *  (one heartbeat every 30s — a 30-min gap means ~60 missed beats). */
export const DEFAULT_FRESHNESS_MS = 30 * 60 * 1000;

export interface MutexConflict {
  runId: string;
  pipelineName: string;
  agentSessionId: number | null;
  startedAt: Date | string;
  heartbeatAt: Date | string | null;
  /** Seconds since the most-recent activity (heartbeatAt, falling back to
   *  startedAt). Used for the human-readable error message. */
  ageSeconds: number;
}

export interface CheckMutexOptions {
  pipelineName: ImproveEntityPipelineName;
  /** When true, skip the check entirely. Wired to the CLI `--force` flag. */
  force?: boolean;
  /** ms threshold for considering a running row "fresh". Default 30 min. */
  freshnessMs?: number;
  /** Test injection — defaults to the real `listPipelineRuns`. The shape
   *  matches `listPipelineRuns` so a mocked function can stand in directly. */
  list?: typeof listPipelineRuns;
  /** Test injection — clock for "now". Defaults to `Date.now`. */
  nowMs?: () => number;
}

/**
 * Returns the most-recently-active conflict, or `null` if there's no
 * running run that should block the caller. The "most-recently-active"
 * conflict wins so the error message points at the run the operator is
 * most likely to recognize.
 */
export async function checkImproveEntityMutex(
  options: CheckMutexOptions,
): Promise<MutexConflict | null> {
  if (options.force) return null;

  const list = options.list ?? listPipelineRuns;
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const now = (options.nowMs ?? Date.now)();

  let result: ApiResult<{ runs: PipelineRunRow[]; count: number }>;
  try {
    result = await list({
      status: 'running',
      pipelineName: options.pipelineName,
      // 50 is well above any realistic concurrency. The list endpoint caps
      // at 500; we don't need close to that.
      limit: 50,
    });
  } catch (e) {
    // Network/throw path — fail-open. Distinguishes from `ok: false` which
    // is the API-returned-error path; both lead to the same fail-open
    // behavior, but we log differently so debugging knows which branch hit.
    console.warn(
      `[mutex] list pipeline-runs threw; allowing run to proceed (fail-open). ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  if (!result.ok) {
    console.warn(
      `[mutex] list pipeline-runs returned !ok; allowing run to proceed (fail-open). error=${result.error} message=${result.message}`,
    );
    return null;
  }

  // Filter to "fresh" running rows. heartbeatAt is the authoritative
  // freshness signal; if it's null (route was hit before any heartbeat
  // landed), fall back to startedAt — both are populated on insert.
  const conflicts: MutexConflict[] = [];
  for (const row of result.data.runs) {
    const beat = row.heartbeatAt ?? row.startedAt;
    const beatMs = parseToMs(beat);
    if (beatMs == null) continue;
    const age = now - beatMs;
    if (age > freshnessMs) continue;
    if (age < 0) {
      // Row's heartbeat is in the future — clock skew between server and
      // client. Don't block; treat as fresh and let the operator see it.
      // (This is a fail-open within fail-open: skew shouldn't strand the
      // user, but a future-heartbeat IS a live row so we still report it.)
    }
    conflicts.push({
      runId: row.runId,
      pipelineName: row.pipelineName,
      agentSessionId: row.agentSessionId ?? null,
      startedAt: row.startedAt,
      heartbeatAt: row.heartbeatAt,
      ageSeconds: Math.max(0, Math.round(age / 1000)),
    });
  }

  if (conflicts.length === 0) return null;

  // Most-recently-active wins. `ageSeconds` is small for active rows.
  conflicts.sort((a, b) => a.ageSeconds - b.ageSeconds);
  return conflicts[0];
}

/**
 * Render the user-facing refusal message for a mutex conflict. Exported so
 * tests can assert on the format, and so callers can choose between
 * throwing and printing.
 */
export function formatMutexError(
  conflict: MutexConflict,
  pipelineName: ImproveEntityPipelineName,
): string {
  const ageStr = formatAge(conflict.ageSeconds);
  const sessionStr =
    conflict.agentSessionId != null
      ? `, agent_session_id=${conflict.agentSessionId}`
      : '';
  return (
    `✗ Another ${pipelineName} run is in progress ` +
    `(run_id=${conflict.runId}, started ${ageStr} ago${sessionStr}).\n` +
    `  Wait for it to complete, or pass --force to start anyway.`
  );
}

/** Thrown by `improveSingleEntity` and `runSuite` when the mutex check
 *  finds a conflicting run. Exit code 2 (matches the parent ticket spec).
 *  The CLI catches this and prints `formatMutexError(conflict)`. */
export class ImproveEntityMutexError extends Error {
  readonly conflict: MutexConflict;
  readonly pipelineName: ImproveEntityPipelineName;
  constructor(conflict: MutexConflict, pipelineName: ImproveEntityPipelineName) {
    super(formatMutexError(conflict, pipelineName));
    this.name = 'ImproveEntityMutexError';
    this.conflict = conflict;
    this.pipelineName = pipelineName;
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

/** Convert a `Date | string | null | undefined` field into ms-since-epoch.
 *  Returns null when the input is missing or unparseable. */
function parseToMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Format an age in seconds as a compact human label.
 *    7s, 45s, 3m, 12m, 1h 5m. */
function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${ageSeconds}s`;
  if (ageSeconds < 3600) {
    const m = Math.floor(ageSeconds / 60);
    return `${m}m`;
  }
  const h = Math.floor(ageSeconds / 3600);
  const m = Math.floor((ageSeconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
