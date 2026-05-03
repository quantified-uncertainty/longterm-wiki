/**
 * Health Monitor — Daemon main loop.
 *
 * Polls the wiki-server /health endpoint every `pollIntervalSeconds`,
 * polls GitHub workflow_runs every `ciCheckEveryNCycles` cycles, and
 * evaluates the two MVP signals from QUA-1048:
 *   - ci-stale: last green main CI > threshold
 *   - jobs-stuck: pendingJobs queue not draining for trend window
 *
 * State is written to ~/.cache/health-monitor/. The companion
 * scripts/inject-health-status.sh hook reads alert-* files and
 * surfaces them as <system-reminder> blocks on coord turns.
 */

import { existsSync } from 'fs';
import { githubApi, REPO } from '../lib/github.ts';
import { getApiKey, getServerUrl } from '../lib/wiki-server/client.ts';
import {
  appendHistory,
  clearAlert,
  clearPidFile,
  defaultCacheDir,
  ensureDirs,
  pidIsRunning,
  readAlert,
  readPidFile,
  readRecentHistory,
  trimHistory,
  writeAlert,
  writePidFile,
} from './state.ts';
import { evaluateCiStale, evaluateJobsStuck } from './signals.ts';
import type {
  Alert,
  CiSnapshot,
  DaemonConfig,
  HealthSnapshot,
  SignalId,
} from './types.ts';

const FETCH_TIMEOUT_MS = 15_000;
const CI_WORKFLOW = 'ci.yml';

export const DEFAULT_CONFIG: DaemonConfig = {
  pollIntervalSeconds: 60,
  ciCheckEveryNCycles: 5,
  ciStaleThresholdSeconds: 2 * 60 * 60,
  jobsTrendWindowSeconds: 15 * 60,
  jobsTrendMinGrowthSeconds: 12 * 60,
  cacheDir: defaultCacheDir(),
};

export function buildConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  // Clamp pacing to safe minimums. The CLI parser refuses 0/negative, but a
  // programmatic caller (or a future config-file path) could pass them.
  // Without this clamp, ciCheckEveryNCycles=0 makes `cycleNum % 0` = NaN
  // (always false after cycle 0), silently disabling CI checks forever.
  if (merged.pollIntervalSeconds < 1) merged.pollIntervalSeconds = 1;
  if (merged.ciCheckEveryNCycles < 1) merged.ciCheckEveryNCycles = 1;
  if (merged.jobsTrendWindowSeconds < 60) merged.jobsTrendWindowSeconds = 60;
  if (merged.jobsTrendMinGrowthSeconds < 0) merged.jobsTrendMinGrowthSeconds = 0;
  if (merged.ciStaleThresholdSeconds < 60) merged.ciStaleThresholdSeconds = 60;
  return merged;
}

interface HealthEndpointResponse {
  status?: string;
  pendingJobs?: number | null;
  oldestPendingJobAgeSeconds?: number | null;
  uptime?: number | null;
}

interface WorkflowRun {
  conclusion: string | null;
  created_at: string;
}

interface WorkflowRunsResponse {
  workflow_runs?: WorkflowRun[];
}

