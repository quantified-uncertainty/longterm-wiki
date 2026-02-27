import { describe, it, expect } from 'vitest';
import { normalizeClosesSyntax, validateTestPlan, bigramSimilarity } from './pr.ts';

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
    const body = `## Summary\nChanges\n\n## Test plan\n- [ ] Run unit tests\n- [ ] Manual verification\n`;
    const result = validateTestPlan(body);
    expect(result.status).toBe('block');
    expect(result.checkedItems).toBe(0);
    expect(result.uncheckedItems).toBe(2);
  });

  it('warns when some items are unchecked', () => {
    const body = `## Summary\nChanges\n\n## Test plan\n- [x] Run unit tests\n- [ ] Manual verification\n`;
    const result = validateTestPlan(body);
    expect(result.status).toBe('warn');
    expect(result.checkedItems).toBe(1);
    expect(result.uncheckedItems).toBe(1);
  });

  it('passes when all items are checked', () => {
    const body = `## Summary\nChanges\n\n## Test plan\n- [x] Run unit tests\n- [x] Manual verification\n`;
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
