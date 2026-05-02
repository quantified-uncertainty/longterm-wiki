/**
 * Health Monitor — Pure signal evaluation.
 *
 * No I/O — both functions take already-fetched snapshots and return a
 * decision. The daemon wraps these with cache + alert-file management.
 *
 * Signals:
 *   ci-stale    Last green main CI is older than threshold.
 *   jobs-stuck  pendingJobs > 0 with oldestPendingJobAgeSeconds growing
 *               for the trend window.
 */

import type { Alert, CiSnapshot, DaemonConfig, HealthSnapshot, SignalId } from './types.ts';

export interface SignalEvaluation {
  signal: SignalId;
  alert: Alert | null;       // non-null when the signal is currently breached
  reason: string;            // one-line human-readable explanation
}

export function evaluateCiStale(
  ci: CiSnapshot,
  config: Pick<DaemonConfig, 'ciStaleThresholdSeconds'>,
  nowMs = Date.now(),
): SignalEvaluation {
  const signal: SignalId = 'ci-stale';
  const tsIso = new Date(nowMs).toISOString();

  if (ci.fetchError) {
    return { signal, alert: null, reason: `ci-fetch-error: ${ci.fetchError}` };
  }

  // No green found in the sampled window. There are two sub-cases:
  //   (a) The repo is quiet — no completed runs at all on main. Don't alert.
  //   (b) Every sampled run is a non-success conclusion (failure, cancelled,
  //       timed out). The last green is older than the entire sample, so
  //       it's at least as stale as the oldest sample timestamp — that's
  //       exactly when ci-stale should fire loudest. Use the oldest sampled
  //       run's age as a *lower bound* for the synthetic age.
  // The earlier MVP missed (b): an all-failures sampled window returned
  // alert: null, suppressing the alert exactly when CI was most broken.
  // Caught in QUA-1048 review pass.
  if (!ci.lastGreenAt) {
    if (ci.completedRunsSampled === 0) {
      return { signal, alert: null, reason: 'no completed runs sampled' };
    }
    let syntheticAgeSeconds = config.ciStaleThresholdSeconds;
    let oldestForReason: string | null = null;
    if (ci.oldestSampledAt) {
      const oldestMs = new Date(ci.oldestSampledAt).getTime();
      if (!Number.isNaN(oldestMs)) {
        const ageFromOldest = Math.floor((nowMs - oldestMs) / 1000);
        if (ageFromOldest > syntheticAgeSeconds) syntheticAgeSeconds = ageFromOldest;
        oldestForReason = ci.oldestSampledAt;
      }
    }
    return {
      signal,
      alert: {
        signal,
        since: tsIso,
        detectedAt: tsIso,
        context: {
          lastGreenAt: null,
          lastConclusion: ci.lastConclusion,
          ageSeconds: syntheticAgeSeconds,
          thresholdSeconds: config.ciStaleThresholdSeconds,
          completedRunsSampled: ci.completedRunsSampled,
          oldestSampledAt: oldestForReason,
          syntheticAge: true,
        },
      },
      reason: `no green in last ${ci.completedRunsSampled} completed runs (≥ ${formatSeconds(syntheticAgeSeconds)} stale)`,
    };
  }

  const lastGreenMs = new Date(ci.lastGreenAt).getTime();
  if (Number.isNaN(lastGreenMs)) {
    return { signal, alert: null, reason: `unparseable lastGreenAt: ${ci.lastGreenAt}` };
  }

  const ageSeconds = Math.floor((nowMs - lastGreenMs) / 1000);
  if (ageSeconds < config.ciStaleThresholdSeconds) {
    return {
      signal,
      alert: null,
      reason: `last green ${formatSeconds(ageSeconds)} ago (under ${formatSeconds(config.ciStaleThresholdSeconds)})`,
    };
  }

  return {
    signal,
    alert: {
      signal,
      since: tsIso,
      detectedAt: tsIso,
      context: {
        lastGreenAt: ci.lastGreenAt,
        lastConclusion: ci.lastConclusion,
        ageSeconds,
        thresholdSeconds: config.ciStaleThresholdSeconds,
      },
    },
    reason: `last green ${formatSeconds(ageSeconds)} ago (over ${formatSeconds(config.ciStaleThresholdSeconds)})`,
  };
}

/**
 * Evaluate "queue is stuck" against a recent slice of HealthSnapshot history.
 *
 * The queue is "stuck" when:
 *   - We have ≥ 90% of the trend window worth of samples
 *   - Every sample in the window has pendingJobs > 0
 *   - oldestPendingJobAgeSeconds grew end-to-end by ≥ minGrowthSeconds
 *   - The newest oldestPendingJobAgeSeconds itself exceeds the trend window
 *     (else we're observing a fresh slow job, not an actually-stuck queue)
 *
 * If `pendingJobs` ever drops to 0 the queue drained normally and we don't
 * alert. If `oldestPendingJobAgeSeconds` declines, a worker picked something
 * up — also no alert. Strict monotonicity is NOT required: small dips can
 * happen when one job completes briefly between samples.
 */
export function evaluateJobsStuck(
  history: HealthSnapshot[],
  config: Pick<DaemonConfig, 'jobsTrendWindowSeconds' | 'jobsTrendMinGrowthSeconds'>,
): SignalEvaluation {
  const signal: SignalId = 'jobs-stuck';

  const usable = history.filter(
    (s) =>
      s.serverHealthy &&
      s.pendingJobs !== null &&
      s.oldestPendingJobAgeSeconds !== null,
  );

  if (usable.length < 2) {
    return {
      signal,
      alert: null,
      reason: `insufficient samples (${usable.length}) for trend analysis`,
    };
  }

  const sorted = [...usable].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const oldestMs = new Date(oldest.ts).getTime();
  const newestMs = new Date(newest.ts).getTime();
  const spanSeconds = (newestMs - oldestMs) / 1000;
  const requiredSpan = config.jobsTrendWindowSeconds * 0.9;

  if (spanSeconds < requiredSpan) {
    return {
      signal,
      alert: null,
      reason: `only ${formatSeconds(Math.floor(spanSeconds))} of samples (need ${formatSeconds(config.jobsTrendWindowSeconds)})`,
    };
  }

  if (sorted.some((s) => (s.pendingJobs ?? 0) <= 0)) {
    return { signal, alert: null, reason: 'queue drained at some point in window' };
  }

  const ageStart = oldest.oldestPendingJobAgeSeconds ?? 0;
  const ageEnd = newest.oldestPendingJobAgeSeconds ?? 0;
  const growthSeconds = ageEnd - ageStart;

  if (growthSeconds < config.jobsTrendMinGrowthSeconds) {
    return {
      signal,
      alert: null,
      reason: `oldest age grew only ${growthSeconds}s in window (need ${config.jobsTrendMinGrowthSeconds}s)`,
    };
  }

  if (ageEnd < config.jobsTrendWindowSeconds) {
    return {
      signal,
      alert: null,
      reason: `oldest job age (${ageEnd}s) shorter than window — possibly a fresh slow job`,
    };
  }

  return {
    signal,
    alert: {
      signal,
      since: oldest.ts,
      detectedAt: newest.ts,
      context: {
        windowStartAge: ageStart,
        windowEndAge: ageEnd,
        growthSeconds,
        pendingJobsLatest: newest.pendingJobs,
        sampleCount: sorted.length,
      },
    },
    reason: `oldest age grew ${growthSeconds}s over ${formatSeconds(Math.floor(spanSeconds))}; ${newest.pendingJobs} jobs pending`,
  };
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
