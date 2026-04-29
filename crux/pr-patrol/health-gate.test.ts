import { describe, it, expect } from 'vitest';

import { MissingTokenError } from '../lib/github.ts';
import {
  runHealthGate,
  fingerprintIssue,
  HEALTH_GATE_COOLDOWN_MINUTES,
  MAX_CONSECUTIVE_SCAN_ERRORS,
  DISABLE_ENV_VAR,
  type HealthGateDeps,
} from './health-gate.ts';
import { handlePermanentFault, type PermanentFaultDeps } from './index.ts';
import type { HealthScanResult, HealthIssue } from './health-scan.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-12T20:00:00Z');

function healthyScan(): HealthScanResult {
  return {
    healthy: true,
    deploy: {
      healthy: true,
      reason: 'latest production deploy succeeded',
      lastSuccessfulDeployAt: NOW,
      failingDeploys: [],
    },
    mainCi: {
      healthy: true,
      reason: 'latest main CI runs succeeded',
      failingCount: 0,
      redStreakStarted: null,
      failingCommits: [],
    },
    ratchet: {
      healthy: true,
      reason: 'all ratchet baselines within thresholds',
      drifts: [],
    },
    issues: [],
  };
}

function unhealthyScan(issues: HealthIssue[]): HealthScanResult {
  return {
    healthy: false,
    deploy: {
      healthy: issues.every((i) => i.type !== 'deploy-stuck'),
      reason: '',
      lastSuccessfulDeployAt: null,
      failingDeploys: [],
    },
    mainCi: {
      healthy: issues.every((i) => i.type !== 'main-ci-red'),
      reason: '',
      failingCount: 0,
      redStreakStarted: null,
      failingCommits: [],
    },
    ratchet: {
      healthy: issues.every((i) => i.type !== 'ratchet-drift'),
      reason: '',
      drifts: [],
    },
    issues,
  };
}

function deployStuckIssue(overrides: Partial<HealthIssue> = {}): HealthIssue {
  return {
    type: 'deploy-stuck',
    score: 200,
    reason: '2 consecutive production deploy failures',
    url: 'https://example.com/run/1',
    detectedAt: NOW.toISOString(),
    ...overrides,
  };
}

/**
 * In-memory cooldown store used across tests. Reset between tests.
 */
function inMemoryCooldown() {
  const map = new Map<string, Date>();
  const counts = new Map<string, number>();
  return {
    get: (fp: string) => map.get(fp) ?? null,
    set: (fp: string, at: Date) => {
      map.set(fp, at);
    },
    getCount: (key: string) => counts.get(key) ?? 0,
    setCount: (key: string, n: number) => {
      counts.set(key, n);
    },
    _map: map,
    _counts: counts,
  };
}

function makeDeps(overrides: Partial<HealthGateDeps> = {}): HealthGateDeps & {
  events: Array<Record<string, unknown>>;
  logs: string[];
} {
  const events: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  return {
    now: () => NOW,
    // Default env has GITHUB_TOKEN present. The dedicated missing-token tests
    // override this with an empty env or a stripped-token env (QUA-395).
    env: { GITHUB_TOKEN: 'test-token' },
    writeEvent: (entry) => events.push(entry),
    log: (msg) => logs.push(msg),
    cooldownStore: inMemoryCooldown(),
    ...overrides,
    events,
    logs,
  };
}

// ── Env escape hatch ─────────────────────────────────────────────────────────

