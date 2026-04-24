/**
 * Enrichment watchdog — QUA-643.
 *
 * Long-running bursts can accidentally burn budget if an agent goes into a
 * runaway loop or if the verdict-LLM rejection rate collapses (so the same
 * payload keeps re-costing the LLM). The watchdog polls an
 * `enrichment_runs.id` and computes the average $/hour over a recent
 * window. When that rate exceeds `maxSpendPerHour`, it:
 *
 *   1. Writes a kill marker file at `~/.cache/enrichment/kill-<runId>` — the
 *      burst loop is expected to check for this file between iterations and
 *      exit voluntarily. File-based kill, not a signal, because the
 *      subscription-mode Claude sessions run in separate tmux windows that
 *      the watchdog doesn't own (`.claude/rules/slot-isolation.md`).
 *   2. Optionally posts to a Discord webhook with a summary of the kill
 *      reason. Fail-silent if Discord is unreachable — the kill marker is
 *      the load-bearing signal.
 *   3. Returns `killed: true` so the caller can exit 2.
 *
 * Spend rate calculation:
 *   - Ask `/api/enrichment/runs?since=<now - windowMinutes>` for a snapshot.
 *   - Poll every `pollSeconds`; diff the cost_usd against the first sample's
 *     snapshot of the same row to compute the rate over the last
 *     `windowMinutes` minutes of *observed* activity.
 *   - If the DB doesn't have `windowMinutes` of runtime yet (e.g. run just
 *     started), require at least 3 minutes of observed delta before killing.
 *     Below that, we don't have enough signal to trust the rate.
 *
 * The watchdog is intentionally simple and file-based. Writing a full
 * streaming spend tracker is out of scope; the per-propose cost tracking
 * in enrichment_runs.cost_usd (added in QUA-643 Phase 4) is the primary
 * signal.
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { apiRequest } from '../wiki-server/client.ts';

export interface WatchdogOptions {
  runId: string;
  /** USD/hour cap. Hitting it triggers kill. */
  maxSpendPerHour: number;
  /** How far back to look for the spend signal. Default 30. */
  windowMinutes: number;
  /** Poll interval (seconds) between snapshots. */
  pollSeconds: number;
  /** Optional Discord webhook URL for kill alerts. */
  discordWebhook?: string;
  /** If true, run one check and return. Otherwise loop. */
  oneshot?: boolean;
  /** Override kill-marker dir (for tests). */
  killMarkerDir?: string;
  /** Hook for tests so we don't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Hook for tests so we don't actually post to Discord. */
  discordPost?: (webhook: string, body: unknown) => Promise<void>;
  /**
   * Optional snapshot fetcher override. Production callers leave this
   * unset and the watchdog hits /api/enrichment/runs. Tests pass a stub.
   */
  fetchSnapshot?: (runId: string) => Promise<WatchdogRunSnapshot | null>;
  /** Max iterations in loop mode (safety cap; tests use small values). */
  maxIterations?: number;
}

export interface WatchdogRunSnapshot {
  runId: string;
  costUsd: number;
  proposesAccepted: number;
  proposesRejected: number;
  updatedAt: string;
}

export interface WatchdogResult {
  killed: boolean;
  runId: string;
  /** Computed $/hour at the moment of decision. */
  spendPerHour: number;
  /** Observed delta (USD) between first and last sample. */
  deltaUsd: number;
  /** Observed delta (minutes) between first and last sample. */
  deltaMinutes: number;
  /** Human-readable one-line summary. */
  summary: string;
  killMarkerPath?: string;
}

const MIN_OBSERVATION_MINUTES = 3;

function killMarkerPathFor(runId: string, dir?: string): string {
  const base = dir ?? join(homedir(), '.cache', 'enrichment');
  // runId was already server-validated (≤64 chars, alphanumeric + dashes in
  // practice); we still sanitize here so an operator passing a weird local
  // id can't escape the cache dir.
  const safe = runId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  return join(base, `kill-${safe}`);
}

function writeKillMarker(runId: string, dir?: string): string {
  const path = killMarkerPathFor(runId, dir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `killed_at=${new Date().toISOString()}\n`);
  return path;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultDiscordPost(
  webhook: string,
  body: unknown,
): Promise<void> {
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Webhook is a best-effort notification; the kill marker is the
    // load-bearing signal. Swallow failures so the loop continues.
  }
}

/**
 * One poll of /api/enrichment/runs. Returns the matching row or null.
 * Exposed for tests; watchdog loops call this internally.
 */
export async function fetchRunSnapshot(
  runId: string,
): Promise<WatchdogRunSnapshot | null> {
  // Use the server's explicit id filter so the watchdog can't miss the
  // target run if it scrolls past the 50-row default page on a busy server.
  const encoded = encodeURIComponent(runId);
  const res = await apiRequest<{
    runs: Array<{
      id: string;
      costUsd: number;
      proposesAccepted: number;
      proposesRejected: number;
      updatedAt: string;
    }>;
  }>('GET', `/api/enrichment/runs?id=${encoded}`);
  if (!res.ok) return null;
  const match = res.data.runs.find((r) => r.id === runId);
  if (!match) return null;
  return {
    runId: match.id,
    costUsd: match.costUsd,
    proposesAccepted: match.proposesAccepted,
    proposesRejected: match.proposesRejected,
    updatedAt: match.updatedAt,
  };
}

/**
 * Compute $/hour from two snapshots. Pure function exported for tests.
 * Returns null when the observation window is too short (< 3 min) to
 * trust the rate.
 */
