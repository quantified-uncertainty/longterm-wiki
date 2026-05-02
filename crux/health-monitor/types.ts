/**
 * Health Monitor — Type definitions shared across the daemon.
 *
 * MVP scope per QUA-1048: two signals, no Linear posting yet.
 */

export interface HealthSnapshot {
  ts: string;                          // ISO timestamp of the sample
  pendingJobs: number | null;          // wiki-server /health.pendingJobs
  oldestPendingJobAgeSeconds: number | null;
  uptime: number | null;               // seconds since wiki-server start
  serverHealthy: boolean;              // /health returned 200 with status:"healthy"
  fetchError?: string;                 // populated when fetch failed
}

export interface CiSnapshot {
  ts: string;                          // when the GitHub poll happened
  lastGreenAt: string | null;          // ISO of most recent green main run, or null
  lastConclusion: string | null;       // conclusion of the most recent completed run
  /** Total completed runs in the sampled page — needed to disambiguate
   *  "no green found because no runs at all" from "no green found because
   *  the entire sampled window is non-green failures" (the second is a
   *  ci-stale alert; the first is just a quiet repo). */
  completedRunsSampled: number;
  /** ISO timestamp of the oldest completed run in the sampled page, or null
   *  if no runs were sampled. Used to attribute a synthetic age when no
   *  green run was found. */
  oldestSampledAt: string | null;
  fetchError?: string;
}

export type SignalId = 'ci-stale' | 'jobs-stuck';

export interface Alert {
  signal: SignalId;
  since: string;                       // first detection (preserved across cycles)
  detectedAt: string;                  // most recent confirmation
  context: Record<string, unknown>;    // signal-specific debug context
}

export interface DaemonConfig {
  pollIntervalSeconds: number;         // default 60
  ciCheckEveryNCycles: number;         // default 5 (≈5 min at 60s cadence)
  ciStaleThresholdSeconds: number;     // default 7200 (2h)
  jobsTrendWindowSeconds: number;      // default 900 (15 min)
  jobsTrendMinGrowthSeconds: number;   // default 720 (12 min — slack vs perfect 1:1)
  cacheDir: string;                    // default ~/.cache/health-monitor
  once?: boolean;                      // single cycle then exit
}