describe('runHealthGate — env escape hatch', () => {
  it(`bypasses the gate when ${DISABLE_ENV_VAR}=1`, async () => {
    const deps = makeDeps({ env: { [DISABLE_ENV_VAR]: '1' } });
    // Scanner should NOT be called — use one that throws if invoked.
    const scan = async () => {
      throw new Error('scanner should not be called when gate is bypassed');
    };
    const decision = await runHealthGate({ ...deps, scan });
    expect(decision.proceed).toBe(true);
    expect(decision.bypassed).toBe(true);
    // Bypass NEVER reports a permanent fault — the operator explicitly opted
    // into ignoring the gate, so the daemon must not exit on this path.
    expect(decision.permanentFault).toBe(false);
    expect(deps.logs.some((l) => l.includes('BYPASSED'))).toBe(true);
    expect(deps.events).toHaveLength(0);
  });

  it('does NOT bypass when env var is unset', async () => {
    const deps = makeDeps({ env: { GITHUB_TOKEN: 'test-token' } });
    const decision = await runHealthGate({
      ...deps,
      scan: async () => unhealthyScan([deployStuckIssue()]),
    });
    expect(decision.bypassed).toBe(false);
    expect(decision.proceed).toBe(false);
  });

  it('does NOT bypass when env var is set to "0"', async () => {
    const deps = makeDeps({ env: { [DISABLE_ENV_VAR]: '0', GITHUB_TOKEN: 'test-token' } });
    const decision = await runHealthGate({
      ...deps,
      scan: async () => healthyScan(),
    });
    expect(decision.bypassed).toBe(false);
  });

  it('rate-limits the bypass warning across cycles (log spam mitigation)', async () => {
    const store = inMemoryCooldown();
    const logs: string[] = [];
    const common = {
      env: { [DISABLE_ENV_VAR]: '1' },
      writeEvent: () => {},
      log: (msg: string) => logs.push(msg),
      cooldownStore: store,
      scan: async () => healthyScan(),
    };

    await runHealthGate({ ...common, now: () => NOW });
    const soonAfter = new Date(NOW.getTime() + 5 * 60_000);
    await runHealthGate({ ...common, now: () => soonAfter });
    const wayLater = new Date(NOW.getTime() + (HEALTH_GATE_COOLDOWN_MINUTES + 1) * 60_000);
    await runHealthGate({ ...common, now: () => wayLater });

    const bypassLogs = logs.filter((l) => l.includes('BYPASSED'));
    expect(bypassLogs).toHaveLength(2); // first, and one after cooldown elapsed
  });
});

// ── Healthy path ─────────────────────────────────────────────────────────────

describe('runHealthGate — healthy', () => {
  it('returns proceed=true with no events when all scanners green', async () => {
    const deps = makeDeps();
    const decision = await runHealthGate({ ...deps, scan: async () => healthyScan() });
    expect(decision.proceed).toBe(true);
    expect(decision.emittedIssues).toHaveLength(0);
    expect(deps.events).toHaveLength(0);
  });
});

// ── Missing GITHUB_TOKEN (QUA-395) ───────────────────────────────────────────