export function computeSpendRate(
  first: Pick<WatchdogRunSnapshot, 'costUsd' | 'updatedAt'>,
  last: Pick<WatchdogRunSnapshot, 'costUsd' | 'updatedAt'>,
): {
  spendPerHour: number;
  deltaUsd: number;
  deltaMinutes: number;
  reliable: boolean;
} {
  const deltaUsd = Math.max(0, last.costUsd - first.costUsd);
  const deltaMs =
    new Date(last.updatedAt).getTime() - new Date(first.updatedAt).getTime();
  const deltaMinutes = deltaMs / 60_000;
  const reliable = deltaMinutes >= MIN_OBSERVATION_MINUTES;
  const spendPerHour =
    deltaMinutes > 0 ? (deltaUsd / deltaMinutes) * 60 : 0;
  return { spendPerHour, deltaUsd, deltaMinutes, reliable };
}

/**
 * Core watchdog loop. Returns when --oneshot is true or when a kill fires.
 * Writes the kill marker + posts Discord before returning killed=true.
 */
export async function runWatchdog(
  opts: WatchdogOptions,
): Promise<WatchdogResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const discordPost = opts.discordPost ?? defaultDiscordPost;
  const fetchSnap = opts.fetchSnapshot ?? fetchRunSnapshot;
  const maxIterations = opts.maxIterations ?? 120; // 120 * 30s default = 1h

  // Ring buffer of recent snapshots. On each poll we trim entries older
  // than `windowMinutes` (by observed updatedAt) off the front, so the
  // oldest remaining sample is always the start of a window ≤ windowMinutes.
  // This avoids the "reset to current" blind spot that would hide runaway
  // spend for a full window after the buffer first fills up.
  const windowMs = opts.windowMinutes * 60_000;
  const recent: WatchdogRunSnapshot[] = [];

  for (let i = 0; i < maxIterations; i += 1) {
    const snap = await fetchSnap(opts.runId);
    if (!snap) {
      // Run id doesn't exist yet. In oneshot mode that's a skip; in loop
      // mode we wait for it to appear (the burst may have just started).
      if (opts.oneshot) {
        return {
          killed: false,
          runId: opts.runId,
          spendPerHour: 0,
          deltaUsd: 0,
          deltaMinutes: 0,
          summary: `run-id "${opts.runId}" not found yet (server has no rows). No action.`,
        };
      }
      await sleep(opts.pollSeconds * 1000);
      continue;
    }

    recent.push(snap);
    // Deduplicate consecutive identical snapshots (server hasn't ticked
    // since last poll) so the rate calculation stays stable.
    if (
      recent.length >= 2 &&
      recent[recent.length - 1].updatedAt ===
        recent[recent.length - 2].updatedAt
    ) {
      recent.pop();
    }

    const latest = recent[recent.length - 1];
    const latestMs = new Date(latest.updatedAt).getTime();
    // Trim anything older than windowMinutes — but keep at least one older
    // sample so we can compute a rate; if the oldest is already outside
    // the window, it becomes the "first" for a slightly-larger-than-window
    // measurement (more conservative, not less — we kill earlier, not later).
    while (
      recent.length > 2 &&
      latestMs - new Date(recent[0].updatedAt).getTime() > windowMs
    ) {
      recent.shift();
    }

    const first = recent[0];
    const rate = computeSpendRate(first, latest);
    if (rate.reliable && rate.spendPerHour > opts.maxSpendPerHour) {
      const markerPath = writeKillMarker(opts.runId, opts.killMarkerDir);
      const summary =
        `⚠ KILL: run ${opts.runId} at $${rate.spendPerHour.toFixed(2)}/h exceeds ` +
        `cap $${opts.maxSpendPerHour}/h (observed $${rate.deltaUsd.toFixed(2)} ` +
        `over ${rate.deltaMinutes.toFixed(1)} min). Marker: ${markerPath}`;
      if (opts.discordWebhook) {
        await discordPost(opts.discordWebhook, {
          content: summary,
          username: 'enrichment-watchdog',
        });
      }
      return {
        killed: true,
        runId: opts.runId,
        spendPerHour: rate.spendPerHour,
        deltaUsd: rate.deltaUsd,
        deltaMinutes: rate.deltaMinutes,
        summary,
        killMarkerPath: markerPath,
      };
    }

    if (opts.oneshot) {
      const reliableTag = rate.reliable ? '' : ' (window too short to trust)';
      return {
        killed: false,
        runId: opts.runId,
        spendPerHour: rate.spendPerHour,
        deltaUsd: rate.deltaUsd,
        deltaMinutes: rate.deltaMinutes,
        summary: `✓ run ${opts.runId} at $${rate.spendPerHour.toFixed(2)}/h (cap $${opts.maxSpendPerHour}/h)${reliableTag}`,
      };
    }

    await sleep(opts.pollSeconds * 1000);
  }

  // Exhausted maxIterations. Report the last observed rate without killing.
  const final =
    recent.length >= 2
      ? computeSpendRate(recent[0], recent[recent.length - 1])
      : { spendPerHour: 0, deltaUsd: 0, deltaMinutes: 0, reliable: false };
  return {
    killed: false,
    runId: opts.runId,
    spendPerHour: final.spendPerHour,
    deltaUsd: final.deltaUsd,
    deltaMinutes: final.deltaMinutes,
    summary: `watchdog exited after ${maxIterations} iterations; final rate $${final.spendPerHour.toFixed(2)}/h`,
  };
}

/** True if a kill marker already exists for this runId. Used by burst loops. */
export function isRunKilled(runId: string, dir?: string): boolean {
  return existsSync(killMarkerPathFor(runId, dir));
}
