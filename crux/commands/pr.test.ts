import { describe, it, expect } from 'vitest';
import { normalizeClosesSyntax, validateTestPlan, bigramSimilarity, injectLinearRefs } from './pr.ts';

describe('normalizeClosesSyntax', () => {
  it('rewrites comma-separated Closes to one-per-line', () => {
    const { result, fixed } = normalizeClosesSyntax('Closes #1, #2, #3');
    expect(result).toBe('Closes #1\nCloses #2\nCloses #3');
    expect(fixed).toBe(1);
  });

  it('handles Fixes keyword', () => {
    const { result } = normalizeClosesSyntax('Fixes #10, #20');
    expect(result).toBe('Fixes #10\nFixes #20');
  });

  it('handles Resolves keyword', () => {
    const { result } = normalizeClosesSyntax('Resolves #5, #6, #7');
    expect(result).toBe('Resolves #5\nResolves #6\nResolves #7');
  });

  it('handles "and" separator', () => {
    const { result } = normalizeClosesSyntax('Closes #1 and #2');
    expect(result).toBe('Closes #1\nCloses #2');
  });

  it('leaves already-correct one-per-line format unchanged', () => {
    const input = 'Closes #1\nCloses #2\nCloses #3';
    const { result, fixed } = normalizeClosesSyntax(input);
    expect(result).toBe(input);
    expect(fixed).toBe(0);
  });

  it('leaves single Closes unchanged', () => {
    const input = 'Closes #42';
    const { result, fixed } = normalizeClosesSyntax(input);
    expect(result).toBe(input);
    expect(fixed).toBe(0);
  });

  it('handles mixed content around Closes lines', () => {
    const input = '## Summary\nSome text\n\nCloses #1, #2\n\nMore text';
    const { result } = normalizeClosesSyntax(input);
    expect(result).toBe('## Summary\nSome text\n\nCloses #1\nCloses #2\n\nMore text');
  });

  it('handles numbers without # prefix', () => {
    const { result } = normalizeClosesSyntax('Closes #1, 2, 3');
    expect(result).toBe('Closes #1\nCloses #2\nCloses #3');
  });
});

describe('validateTestPlan', () => {
  it('blocks when test plan section is missing', () => {
    const result = validateTestPlan('## Summary\nSome changes\n');
    expect(result.status).toBe('block');
    expect(result.hasTestPlanSection).toBe(false);
  });

  it('blocks when test plan section has no checkbox items', () => {
    const result = validateTestPlan('## Summary\nChanges\n\n## Test plan\nJust some text, no checkboxes.\n');
    expect(result.status).toBe('block');
    expect(result.hasTestPlanSection).toBe(true);
    expect(result.totalItems).toBe(0);
  });

  it('blocks when all items are unchecked (tests listed but not executed)', () => {
    const body = `## Summary\nChanges\n\n## Test plan\n- [ ] Run unit tests\n- [ ] Manual check\n`;
    const result = validateTestPlan(body);
    expect(result.status).toBe('block');
    expect(result.checkedItems).toBe(0);
    expect(result.uncheckedItems).toBe(2);
  });

  it('warns when some items are unchecked', () => {
    const body = `## Summary\nChanges\n\n## Test plan\n- [x] Run unit tests\n- [ ] Manual check\n`;
    const result = validateTestPlan(body);
    expect(result.status).toBe('warn');
    expect(result.checkedItems).toBe(1);
    expect(result.uncheckedItems).toBe(1);
  });

  it('passes when all items are checked', () => {
    const body = `## Summary\nChanges\n\n## Test plan\n- [x] Run unit tests\n- [x] Manual check\n`;
    const result = validateTestPlan(body);
    expect(result.status).toBe('ok');
    expect(result.checkedItems).toBe(2);
    expect(result.uncheckedItems).toBe(0);
  });

  it('handles ### heading level', () => {
    const body = `## Summary\nChanges\n\n### Test plan\n- [x] Verified\n`;
    const result = validateTestPlan(body);
    expect(result.status).toBe('ok');
  });

  it('is case-insensitive for heading', () => {
    const body = `## Summary\n\n## TEST PLAN\n- [x] Done\n`;
    const result = validateTestPlan(body);
    expect(result.status).toBe('ok');
  });

  it('stops at the next heading', () => {
    const body = `## Test plan\n- [x] Done\n\n## Notes\n- [ ] This is not a test item\n`;
    const result = validateTestPlan(body);
    expect(result.status).toBe('ok');
    expect(result.totalItems).toBe(1);
  });

  it('handles [X] (uppercase) as checked', () => {
    const body = `## Test plan\n- [X] Verified\n`;
    const result = validateTestPlan(body);
    expect(result.status).toBe('ok');
    expect(result.checkedItems).toBe(1);
  });

  it('handles empty body', () => {
    const result = validateTestPlan('');
    expect(result.status).toBe('block');
    expect(result.hasTestPlanSection).toBe(false);
  });
});

