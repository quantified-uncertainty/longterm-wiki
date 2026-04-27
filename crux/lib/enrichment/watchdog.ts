/**
 * Spend-rate watchdog for defensive-enrichment bursts.
 *
 * Polls `enrichment_runs.cost_usd`, computes $/hour over a sliding window,
 * and writes `~/.cache/enrichment/kill-<runId>` when the rate exceeds the
 * cap. File-based because slot-isolation rules (`.claude/rules/slot-
 * isolation.md`) forbid cross-slot signals — the burst loop polls the
 * marker between iterations and exits voluntarily.
 *
 * The 3-minute reliability gate (see MIN_OBSERVATION_MINUTES) exists because
 * very short windows can show extreme rates from a single costly proposal
 * that aren't representative of steady-state spend.
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getRunById } from '../wiki-server/enrichment.ts';

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
  // Server's id filter short-circuits the 50-row LIMIT so the watchdog
  // can't miss its target run on a busy server.
  const res = await getRunById(runId);
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
