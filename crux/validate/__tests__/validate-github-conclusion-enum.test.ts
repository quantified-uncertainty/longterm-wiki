import { describe, it, expect } from 'vitest';
import { scanFileContent } from '../validate-github-conclusion-enum.ts';

const PATH = '/fake/crux/lib/releases.ts';

describe('scanFileContent — github conclusion enum exhaustiveness', () => {
  it('flags the QUA-339 pass-1 regex gap: /fail|cancel|error/', () => {
    const code = `
      const failing = checks.filter((c) =>
        c.conclusion && /fail|cancel|error/i.test(c.conclusion)
      );
    `;
    const violations = scanFileContent(PATH, code);
    expect(violations).toHaveLength(1);
    expect(violations[0].missing).toContain('failure');
    expect(violations[0].missing).toContain('cancelled');
    expect(violations[0].missing).toContain('timed_out');
    expect(violations[0].missing).toContain('action_required');
    expect(violations[0].missing).toContain('startup_failure');
  });

  it('flags the sibling regex /failure|cancelled|timed_out/ for missing action_required', () => {
    const code = `
      const failed = runs.filter((r) => /failure|cancelled|timed_out/.test(r.conclusion));
    `;
    const violations = scanFileContent(PATH, code);
    expect(violations).toHaveLength(1);
    expect(violations[0].missing).toEqual(['action_required', 'startup_failure']);
  });

  it('accepts a complete regex covering all FAILING_CONCLUSIONS', () => {
    const code = `
      const failed = runs.filter((r) => /failure|cancelled|timed_out|action_required|startup_failure/.test(r.conclusion));
    `;
    expect(scanFileContent(PATH, code)).toHaveLength(0);
  });

  it('ignores regexes that do not mention any failing conclusion', () => {
    const code = `
      if (conclusion === 'success') return true;
      const ok = /success|neutral|skipped/.test(conclusion);
    `;
    expect(scanFileContent(PATH, code)).toHaveLength(0);
  });

  it('ignores regexes on lines that do not mention conclusion context', () => {
    const code = `
      const title = s.replace(/failure/, 'FAILURE');
    `;
    expect(scanFileContent(PATH, code)).toHaveLength(0);
  });

  it('respects `// conclusion-enum-ok` suppression on the same line', () => {
    const code = `
      const failing = /fail|cancel/.test(c.conclusion); // conclusion-enum-ok: narrow scope
    `;
    expect(scanFileContent(PATH, code)).toHaveLength(0);
  });

  it('respects `// conclusion-enum-ok` suppression on the previous line', () => {
    const code = `
      // conclusion-enum-ok: scoped to draft PRs only
      const failing = /fail|cancel/.test(c.conclusion);
    `;
    expect(scanFileContent(PATH, code)).toHaveLength(0);
  });

  it('treats division as NOT a regex literal', () => {
    const code = `
      // Division, not a regex — line mentions conclusion to trip the prefilter
      const rate = failures / total; // conclusion
    `;
    expect(scanFileContent(PATH, code)).toHaveLength(0);
  });

  it('ignores commented-out regexes (live-code check only)', () => {
    const code = `
      // const old = /failure|cancel/.test(c.conclusion);
      const rate = 1; // conclusion
    `;
    expect(scanFileContent(PATH, code)).toHaveLength(0);
  });

  // QUA-363 hostile-review LOW-6: `error` isn't a canonical GitHub
  // check-run conclusion, but the old flavored-token regex flagged any
  // error-matching regex that happened to be on a line containing
  // "conclusion" in a comment. Dropping `error` from the trigger set
  // eliminates the false positive.
  it('does not flag log-level regexes that happen to be near a "conclusion" word', () => {
    const code = `
      // this line mentions conclusion in a comment for prefilter trip
      const logErrors = /error|fatal/.test(message);
    `;
    expect(scanFileContent(PATH, code)).toHaveLength(0);
  });

  it('catches multiple violations in one file', () => {
    const code = `
      const a = /failure|cancelled/.test(x.conclusion);
      const b = /fail|error/.test(y.conclusion);
    `;
    const violations = scanFileContent(PATH, code);
    expect(violations).toHaveLength(2);
  });

  it('preserves line numbers', () => {
    const code = [
      '',
      'function foo() {',
      '  return /fail|cancel/.test(c.conclusion);',
      '}',
    ].join('\n');
    const violations = scanFileContent(PATH, code);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(3);
  });
});
