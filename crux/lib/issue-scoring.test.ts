/**
 * Tests for issue-scoring.ts — pure scoring, ranking, and classification functions.
 *
 * These tests run without any mocks (no GitHub API, no filesystem).
 */
import { describe, it, expect } from 'vitest';
import {
  scoreIssue,
  isBlocked,
  findPotentialDuplicates,
  rankIssues,
  extractModel,
  checkIssueSections,
  buildIssueBody,
  issuePriority,
  mergeSections,
  type RankedIssue,
} from './issue-scoring.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_ISO = new Date().toISOString();
const OLD_DATE = '2024-01-01T00:00:00Z';
const RECENT_DATE = new Date(Date.now() - 3 * 86400000).toISOString(); // 3 days ago

function makeRankedIssue(overrides: Partial<RankedIssue> = {}): RankedIssue {
  const labels = overrides.labels ?? [];
  const body = overrides.body ?? '';
  const createdAt = overrides.createdAt ?? OLD_DATE.slice(0, 10);
  const updatedAt = overrides.updatedAt ?? OLD_DATE.slice(0, 10);
  const breakdown = scoreIssue(labels, body, createdAt, updatedAt);
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? 'Test issue',
    body,
    labels,
    createdAt,
    updatedAt,
    url: overrides.url ?? 'https://example.com/1',
    priority: issuePriority(labels),
    score: breakdown.total,
    scoreBreakdown: breakdown,
    inProgress: overrides.inProgress ?? false,
    blocked: overrides.blocked ?? false,
    recommendedModel: overrides.recommendedModel ?? null,
    missingSections: overrides.missingSections ?? [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scoreIssue
// ---------------------------------------------------------------------------

describe('scoreIssue', () => {
  it('returns base score of 50 for unlabeled issues', () => {
    const result = scoreIssue([], '', OLD_DATE, OLD_DATE);
    expect(result.priority).toBe(50);
  });

  it('gives P0 issues a score of 1000', () => {
    const result = scoreIssue(['P0'], '', OLD_DATE, OLD_DATE);
    expect(result.priority).toBe(1000);
  });

  it('gives P1 issues a score of 500', () => {
    const result = scoreIssue(['P1'], '', OLD_DATE, OLD_DATE);
    expect(result.priority).toBe(500);
  });

  it('gives P2 issues a score of 200', () => {
    const result = scoreIssue(['P2'], '', OLD_DATE, OLD_DATE);
    expect(result.priority).toBe(200);
  });

  it('gives P3 issues a score of 100', () => {
    const result = scoreIssue(['P3'], '', OLD_DATE, OLD_DATE);
    expect(result.priority).toBe(100);
  });

  it('adds +50 bug bonus for bug labels', () => {
    const result = scoreIssue(['bug'], '', OLD_DATE, OLD_DATE);
    expect(result.bugBonus).toBe(50);
  });

  it('adds bug bonus for regression label', () => {
    const result = scoreIssue(['regression'], '', OLD_DATE, OLD_DATE);
    expect(result.bugBonus).toBe(50);
  });

  it('gives no bug bonus for non-bug labels', () => {
    const result = scoreIssue(['enhancement'], '', OLD_DATE, OLD_DATE);
    expect(result.bugBonus).toBe(0);
  });

  it('adds claude-ready bonus (50% of base)', () => {
    const result = scoreIssue(['claude-ready', 'P2'], '', OLD_DATE, OLD_DATE);
    expect(result.claudeReadyBonus).toBeGreaterThan(0);
    // P2 = 200 base, +age bonus, claude-ready adds ~50% of (200+age)
    expect(result.total).toBeGreaterThan(result.priority + result.ageBonus);
  });

  it('adjusts for low effort (+20)', () => {
    const result = scoreIssue(['effort:low'], '', OLD_DATE, OLD_DATE);
    expect(result.effortAdjustment).toBe(20);
  });

  it('adjusts for high effort (-20)', () => {
    const result = scoreIssue(['effort:high'], '', OLD_DATE, OLD_DATE);
    expect(result.effortAdjustment).toBe(-20);
  });

  it('gives recency bonus for recently updated issues', () => {
    const result = scoreIssue([], '', OLD_DATE, RECENT_DATE);
    expect(result.recencyBonus).toBe(15);
  });

  it('gives no recency bonus for stale issues', () => {
    const result = scoreIssue([], '', OLD_DATE, OLD_DATE);
    expect(result.recencyBonus).toBe(0);
  });

  it('gives age bonus for old issues (capped at 10)', () => {
    // 2+ years old = well over 10 months
    const result = scoreIssue([], '', OLD_DATE, OLD_DATE);
    expect(result.ageBonus).toBe(10);
  });

  it('gives no age bonus for brand new issues', () => {
    const result = scoreIssue([], '', NOW_ISO, NOW_ISO);
    expect(result.ageBonus).toBe(0);
  });

  it('handles case-insensitive priority labels', () => {
    const result = scoreIssue(['p0'], '', OLD_DATE, OLD_DATE);
    expect(result.priority).toBe(1000);
  });

  it('handles alternative priority labels', () => {
    const result = scoreIssue(['priority:critical'], '', OLD_DATE, OLD_DATE);
    expect(result.priority).toBe(1000);
  });

  it('total is sum of all components', () => {
    const result = scoreIssue(['P1', 'bug'], '', OLD_DATE, OLD_DATE);
    const expected = result.priority + result.bugBonus + result.effortAdjustment +
      result.recencyBonus + result.ageBonus + result.claudeReadyBonus;
    expect(result.total).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// issuePriority
// ---------------------------------------------------------------------------

describe('issuePriority', () => {
  it('returns 99 for no priority labels', () => {
    expect(issuePriority([])).toBe(99);
    expect(issuePriority(['enhancement', 'bug'])).toBe(99);
  });

  it('returns 0 for P0', () => {
    expect(issuePriority(['P0'])).toBe(0);
  });

  it('returns 1 for P1', () => {
    expect(issuePriority(['P1'])).toBe(1);
  });

  it('returns lowest priority when multiple labels present', () => {
    expect(issuePriority(['P3', 'P1'])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isBlocked
// ---------------------------------------------------------------------------

describe('isBlocked', () => {
  it('returns true for blocked label', () => {
    expect(isBlocked(['blocked'], '')).toBe(true);
  });

  it('returns true for waiting label', () => {
    expect(isBlocked(['waiting'], '')).toBe(true);
  });

  it('returns true for needs-info label', () => {
    expect(isBlocked(['needs-info'], '')).toBe(true);
  });

  it('returns true for "blocked by" in body', () => {
    expect(isBlocked([], 'This is blocked by another PR')).toBe(true);
  });

  it('returns true for "waiting for" in body', () => {
    expect(isBlocked([], 'Waiting for upstream fix')).toBe(true);
  });

  it('returns true for "depends on #N" in body', () => {
    expect(isBlocked([], 'This depends on #42')).toBe(true);
  });

  it('returns false when not blocked', () => {
    expect(isBlocked(['enhancement'], 'Normal issue body')).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(isBlocked([], '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rankIssues
// ---------------------------------------------------------------------------

describe('rankIssues', () => {
  it('sorts by score descending', () => {
    const issues = [
      makeRankedIssue({ number: 1, labels: ['P3'], score: 100 }),
      makeRankedIssue({ number: 2, labels: ['P1'], score: 500 }),
      makeRankedIssue({ number: 3, labels: ['P2'], score: 200 }),
    ];
    const ranked = rankIssues(issues);
    expect(ranked[0].number).toBe(2); // P1, highest score
    expect(ranked[1].number).toBe(3); // P2
    expect(ranked[2].number).toBe(1); // P3, lowest score
  });

  it('breaks ties by creation date (oldest first)', () => {
    const issues = [
      makeRankedIssue({ number: 1, score: 100, createdAt: '2025-06-01' }),
      makeRankedIssue({ number: 2, score: 100, createdAt: '2025-01-01' }),
    ];
    const ranked = rankIssues(issues);
    expect(ranked[0].number).toBe(2); // older
    expect(ranked[1].number).toBe(1);
  });

  it('does not mutate the input array', () => {
    const issues = [
      makeRankedIssue({ number: 1, score: 50 }),
      makeRankedIssue({ number: 2, score: 100 }),
    ];
    const ranked = rankIssues(issues);
    expect(issues[0].number).toBe(1); // original unchanged
    expect(ranked[0].number).toBe(2); // sorted copy
  });

  it('handles empty array', () => {
    expect(rankIssues([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractModel
// ---------------------------------------------------------------------------

describe('extractModel', () => {
  it('extracts model from label (highest priority)', () => {
    expect(extractModel('Title', 'body', ['model:haiku'])).toBe('haiku');
    expect(extractModel('Title', 'body', ['model:sonnet'])).toBe('sonnet');
    expect(extractModel('Title', 'body', ['model:opus'])).toBe('opus');
  });

  it('labels take priority over body', () => {
    const body = '## Recommended Model\n\n**Opus**';
    expect(extractModel('Title', body, ['model:haiku'])).toBe('haiku');
  });

  it('extracts model from body section', () => {
    const body = '## Recommended Model\n\n**Sonnet** - balanced choice';
    expect(extractModel('Title', body)).toBe('sonnet');
  });

  it('extracts model from body with blank line', () => {
    const body = '## Recommended Model\n\n**Haiku**';
    expect(extractModel('Title', body)).toBe('haiku');
  });

  it('extracts model from title suffix', () => {
    expect(extractModel('Fix the build [haiku]', '')).toBe('haiku');
    expect(extractModel('Complex task [opus]', '')).toBe('opus');
  });

  it('is case-insensitive for labels', () => {
    expect(extractModel('Title', '', ['model:SONNET'])).toBe('sonnet');
  });

  it('is case-insensitive for title', () => {
    expect(extractModel('Task [Haiku]', '')).toBe('haiku');
  });

  it('returns null when no model found', () => {
    expect(extractModel('Title', 'Some body')).toBeNull();
    expect(extractModel('Title', '', [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkIssueSections
// ---------------------------------------------------------------------------

describe('checkIssueSections', () => {
  it('returns "body too short" for very short bodies', () => {
    const missing = checkIssueSections('Title', 'Short');
    expect(missing).toEqual(['body (too short or empty)']);
  });

  it('passes for a well-formed issue', () => {
    const body = `## Problem\n\nSomething is broken and needs fixing.\n\n## Acceptance Criteria\n\n- [ ] Fix applied\n- [ ] Tests pass`;
    const missing = checkIssueSections('Title [sonnet]', body);
    expect(missing).toEqual([]);
  });

  it('detects missing problem section', () => {
    const body = 'A short body here that is exactly enough to pass the minimum length check threshold.';
    const missing = checkIssueSections('Title [sonnet]', body);
    expect(missing).toContain('## Problem / ## Summary section');
  });

  it('accepts long freeform body as problem section', () => {
    const body = 'A'.repeat(301);
    const missing = checkIssueSections('Title [sonnet]', body);
    expect(missing).not.toContain('## Problem / ## Summary section');
  });

  it('detects missing acceptance criteria', () => {
    const body = '## Problem\n\nDescription of the problem that needs to be addressed urgently.';
    const missing = checkIssueSections('Title [sonnet]', body);
    expect(missing).toContain('Acceptance Criteria (## section or - [ ] checkboxes)');
  });

  it('accepts checkboxes as acceptance criteria', () => {
    const body = '## Problem\n\nDescription of the problem.\n\n- [ ] Do thing\n- [ ] Done';
    const missing = checkIssueSections('Title [sonnet]', body);
    expect(missing).not.toContain('Acceptance Criteria (## section or - [ ] checkboxes)');
  });

  it('detects missing model recommendation', () => {
    const body = '## Problem\n\nDescription.\n\n## Acceptance Criteria\n\n- [ ] Fix';
    const missing = checkIssueSections('Title', body);
    expect(missing).toContain('Recommended Model (model:haiku/sonnet/opus label, ## section, or [model] in title)');
  });

  it('accepts model from label', () => {
    const body = '## Problem\n\nDescription.\n\n## Acceptance Criteria\n\n- [ ] Fix';
    const missing = checkIssueSections('Title', body, ['model:haiku']);
    expect(missing).not.toContain('Recommended Model (model:haiku/sonnet/opus label, ## section, or [model] in title)');
  });
});

// ---------------------------------------------------------------------------
// buildIssueBody
// ---------------------------------------------------------------------------

describe('buildIssueBody', () => {
  it('builds a body with problem section', () => {
    const body = buildIssueBody({ problem: 'Something is broken' });
    expect(body).toContain('## Problem');
    expect(body).toContain('Something is broken');
  });

  it('builds a body with acceptance criteria', () => {
    const body = buildIssueBody({ criteria: 'Fix applied|Tests pass' });
    expect(body).toContain('## Acceptance Criteria');
    expect(body).toContain('- [ ] Fix applied');
    expect(body).toContain('- [ ] Tests pass');
  });

  it('builds a body with recommended model', () => {
    const body = buildIssueBody({ model: 'haiku' });
    expect(body).toContain('## Recommended Model');
    expect(body).toContain('Haiku');
  });

  it('includes cost in model section', () => {
    const body = buildIssueBody({ model: 'sonnet', cost: '~$2-4' });
    expect(body).toContain('~$2-4');
  });

  it('includes dependencies', () => {
    const body = buildIssueBody({ depends: '42,43' });
    expect(body).toContain('## Dependencies');
    expect(body).toContain('#42');
    expect(body).toContain('#43');
  });

  it('includes fix section', () => {
    const body = buildIssueBody({ fix: 'Add validation in gate.ts' });
    expect(body).toContain('## Proposed Fix');
    expect(body).toContain('Add validation in gate.ts');
  });

  it('includes evidence with file and observation', () => {
    const body = buildIssueBody({ file: '/path/to/file.ts', evidence: 'Error at line 42' });
    expect(body).toContain('## Evidence');
    expect(body).toContain('`/path/to/file.ts`');
    expect(body).toContain('Error at line 42');
  });

  it('returns empty string when no options provided', () => {
    expect(buildIssueBody({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// findPotentialDuplicates
// ---------------------------------------------------------------------------

describe('findPotentialDuplicates', () => {
  it('finds issues with very similar titles', () => {
    const issues = [
      makeRankedIssue({ number: 1, title: 'Add validation for entity types in gate check' }),
      makeRankedIssue({ number: 2, title: 'Add validation for entity types in gate' }),
    ];
    const dupes = findPotentialDuplicates(issues);
    expect(dupes.length).toBe(1);
    expect(dupes[0].similarity).toBeGreaterThan(0.5);
  });

  it('does not flag unrelated issues', () => {
    const issues = [
      makeRankedIssue({ number: 1, title: 'Add validation for entity types' }),
      makeRankedIssue({ number: 2, title: 'Refactor database migration runner' }),
    ];
    const dupes = findPotentialDuplicates(issues);
    expect(dupes.length).toBe(0);
  });

  it('handles empty array', () => {
    expect(findPotentialDuplicates([])).toEqual([]);
  });

  it('handles single issue', () => {
    const issues = [makeRankedIssue({ number: 1, title: 'Something' })];
    expect(findPotentialDuplicates(issues)).toEqual([]);
  });

  it('sorts by similarity descending', () => {
    const issues = [
      makeRankedIssue({ number: 1, title: 'validation entity types gate check' }),
      makeRankedIssue({ number: 2, title: 'validation entity types gate check run' }),
      makeRankedIssue({ number: 3, title: 'validation entity types gate' }),
    ];
    const dupes = findPotentialDuplicates(issues);
    if (dupes.length >= 2) {
      expect(dupes[0].similarity).toBeGreaterThanOrEqual(dupes[1].similarity);
    }
  });
});

// ---------------------------------------------------------------------------
// mergeSections
// ---------------------------------------------------------------------------

describe('mergeSections', () => {
  it('replaces existing sections in-place', () => {
    const existing = '## Problem\n\nOld problem\n\n## Criteria\n\nOld criteria';
    const incoming = '## Problem\n\nNew problem';
    const result = mergeSections(existing, incoming);
    expect(result).toContain('New problem');
    expect(result).not.toContain('Old problem');
    expect(result).toContain('Old criteria');
  });

  it('appends new sections', () => {
    const existing = '## Problem\n\nThe problem';
    const incoming = '## Acceptance Criteria\n\n- [ ] Done';
    const result = mergeSections(existing, incoming);
    expect(result).toContain('The problem');
    expect(result).toContain('Acceptance Criteria');
    expect(result).toContain('- [ ] Done');
  });

  it('handles empty existing body', () => {
    const result = mergeSections('', '## Problem\n\nNew');
    expect(result).toContain('## Problem');
  });

  it('handles empty incoming body', () => {
    const result = mergeSections('## Problem\n\nExisting', '');
    expect(result).toContain('Existing');
  });
});
