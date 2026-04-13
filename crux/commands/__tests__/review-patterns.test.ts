import { describe, it, expect } from 'vitest';
import {
  collectPatternAttestations,
  allAttested,
} from '../review-patterns.ts';
import type { ParsedItem } from '../../lib/session/session-checklist.ts';

function item(id: string, status: 'checked' | 'unchecked' | 'na', naReason?: string): ParsedItem {
  return { id, label: `test label for ${id}`, status, naReason };
}

describe('collectPatternAttestations', () => {
  it('returns only review-* items', () => {
    const items: ParsedItem[] = [
      item('duplicate-check', 'checked'),
      item('review-github-conclusion-enum', 'unchecked'),
      item('tests-written', 'unchecked'),
      item('review-readdir-iteration-determinism', 'checked'),
    ];
    const results = collectPatternAttestations(items);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.patternId).sort()).toEqual([
      'github-conclusion-enum',
      'readdir-iteration-determinism',
    ]);
  });

  it('resolves the pattern reason from the registry', () => {
    const items: ParsedItem[] = [
      item('review-github-conclusion-enum', 'unchecked'),
    ];
    const r = collectPatternAttestations(items)[0];
    expect(r.reason).toContain('timed_out');
  });

  it('reports "(unknown pattern...)" for unregistered pattern ids', () => {
    const items: ParsedItem[] = [
      item('review-fake-pattern-that-does-not-exist', 'checked'),
    ];
    const r = collectPatternAttestations(items)[0];
    expect(r.reason).toContain('unknown');
  });

  it('preserves status and naReason', () => {
    const items: ParsedItem[] = [
      item('review-numeric-id-substring-match', 'na', 'no numeric matching in this PR'),
    ];
    const r = collectPatternAttestations(items)[0];
    expect(r.status).toBe('na');
    expect(r.naReason).toContain('no numeric matching');
  });
});

describe('allAttested', () => {
  it('true when every pattern item is checked or na', () => {
    const r = collectPatternAttestations([
      item('review-github-conclusion-enum', 'checked'),
      item('review-test-fake-silent-default', 'na', 'no fakes in this PR'),
    ]);
    expect(allAttested(r)).toBe(true);
  });

  it('false when any pattern item is unchecked', () => {
    const r = collectPatternAttestations([
      item('review-github-conclusion-enum', 'checked'),
      item('review-test-fake-silent-default', 'unchecked'),
    ]);
    expect(allAttested(r)).toBe(false);
  });

  it('true when no pattern items exist', () => {
    const r = collectPatternAttestations([
      item('duplicate-check', 'unchecked'),
    ]);
    expect(allAttested(r)).toBe(true);
  });
});
