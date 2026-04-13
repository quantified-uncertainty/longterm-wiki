import { describe, it, expect } from 'vitest';
import {
  categorizeCommit,
  groupCommits,
  generateReleaseBody,
  evaluateReleasePreflight,
} from './release.ts';
import type { DeployHealthStatus } from '../lib/pr-analysis/deploy-status.ts';

// ── categorizeCommit ─────────────────────────────────────────────────────────

describe('categorizeCommit', () => {
  it('categorizes feat commits', () => {
    expect(categorizeCommit('feat: add new feature')).toBe('features');
    expect(categorizeCommit('feat(scope): scoped feature')).toBe('features');
  });

  it('categorizes fix commits', () => {
    expect(categorizeCommit('fix: resolve bug')).toBe('fixes');
    expect(categorizeCommit('fix(auth): login issue')).toBe('fixes');
  });

  it('categorizes refactor commits', () => {
    expect(categorizeCommit('refactor: simplify logic')).toBe('refactoring');
    expect(categorizeCommit('refactor(api): clean up routes')).toBe('refactoring');
  });

  it('categorizes docs commits', () => {
    expect(categorizeCommit('docs: update readme')).toBe('docs');
  });

  it('categorizes infrastructure commits', () => {
    expect(categorizeCommit('chore: update deps')).toBe('infrastructure');
    expect(categorizeCommit('ci: fix workflow')).toBe('infrastructure');
    expect(categorizeCommit('build: update config')).toBe('infrastructure');
    expect(categorizeCommit('perf: optimize query')).toBe('infrastructure');
  });

  it('categorizes unknown commits as other', () => {
    expect(categorizeCommit('update something')).toBe('other');
    expect(categorizeCommit('initial commit')).toBe('other');
    expect(categorizeCommit('Merge pull request #123')).toBe('other');
  });
});

// ── groupCommits ─────────────────────────────────────────────────────────────

describe('groupCommits', () => {
  it('groups commits by category', () => {
    const subjects = [
      'feat: add login',
      'fix: resolve crash',
      'chore: update deps',
      'docs: update readme',
      'refactor: simplify auth',
      'something else',
    ];

    const groups = groupCommits(subjects);
    expect(groups.features).toEqual(['feat: add login']);
    expect(groups.fixes).toEqual(['fix: resolve crash']);
    expect(groups.infrastructure).toEqual(['chore: update deps']);
    expect(groups.docs).toEqual(['docs: update readme']);
    expect(groups.refactoring).toEqual(['refactor: simplify auth']);
    expect(groups.other).toEqual(['something else']);
  });

  it('handles empty input', () => {
    const groups = groupCommits([]);
    expect(groups.features).toEqual([]);
    expect(groups.fixes).toEqual([]);
    expect(groups.refactoring).toEqual([]);
    expect(groups.docs).toEqual([]);
    expect(groups.infrastructure).toEqual([]);
    expect(groups.other).toEqual([]);
  });

  it('handles all commits in one category', () => {
    const subjects = ['feat: one', 'feat: two', 'feat: three'];
    const groups = groupCommits(subjects);
    expect(groups.features).toHaveLength(3);
    expect(groups.fixes).toHaveLength(0);
  });
});

// ── generateReleaseBody ──────────────────────────────────────────────────────

