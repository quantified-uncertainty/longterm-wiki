import { describe, it, expect } from 'vitest';
import { getColors } from '../lib/output.ts';
import {
  formatHealthSummary,
  type HealthSummary,
} from './format.ts';

// CI mode disables ANSI — predictable assertions
const c = getColors(true);

describe('formatHealthSummary', () => {
  it('shows green status when everything is healthy', () => {
    const health: HealthSummary = {
      mainBranch: { isRed: false, redSince: null, fixAttempts: 0, culprits: [] },
      deploy: { healthy: true, lastDeploy: null, failingSince: null },
      daemon: { state: 'idle', currentPr: null, cycleCount: 5, lastCycleAt: null },
    };
    const result = formatHealthSummary(health, c);
    expect(result).toContain('GREEN');
    expect(result).toContain('idle');
    expect(result).toContain('cycles: 5');
  });

  it('shows red main branch with culprits', () => {
    const health: HealthSummary = {
      mainBranch: {
        isRed: true,
        redSince: new Date(Date.now() - 7200_000).toISOString(),
        fixAttempts: 3,
        culprits: [1842, 1840],
      },
      deploy: { healthy: true, lastDeploy: null, failingSince: null },
      daemon: { state: 'fixing', currentPr: 1842, cycleCount: 10, lastCycleAt: null },
    };
    const result = formatHealthSummary(health, c);
    expect(result).toContain('RED');
    expect(result).toContain('3 fix attempts');
    expect(result).toContain('#1842');
    expect(result).toContain('#1840');
    expect(result).toContain('fixing');
  });

  it('shows failing deploy status', () => {
    const health: HealthSummary = {
      mainBranch: { isRed: false, redSince: null, fixAttempts: 0, culprits: [] },
      deploy: {
        healthy: false,
        lastDeploy: { status: 'failure', sha: 'abc', url: '', timestamp: new Date(Date.now() - 3600_000).toISOString() },
        failingSince: new Date(Date.now() - 3600_000).toISOString(),
      },
      daemon: { state: 'idle', currentPr: null, cycleCount: 5, lastCycleAt: null },
    };
    const result = formatHealthSummary(health, c);
    expect(result).toContain('FAILING');
  });

  it('shows no data for deploy when lastDeploy is null', () => {
    const health: HealthSummary = {
      mainBranch: { isRed: false, redSince: null, fixAttempts: 0, culprits: [] },
      deploy: { healthy: true, lastDeploy: null, failingSince: null },
      daemon: { state: 'idle', currentPr: null, cycleCount: 0, lastCycleAt: null },
    };
    const result = formatHealthSummary(health, c);
    expect(result).toContain('no data');
  });
});
