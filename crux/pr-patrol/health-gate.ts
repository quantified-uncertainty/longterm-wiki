/**
 * PR Patrol — Health gate (QUA-300 Phase 3).
 *
 * Wires the Phase 1 + Phase 2 scanners (health-scan.ts) into the patrol loop
 * as a precondition. When any health-scan sub-check is unhealthy, the gate
 *   1. emits an escalation entry to the JSONL log (coordinator reads this),
 *   2. logs a red warning to stderr for human visibility,
 *   3. tells the caller to skip PR scan/fix for this cycle.
 *
 * Cooldown: the same failure fingerprint is only re-emitted once per
 * HEALTH_GATE_COOLDOWN_MINUTES, so a hours-long outage doesn't spam the log.
 *
 * Escape hatch: `PATROL_DISABLE_HEALTH_GATE=1` bypasses the gate entirely.
 * Intended for emergencies where the gate itself is misbehaving. Logs loudly
 * when engaged.
 *
 * All dependencies (scanner, clock, JSONL writer, logger, env) are injectable
 * so the gate is unit-testable without network or filesystem.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { healthScan as realHealthScan, type HealthScanResult, type HealthIssue } from './health-scan.ts';
import { appendJsonl, JSONL_FILE, STATE_DIR, ensureDirs, cl, log as realLog } from './state.ts';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum gap between emissions of the same escalation fingerprint. Set to
 * 30min so a stuck prod deploy doesn't spam the log every patrol cycle (which
 * can run as often as every 5min), while still reminding the coordinator on a
 * human-comfortable cadence.
 */
export const HEALTH_GATE_COOLDOWN_MINUTES = 30;

/**
 * After this many consecutive scan failures, the gate flips from fail-open
 * ("proceed with caution") to fail-closed ("halt, something's wrong"). Without
 * this, a misconfigured env or removed GitHub endpoint would let patrol run
 * forever while pretending prod is healthy.
 */
export const MAX_CONSECUTIVE_SCAN_ERRORS = 3;

/** Env var to bypass the gate. Value `1` disables it. */
export const DISABLE_ENV_VAR = 'PATROL_DISABLE_HEALTH_GATE';

/** State file where last-emission timestamps per fingerprint are kept. */
const HEALTH_GATE_STATE_FILE = join(STATE_DIR, 'health-gate-cooldown.json');

/** Reserved fingerprint used to track consecutive scan-error count. */
const SCAN_ERROR_COUNTER_KEY = '__scan_error_count__';

// ── Types ────────────────────────────────────────────────────────────────────

export interface HealthGateDecision {
  /** True when the caller should proceed with normal PR scan/fix work. */
  proceed: boolean;
  /** Why we're skipping (empty string when proceeding). */
  reason: string;
  /** The full scan result (for logging / downstream use). */
  result: HealthScanResult;
  /** Issues that actually triggered an escalation (after cooldown filtering). */
  emittedIssues: HealthIssue[];
  /** Issues that were suppressed by cooldown. */
  suppressedIssues: HealthIssue[];
  /** True when the env escape hatch was engaged. */
  bypassed: boolean;
}

export interface HealthGateDeps {
  scan?: () => Promise<HealthScanResult>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** JSONL writer. Defaults to appendJsonl → ~/.cache/pr-patrol/runs.jsonl. */
  writeEvent?: (entry: Record<string, unknown>) => void;
  /** Human-visible log. Defaults to state.ts `log()` (stderr). */
  log?: (msg: string) => void;
  /** Cooldown store. Defaults to the on-disk JSON file. */
  cooldownStore?: {
    get: (fingerprint: string) => Date | null;
    set: (fingerprint: string, at: Date) => void;
    /** Read a plain numeric counter (for consecutive scan-error tracking). */
    getCount?: (key: string) => number;
    /** Write a plain numeric counter. */
    setCount?: (key: string, n: number) => void;
  };
}

// ── Fingerprinting ───────────────────────────────────────────────────────────

