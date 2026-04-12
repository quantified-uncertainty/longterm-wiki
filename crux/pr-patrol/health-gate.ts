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

import { existsSync, readFileSync, writeFileSync } from 'fs';
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

/** Env var to bypass the gate. Value `1` disables it. */
export const DISABLE_ENV_VAR = 'PATROL_DISABLE_HEALTH_GATE';

/** State file where last-emission timestamps per fingerprint are kept. */
const HEALTH_GATE_STATE_FILE = join(STATE_DIR, 'health-gate-cooldown.json');

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

function defaultCooldownStore() {
  return {
    get(fingerprint: string): Date | null {
      if (!existsSync(HEALTH_GATE_STATE_FILE)) return null;
      try {
        const raw = JSON.parse(readFileSync(HEALTH_GATE_STATE_FILE, 'utf-8')) as Record<
          string,
          string
        >;
        const iso = raw[fingerprint];
        return iso ? new Date(iso) : null;
      } catch {
        return null;
      }
    },
    set(fingerprint: string, at: Date): void {
      ensureDirs();
      let store: Record<string, string> = {};
      if (existsSync(HEALTH_GATE_STATE_FILE)) {
        try {
          store = JSON.parse(readFileSync(HEALTH_GATE_STATE_FILE, 'utf-8')) as Record<
            string,
            string
          >;
        } catch {
          /* ignore parse errors — treat as empty */
        }
      }
      store[fingerprint] = at.toISOString();
      writeFileSync(HEALTH_GATE_STATE_FILE, JSON.stringify(store, null, 2));
    },
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

  // Escape hatch first — if disabled, we never even run the scan.
  if (env[DISABLE_ENV_VAR] === '1') {
    log(`${cl.yellow}⚠ ${DISABLE_ENV_VAR}=1 — health gate BYPASSED${cl.reset}`);
    // Build a minimal synthetic "healthy" result so downstream consumers don't
    // have to special-case the bypass path.
    const synthetic: HealthScanResult = {
      healthy: true,
      deploy: {
        healthy: true,
        reason: 'health gate bypassed',
        lastSuccessfulDeployAt: null,
        failingDeploys: [],
      },
      mainCi: {
        healthy: true,
        reason: 'health gate bypassed',
        failingCount: 0,
        redStreakStarted: null,
        failingCommits: [],
      },
      ratchet: {
        healthy: true,
        reason: 'health gate bypassed',
        drifts: [],
      },
      issues: [],
    };
    return {
      proceed: true,
      reason: '',
      result: synthetic,
      emittedIssues: [],
      suppressedIssues: [],
      bypassed: true,
    };
  }

  let result: HealthScanResult;
  try {
    result = await scan();
  } catch (e) {
    // Scanner failed (GitHub 5xx, rate limit, network). Don't silently look
    // healthy — log and let the patrol proceed. Policy choice: a transient
    // GitHub hiccup shouldn't halt PR work, but it also shouldn't masquerade
    // as "all clear". Record the failure, keep going.
    const message = e instanceof Error ? e.message : String(e);
    log(`${cl.yellow}⚠ Health scan failed — proceeding with caution: ${message}${cl.reset}`);
    writeEvent({
      type: 'health_scan_error',
      timestamp: now.toISOString(),
      error: message,
    });
    return {
      proceed: true,
      reason: '',
      result: {
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
      },
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
