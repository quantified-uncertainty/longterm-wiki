import { describe, it, expect } from 'vitest';
import { categorizeCommit, groupCommits, generateReleaseBody } from './release.ts';

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
  it('generates a basic release body', () => {
    const body = generateReleaseBody({
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

  it('includes divergence warning when behind > 0', () => {
    const body = generateReleaseBody({
      date: '2026-03-04',
      ahead: 3,
      behind: 2,
      subjects: ['feat: something'],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('> [!WARNING]');
    expect(body).toContain('**2 commits** not on main');
  });

  it('omits divergence warning when behind = 0', () => {
    const body = generateReleaseBody({
      date: '2026-03-04',
      ahead: 3,
      behind: 0,
      subjects: ['feat: something'],
      repoSlug: 'org/repo',
    });

    expect(body).not.toContain('[!WARNING]');
  });

  it('omits empty categories', () => {
    const body = generateReleaseBody({
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

  it('handles empty subjects', () => {
    const body = generateReleaseBody({
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

  it('groups all conventional commit types correctly', () => {
    const body = generateReleaseBody({
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