/** Always returns a snapshot — wraps fetch errors into the snapshot itself. */
export async function fetchHealthSnapshot(nowMs = Date.now()): Promise<HealthSnapshot> {
  const ts = new Date(nowMs).toISOString();
  const url = getServerUrl();
  if (!url) {
    return {
      ts,
      pendingJobs: null,
      oldestPendingJobAgeSeconds: null,
      uptime: null,
      serverHealthy: false,
      fetchError: 'wiki-server URL not set',
    };
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = getApiKey();
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const res = await fetch(`${url}/health`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ts,
        pendingJobs: null,
        oldestPendingJobAgeSeconds: null,
        uptime: null,
        serverHealthy: false,
        fetchError: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as HealthEndpointResponse;
    // `serverHealthy` means "we received parseable queue-state data" — NOT
    // strictly "the server reports status:healthy". A server returning
    // `{status:"degraded"}` with a numeric pendingJobs still gives us valid
    // queue information; we want jobs-stuck evaluation to consider those
    // samples. The reviewer caught this in the QUA-1048 review pass: the
    // earlier strict `status === 'healthy'` check let a degraded-but-
    // responsive server silently discard its own queue data.
    const hasQueueData =
      typeof data.pendingJobs === 'number' &&
      (data.oldestPendingJobAgeSeconds === null ||
        typeof data.oldestPendingJobAgeSeconds === 'number');
    return {
      ts,
      pendingJobs: data.pendingJobs ?? null,
      oldestPendingJobAgeSeconds: data.oldestPendingJobAgeSeconds ?? null,
      uptime: data.uptime ?? null,
      serverHealthy: hasQueueData,
    };
  } catch (err) {
    return {
      ts,
      pendingJobs: null,
      oldestPendingJobAgeSeconds: null,
      uptime: null,
      serverHealthy: false,
      fetchError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Always returns a snapshot — wraps fetch errors into the snapshot. */
export async function fetchCiSnapshot(nowMs = Date.now()): Promise<CiSnapshot> {
  const ts = new Date(nowMs).toISOString();
  try {
    const resp = await githubApi<WorkflowRunsResponse>(
      `/repos/${REPO}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&status=completed&per_page=10`,
    );
    const runs = resp.workflow_runs ?? [];
    if (runs.length === 0) {
      return {
        ts,
        lastGreenAt: null,
        lastConclusion: null,
        completedRunsSampled: 0,
        oldestSampledAt: null,
      };
    }
    const lastGreen = runs.find((r) => r.conclusion === 'success');
    // GitHub returns workflow_runs newest-first. The oldest sampled run is
    // the last in the list — we use it as a lower-bound for the ci-stale
    // synthetic age when no green is found in the page.
    const oldest = runs[runs.length - 1];
    return {
      ts,
      lastGreenAt: lastGreen?.created_at ?? null,
      lastConclusion: runs[0].conclusion,
      completedRunsSampled: runs.length,
      oldestSampledAt: oldest.created_at ?? null,
    };
  } catch (err) {
    return {
      ts,
      lastGreenAt: null,
      lastConclusion: null,
      completedRunsSampled: 0,
      oldestSampledAt: null,
      fetchError: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CycleEvaluation {
  signal: SignalId;
  reason: string;
  alerting: boolean;
}

export interface CycleResult {
  health: HealthSnapshot;
  ci: CiSnapshot | null;
  evaluations: CycleEvaluation[];
}

/**
 * Run a single check cycle: fetch /health, optionally fetch CI, evaluate
 * signals, and update alert files. Returns a summary for logging.
 *
 * `cycleNum` controls CI rate-limiting — CI is only fetched on cycle 0
 * and every Nth cycle thereafter.
 */
export async function runCycle(
  config: DaemonConfig,
  cycleNum: number,
  nowMs = Date.now(),
): Promise<CycleResult> {
  ensureDirs(config.cacheDir);

  const health = await fetchHealthSnapshot(nowMs);
  appendHistory(config.cacheDir, health);

  const shouldFetchCi = cycleNum === 0 || cycleNum % config.ciCheckEveryNCycles === 0;
  const ci = shouldFetchCi ? await fetchCiSnapshot(nowMs) : null;

  const evaluations: CycleEvaluation[] = [];

  if (ci) {
    const ev = evaluateCiStale(ci, config, nowMs);
    evaluations.push({ signal: ev.signal, reason: ev.reason, alerting: !!ev.alert });
    if (ev.alert) {
      const merged = mergePreservingSince(config.cacheDir, ev.alert);
      writeAlert(config.cacheDir, merged);
    } else if (!ci.fetchError) {
      // Only clear when the fetch actually succeeded — a transient API
      // outage shouldn't drop an active alert.
      clearAlert(config.cacheDir, ev.signal);
    }
  }

  // jobs-stuck always evaluates against the most recent history slice
  const recent = readRecentHistory(config.cacheDir, config.jobsTrendWindowSeconds, nowMs);
  const jobsEv = evaluateJobsStuck(recent, config);
  evaluations.push({ signal: jobsEv.signal, reason: jobsEv.reason, alerting: !!jobsEv.alert });
  if (jobsEv.alert) {
    const merged = mergePreservingSince(config.cacheDir, jobsEv.alert);
    writeAlert(config.cacheDir, merged);
  } else if (health.serverHealthy) {
    // Same logic as ci-stale: only clear when we actually saw the server.
    clearAlert(config.cacheDir, jobsEv.signal);
  }

  // Bound disk usage — keep ~2x trend window of history
  trimHistory(config.cacheDir, config.jobsTrendWindowSeconds * 2, nowMs);

  return { health, ci, evaluations };
}

function mergePreservingSince(cacheDir: string, fresh: Alert): Alert {
  const existing = readAlert(cacheDir, fresh.signal);
  if (!existing) return fresh;
  return { ...fresh, since: existing.since };
}

/** Run the daemon loop. Sets a singleton lock and respects SIGTERM/SIGINT. */
export async function runDaemon(config: DaemonConfig = DEFAULT_CONFIG): Promise<void> {
  ensureDirs(config.cacheDir);

  const existing = readPidFile(config.cacheDir);
  if (existing && existing !== process.pid && pidIsRunning(existing)) {
    console.error(`[health-monitor] another daemon is running (pid ${existing}); exiting`);
    return;
  }
  writePidFile(config.cacheDir, process.pid);

  const cleanup = () => {
    const cur = readPidFile(config.cacheDir);
    if (cur === process.pid) clearPidFile(config.cacheDir);
  };
  const onSig = () => {
    cleanup();
    process.exit(0);
  };
  process.on('SIGTERM', onSig);
  process.on('SIGINT', onSig);
  process.on('exit', cleanup);

  console.error(
    `[health-monitor] starting (pid ${process.pid}, cache ${config.cacheDir})`,
  );
  console.error(
    `[health-monitor] poll=${config.pollIntervalSeconds}s ci-every=${config.ciCheckEveryNCycles} ci-stale=${config.ciStaleThresholdSeconds}s jobs-window=${config.jobsTrendWindowSeconds}s`,
  );

  let cycleNum = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await runCycle(config, cycleNum);
      const tag = `cycle=${cycleNum}`;
      const evs = result.evaluations
        .map((e) => `${e.signal}=${e.alerting ? 'ALERT' : 'ok'}`)
        .join(' ');
      console.error(`[health-monitor] ${tag} ${evs}`);
      for (const e of result.evaluations) {
        console.error(`[health-monitor]   ${e.signal}: ${e.reason}`);
      }
    } catch (err) {
      console.error(
        `[health-monitor] cycle error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (config.once) break;
    cycleNum++;
    await sleep(config.pollIntervalSeconds * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface DaemonStatus {
  pid: number | null;
  running: boolean;
  alerts: Alert[];
  recentSampleCount: number;
  cacheDir: string;
}

export function getDaemonStatus(
  cacheDir: string = defaultCacheDir(),
  nowMs = Date.now(),
): DaemonStatus {
  const pid = readPidFile(cacheDir);
  const running = pid !== null && pidIsRunning(pid);
  const alerts: Alert[] = [];
  for (const sig of ['ci-stale', 'jobs-stuck'] as SignalId[]) {
    const a = readAlert(cacheDir, sig);
    if (a) alerts.push(a);
  }
  const recentSampleCount = existsSync(cacheDir)
    ? readRecentHistory(cacheDir, 30 * 60, nowMs).length
    : 0;
  return { pid, running, alerts, recentSampleCount, cacheDir };
}
