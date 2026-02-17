import { describe, it, expect } from 'vitest';
import { enrichWithPrNumbers } from '../github-pr-lookup.mjs';

describe('enrichWithPrNumbers', () => {
  it('adds PR number to entries missing it', () => {
    const pageHistory = {
      'my-page': [
        { date: '2026-02-15', branch: 'claude/fix-bug-Abc12', title: 'Fix bug', summary: 'Fixed it.' },
      ],
    };
    const branchToPr = new Map([['claude/fix-bug-Abc12', 42]]);

    const count = enrichWithPrNumbers(pageHistory, branchToPr);

    expect(count).toBe(1);
    expect(pageHistory['my-page'][0].pr).toBe(42);
  });

  it('does not overwrite existing PR from session log', () => {
    const pageHistory = {
      'my-page': [
        { date: '2026-02-15', branch: 'claude/fix-bug-Abc12', title: 'Fix bug', summary: 'Fixed it.', pr: 99 },
      ],
    };
    const branchToPr = new Map([['claude/fix-bug-Abc12', 42]]);

    const count = enrichWithPrNumbers(pageHistory, branchToPr);

    expect(count).toBe(0);
    expect(pageHistory['my-page'][0].pr).toBe(99); // unchanged
  });

  it('handles entries with no matching branch in the map', () => {
    const pageHistory = {
      'my-page': [
        { date: '2026-02-15', branch: 'claude/unknown-branch', title: 'Unknown', summary: '' },
      ],
    };
    const branchToPr = new Map([['claude/other-branch', 42]]);

    const count = enrichWithPrNumbers(pageHistory, branchToPr);

    expect(count).toBe(0);
    expect(pageHistory['my-page'][0].pr).toBeUndefined();
  });

  it('handles empty branch-to-PR map gracefully', () => {
    const pageHistory = {
      'my-page': [
        { date: '2026-02-15', branch: 'claude/fix-bug', title: 'Fix', summary: '' },
      ],
    };
    const branchToPr = new Map();

    const count = enrichWithPrNumbers(pageHistory, branchToPr);

    expect(count).toBe(0);
    expect(pageHistory['my-page'][0].pr).toBeUndefined();
  });

  it('enriches multiple entries across multiple pages', () => {
    const pageHistory = {
      'page-a': [
        { date: '2026-02-14', branch: 'claude/branch-1', title: 'A', summary: '' },
        { date: '2026-02-15', branch: 'claude/branch-2', title: 'B', summary: '', pr: 10 },
      ],
      'page-b': [
        { date: '2026-02-15', branch: 'claude/branch-1', title: 'C', summary: '' },
      ],
    };
    const branchToPr = new Map([
      ['claude/branch-1', 50],
      ['claude/branch-2', 60],
    ]);

    const count = enrichWithPrNumbers(pageHistory, branchToPr);

    expect(count).toBe(2); // page-a[0] and page-b[0]; page-a[1] already has pr
    expect(pageHistory['page-a'][0].pr).toBe(50);
    expect(pageHistory['page-a'][1].pr).toBe(10); // preserved
    expect(pageHistory['page-b'][0].pr).toBe(50);
  });
});
