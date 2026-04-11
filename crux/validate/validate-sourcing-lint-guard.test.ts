import { describe, it, expect } from 'vitest';
import { countInText, runCheck } from './validate-sourcing-lint-guard.ts';

describe('countInText', () => {
  it('returns all zeros for clean text', () => {
    expect(countInText('const x = sourcing;')).toEqual({
      hyphenated: 0,
      camelCase: 0,
      PascalCase: 0,
      route: 0,
      total: 0,
    });
  });

  it('counts a single hyphenated occurrence', () => {
    const c = countInText('// TODO: wire the source-check orchestrator');
    expect(c.hyphenated).toBe(1);
    expect(c.route).toBe(0);
    expect(c.total).toBe(1);
  });

  it('counts multiple hyphenated occurrences on one line', () => {
    const c = countInText('source-check source-check');
    expect(c.hyphenated).toBe(2);
  });

  it('subtracts route matches from hyphenated count to avoid double counting', () => {
    const c = countInText(`fetch("/api/source-checks/verdicts")`);
    expect(c.route).toBe(1);
    expect(c.hyphenated).toBe(0);
    expect(c.total).toBe(1);
  });

  it('handles a mix of hyphenated and route references', () => {
    const text = `
      // wire up the source-check pipeline
      const url = "/api/source-checks/run";
      console.log("source-check done");
    `;
    const c = countInText(text);
    expect(c.route).toBe(1);
    expect(c.hyphenated).toBe(2);
    expect(c.total).toBe(3);
  });

  it('counts camelCase identifiers only when followed by another identifier char', () => {
    const c = countInText('const sourceCheckClient = new SourceCheckOrchestrator();');
    // `sourceCheckC` — the pattern requires sourceCheck followed by [A-Z_0-9]
    expect(c.camelCase).toBe(1);
    // `SourceCheckO` — pattern requires SourceCheck followed by identifier char
    expect(c.PascalCase).toBe(1);
  });

  it('does not double-count camel/pascal when the prefix happens to also match hyphenated', () => {
    // "sourceCheckX" and "SourceCheckY" do not contain a hyphen, so they are
    // categorized separately from `source-check`.
    const c = countInText('sourceCheckX SourceCheckY source-check');
    expect(c.camelCase).toBe(1);
    expect(c.PascalCase).toBe(1);
    expect(c.hyphenated).toBe(1);
    expect(c.total).toBe(3);
  });

  it('ignores substrings that are not on a word boundary for camelCase', () => {
    // "mySourceCheckX" starts with a letter before sourceCheck, so \b fails.
    const c = countInText('mySourceCheckX');
    // PascalCase pattern still matches `SourceCheckX` — its leading char is a
    // word boundary on the capital S preceded by a lowercase letter.
    // But camelCase requires \bsourceCheck which is blocked here.
    expect(c.camelCase).toBe(0);
  });

  it('matches PascalCase for type names like SourceCheckResult', () => {
    const c = countInText('type T = SourceCheckResult | null;');
    expect(c.PascalCase).toBe(1);
  });

  it('matches bare camelCase and PascalCase identifiers at word boundaries', () => {
    // Regression: the original regex required an extra character after the
    // prefix, so bare `sourceCheck` / `SourceCheck` tokens slipped through.
    const c = countInText('const sourceCheck = 1; type X = SourceCheck;');
    expect(c.camelCase).toBe(1);
    expect(c.PascalCase).toBe(1);
    expect(c.hyphenated).toBe(0);
    expect(c.route).toBe(0);
  });

  it('matches extended forms like sourceChecker and sourceCheckMode once each', () => {
    const c = countInText('sourceChecker sourceChecking sourceCheckMode');
    // Each of the three identifiers matches once as a whole word — not twice.
    expect(c.camelCase).toBe(3);
    expect(c.PascalCase).toBe(0);
  });

  it('keeps total flat under category redistribution', () => {
    // The ratchet compares totals, not per-bucket counts. Replacing a
    // hyphenated reference with a camelCase one should leave the total
    // unchanged even though individual buckets shift.
    const before = countInText('source-check source-check source-check');
    const after = countInText('source-check source-check sourceCheckX');
    expect(before.total).toBe(after.total);
    expect(before.hyphenated).toBe(3);
    expect(after.hyphenated).toBe(2);
    expect(after.camelCase).toBe(1);
  });

  it('counts route once per occurrence even if it appears inside strings', () => {
    const c = countInText(`
      const r1 = "/api/source-checks";
      const r2 = '/api/source-checks';
      const r3 = \`/api/source-checks\`;
    `);
    expect(c.route).toBe(3);
    expect(c.hyphenated).toBe(0);
  });

  it('runCheck passes on the current codebase (baseline must not regress)', () => {
    // Regression guard: enforce the ratchet only on main. Feature branches
    // that add source-check-related code naturally increase the count
    // temporarily; the ratchet catches it when they merge to main via the
    // gate check. Running it on every PR branch causes cascading CI failures
    // for PRs that aren't part of the rename effort (see QUA-238).
    const branch = process.env.GITHUB_REF ?? '';
    if (branch && !branch.includes('refs/heads/main')) {
      // On a PR branch — skip the ratchet assertion, just verify the check runs
      const result = runCheck();
      expect(result.baseline).not.toBeNull();
      return;
    }
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.baseline).not.toBeNull();
  });
});
