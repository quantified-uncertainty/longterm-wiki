import { describe, it, expect } from 'vitest';
import {
  PATTERNS,
  parseDiff,
  detectAllPatterns,
  getPatternById,
} from '../patterns.ts';

// ---------------------------------------------------------------------------
// Diff fixtures — each shaped like real `git diff origin/main...HEAD` output.
// Keep these minimal and copy-pasteable so reviewers can see the exact bug
// each pattern detects.
// ---------------------------------------------------------------------------

const DIFF_CONCLUSION_REGEX_GAP = `diff --git a/crux/lib/foo.ts b/crux/lib/foo.ts
index abc..def 100644
--- a/crux/lib/foo.ts
+++ b/crux/lib/foo.ts
@@ -10,3 +10,5 @@
 export function failing(c: { conclusion: string }) {
-  return false;
+  // BUG: regex misses timed_out and action_required
+  return /failure|cancelled/.test(c.conclusion);
 }
`;

const DIFF_COMMAND_HANDLER_NO_TRY = `diff --git a/crux/commands/foo.ts b/crux/commands/foo.ts
index abc..def 100644
--- a/crux/commands/foo.ts
+++ b/crux/commands/foo.ts
@@ -1,3 +1,6 @@
+async function newHandler(args: string[], options: CommandOptions): Promise<CommandResult> {
+  const r = writeFileSync('/tmp/x', 'data');
+  return { exitCode: 0, output: 'ok' };
+}
 export const commands = { default: newHandler };
`;

const DIFF_READDIR_IN_PRIORITY_LOOP = `diff --git a/crux/lib/scan.ts b/crux/lib/scan.ts
index abc..def 100644
--- a/crux/lib/scan.ts
+++ b/crux/lib/scan.ts
@@ -1,4 +1,10 @@
 import { readdirSync } from 'fs';
+export function findFirst(dir: string) {
+  const entries = readdirSync(dir);
+  for (const e of entries) {
+    if (e.startsWith('target')) return e;
+  }
+}
`;

const DIFF_NUMERIC_SUBSTRING = `diff --git a/crux/commands/match.ts b/crux/commands/match.ts
index abc..def 100644
--- a/crux/commands/match.ts
+++ b/crux/commands/match.ts
@@ -5,2 +5,4 @@
 export function hung(line: string, slotPath: string) {
+  // BUG: a1 prefix-collides with a10
+  return line.includes(slotPath);
 }
`;

const DIFF_FAKE_ENV_NEW_CLASS = `diff --git a/crux/lib/foo/__tests__/fake-env.ts b/crux/lib/foo/__tests__/fake-env.ts
new file mode 100644
index 0000000..abc
--- /dev/null
+++ b/crux/lib/foo/__tests__/fake-env.ts
@@ -0,0 +1,5 @@
+export class FakeRuntimeEnv implements Runtime {
+  exec(cmd: string): ExecResult {
+    return { code: 0, stdout: '', stderr: '' };
+  }
+}
`;

const DIFF_CLEAN = `diff --git a/content/docs/foo.mdx b/content/docs/foo.mdx
index abc..def 100644
--- a/content/docs/foo.mdx
+++ b/content/docs/foo.mdx
@@ -1,3 +1,4 @@
 ---
 title: Foo
+description: A page
 ---
`;

// ---------------------------------------------------------------------------
// Registry invariants
// ---------------------------------------------------------------------------

