import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before importing the rule
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from 'fs';
import { sourceCheckVerdictsRule } from './source-check-verdicts.ts';
import { ValidationEngine, Issue, type ContentFile } from '../validation/validation-engine.ts';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

// Minimal engine stub — the rule doesn't use engine methods
const stubEngine = {} as ValidationEngine;
const emptyFiles: ContentFile[] = [];

/** Helper: call the sync check function and return issues typed correctly */
function runCheck(): Issue[] {
  return sourceCheckVerdictsRule.check(emptyFiles, stubEngine) as Issue[];
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('sourceCheckVerdictsRule', () => {
  it('has correct metadata', () => {
    expect(sourceCheckVerdictsRule.id).toBe('source-check-verdicts');
    expect(sourceCheckVerdictsRule.scope).toBe('global');
  });

  it('returns no issues when data files do not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    const issues = runCheck();
    expect(issues).toEqual([]);
  });

  it('returns no issues when all record verdicts are confirmed', () => {
    mockedExistsSync.mockImplementation((path) => {
      return String(path).includes('record-verdicts.json');
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      'personnel:123': { verdict: 'confirmed', confidence: 0.95, sourcesChecked: 2, needsRecheck: false, lastComputedAt: '2026-01-01' },
      'grant:456': { verdict: 'confirmed', confidence: 0.9, sourcesChecked: 1, needsRecheck: false, lastComputedAt: '2026-01-01' },
    }));

    const issues = runCheck();
    expect(issues).toEqual([]);
  });

  it('warns on contradicted record verdicts', () => {
    mockedExistsSync.mockImplementation((path) => {
      return String(path).includes('record-verdicts.json');
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      'personnel:abc': { verdict: 'contradicted', confidence: 0.8, sourcesChecked: 3, needsRecheck: true, lastComputedAt: '2026-01-01' },
      'grant:xyz': { verdict: 'confirmed', confidence: 0.95, sourcesChecked: 2, needsRecheck: false, lastComputedAt: '2026-01-01' },
    }));

    const issues = runCheck();
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('1 record(s) have contradicted');
    expect(issues[0].message).toContain('personnel:abc');
  });

  it('warns on outdated record verdicts', () => {
    mockedExistsSync.mockImplementation((path) => {
      return String(path).includes('record-verdicts.json');
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      'investment:100': { verdict: 'outdated', confidence: 0.7, sourcesChecked: 1, needsRecheck: true, lastComputedAt: '2025-06-01' },
      'investment:200': { verdict: 'outdated', confidence: 0.6, sourcesChecked: 1, needsRecheck: true, lastComputedAt: '2025-06-01' },
    }));

    const issues = runCheck();
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('2 record(s) have outdated');
    expect(issues[0].message).toContain('investment:100');
    expect(issues[0].message).toContain('investment:200');
  });

  it('reports both contradicted and outdated separately', () => {
    mockedExistsSync.mockImplementation((path) => {
      return String(path).includes('record-verdicts.json');
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      'personnel:a': { verdict: 'contradicted', confidence: 0.8, sourcesChecked: 2, needsRecheck: true, lastComputedAt: '2026-01-01' },
      'grant:b': { verdict: 'outdated', confidence: 0.5, sourcesChecked: 1, needsRecheck: true, lastComputedAt: '2025-01-01' },
      'personnel:c': { verdict: 'confirmed', confidence: 0.95, sourcesChecked: 3, needsRecheck: false, lastComputedAt: '2026-01-01' },
    }));

    const issues = runCheck();
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toContain('contradicted');
    expect(issues[1].message).toContain('outdated');
  });

  it('warns on inaccurate KB fact verdicts', () => {
    mockedExistsSync.mockImplementation((path) => {
      return String(path).includes('kb-fact-verification.json');
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      'f_anthropic_001': 'inaccurate',
      'f_openai_002': 'accurate',
      'f_deepmind_003': 'inaccurate',
    }));

    const issues = runCheck();
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('2 FactBase fact(s) have inaccurate');
    expect(issues[0].message).toContain('f_anthropic_001');
    expect(issues[0].message).toContain('f_deepmind_003');
  });

  it('warns on unsupported KB fact verdicts', () => {
    mockedExistsSync.mockImplementation((path) => {
      return String(path).includes('kb-fact-verification.json');
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      'f_abc': 'unsupported',
      'f_def': 'verified',
    }));

    const issues = runCheck();
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('1 FactBase fact(s) have unsupported');
    expect(issues[0].message).toContain('f_abc');
  });

  it('handles both data files present with mixed verdicts', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((filePath) => {
      const path = String(filePath);
      if (path.includes('record-verdicts.json')) {
        return JSON.stringify({
          'personnel:a': { verdict: 'contradicted', confidence: 0.8, sourcesChecked: 2, needsRecheck: true, lastComputedAt: '2026-01-01' },
        });
      }
      if (path.includes('kb-fact-verification.json')) {
        return JSON.stringify({
          'f_xyz': 'inaccurate',
        });
      }
      return '{}';
    });

    const issues = runCheck();
    // 1 contradicted record + 1 inaccurate fact = 2 issues
    expect(issues).toHaveLength(2);
    expect(issues.some((i: Issue) => i.message.includes('contradicted'))).toBe(true);
    expect(issues.some((i: Issue) => i.message.includes('inaccurate'))).toBe(true);
  });

  it('truncates long lists to 10 items with a count suffix', () => {
    mockedExistsSync.mockImplementation((path) => {
      return String(path).includes('record-verdicts.json');
    });

    const verdicts: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      verdicts[`personnel:${i}`] = { verdict: 'contradicted', confidence: 0.5, sourcesChecked: 1, needsRecheck: true, lastComputedAt: null };
    }
    mockedReadFileSync.mockReturnValue(JSON.stringify(verdicts));

    const issues = runCheck();
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('15 record(s)');
    expect(issues[0].message).toContain('(and 5 more)');
  });

  it('handles malformed JSON gracefully', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not valid json{{{');

    // Should not throw, just return empty (logs a warning internally)
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const issues = runCheck();
    expect(issues).toEqual([]);
    consoleSpy.mockRestore();
  });

  it('ignores non-problematic verdicts', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((filePath) => {
      const path = String(filePath);
      if (path.includes('record-verdicts.json')) {
        return JSON.stringify({
          'personnel:a': { verdict: 'confirmed', confidence: 0.95, sourcesChecked: 3, needsRecheck: false, lastComputedAt: '2026-01-01' },
          'grant:b': { verdict: 'partial', confidence: 0.6, sourcesChecked: 1, needsRecheck: false, lastComputedAt: '2026-01-01' },
          'investment:c': { verdict: 'unverifiable', confidence: null, sourcesChecked: 0, needsRecheck: false, lastComputedAt: null },
          'funding-round:d': { verdict: 'unchecked', confidence: null, sourcesChecked: 0, needsRecheck: false, lastComputedAt: null },
        });
      }
      if (path.includes('kb-fact-verification.json')) {
        return JSON.stringify({
          'f_a': 'accurate',
          'f_b': 'minor_issues',
          'f_c': 'not_verifiable',
          'f_d': 'verified',
        });
      }
      return '{}';
    });

    const issues = runCheck();
    expect(issues).toEqual([]);
  });

  it('handles empty verdict objects', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('{}');

    const issues = runCheck();
    expect(issues).toEqual([]);
  });
});