describe('runHealthGate — missing GITHUB_TOKEN', () => {
  it('halts immediately when GITHUB_TOKEN is unset (does not call scan)', async () => {
    const deps = makeDeps({ env: {} });
    let scanCalled = false;
    const decision = await runHealthGate({
      ...deps,
      scan: async () => {
        scanCalled = true;
        return healthyScan();
      },
    });

    expect(scanCalled).toBe(false);
    expect(decision.proceed).toBe(false);
    expect(decision.bypassed).toBe(false);
    expect(decision.permanentFault).toBe(true);
    expect(decision.reason).toContain('GITHUB_TOKEN');
    expect(deps.events).toHaveLength(1);
    expect(deps.events[0]).toMatchObject({
      type: 'health_gate_missing_token',
      reason: 'GITHUB_TOKEN not set in environment',
    });
    expect(deps.logs.some((l) => l.includes('GITHUB_TOKEN not set'))).toBe(true);
  });

  it('halts immediately when GITHUB_TOKEN is empty string (falsy)', async () => {
    const deps = makeDeps({ env: { GITHUB_TOKEN: '' } });
    const decision = await runHealthGate({
      ...deps,
      scan: async () => healthyScan(),
    });
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toContain('GITHUB_TOKEN');
    expect(decision.permanentFault).toBe(true);
  });

  it('resets the consecutive-error counter when halting on missing token', async () => {
    // Pre-populate: 2 prior scan errors. Missing token should wipe this so
    // a subsequent real scan isn't artificially near MAX_CONSECUTIVE_SCAN_ERRORS.
    const store = inMemoryCooldown();
    store.setCount('__scan_error_count__', MAX_CONSECUTIVE_SCAN_ERRORS - 1);
    const deps = makeDeps({ env: {}, cooldownStore: store });

    await runHealthGate({
      ...deps,
      scan: async () => healthyScan(),
    });
    expect(store.getCount('__scan_error_count__')).toBe(0);
  });

  it('bypass env var still takes precedence over missing-token halt', async () => {
    // Operator explicitly bypassing the gate — respect it even when the
    // token is missing. Without this, bypass couldn't rescue a stuck patrol.
    const deps = makeDeps({ env: { [DISABLE_ENV_VAR]: '1' } }); // no GITHUB_TOKEN
    const decision = await runHealthGate({
      ...deps,
      scan: async () => {
        throw new Error('scan should not be called when bypassed');
      },
    });
    expect(decision.bypassed).toBe(true);
    expect(decision.proceed).toBe(true);
  });

  it('classifies token errors thrown from scan as permanent (not counted as transient)', async () => {
    // Edge case: env.GITHUB_TOKEN looks present at gate entry, but the scan's
    // internal call to getGitHubToken() reads process.env and finds nothing.
    // The error bubbles up and we classify it as permanent — no counter bump.
    const store = inMemoryCooldown();
    store.setCount('__scan_error_count__', 0);
    const deps = makeDeps({ cooldownStore: store });

    const decision = await runHealthGate({
      ...deps,
      scan: async () => {
        throw new MissingTokenError();
      },
    });

    expect(decision.proceed).toBe(false);
    expect(decision.reason).toContain('GITHUB_TOKEN');
    expect(decision.permanentFault).toBe(true);
    // Counter did not tick up — permanent errors shouldn't use streak budget.
    expect(store.getCount('__scan_error_count__')).toBe(0);
    expect(deps.events.some((e) => e.type === 'health_gate_missing_token')).toBe(true);
  });

  it('does NOT misclassify unrelated errors as missing-token', async () => {
    // Regression: a generic "GitHub API 500" mustn't get caught by the token
    // classifier. Normal errors go through the consecutive-error path.
    const deps = makeDeps();
    const decision = await runHealthGate({
      ...deps,
      scan: async () => {
        throw new Error('GitHub API returned 500');
      },
    });
    expect(decision.proceed).toBe(true);
    expect(deps.events[0]).toMatchObject({ type: 'health_scan_error' });
  });

  it('does NOT misclassify errors that merely echo the legacy signal string', async () => {
    // QUA-482: the classifier now uses `instanceof MissingTokenError`, not
    // substring-matching. A generic Error whose message happens to contain
    // 'GITHUB_TOKEN not set' (e.g. a log line echoed back from a subprocess)
    // must NOT trip the permanent-halt path.
    const deps = makeDeps();
    const decision = await runHealthGate({
      ...deps,
      scan: async () => {
        throw new Error(
          'upstream log: "GITHUB_TOKEN not set" appeared in a prior run',
        );
      },
    });
    expect(decision.proceed).toBe(true);
    // Use `.some()` rather than `events[0]` so the assertion survives a
    // future refactor that adds a leading event (e.g. a telemetry marker).
    expect(deps.events.some((e) => e.type === 'health_scan_error')).toBe(true);
    expect(
      deps.events.some((e) => e.type === 'health_gate_missing_token'),
    ).toBe(false);
  });
});

// ── Scanner failure ──────────────────────────────────────────────────────────

describe('runHealthGate — scanner error', () => {
  it('logs + records an error event + lets patrol proceed on the first failure', async () => {
    const deps = makeDeps();
    const decision = await runHealthGate({
      ...deps,
      scan: async () => {
        throw new Error('GitHub API 503');
      },
    });
    expect(decision.proceed).toBe(true);
    expect(decision.permanentFault).toBe(false);
    expect(deps.events).toHaveLength(1);
    expect(deps.events[0]).toMatchObject({
      type: 'health_scan_error',
      error: 'GitHub API 503',
      consecutive_errors: 1,
    });
  });

  it(`HALTS patrol after ${MAX_CONSECUTIVE_SCAN_ERRORS} consecutive failures (regression: fail-open-forever risk)`, async () => {
    const store = inMemoryCooldown();
    const deps = { ...makeDeps({ cooldownStore: store }) };
    const scan = async () => {
      throw new Error('missing API key');
    };

    let lastDecision;
    for (let i = 0; i < MAX_CONSECUTIVE_SCAN_ERRORS; i++) {
      lastDecision = await runHealthGate({ ...deps, scan });
    }
    // First N-1 proceed; Nth halts
    expect(lastDecision!.proceed).toBe(false);
    expect(lastDecision!.reason).toContain('consecutively');
    // QUA-799: a transient streak halt is NOT a permanent fault — the
    // daemon should keep cycling (the streak may clear when GitHub recovers),
    // unlike a missing-token halt which exits the daemon outright.
    expect(lastDecision!.permanentFault).toBe(false);
    expect(store.getCount('__scan_error_count__')).toBe(MAX_CONSECUTIVE_SCAN_ERRORS);
  });

  it('resets the error counter on a successful scan (so the halt only fires on a true streak)', async () => {
    const store = inMemoryCooldown();
    // Pre-populate: 2 consecutive errors (1 short of halt)
    store.setCount('__scan_error_count__', MAX_CONSECUTIVE_SCAN_ERRORS - 1);
    const deps = { ...makeDeps({ cooldownStore: store }) };

    // One successful scan clears the counter
    await runHealthGate({ ...deps, scan: async () => healthyScan() });
    expect(store.getCount('__scan_error_count__')).toBe(0);

    // Now a single failure should NOT halt (counter restarted from 0)
    const decision = await runHealthGate({
      ...deps,
      scan: async () => {
        throw new Error('transient');
      },
    });
    expect(decision.proceed).toBe(true);
  });
});