describe('PATTERNS registry', () => {
  it('has at least 5 patterns covering the QUA-339 bug classes', () => {
    expect(PATTERNS.length).toBeGreaterThanOrEqual(5);
  });
  it('every pattern has a unique id', () => {
    const ids = new Set(PATTERNS.map((p) => p.id));
    expect(ids.size).toBe(PATTERNS.length);
  });
  it('every pattern id is kebab-case', () => {
    for (const p of PATTERNS) {
      expect(p.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
  it('every pattern has a nonzero-length reason and label', () => {
    for (const p of PATTERNS) {
      expect(p.label.length).toBeGreaterThan(5);
      expect(p.reason.length).toBeGreaterThan(10);
    }
  });
  it('getPatternById returns the right entry', () => {
    expect(getPatternById('github-conclusion-enum')?.label).toContain('GitHub');
    expect(getPatternById('does-not-exist')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseDiff — the minimal diff parser
// ---------------------------------------------------------------------------

describe('parseDiff', () => {
  it('extracts file path and added lines from a simple diff', () => {
    const d = parseDiff(DIFF_CLEAN);
    expect(d.files).toHaveLength(1);
    expect(d.files[0].path).toBe('content/docs/foo.mdx');
    expect(d.files[0].added).toBe(false);
    expect(d.files[0].addedLines.map((l) => l.content)).toContain('description: A page');
  });
  it('marks `new file mode` files as added', () => {
    const d = parseDiff(DIFF_FAKE_ENV_NEW_CLASS);
    expect(d.files[0].added).toBe(true);
  });
  it('tracks new-file line numbers through hunks', () => {
    const d = parseDiff(DIFF_CONCLUSION_REGEX_GAP);
    const added = d.files[0].addedLines.find((l) => l.content.includes('timed_out'));
    expect(added?.newLineNumber).toBeGreaterThan(0);
  });
  it('handles multi-file diffs', () => {
    const combined = DIFF_CLEAN + DIFF_CONCLUSION_REGEX_GAP;
    const d = parseDiff(combined);
    expect(d.files).toHaveLength(2);
    expect(d.files.map((f) => f.path).sort()).toEqual([
      'content/docs/foo.mdx',
      'crux/lib/foo.ts',
    ]);
  });
  it('ignores the +++ / --- diff headers in added-line collection', () => {
    const d = parseDiff(DIFF_CONCLUSION_REGEX_GAP);
    const weirdHeaders = d.files[0].addedLines.filter((l) => l.content.startsWith('++'));
    expect(weirdHeaders).toHaveLength(0);
  });

  // QUA-363 hostile-review MED-4: a content line that literally starts
  // with `+++` (e.g., 4+ plus signs in source code, MDX bullets, ASCII
  // art separators) used to be misclassified as the `+++` file header
  // via .startsWith('+++'). The fix requires the trailing space that
  // distinguishes `+++ b/path` from `+++ content`.
  it('classifies content lines starting with `+++` as added, not headers', () => {
    const d = parseDiff(`diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,4 @@
 normal context
+++ three pluses at start of content
++++ four pluses at start of content
 more context
`);
    expect(d.files).toHaveLength(1);
    const added = d.files[0].addedLines.map((l) => l.content);
    expect(added).toContain('++ three pluses at start of content');
    expect(added).toContain('+++ four pluses at start of content');
  });

  it('classifies context lines starting with `---` as context, not headers', () => {
    // Mirror of the above for the `---` side: a content line beginning
    // with `---` (e.g., MDX frontmatter delimiter) must not be treated
    // as the file-header form `--- a/path`.
    const d = parseDiff(`diff --git a/foo.mdx b/foo.mdx
index abc..def 100644
--- a/foo.mdx
+++ b/foo.mdx
@@ -1,3 +1,4 @@
 ---
 title: Foo
+description: A page
 ---
`);
    // The frontmatter `---` on context lines should not corrupt line numbers
    expect(d.files[0].path).toBe('foo.mdx');
    const added = d.files[0].addedLines.find((l) => l.content.includes('description'));
    expect(added).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Individual pattern detection — one "triggers" + one "clean" per pattern
// ---------------------------------------------------------------------------

describe('github-conclusion-enum', () => {
  const pattern = getPatternById('github-conclusion-enum')!;
  it('detects regex gap', () => {
    const hits = pattern.detect(parseDiff(DIFF_CONCLUSION_REGEX_GAP));
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('crux/lib/foo.ts');
    expect(hits[0].snippet).toContain('failure|cancelled');
  });
  it('no false positives on clean diff', () => {
    expect(pattern.detect(parseDiff(DIFF_CLEAN))).toHaveLength(0);
  });
  it('skips test files', () => {
    const d = DIFF_CONCLUSION_REGEX_GAP.replaceAll('crux/lib/foo.ts', 'crux/lib/foo.test.ts');
    expect(pattern.detect(parseDiff(d))).toHaveLength(0);
  });
  it('skips .spec.ts files', () => {
    const d = DIFF_CONCLUSION_REGEX_GAP.replaceAll('crux/lib/foo.ts', 'crux/lib/foo.spec.ts');
    expect(pattern.detect(parseDiff(d))).toHaveLength(0);
  });
  it('skips files inside __tests__ directories', () => {
    const d = DIFF_CONCLUSION_REGEX_GAP.replaceAll(
      'crux/lib/foo.ts',
      'crux/lib/__tests__/foo.ts',
    );
    expect(pattern.detect(parseDiff(d))).toHaveLength(0);
  });
});

describe('command-handler-error-boundary', () => {
  const pattern = getPatternById('command-handler-error-boundary')!;
  it('detects new handler in crux/commands/', () => {
    const hits = pattern.detect(parseDiff(DIFF_COMMAND_HANDLER_NO_TRY));
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('crux/commands/foo.ts');
  });
  it('ignores handler-shaped code outside crux/commands/', () => {
    const d = DIFF_COMMAND_HANDLER_NO_TRY.replace(/crux\/commands/g, 'crux/lib');
    expect(pattern.detect(parseDiff(d))).toHaveLength(0);
  });
});

describe('readdir-iteration-determinism', () => {
  const pattern = getPatternById('readdir-iteration-determinism')!;
  it('detects readdirSync in new code', () => {
    const hits = pattern.detect(parseDiff(DIFF_READDIR_IN_PRIORITY_LOOP));
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('readdirSync');
  });
  it('no false positives', () => {
    expect(pattern.detect(parseDiff(DIFF_CLEAN))).toHaveLength(0);
  });
});

describe('numeric-id-substring-match', () => {
  const pattern = getPatternById('numeric-id-substring-match')!;
  it('detects .includes() against a *Path variable', () => {
    const hits = pattern.detect(parseDiff(DIFF_NUMERIC_SUBSTRING));
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('slotPath');
  });
  it('does not trigger on .includes(stringLiteral)', () => {
    const benign = `diff --git a/crux/lib/x.ts b/crux/lib/x.ts
--- a/crux/lib/x.ts
+++ b/crux/lib/x.ts
@@ -1,1 +1,2 @@
+const has = name.includes('thing');
`;
    expect(pattern.detect(parseDiff(benign))).toHaveLength(0);
  });
});

describe('test-fake-silent-default', () => {
  const pattern = getPatternById('test-fake-silent-default')!;
  it('detects new FakeEnv class in __tests__/', () => {
    const hits = pattern.detect(parseDiff(DIFF_FAKE_ENV_NEW_CLASS));
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toContain('fake-env');
  });
  it('does not trigger on a normal class in product code', () => {
    const d = `diff --git a/crux/lib/real.ts b/crux/lib/real.ts
--- a/crux/lib/real.ts
+++ b/crux/lib/real.ts
@@ -1,1 +1,2 @@
+export class RealThing { x = 1; }
`;
    expect(pattern.detect(parseDiff(d))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectAllPatterns — integration
// ---------------------------------------------------------------------------

describe('detectAllPatterns', () => {
  it('returns empty list for clean diff', () => {
    expect(detectAllPatterns(parseDiff(DIFF_CLEAN))).toHaveLength(0);
  });
  it('catches the QUA-339 pass-2 bug shapes in one combined diff', () => {
    const combined = [
      DIFF_CONCLUSION_REGEX_GAP,
      DIFF_COMMAND_HANDLER_NO_TRY,
      DIFF_READDIR_IN_PRIORITY_LOOP,
      DIFF_NUMERIC_SUBSTRING,
      DIFF_FAKE_ENV_NEW_CLASS,
    ].join('');
    const detections = detectAllPatterns(parseDiff(combined));
    const ids = detections.map((d) => d.pattern.id).sort();
    expect(ids).toEqual([
      'command-handler-error-boundary',
      'github-conclusion-enum',
      'numeric-id-substring-match',
      'readdir-iteration-determinism',
      'test-fake-silent-default',
    ]);
  });
});