describe('injectLinearRefs', () => {
  it('injects from branch name', () => {
    const result = injectLinearRefs('## Summary\nSome changes', 'claude/qua-184-linear-integration', undefined, null);
    expect(result.injected).toEqual(['QUA-184']);
    expect(result.body).toContain('Fixes QUA-184');
  });

  it('injects from explicit --linear flag', () => {
    const result = injectLinearRefs('## Summary\nSome changes', 'claude/tier0-data-integrity', 'QUA-155', null);
    expect(result.injected).toEqual(['QUA-155']);
    expect(result.body).toContain('Fixes QUA-155');
  });

  it('injects multiple from comma-separated --linear flag', () => {
    const result = injectLinearRefs('## Summary', 'claude/some-branch', 'QUA-155,QUA-151', null);
    expect(result.injected).toEqual(['QUA-155', 'QUA-151']);
    expect(result.body).toContain('Fixes QUA-155');
    expect(result.body).toContain('Fixes QUA-151');
  });

  it('injects from checklist metadata when branch has NO Linear ID', () => {
    const result = injectLinearRefs('## Summary', 'claude/some-branch', undefined, 'QUA-110');
    expect(result.injected).toEqual(['QUA-110']);
    expect(result.body).toContain('Fixes QUA-110');
  });

  // QUA-457: the exact regression from PR #4306
  it('IGNORES stale checklist ID when branch encodes a different Linear ID', () => {
    const result = injectLinearRefs(
      '## Summary',
      'claude/qua-419-sourcing-detail-empty-state',
      undefined,
      'QUA-418', // stale from prior session
    );
    expect(result.injected).toEqual(['QUA-419']);
    expect(result.body).toContain('Fixes QUA-419');
    expect(result.body).not.toContain('Fixes QUA-418');
    expect(result.warnings.join(' ')).toMatch(/checklist Linear ID QUA-418 ignored/);
  });

  it('warns when --linear disagrees with branch-encoded ID but still injects both', () => {
    const result = injectLinearRefs('## Summary', 'claude/qua-184-fix', 'QUA-155', null);
    expect(result.injected).toEqual(['QUA-184', 'QUA-155']);
    expect(result.warnings.join(' ')).toMatch(/--linear=QUA-155 disagrees with branch/);
  });

  it('deduplicates across sources', () => {
    const result = injectLinearRefs('## Summary', 'claude/qua-184-fix', 'QUA-184', 'QUA-184');
    expect(result.injected).toEqual(['QUA-184']);
    expect(result.body.match(/Fixes QUA-184/g)?.length).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('skips already-referenced IDs', () => {
    const body = '## Summary\n\nFixes QUA-184';
    const result = injectLinearRefs(body, 'claude/qua-184-fix', undefined, null);
    expect(result.injected).toEqual([]);
    expect(result.body).toBe(body);
  });

  it('skips Closes/Resolves variants too', () => {
    const body = '## Summary\n\nCloses QUA-155\nResolves QUA-151';
    const result = injectLinearRefs(body, 'claude/qua-155-fix', 'QUA-151', null);
    expect(result.injected).toEqual([]);
  });

  it('returns original body when no IDs found', () => {
    const body = '## Summary';
    const result = injectLinearRefs(body, 'claude/some-feature', undefined, null);
    expect(result.injected).toEqual([]);
    expect(result.body).toBe(body);
  });

  it('does NOT warn about checklist when its ID is already injected via --linear', () => {
    // Edge case: branch=qua-184, --linear=QUA-110, checklist=QUA-110.
    // Checklist ID is already in linearIds via --linear, so "ignored" warning
    // would be misleading.
    const result = injectLinearRefs('## Summary', 'claude/qua-184-fix', 'QUA-110', 'QUA-110');
    expect(result.injected).toEqual(['QUA-184', 'QUA-110']);
    expect(result.warnings.some((w) => w.includes('checklist Linear ID QUA-110 ignored'))).toBe(false);
  });

  it('branch-matching --linear produces no warning', () => {
    const result = injectLinearRefs('## Summary', 'claude/qua-184-fix', 'QUA-184', null);
    expect(result.injected).toEqual(['QUA-184']);
    expect(result.warnings).toEqual([]);
  });

  it('mixed --linear list: warns for disagreeing ID, silent for matching one', () => {
    const result = injectLinearRefs('## Summary', 'claude/qua-184-fix', 'QUA-184,QUA-155', null);
    expect(result.injected).toEqual(['QUA-184', 'QUA-155']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/--linear=QUA-155 disagrees with branch/);
  });

  it('branch ID wins over stale checklist; --linear still adds explicit ID', () => {
    // QUA-457: when branch encodes an ID, checklist is ignored (may be stale).
    // Explicit --linear still injects its ID on top.
    const result = injectLinearRefs('## Summary', 'claude/qua-184-fix', 'QUA-155', 'QUA-110');
    expect(result.injected).toEqual(['QUA-184', 'QUA-155']);
    expect(result.body).toContain('Fixes QUA-184');
    expect(result.body).toContain('Fixes QUA-155');
    expect(result.body).not.toContain('Fixes QUA-110');
    expect(result.warnings.some((w) => w.includes('QUA-110 ignored'))).toBe(true);
  });
});

describe('bigramSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(bigramSimilarity('hello world foo bar', 'hello world foo bar')).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    expect(bigramSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });

  it('returns 0 for empty strings', () => {
    expect(bigramSimilarity('', 'hello world')).toBe(0);
    expect(bigramSimilarity('hello world', '')).toBe(0);
  });

  it('returns high similarity for near-identical strings', () => {
    const a = 'add new feature for user authentication with JWT tokens';
    const b = 'add new feature for user authentication with session tokens';
    const sim = bigramSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.5);
  });

  it('ignores punctuation', () => {
    const sim = bigramSimilarity('hello, world!', 'hello world');
    expect(sim).toBe(1.0);
  });
});