// ── Unhealthy path ───────────────────────────────────────────────────────────

describe('runHealthGate — unhealthy', () => {
  it('returns proceed=false, emits a JSONL event for each issue', async () => {
    const deps = makeDeps();
    const decision = await runHealthGate({
      ...deps,
      scan: async () =>
        unhealthyScan([
          deployStuckIssue(),
          {
            type: 'main-ci-red',
            score: 180,
            reason: '3 consecutive main failures',
            detectedAt: NOW.toISOString(),
          },
        ]),
    });
    expect(decision.proceed).toBe(false);
    expect(decision.emittedIssues).toHaveLength(2);
    expect(deps.events).toHaveLength(2);
    expect(deps.events[0]).toMatchObject({
      type: 'health_gate_tripped',
      issue_type: 'deploy-stuck',
      score: 200,
    });
    expect(deps.events[1]).toMatchObject({
      type: 'health_gate_tripped',
      issue_type: 'main-ci-red',
    });
  });

  it('skips PR work even when every signal is cooldown-suppressed', async () => {
    const store = inMemoryCooldown();
    // Pre-populate: deploy-stuck emitted 10min ago (within cooldown).
    store.set('deploy-stuck', new Date(NOW.getTime() - 10 * 60_000));

    const deps = makeDeps({ cooldownStore: store });
    const decision = await runHealthGate({
      ...deps,
      scan: async () => unhealthyScan([deployStuckIssue()]),
    });

    expect(decision.proceed).toBe(false); // MUST skip even with cooldown
    expect(decision.emittedIssues).toHaveLength(0);
    expect(decision.suppressedIssues).toHaveLength(1);
    expect(deps.events).toHaveLength(0); // no new JSONL emission
  });

  it('reports permanentFault=false for fleet-level signals (deploy-stuck etc.)', async () => {
    // QUA-799 regression: deploy-stuck and similar signals are transient by
    // construction — the patrol should keep cycling and re-checking. Only
    // missing-token sets permanentFault.
    const deps = makeDeps();
    const decision = await runHealthGate({
      ...deps,
      scan: async () => unhealthyScan([deployStuckIssue()]),
    });
    expect(decision.proceed).toBe(false);
    expect(decision.permanentFault).toBe(false);
  });
});

// ── Cooldown ─────────────────────────────────────────────────────────────────

