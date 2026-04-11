/**
 * Job Queue Health Check
 *
 * Fetches /api/jobs/stats from wiki-server and checks for:
 *   - High failure rates over the recent time window (48h by default)
 *   - Large pending backlogs
 *
 * Thresholds use two tiers:
 *   - FAIL (CI-blocking): catastrophic issues that need immediate attention
 *     - >80% failure rate with >=10 recent completed+failed jobs
 *     - >500 pending jobs for any single type
 *   - WARN (informational): elevated but not actionable yet
 *     - >40% failure rate with >=10 recent jobs
 *     - >100 pending jobs
 *
 * The failure rate is computed server-side over a 48h window, so stale
 * historical failures don't inflate the rate. The `recentTotal` field
 * from the stats endpoint gives the actual sample size for that window.
 *
 * Pending counts are all-time (not windowed), representing accumulated
 * unprocessed jobs. A stable pending count is normal for batch queues
 * where workers run periodically; only large or rapidly growing backlogs
 * should trigger alerts.
 */

import type { CheckResult } from '../health-check.ts';

// ---------------------------------------------------------------------------
// Thresholds (exported for tests)
// ---------------------------------------------------------------------------

/** Minimum recent (48h) completed+failed jobs to consider the failure rate meaningful. */
export const MIN_SAMPLE_SIZE = 10;

/** FAIL tier: failure rate above this with sufficient sample size fails CI. */
export const FAIL_RATE_PCT = 80;
/** WARN tier: failure rate above this is logged but doesn't fail CI. */
export const WARN_RATE_PCT = 40;

/** FAIL tier: pending count above this fails CI. */
export const FAIL_PENDING = 500;
/** WARN tier: pending count above this is logged. */
export const WARN_PENDING = 100;

/**
 * Job types excluded from health evaluation.
 * auto-update is intentionally disabled (PR #2592) but still shows 100% failure
 * rate in job stats, causing recurring false-positive wellness issues (#4086, #4068, #4107).
 */
export const EXCLUDED_JOB_TYPES = new Set(['auto-update']);

// ---------------------------------------------------------------------------
// Types (exported for tests)
// ---------------------------------------------------------------------------

export interface JobTypeStats {
  byStatus: Record<string, number>;
  failureRate?: number;
  avgDurationMs?: number;
  /** Number of completed+failed jobs in the recent time window. */
  recentTotal?: number;
  /** Number of failed jobs in the recent time window. */
  recentFailed?: number;
}

export interface JobStatsResponse {
  totalJobs?: number;
  byType?: Record<string, JobTypeStats>;
  /** Time window in hours used for failure rate calculation. */
  hours?: number;
}

// ---------------------------------------------------------------------------
// Evaluation logic (pure, exported for tests)
// ---------------------------------------------------------------------------

export interface EvaluationResult {
  detail: string[];
  failures: string[];
}

/**
 * Evaluate job stats data and produce detail lines and failures.
 * Pure function — no I/O — so it's testable without mocking fetch.
 */
export function evaluateJobStats(data: JobStatsResponse): EvaluationResult {
  const detail: string[] = [];
  const failures: string[] = [];

  const totalJobs = data.totalJobs ?? 0;
  const windowHours = data.hours ?? 48;
  detail.push(`Total jobs (last ${windowHours}h window): ${totalJobs}`);

  const byType = data.byType ?? {};

  for (const [jobType, stats] of Object.entries(byType)) {
    if (EXCLUDED_JOB_TYPES.has(jobType)) {
      detail.push(`SKIP  ${jobType}: excluded (intentionally disabled)`);
      continue;
    }
    const statusCounts = stats.byStatus ?? {};
    const pending = statusCounts['pending'] ?? 0;
    const running = statusCounts['running'] ?? 0;
    const failedAllTime = statusCounts['failed'] ?? 0;
    const failureRate = stats.failureRate ?? 0;
    const avgMs = stats.avgDurationMs ?? 'N/A';
    const failurePct = Math.round(failureRate * 100);

    // Use recentTotal from the server's time-windowed query for sample size.
    // Falls back to assuming sufficient sample if the server doesn't provide it
    // (backwards compatibility with older server versions).
    const recentTotal = stats.recentTotal;
    const recentFailed = stats.recentFailed ?? 0;
    const hasSufficientSample = recentTotal != null ? recentTotal >= MIN_SAMPLE_SIZE : true;

    // ── Failure rate check ──
    if (failurePct > FAIL_RATE_PCT && hasSufficientSample) {
      const sampleNote = recentTotal != null ? ` (${recentFailed}/${recentTotal} in ${windowHours}h)` : '';
      detail.push(`FAIL  ${jobType}: ${failurePct}% failure rate${sampleNote}`);
      failures.push(`${jobType}: ${failurePct}% failure rate${sampleNote}`);
    } else if (failurePct > WARN_RATE_PCT && hasSufficientSample) {
      const sampleNote = recentTotal != null ? ` (${recentFailed}/${recentTotal} in ${windowHours}h)` : '';
      detail.push(`WARN  ${jobType}: ${failurePct}% failure rate${sampleNote} — below FAIL threshold`);
      // Warn-only: not added to failures array
    } else if (failurePct > WARN_RATE_PCT && !hasSufficientSample) {
      const sampleNote = recentTotal != null ? ` (sample=${recentTotal}, need >=${MIN_SAMPLE_SIZE})` : '';
      detail.push(`INFO  ${jobType}: ${failurePct}% failure rate${sampleNote} — insufficient sample`);
    } else {
      detail.push(
        `PASS  ${jobType}: pending=${pending} running=${running} failed=${failedAllTime} failure=${failurePct}% avg=${avgMs}ms`,
      );
    }

    // ── Pending backlog check ──
    if (pending > FAIL_PENDING) {
      detail.push(`FAIL  ${jobType}: ${pending} pending jobs (backlog exceeds ${FAIL_PENDING})`);
      failures.push(`${jobType}: ${pending} pending jobs (large backlog)`);
    } else if (pending > WARN_PENDING) {
      detail.push(`WARN  ${jobType}: ${pending} pending jobs — below FAIL threshold of ${FAIL_PENDING}`);
      // Warn-only: not added to failures array
    }
  }

  return { detail, failures };
}

// ---------------------------------------------------------------------------
// Main check (performs fetch + evaluation)
// ---------------------------------------------------------------------------

export async function checkJobQueue(): Promise<CheckResult> {
  const name = 'Job queue';

  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL ?? '';
  const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY ?? '';

  if (!serverUrl) {
    return { name, ok: true, summary: 'Skipped (LONGTERMWIKI_SERVER_URL not set)' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let data: JobStatsResponse;
  try {
    const res = await fetch(`${serverUrl}/api/jobs/stats`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return {
        name,
        ok: true,
        summary: `Skipped (HTTP ${res.status} from /api/jobs/stats)`,
        detail: [`Jobs stats endpoint returned HTTP ${res.status}`],
      };
    }

    data = (await res.json()) as JobStatsResponse;
  } catch (err) {
    return {
      name,
      ok: true,
      summary: 'Skipped (jobs stats endpoint unreachable)',
      detail: [`Error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const { detail, failures } = evaluateJobStats(data);
  const totalJobs = data.totalJobs ?? 0;

  if (failures.length > 0) {
    return { name, ok: false, summary: 'Job queue issues detected', detail };
  }
  return { name, ok: true, summary: `Job queue healthy (${totalJobs} total jobs)`, detail };
}