describe('generateReleaseBody', () => {
  it('generates a basic release body', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 5,
      behind: 0,
      subjects: ['feat: add login', 'fix: crash on startup'],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('## Release 2026-03-04');
    expect(body).toContain('**5 commits**');
    expect(body).toContain('### Features');
    expect(body).toContain('- feat: add login');
    expect(body).toContain('### Fixes');
    expect(body).toContain('- fix: crash on startup');
    expect(body).toContain('[Full diff](https://github.com/org/repo/compare/production...main)');
  });

  it('includes divergence warning when behind > 0', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 3,
      behind: 2,
      subjects: ['feat: something'],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('> [!WARNING]');
    expect(body).toContain('**2 commits** not on main');
  });

  it('omits divergence warning when behind = 0', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 3,
      behind: 0,
      subjects: ['feat: something'],
      repoSlug: 'org/repo',
    });

    expect(body).not.toContain('[!WARNING]');
  });

  it('omits empty categories', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 1,
      behind: 0,
      subjects: ['feat: only features here'],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('### Features');
    expect(body).not.toContain('### Fixes');
    expect(body).not.toContain('### Refactoring');
    expect(body).not.toContain('### Documentation');
    expect(body).not.toContain('### Infrastructure');
    expect(body).not.toContain('### Other');
  });

  it('handles empty subjects', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 0,
      behind: 0,
      subjects: [],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('## Release 2026-03-04');
    expect(body).toContain('**0 commits**');
    expect(body).not.toContain('### Features');
  });

  it('groups all conventional commit types correctly', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 6,
      behind: 0,
      subjects: [
        'feat: new feature',
        'fix: bug fix',
        'refactor: code cleanup',
        'docs: update docs',
        'chore: update deps',
        'random commit message',
      ],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('### Features');
    expect(body).toContain('### Fixes');
    expect(body).toContain('### Refactoring');
    expect(body).toContain('### Documentation');
    expect(body).toContain('### Infrastructure');
    expect(body).toContain('### Other');
  });
});

// ── evaluateReleasePreflight ─────────────────────────────────────────────────

describe('evaluateReleasePreflight', () => {
  const healthySuccess: DeployHealthStatus = {
    healthy: true,
    lastDeploy: {
      status: 'success',
      sha: 'abc1234567',
      url: 'https://github.com/org/repo/actions/runs/1',
      timestamp: '2026-04-12T10:00:00Z',
    },
    failingSince: null,
  };

  const failedDeploy: DeployHealthStatus = {
    healthy: false,
    lastDeploy: {
      status: 'failure',
      sha: 'def4567890',
      url: 'https://github.com/org/repo/actions/runs/2',
      timestamp: '2026-04-12T11:00:00Z',
    },
    failingSince: '2026-04-12T11:00:00Z',
  };

  it('passes when deploy healthy', () => {
    const decision = evaluateReleasePreflight(healthySuccess, { force: false });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.warning).toBeNull();
  });

  it('passes when no prior deploy data (fail-open)', () => {
    const decision = evaluateReleasePreflight(
      { healthy: true, lastDeploy: null, failingSince: null },
      { force: false },
    );
    expect(decision.ok).toBe(true);
  });

  it('passes defensively when healthy=false but lastDeploy=null', () => {
    // Shouldn't happen per checkDeployHealth's contract, but guard anyway.
    const decision = evaluateReleasePreflight(
      { healthy: false, lastDeploy: null, failingSince: null },
      { force: false },
    );
    expect(decision.ok).toBe(true);
  });

  it('blocks when last deploy failed', () => {
    const decision = evaluateReleasePreflight(failedDeploy, { force: false });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain('failure');
      expect(decision.reason).toContain('def4567');
      expect(decision.reason).toContain('QUA-295');
      expect(decision.reason).toContain('--force');
      expect(decision.lastDeployUrl).toBe('https://github.com/org/repo/actions/runs/2');
    }
  });

  it('blocks when last deploy was cancelled', () => {
    const decision = evaluateReleasePreflight(
      {
        healthy: false,
        lastDeploy: {
          status: 'cancelled',
          sha: 'aaa1111222',
          url: 'https://github.com/org/repo/actions/runs/3',
          timestamp: '2026-04-12T12:00:00Z',
        },
        failingSince: '2026-04-12T12:00:00Z',
      },
      { force: false },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('cancelled');
  });

  it('--force bypasses failed deploy with a loud warning', () => {
    const decision = evaluateReleasePreflight(failedDeploy, { force: true });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.warning).not.toBeNull();
      expect(decision.warning).toContain('--force override');
      expect(decision.warning).toContain('failure');
      expect(decision.warning).toContain('def4567');
      expect(decision.warning).toContain('https://github.com/org/repo/actions/runs/2');
    }
  });

  it('--force with healthy deploy still has no warning', () => {
    const decision = evaluateReleasePreflight(healthySuccess, { force: true });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.warning).toBeNull();
  });
});