describe('runHealthGate — cooldown', () => {
  it('emits once, then suppresses a repeat within the cooldown window', async () => {
    const store = inMemoryCooldown();
    const events: Array<Record<string, unknown>> = [];

    // First call — no prior state, should emit.
    await runHealthGate({
      now: () => NOW,
      env: { GITHUB_TOKEN: "test-token" },
      writeEvent: (e) => events.push(e),
      log: () => {},
      cooldownStore: store,
      scan: async () => unhealthyScan([deployStuckIssue()]),
    });
    expect(events).toHaveLength(1);

    // Second call, 5min later (well under 30min cooldown). Should suppress.
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const decision = await runHealthGate({
      now: () => later,
      env: { GITHUB_TOKEN: "test-token" },
      writeEvent: (e) => events.push(e),
      log: () => {},
      cooldownStore: store,
      scan: async () => unhealthyScan([deployStuckIssue()]),
    });
    expect(events).toHaveLength(1); // no new event
    expect(decision.emittedIssues).toHaveLength(0);
    expect(decision.suppressedIssues).toHaveLength(1);
    expect(decision.proceed).toBe(false);
  });

  it('re-emits after the cooldown window has passed', async () => {
    const store = inMemoryCooldown();
    const events: Array<Record<string, unknown>> = [];

    await runHealthGate({
      now: () => NOW,
      env: { GITHUB_TOKEN: "test-token" },
      writeEvent: (e) => events.push(e),
      log: () => {},
      cooldownStore: store,
      scan: async () => unhealthyScan([deployStuckIssue()]),
    });

    const wayLater = new Date(NOW.getTime() + (HEALTH_GATE_COOLDOWN_MINUTES + 1) * 60_000);
    await runHealthGate({
      now: () => wayLater,
      env: { GITHUB_TOKEN: "test-token" },
      writeEvent: (e) => events.push(e),
      log: () => {},
      cooldownStore: store,
      scan: async () => unhealthyScan([deployStuckIssue()]),
    });

    expect(events).toHaveLength(2);
  });

  it('cooldowns are fingerprint-scoped (ratchet-drift for different files do not suppress each other)', async () => {
    const store = inMemoryCooldown();
    const events: Array<Record<string, unknown>> = [];

    const driftA: HealthIssue = {
      type: 'ratchet-drift',
      score: 150,
      reason: 'sourcing baseline bumped 3× ↑',
      detectedAt: NOW.toISOString(),
    };
    const driftB: HealthIssue = {
      type: 'ratchet-drift',
      score: 150,
      reason: 'review-marker baseline bumped 3× ↑',
      detectedAt: NOW.toISOString(),
    };

    // Pre-fill: sourcing already in cooldown
    store.set('ratchet-drift:sourcing', new Date(NOW.getTime() - 5 * 60_000));

    const decision = await runHealthGate({
      now: () => NOW,
      env: { GITHUB_TOKEN: "test-token" },
      writeEvent: (e) => events.push(e),
      log: () => {},
      cooldownStore: store,
      scan: async () => unhealthyScan([driftA, driftB]),
    });

    // sourcing suppressed, review-marker emitted
    expect(decision.emittedIssues).toHaveLength(1);
    expect(decision.emittedIssues[0].reason).toContain('review-marker');
    expect(decision.suppressedIssues).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});

// ── Fingerprint ──────────────────────────────────────────────────────────────

describe('fingerprintIssue', () => {
  it('collapses deploy-stuck issues to a single fingerprint regardless of URL', () => {
    const a = fingerprintIssue(deployStuckIssue({ url: 'https://a.example' }));
    const b = fingerprintIssue(deployStuckIssue({ url: 'https://b.example' }));
    expect(a).toBe(b);
    expect(a).toBe('deploy-stuck');
  });

  it('separates ratchet-drift fingerprints by file name', () => {
    const a = fingerprintIssue({
      type: 'ratchet-drift',
      score: 150,
      reason: 'sourcing baseline bumped 3× ↑',
      detectedAt: NOW.toISOString(),
    });
    const b = fingerprintIssue({
      type: 'ratchet-drift',
      score: 150,
      reason: 'review-marker baseline bumped 3× ↑',
      detectedAt: NOW.toISOString(),
    });
    expect(a).not.toBe(b);
    expect(a).toBe('ratchet-drift:sourcing');
    expect(b).toBe('ratchet-drift:review-marker');
  });

  // ── QUA-309: structured fingerprintKey ─────────────────────────────────────

  it('prefers structured fingerprintKey over reason regex when both are present', () => {
    const fp = fingerprintIssue({
      type: 'ratchet-drift',
      score: 150,
      // Reason text that the regex would parse as "different baseline"
      reason: 'sourcing baseline bumped 3× ↑',
      detectedAt: NOW.toISOString(),
      fingerprintKey: 'review-marker', // Override
    });
    expect(fp).toBe('ratchet-drift:review-marker');
  });

  it('uses structured fingerprintKey for non-ratchet issue types', () => {
    const fp = fingerprintIssue({
      type: 'main-ci-red',
      score: 180,
      reason: 'main has been red for 5 commits',
      detectedAt: NOW.toISOString(),
      fingerprintKey: 'workflow-X',
    });
    expect(fp).toBe('main-ci-red:workflow-X');
  });

  it('falls back to type alone when fingerprintKey absent for non-ratchet types', () => {
    const fp = fingerprintIssue({
      type: 'main-ci-red',
      score: 180,
      reason: 'main is red',
      detectedAt: NOW.toISOString(),
    });
    expect(fp).toBe('main-ci-red');
  });

  it('falls back to regex parsing when ratchet issue has no fingerprintKey (back-compat)', () => {
    // Older HealthIssue objects in the cooldown store predate the
    // fingerprintKey field. The regex fallback must still work.
    const fp = fingerprintIssue({
      type: 'ratchet-drift',
      score: 150,
      reason: 'legacy-ratchet baseline bumped 3× ↑',
      detectedAt: NOW.toISOString(),
      // intentionally no fingerprintKey
    });
    expect(fp).toBe('ratchet-drift:legacy-ratchet');
  });

  it('falls back to "unknown" suffix when ratchet reason cannot be regex-parsed', () => {
    const fp = fingerprintIssue({
      type: 'ratchet-drift',
      score: 150,
      reason: 'something completely different',
      detectedAt: NOW.toISOString(),
    });
    expect(fp).toBe('ratchet-drift:unknown');
  });

  it('survives a reason text edit when fingerprintKey is set (the bug QUA-309 fixes)', () => {
    // Imagine the reason string format changes from "X baseline bumped..."
    // to "Baseline X has drifted...". Without fingerprintKey, the regex
    // would return "unknown" for both files and collapse them. With
    // fingerprintKey, separation is preserved.
    const a = fingerprintIssue({
      type: 'ratchet-drift',
      score: 150,
      reason: 'Baseline foo has drifted 3× upward in 24h',
      detectedAt: NOW.toISOString(),
      fingerprintKey: 'foo',
    });
    const b = fingerprintIssue({
      type: 'ratchet-drift',
      score: 150,
      reason: 'Baseline bar has drifted 3× upward in 24h',
      detectedAt: NOW.toISOString(),
      fingerprintKey: 'bar',
    });
    expect(a).toBe('ratchet-drift:foo');
    expect(b).toBe('ratchet-drift:bar');
    expect(a).not.toBe(b);
  });
});

// ── Permanent-fault handling (QUA-799) ───────────────────────────────────────

describe('handlePermanentFault', () => {
  function makeFaultDeps() {
    const logs: string[] = [];
    const exits: number[] = [];
    let claimReleased = 0;
    const removed: number[] = [];
    const deps: PermanentFaultDeps = {
      log: (msg) => logs.push(msg),
      removePidFile: () => removed.push(removed.length),
      releaseClaim: async () => {
        claimReleased += 1;
      },
      exit: ((code: number) => {
        exits.push(code);
        // Mock exit must throw to abort the awaiting caller — production
        // process.exit never returns, and tests need a reliable abort signal.
        throw new Error(`__test_exit_${code}__`);
      }) as (code: number) => never,
    };
    return {
      deps,
      logs,
      exits,
      removed,
      claimReleasedCount: () => claimReleased,
    };
  }

  it('logs the reason, releases the claim, removes the pid file, and exits 1', async () => {
    const t = makeFaultDeps();
    await expect(
      handlePermanentFault('GITHUB_TOKEN not set in environment', t.deps),
    ).rejects.toThrow('__test_exit_1__');

    expect(t.exits).toEqual([1]);
    // Claim release must happen BEFORE exit so the next daemon process can
    // pick up the PR — the SIGTERM `shutdown` handler does the same thing.
    expect(t.claimReleasedCount()).toBe(1);
    expect(t.removed).toHaveLength(1);
    expect(t.logs.some((l) => l.includes('GITHUB_TOKEN not set'))).toBe(true);
    expect(t.logs.some((l) => l.includes('Exiting daemon'))).toBe(true);
  });

  it('still exits 1 even if releaseClaim rejects (logs the warning)', async () => {
    // Realistic case: wiki-server is also down or the claim row was already
    // removed manually. The fault path must not get stuck waiting on cleanup.
    const logs: string[] = [];
    const exits: number[] = [];
    const deps: PermanentFaultDeps = {
      log: (msg) => logs.push(msg),
      removePidFile: () => {},
      releaseClaim: async () => {
        throw new Error('wiki-server unreachable');
      },
      exit: ((code: number) => {
        exits.push(code);
        throw new Error(`__test_exit_${code}__`);
      }) as (code: number) => never,
    };
    await expect(handlePermanentFault('test reason', deps)).rejects.toThrow(
      '__test_exit_1__',
    );
    expect(exits).toEqual([1]);
    expect(
      logs.some((l) =>
        l.includes('failed to release claim during permanent-fault exit'),
      ),
    ).toBe(true);
  });
});
