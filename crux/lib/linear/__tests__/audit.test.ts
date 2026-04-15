import { describe, it, expect } from 'vitest';
import { classifyEntry, classifyPRs, extractFixesIds, STALE_DAYS } from '../audit.ts';
import type { LinearChildIssue, LinearChildrenResult, LinearTriageIssue } from '../issues.ts';

function makeChildrenResult(nodes: LinearChildIssue[], hasMore = false): LinearChildrenResult {
  return { nodes, hasMore };
}

function makeIssue(overrides: Partial<LinearTriageIssue> = {}): LinearTriageIssue {
  return {
    identifier: 'QUA-100',
    title: 'Test issue',
    priority: 3,
    updatedAt: new Date().toISOString(),
    state: { name: 'In Progress', type: 'started' },
    assignee: null,
    parent: null,
    project: null,
    labels: { nodes: [] },
    ...overrides,
  };
}

function makePr(overrides: {
  number?: number;
  state?: 'open' | 'closed';
  mergedAt?: string | null;
  body?: string | null;
} = {}) {
  return {
    number: overrides.number ?? 1,
    title: 'PR title',
    html_url: `https://github.com/x/y/pull/${overrides.number ?? 1}`,
    body: overrides.body ?? null,
    state: overrides.state ?? 'open',
    pull_request: { merged_at: overrides.mergedAt ?? null },
  };
}

function makeChild(state: { name: string; type: string }): LinearChildIssue {
  return { identifier: 'QUA-X', title: 'Child', state };
}

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe('extractFixesIds', () => {
  it('extracts canonical Fixes/Closes/Resolves references', () => {
    const body = `## Summary\n\nFixes QUA-184\nCloses QUA-185\nResolves QUA-186`;
    expect(extractFixesIds(body)).toEqual(['QUA-184', 'QUA-185', 'QUA-186']);
  });

  it('handles every GitHub auto-close keyword variant', () => {
    const body = [
      'close QUA-1', 'closes QUA-2', 'closed QUA-3',
      'fix QUA-4', 'fixes QUA-5', 'fixed QUA-6',
      'resolve QUA-7', 'resolves QUA-8', 'resolved QUA-9',
    ].join('\n');
    expect(extractFixesIds(body)).toEqual(
      ['QUA-1','QUA-2','QUA-3','QUA-4','QUA-5','QUA-6','QUA-7','QUA-8','QUA-9'],
    );
  });

  it('accepts colon and extra whitespace between keyword and id', () => {
    const body = `Fixes: QUA-10\nCloses:   QUA-11\nResolved:\tQUA-12`;
    expect(extractFixesIds(body)).toEqual(['QUA-10', 'QUA-11', 'QUA-12']);
  });

  it('is case-insensitive and dedupes', () => {
    const body = `fixes qua-42\nFixes QUA-42\nFIXES QUA-42`;
    expect(extractFixesIds(body)).toEqual(['QUA-42']);
  });

  it('does not match bare QUA-NNN without a keyword', () => {
    const body = `This is about QUA-999 but not closing it.`;
    expect(extractFixesIds(body)).toEqual([]);
  });

  it('does not match keyword with no following id', () => {
    expect(extractFixesIds('Fixes the bug. Closes the discussion.')).toEqual([]);
  });

  it('does NOT match when keyword is mid-word (hotfix, postfix, prefix)', () => {
    // Regression for CodeRabbit critical finding on PR #4229. Without the
    // leading \b, "hotfix QUA-1" would match `fix QUA-1` and the watchdog
    // would auto-close the wrong issue.
    expect(extractFixesIds('hotfix QUA-100')).toEqual([]);
    expect(extractFixesIds('postfix QUA-200')).toEqual([]);
    expect(extractFixesIds('prefix QUA-300')).toEqual([]);
    expect(extractFixesIds('unfixes QUA-400')).toEqual([]);
    expect(extractFixesIds('foreclosed QUA-500')).toEqual([]);
  });

  it('still matches at line start, after punctuation, and after whitespace', () => {
    expect(extractFixesIds('Fixes QUA-1')).toEqual(['QUA-1']);
    expect(extractFixesIds('See [issue]: closes QUA-2')).toEqual(['QUA-2']);
    expect(extractFixesIds('. Resolves QUA-3')).toEqual(['QUA-3']);
    expect(extractFixesIds('(fix QUA-4)')).toEqual(['QUA-4']);
  });

  it('returns empty for no matches', () => {
    expect(extractFixesIds('')).toEqual([]);
    expect(extractFixesIds('nothing to see')).toEqual([]);
  });
});

