import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCheck } from './validate-typed-client.ts';

// ---------------------------------------------------------------------------
// Integration tests for runCheck() — uses fixture filesystem
// ---------------------------------------------------------------------------
//
// Coverage targets the full orchestration path (file walking → exclude
// filtering → per-line check → aggregation) that unit tests on
// lineHasViolation alone cannot exercise. Also covers adversarial fixtures
// that triggered findings during /agent-review-pr.
// ---------------------------------------------------------------------------

describe('runCheck — integration with fixture filesystem', () => {
  let root: string;
  let scanDir: string;

  function write(rel: string, content: string): void {
    const full = join(scanDir, rel);
    const dir = full.substring(0, full.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(full, content);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'typed-client-int-'));
    scanDir = join(root, 'crux');
    mkdirSync(scanDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run() {
    return runCheck({
      scanDirs: ['crux'],
      excludePaths: ['crux/lib/wiki-server'],
      projectRoot: root,
      silent: true,
    });
  }

  it('passes when no apiRequest<T> calls exist', () => {
    write('a.ts', 'export const x = 1;');
    const result = run();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it('fails on a single unsuppressed violation', () => {
    write('a.ts', 'await apiRequest<MyType>("GET", "/x");');
    const result = run();
    expect(result.passed).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('crux/a.ts');
    expect(result.violations[0].line).toBe(1);
  });

  it('passes when violation is suppressed by inline marker', () => {
    write('a.ts', 'await apiRequest<MyType>("GET", "/x"); // typed-client-ok: ad-hoc');
    expect(run().passed).toBe(true);
  });

  it('passes when violation is suppressed by previous-line marker', () => {
    write(
      'a.ts',
      ['// typed-client-ok: legacy', 'await apiRequest<MyType>("GET", "/x");'].join('\n'),
    );
    expect(run().passed).toBe(true);
  });

  it('aggregates violations across multiple files', () => {
    write('a.ts', 'await apiRequest<A>("GET", "/a");');
    write('b.ts', 'await apiRequest<B>("GET", "/b");');
    write('sub/c.ts', 'await apiRequest<C>("GET", "/c");');
    const result = run();
    expect(result.errors).toBe(3);
    expect(result.violations.map((v) => v.file).sort()).toEqual([
      'crux/a.ts',
      'crux/b.ts',
      'crux/sub/c.ts',
    ]);
  });

  it('excludes files under excludePaths', () => {
    // Files under crux/lib/wiki-server/ should NOT be flagged — those ARE
    // the typed client modules and use apiRequest<T> by design.
    write('lib/wiki-server/personnel.ts', 'await apiRequest<X>("GET", "/x");');
    write('a.ts', 'await apiRequest<Y>("GET", "/y");');
    const result = run();
    expect(result.errors).toBe(1);
    expect(result.violations[0].file).toBe('crux/a.ts');
  });

  it('skips test files', () => {
    write('a.test.ts', 'await apiRequest<X>("GET", "/x");');
    write('a.test.tsx', 'await apiRequest<Y>("GET", "/y");');
    write('__tests__/fixture.ts', 'await apiRequest<Z>("GET", "/z");');
    expect(run().passed).toBe(true);
  });

  it('scans .tsx files', () => {
    write('component.tsx', 'await apiRequest<X>("GET", "/x");');
    const result = run();
    expect(result.errors).toBe(1);
    expect(result.violations[0].file).toBe('crux/component.tsx');
  });

  it('records line and trimmed text accurately', () => {
    write(
      'a.ts',
      [
        'export function fetchX() {',
        '  return apiRequest<{ id: string }>("GET", "/x");',
        '}',
      ].join('\n'),
    );
    const result = run();
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].line).toBe(2);
    expect(result.violations[0].text).toBe('return apiRequest<{ id: string }>("GET", "/x");');
  });

  // -------------------------------------------------------------------------
  // Adversarial fixtures — patterns that came up during /agent-review-pr
  // -------------------------------------------------------------------------

  describe('adversarial — does NOT flag', () => {
    it('apiRequest<T> mention inside a string literal', () => {
      write('a.ts', 'const msg = "use apiRequest<T> here";');
      expect(run().passed).toBe(true);
    });

    it('apiRequest<T> mention inside a template literal', () => {
      write('a.ts', 'console.log(`Found apiRequest<T> calls`);');
      expect(run().passed).toBe(true);
    });

    it('apiRequest<T> mention inside an inline comment after real code', () => {
      // Regression: this was a HIGH false positive flagged by the hostile
      // reviewer. Pre-fix, the regex matched `apiRequest<` in the comment.
      write('a.ts', 'foo(); // see apiRequest<T> docs');
      expect(run().passed).toBe(true);
    });

    it('apiRequest<T> mention inside a trailing block comment', () => {
      write('a.ts', 'foo(); /* TODO: switch to apiRequest<T> here */');
      expect(run().passed).toBe(true);
    });

    it('apiRequest<T> on a line that starts with //', () => {
      write('a.ts', '// const r = apiRequest<X>("GET", "/x");');
      expect(run().passed).toBe(true);
    });

    it('apiRequest<T> on a JSDoc continuation line (* prefix)', () => {
      write(
        'a.ts',
        ['/**', ' * Example: apiRequest<T>("GET", "/x")', ' */', 'export const x = 1;'].join('\n'),
      );
      expect(run().passed).toBe(true);
    });

    it('different function name (myApiRequest<T>)', () => {
      write('a.ts', 'await myApiRequest<X>("GET", "/x");');
      expect(run().passed).toBe(true);
    });

    it('untyped apiRequest( without type parameter', () => {
      write('a.ts', 'await apiRequest("GET", "/x");');
      expect(run().passed).toBe(true);
    });
  });

  describe('adversarial — DOES flag', () => {
    it('apiRequest<T> on the same line as a string mentioning it', () => {
      write('a.ts', 'await apiRequest<X>("GET", "/api/x?reason=apiRequest<T>-debug");');
      expect(run().passed).toBe(false);
    });

    it('apiRequest<T> with extra whitespace before <', () => {
      write('a.ts', 'await apiRequest <X>("GET", "/x");');
      expect(run().passed).toBe(false);
    });

    it('apiRequest<T> with multiline-call where < is on the trigger line', () => {
      write(
        'a.ts',
        [
          'const result = await apiRequest<{',
          '  id: string;',
          '  ok: boolean;',
          '}>("POST", "/x", body);',
        ].join('\n'),
      );
      const result = run();
      expect(result.errors).toBe(1);
      expect(result.violations[0].line).toBe(1);
    });

    it('multiple violations on one line', () => {
      write(
        'a.ts',
        'const [a, b] = [apiRequest<A>("GET", "/a"), apiRequest<B>("GET", "/b")];',
      );
      // The line is flagged once (lineHasViolation returns boolean per line),
      // not once per match. This is the documented behavior.
      const result = run();
      expect(result.errors).toBe(1);
    });

    it('suppression marker without a colon-reason does NOT suppress', () => {
      write('a.ts', 'await apiRequest<X>("GET", "/x"); // typed-client-ok');
      expect(run().passed).toBe(false);
    });

    it('suppression marker inside a string literal does NOT suppress', () => {
      write(
        'a.ts',
        'await apiRequest<X>("GET", "typed-client-ok: not a real comment");',
      );
      expect(run().passed).toBe(false);
    });

    it('suppression marker on a code line above does NOT suppress', () => {
      write(
        'a.ts',
        ['const marker = "typed-client-ok: code";', 'await apiRequest<X>("GET", "/x");'].join('\n'),
      );
      expect(run().passed).toBe(false);
    });

    // Template-expression handling — apiRequest<T> inside `${...}` is real
    // code position and must be caught.
    it('apiRequest<T> inside template-literal ${} expression', () => {
      write('a.ts', 'const x = `result: ${await apiRequest<X>("GET", "/x")}`;');
      expect(run().passed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases — filesystem
  // -------------------------------------------------------------------------

  describe('filesystem edge cases', () => {
    it('handles empty directories gracefully', () => {
      // Don't write any files — scanDir is empty.
      const result = run();
      expect(result.passed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('handles files with no newlines', () => {
      write('a.ts', 'await apiRequest<X>("GET", "/x");');
      const result = run();
      expect(result.errors).toBe(1);
      expect(result.violations[0].line).toBe(1);
    });

    it('handles files with trailing newline', () => {
      write('a.ts', 'await apiRequest<X>("GET", "/x");\n');
      expect(run().errors).toBe(1);
    });

    it('handles very large files', () => {
      // 10K lines, one violation in the middle.
      const lines = Array.from({ length: 10_000 }, (_, i) =>
        i === 5_000 ? 'await apiRequest<X>("GET", "/x");' : `// line ${i}`,
      );
      write('big.ts', lines.join('\n'));
      const result = run();
      expect(result.errors).toBe(1);
      expect(result.violations[0].line).toBe(5_001);
    });

    it('handles deeply nested directories', () => {
      write('a/b/c/d/e/f/deep.ts', 'await apiRequest<X>("GET", "/x");');
      const result = run();
      expect(result.errors).toBe(1);
      expect(result.violations[0].file).toBe('crux/a/b/c/d/e/f/deep.ts');
    });
  });
});