/**
 * Stable identifier for a health issue used for cooldown deduplication.
 * Collapses `deploy-stuck` issues to a single key per cycle even if the
 * failing run URL differs, so retries of the same deploy failure don't
 * keep resetting the cooldown.
 */
export function fingerprintIssue(issue: HealthIssue): string {
  // For ratchet drift we want separate cooldowns per file — include the reason
  // snippet that names the file. For deploy-stuck / main-ci-red, the type
  // alone is stable enough.
  if (issue.type === 'ratchet-drift') {
    // Extract the first word or two before "baseline" to scope per-file.
    const match = issue.reason.match(/^(\S+(?:\s\S+)?)\s+baseline/);
    return `ratchet-drift:${match?.[1] ?? 'unknown'}`;
  }
  return issue.type;
}

// ── Cooldown store (filesystem-backed) ───────────────────────────────────────

function readStore(): Record<string, string> {
  if (!existsSync(HEALTH_GATE_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(HEALTH_GATE_STATE_FILE, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Write atomically so concurrent patrol cycles can't clobber each other
 * mid-update: write to a unique temp file, then rename onto the target.
 * `rename` is atomic on POSIX (same filesystem). Race between readStore and
 * writeStore can still lose a concurrent update (last-writer-wins), but that's
 * acceptable for cooldown — worst case is one extra escalation emitted.
 */
function writeStore(store: Record<string, string>): void {
  ensureDirs();
  const tmp = `${HEALTH_GATE_STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, HEALTH_GATE_STATE_FILE);
}

function defaultCooldownStore() {
  return {
    get(fingerprint: string): Date | null {
      const iso = readStore()[fingerprint];
      return iso ? new Date(iso) : null;
    },
    set(fingerprint: string, at: Date): void {
      const store = readStore();
      store[fingerprint] = at.toISOString();
      writeStore(store);
    },
    getCount(key: string): number {
      const raw = readStore()[key];
      const n = raw ? Number.parseInt(raw, 10) : 0;
      return Number.isFinite(n) ? n : 0;
    },
    setCount(key: string, n: number): void {
      const store = readStore();
      store[key] = String(n);
      writeStore(store);
    },
  };
}

/** Build a stub HealthScanResult for the "scan failed" / "bypassed" paths. */
function syntheticScanFailureResult(message: string): HealthScanResult {
  return {
    healthy: true,
    deploy: {
      healthy: true,
      reason: `scan failed: ${message}`,
      lastSuccessfulDeployAt: null,
      failingDeploys: [],
    },
    mainCi: {
      healthy: true,
      reason: `scan failed: ${message}`,
      failingCount: 0,
      redStreakStarted: null,
      failingCommits: [],
    },
    ratchet: { healthy: true, reason: `scan failed: ${message}`, drifts: [] },
    issues: [],
  };
}

// ── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Run the health gate. Returns a decision telling the caller whether to
 * proceed with PR work. Side effects (JSONL event, log line, cooldown
 * update) happen via the injected deps.
 */
export async function runHealthGate(deps: HealthGateDeps = {}): Promise<HealthGateDecision> {
  const scan = deps.scan ?? realHealthScan;
  const nowFn = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const writeEvent = deps.writeEvent ?? ((entry) => appendJsonl(JSONL_FILE, entry));
  const log = deps.log ?? realLog;
  const cooldown = deps.cooldownStore ?? defaultCooldownStore();

  const now = nowFn();

  // Escape hatch first — if disabled, we never even run the scan. Rate-limit
  // the bypass warning via a dedicated fingerprint so the log isn't flooded
  // every cycle during an extended outage.
  if (env[DISABLE_ENV_VAR] === '1') {
    const BYPASS_FP = '__bypass_warning__';
    const lastBypassLog = cooldown.get(BYPASS_FP);
    const cooldownMs = HEALTH_GATE_COOLDOWN_MINUTES * 60_000;
    if (!lastBypassLog || now.getTime() - lastBypassLog.getTime() >= cooldownMs) {
      log(`${cl.yellow}⚠ ${DISABLE_ENV_VAR}=1 — health gate BYPASSED${cl.reset}`);
      cooldown.set(BYPASS_FP, now);
    }
    return {
      proceed: true,
      reason: '',
      result: syntheticScanFailureResult('health gate bypassed'),
      emittedIssues: [],
      suppressedIssues: [],
      bypassed: true,
    };
  }

  let result: HealthScanResult;
  try {
    result = await scan();
    // Successful scan — reset the consecutive-error counter so the halt-
    // threshold only fires on a true streak, not cumulative failures over days.
    cooldown.setCount?.(SCAN_ERROR_COUNTER_KEY, 0);
  } catch (e) {
    // Scanner failed. Policy: a transient GitHub hiccup shouldn't halt PR
    // work. But if the scanner fails N consecutive times, something's wrong
    // with our observability — flip to halt to prevent silent forever-proceed.
    const message = e instanceof Error ? e.message : String(e);
    const prevCount = cooldown.getCount?.(SCAN_ERROR_COUNTER_KEY) ?? 0;
    const newCount = prevCount + 1;
    cooldown.setCount?.(SCAN_ERROR_COUNTER_KEY, newCount);

    writeEvent({
      type: 'health_scan_error',
      timestamp: now.toISOString(),
      error: message,
      consecutive_errors: newCount,
    });

    if (newCount >= MAX_CONSECUTIVE_SCAN_ERRORS) {
      log(
        `${cl.red}✗ Health scan has failed ${newCount}× in a row — HALTING patrol work. ` +
          `Last error: ${message}${cl.reset}`,
      );
      return {
        proceed: false,
        reason: `scan failed ${newCount}× consecutively: ${message}`,
        result: syntheticScanFailureResult(message),
        emittedIssues: [],
        suppressedIssues: [],
        bypassed: false,
      };
    }

    log(
      `${cl.yellow}⚠ Health scan failed (${newCount}/${MAX_CONSECUTIVE_SCAN_ERRORS}) — ` +
        `proceeding with caution: ${message}${cl.reset}`,
    );
    return {
      proceed: true,
      reason: '',
      result: syntheticScanFailureResult(message),
      emittedIssues: [],
      suppressedIssues: [],
      bypassed: false,
    };
  }

  if (result.healthy) {
    return {
      proceed: true,
      reason: '',
      result,
      emittedIssues: [],
      suppressedIssues: [],
      bypassed: false,
    };
  }

  // System is unhealthy — split issues into emitted vs suppressed by cooldown.
  const emitted: HealthIssue[] = [];
  const suppressed: HealthIssue[] = [];
  const cooldownMs = HEALTH_GATE_COOLDOWN_MINUTES * 60_000;

  for (const issue of result.issues) {
    const fp = fingerprintIssue(issue);
    const last = cooldown.get(fp);
    if (last && now.getTime() - last.getTime() < cooldownMs) {
      suppressed.push(issue);
      continue;
    }
    emitted.push(issue);
    cooldown.set(fp, now);
  }

  // Always log + always skip PR work when unhealthy — even if every signal is
  // cooldown-suppressed. Suppression only affects whether we write another
  // JSONL escalation; the patrol still must not touch PRs while prod is red.
  for (const issue of emitted) {
    log(
      `${cl.red}✗ Health gate: ${issue.type} (score ${issue.score}) — ${issue.reason}${cl.reset}`,
    );
    writeEvent({
      type: 'health_gate_tripped',
      timestamp: now.toISOString(),
      issue_type: issue.type,
      score: issue.score,
      reason: issue.reason,
      url: issue.url ?? null,
    });
  }

  for (const issue of suppressed) {
    log(
      `${cl.dim}  (cooldown: ${issue.type} already escalated in the last ${HEALTH_GATE_COOLDOWN_MINUTES}min)${cl.reset}`,
    );
  }

  log(
    `${cl.red}Health gate: system unhealthy — skipping PR scan/fix this cycle.${cl.reset}`,
  );

  return {
    proceed: false,
    reason: result.issues.map((i) => `${i.type}: ${i.reason}`).join(' | '),
    result,
    emittedIssues: emitted,
    suppressedIssues: suppressed,
    bypassed: false,
  };
}