describe('classifyPRs', () => {
  it('separates open and merged PRs', () => {
    const items = [
      makePr({ number: 1, state: 'open' }),
      makePr({ number: 2, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' }),
      makePr({ number: 3, state: 'closed', mergedAt: null }), // abandoned
    ];
    const { openPRs, mergedPRs } = classifyPRs(items);
    expect(openPRs.map((p) => p.number)).toEqual([1]);
    expect(mergedPRs.map((p) => p.number)).toEqual([2]);
  });

  it('sorts merged PRs newest-first', () => {
    const items = [
      makePr({ number: 1, state: 'closed', mergedAt: '2026-04-01T00:00:00Z' }),
      makePr({ number: 2, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' }),
      makePr({ number: 3, state: 'closed', mergedAt: '2026-04-05T00:00:00Z' }),
    ];
    const { mergedPRs } = classifyPRs(items);
    expect(mergedPRs.map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it('handles empty input', () => {
    const { openPRs, mergedPRs } = classifyPRs([]);
    expect(openPRs).toEqual([]);
    expect(mergedPRs).toEqual([]);
  });
});

describe('classifyEntry — bucket assignment', () => {
  it('returns ACTIVE when an open PR exists, regardless of merged history', () => {
    const issue = makeIssue();
    const items = [
      makePr({ number: 10, state: 'open' }),
      makePr({ number: 9, state: 'closed', mergedAt: '2026-04-01T00:00:00Z' }),
    ];
    const e = classifyEntry(issue, items, makeChildrenResult([]));
    expect(e.bucket).toBe('active');
    expect(e.reason).toContain('#10');
  });

  it('returns SHIPPED when only merged PRs exist', () => {
    const issue = makeIssue();
    const items = [makePr({ number: 5, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' })];
    const e = classifyEntry(issue, items, makeChildrenResult([]));
    expect(e.bucket).toBe('shipped');
    expect(e.reason).toContain('#5');
    expect(e.reason).toContain('merged');
  });

  it('SHIPPED reason picks the newest merge when there are multiple', () => {
    const issue = makeIssue();
    const items = [
      makePr({ number: 1, state: 'closed', mergedAt: '2026-04-01T00:00:00Z' }),
      makePr({ number: 2, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' }),
    ];
    const e = classifyEntry(issue, items, makeChildrenResult([]));
    expect(e.reason).toContain('#2');
    expect(e.mergedPRs[0].number).toBe(2);
  });

  it('returns PARENT-EPIC when all sub-issues are resolved', () => {
    const issue = makeIssue();
    const children = [
      makeChild({ name: 'Done', type: 'completed' }),
      makeChild({ name: 'Canceled', type: 'canceled' }),
    ];
    const e = classifyEntry(issue, [], makeChildrenResult(children));
    expect(e.bucket).toBe('parent-epic');
    expect(e.childCount).toBe(2);
    expect(e.unresolvedChildren).toEqual([]);
  });

  it('does NOT return PARENT-EPIC when at least one sub-issue is still active', () => {
    const issue = makeIssue();
    const children = [
      makeChild({ name: 'Done', type: 'completed' }),
      makeChild({ name: 'In Progress', type: 'started' }),
    ];
    const e = classifyEntry(issue, [], makeChildrenResult(children));
    expect(e.bucket).not.toBe('parent-epic');
    expect(e.unresolvedChildren).toHaveLength(1);
  });

  it('does NOT return PARENT-EPIC when child list is truncated, even if all fetched are resolved', () => {
    // Regression for CodeRabbit major finding on PR #4229. With hasMore=true,
    // children #101+ might still be active — auto-closing the parent would
    // be a destructive false positive.
    const issue = makeIssue({ updatedAt: daysAgo(2) });
    const children = [
      makeChild({ name: 'Done', type: 'completed' }),
      makeChild({ name: 'Done', type: 'completed' }),
    ];
    const e = classifyEntry(issue, [], makeChildrenResult(children, true));
    expect(e.bucket).not.toBe('parent-epic');
    // Should fall through to stuck/orphan based on age — recent → stuck
    expect(e.bucket).toBe('stuck');
  });

  it('returns ORPHAN when stale beyond STALE_DAYS with no PR or children', () => {
    const issue = makeIssue({ updatedAt: daysAgo(STALE_DAYS + 5) });
    const e = classifyEntry(issue, [], makeChildrenResult([]));
    expect(e.bucket).toBe('orphan');
    expect(e.reason).toContain('Backlog');
  });

  it('returns STUCK when recent with no PR or children', () => {
    const issue = makeIssue({ updatedAt: daysAgo(1) });
    const e = classifyEntry(issue, [], makeChildrenResult([]));
    expect(e.bucket).toBe('stuck');
  });

  it('boundary: exactly STALE_DAYS old is still STUCK, not ORPHAN', () => {
    const issue = makeIssue({ updatedAt: daysAgo(STALE_DAYS) });
    const e = classifyEntry(issue, [], makeChildrenResult([]));
    expect(e.bucket).toBe('stuck');
  });

  it('an empty children list does NOT trigger PARENT-EPIC', () => {
    const issue = makeIssue();
    const e = classifyEntry(issue, [], makeChildrenResult([]));
    expect(e.bucket).not.toBe('parent-epic');
  });

  it('priority: open PR beats merged PR beats parent epic', () => {
    const issue = makeIssue();
    const items = [
      makePr({ number: 1, state: 'open' }),
      makePr({ number: 2, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' }),
    ];
    const children = [makeChild({ name: 'Done', type: 'completed' })];
    expect(classifyEntry(issue, items, makeChildrenResult(children)).bucket).toBe('active');
    expect(classifyEntry(issue, [items[1]], makeChildrenResult(children)).bucket).toBe('shipped');
    expect(classifyEntry(issue, [], makeChildrenResult(children)).bucket).toBe('parent-epic');
  });
});

describe('classifyEntry — parent epic with open children', () => {
  it('parent with merged PR and open children is ACTIVE, not SHIPPED', () => {
    const issue = makeIssue();
    const items = [
      makePr({ number: 4301, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' }),
    ];
    const children = [
      makeChild({ name: 'Done', type: 'completed' }),
      makeChild({ name: 'In Progress', type: 'started' }),
      makeChild({ name: 'Backlog', type: 'backlog' }),
    ];
    const e = classifyEntry(issue, items, makeChildrenResult(children));
    expect(e.bucket).toBe('active');
    expect(e.bucket).not.toBe('shipped');
    expect(e.reason).toContain('parent epic');
    expect(e.reason).toContain('2 open children');
    expect(e.reason).toContain('#4301');
    // Still surfaces the merged PR data for context
    expect(e.mergedPRs).toHaveLength(1);
    expect(e.unresolvedChildren).toHaveLength(2);
  });

  it('parent with no PRs but open children is ACTIVE (not orphan/stuck)', () => {
    const issue = makeIssue({ updatedAt: daysAgo(STALE_DAYS + 5) });
    const children = [
      makeChild({ name: 'In Progress', type: 'started' }),
      makeChild({ name: 'In Progress', type: 'started' }),
    ];
    const e = classifyEntry(issue, [], makeChildrenResult(children));
    expect(e.bucket).toBe('active');
    expect(e.reason).toContain('2 open children');
  });

  it('parent with one open child uses singular wording', () => {
    const issue = makeIssue();
    const children = [makeChild({ name: 'In Progress', type: 'started' })];
    const e = classifyEntry(issue, [], makeChildrenResult(children));
    expect(e.bucket).toBe('active');
    expect(e.reason).toContain('1 open child');
    expect(e.reason).not.toContain('children');
  });

  it('parent with truncated child list pluralizes even with one visible unresolved child', () => {
    const issue = makeIssue();
    const children = [
      makeChild({ name: 'In Progress', type: 'started' }),
      makeChild({ name: 'Done', type: 'completed' }),
    ];
    const e = classifyEntry(issue, [], makeChildrenResult(children, true));
    expect(e.bucket).toBe('active');
    // Plural + "+" because hasMore=true means unfetched children may also
    // be unresolved — "1 open child+" would mislead.
    expect(e.reason).toContain('1 open children+');
  });

  it('parent with all-resolved children still classifies as PARENT-EPIC', () => {
    const issue = makeIssue();
    const children = [
      makeChild({ name: 'Done', type: 'completed' }),
      makeChild({ name: 'Canceled', type: 'canceled' }),
    ];
    const e = classifyEntry(issue, [], makeChildrenResult(children));
    expect(e.bucket).toBe('parent-epic');
  });

  it('leaf issue (no children) with merged PR still classifies as SHIPPED', () => {
    const issue = makeIssue();
    const items = [
      makePr({ number: 5, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' }),
    ];
    const e = classifyEntry(issue, items, makeChildrenResult([]));
    expect(e.bucket).toBe('shipped');
  });
});

describe('classifyEntry — no-auto-close label', () => {
  function withLabel(): LinearTriageIssue {
    return makeIssue({ labels: { nodes: [{ name: 'no-auto-close' }] } });
  }

  it('leaf issue with merged PR + no-auto-close label is ACTIVE, not SHIPPED', () => {
    const issue = withLabel();
    const items = [
      makePr({ number: 5, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' }),
    ];
    const e = classifyEntry(issue, items, makeChildrenResult([]));
    expect(e.bucket).toBe('active');
    expect(e.reason).toContain('no-auto-close');
    expect(e.reason).toContain('manual review');
  });

  it('parent with all-resolved children + no-auto-close label is ACTIVE, not PARENT-EPIC', () => {
    const issue = withLabel();
    const children = [
      makeChild({ name: 'Done', type: 'completed' }),
      makeChild({ name: 'Done', type: 'completed' }),
    ];
    const e = classifyEntry(issue, [], makeChildrenResult(children));
    expect(e.bucket).toBe('active');
    expect(e.reason).toContain('no-auto-close');
  });

  it('label has no effect on issues without merged PRs or resolved children', () => {
    const issue = withLabel();
    const e = classifyEntry({ ...issue, updatedAt: daysAgo(1) }, [], makeChildrenResult([]));
    expect(e.bucket).toBe('stuck');
  });

  it('parent-epic branch wins when both no-auto-close label and unresolved children are present', () => {
    // Precedence: the open-children branch fires before the label branch,
    // so the reason surfaces "parent epic", not the label. Both paths would
    // have yielded 'active', so the classification is correct either way.
    const issue = withLabel();
    const items = [
      makePr({ number: 5, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' }),
    ];
    const children = [
      makeChild({ name: 'In Progress', type: 'started' }),
    ];
    const e = classifyEntry(issue, items, makeChildrenResult(children));
    expect(e.bucket).toBe('active');
    expect(e.reason).toContain('parent epic');
    expect(e.reason).toContain('#5');
  });

  it('case-insensitive label match (No-Auto-Close, NO-AUTO-CLOSE)', () => {
    for (const labelName of ['No-Auto-Close', 'NO-AUTO-CLOSE', 'no-auto-close']) {
      const issue = makeIssue({ labels: { nodes: [{ name: labelName }] } });
      const items = [
        makePr({ number: 1, state: 'closed', mergedAt: '2026-04-10T00:00:00Z' }),
      ];
      const e = classifyEntry(issue, items, makeChildrenResult([]));
      expect(e.bucket, `label="${labelName}"`).toBe('active');
      expect(e.reason).toContain('no-auto-close');
    }
  });
});
