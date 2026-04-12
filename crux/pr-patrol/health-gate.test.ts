import { describe, it, expect } from 'vitest';

import {
  runHealthGate,
  fingerprintIssue,
  HEALTH_GATE_COOLDOWN_MINUTES,
  DISABLE_ENV_VAR,
  type HealthGateDeps,
} from './health-gate.ts';
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
  return {
    get: (fp: string) => map.get(fp) ?? null,
    set: (fp: string, at: Date) => {
      map.set(fp, at);
    },
    _map: map,
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
    env: {},
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
    expect(deps.logs.some((l) => l.includes('BYPASSED'))).toBe(true);
    expect(deps.events).toHaveLength(0);
  });

  it('does NOT bypass when env var is unset', async () => {
    const deps = makeDeps({ env: {} });
    const decision = await runHealthGate({
      ...deps,
      scan: async () => unhealthyScan([deployStuckIssue()]),
    });
    expect(decision.bypassed).toBe(false);
    expect(decision.proceed).toBe(false);
  });

  it('does NOT bypass when env var is set to "0"', async () => {
    const deps = makeDeps({ env: { [DISABLE_ENV_VAR]: '0' } });
    const decision = await runHealthGate({
      ...deps,
      scan: async () => healthyScan(),
    });
    expect(decision.bypassed).toBe(false);
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

// ── Scanner failure ──────────────────────────────────────────────────────────

describe('runHealthGate — scanner error', () => {
  it('logs + records an error event + lets patrol proceed (does not masquerade as healthy)', async () => {
    const deps = makeDeps();
    const decision = await runHealthGate({
      ...deps,
      scan: async () => {
        throw new Error('GitHub API 503');
      },
    });
    expect(decision.proceed).toBe(true);
    expect(deps.events).toHaveLength(1);
    expect(deps.events[0]).toMatchObject({
      type: 'health_scan_error',
      error: 'GitHub API 503',
    });
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
});

// ── Cooldown ─────────────────────────────────────────────────────────────────

describe('runHealthGate — cooldown', () => {
  it('emits once, then suppresses a repeat within the cooldown window', async () => {
    const store = inMemoryCooldown();
    const events: Array<Record<string, unknown>> = [];

    // First call — no prior state, should emit.
    await runHealthGate({
      now: () => NOW,
      env: {},
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
      env: {},
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
      env: {},
      writeEvent: (e) => events.push(e),
      log: () => {},
      cooldownStore: store,
      scan: async () => unhealthyScan([deployStuckIssue()]),
    });

    const wayLater = new Date(NOW.getTime() + (HEALTH_GATE_COOLDOWN_MINUTES + 1) * 60_000);
    await runHealthGate({
      now: () => wayLater,
      env: {},
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
      env: {},
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
});
