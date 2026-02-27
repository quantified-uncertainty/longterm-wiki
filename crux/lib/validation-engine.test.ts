/**
 * Unit Tests for ValidationEngine, Issue, and ContentFile
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { Issue, Severity, FixType, ContentFile, ValidationEngine } from './validation-engine.ts';
import { CONTENT_DIR_ABS } from './content-types.ts';

// ---------------------------------------------------------------------------
// Issue class basics
// ---------------------------------------------------------------------------

describe('Issue class', () => {
  it('toString() includes severity, rule, file, line, and message', () => {
    const issue = new Issue({
      rule: 'test-rule',
      file: 'content/docs/test.mdx',
      line: 42,
      message: 'Something is wrong',
      severity: Severity.ERROR,
    });
    expect(issue.toString()).toBe(
      '[ERROR] test-rule: content/docs/test.mdx:42 - Something is wrong'
    );
  });

  it('toString() omits line number when not set', () => {
    const issue = new Issue({
      rule: 'test-rule',
      file: 'content/docs/test.mdx',
      message: 'No line info',
    });
    expect(issue.toString()).toBe(
      '[ERROR] test-rule: content/docs/test.mdx - No line info'
    );
  });

  it('toString() uses default severity ERROR when not specified', () => {
    const issue = new Issue({
      rule: 'r',
      file: 'f',
      message: 'm',
    });
    expect(issue.toString()).toContain('[ERROR]');
  });

  it('isFixable returns true when fix has a type', () => {
    const issue = new Issue({
      rule: 'test-rule',
      file: 'test.mdx',
      message: 'fixable',
      fix: { type: FixType.REPLACE_TEXT, oldText: 'a', newText: 'b' },
    });
    expect(issue.isFixable).toBe(true);
  });

  it('isFixable returns false when fix is null', () => {
    const issue = new Issue({
      rule: 'test-rule',
      file: 'test.mdx',
      message: 'not fixable',
      fix: null,
    });
    expect(issue.isFixable).toBe(false);
  });

  it('isFixable returns false when fix has no type', () => {
    const issue = new Issue({
      rule: 'test-rule',
      file: 'test.mdx',
      message: 'bad fix',
      // fix object without a type field
      fix: { oldText: 'a', newText: 'b' } as any,
    });
    expect(issue.isFixable).toBe(false);
  });

  it('defaults severity to ERROR', () => {
    const issue = new Issue({
      rule: 'r',
      file: 'f',
      message: 'm',
    });
    expect(issue.severity).toBe(Severity.ERROR);
  });

  it('defaults fix to null', () => {
    const issue = new Issue({
      rule: 'r',
      file: 'f',
      message: 'm',
    });
    expect(issue.fix).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ContentFile construction
// ---------------------------------------------------------------------------

describe('ContentFile', () => {
  const makePath = (relativePart: string) => join(CONTENT_DIR_ABS, relativePart);

  it('parses frontmatter correctly', () => {
    const raw = '---\ntitle: Hello World\ndescription: A test\n---\nBody text here.';
    const cf = new ContentFile(makePath('hello-world.mdx'), raw);
    expect(cf.frontmatter).toEqual({ title: 'Hello World', description: 'A test' });
  });

  it('extracts body correctly', () => {
    const raw = '---\ntitle: Test\n---\nLine one\nLine two';
    const cf = new ContentFile(makePath('test.mdx'), raw);
    expect(cf.body).toBe('Line one\nLine two');
  });

  it('handles content with no frontmatter', () => {
    const raw = 'Just some body text.';
    const cf = new ContentFile(makePath('no-fm.mdx'), raw);
    expect(cf.frontmatter).toEqual({});
    expect(cf.body).toBe('Just some body text.');
  });

  it('sets isIndex for index files', () => {
    const raw = '---\ntitle: Index\n---\nContent';
    const cf = new ContentFile(makePath('ai-safety/index.mdx'), raw);
    expect(cf.isIndex).toBe(true);
  });

  it('sets isIndex to false for non-index files', () => {
    const raw = '---\ntitle: Page\n---\nContent';
    const cf = new ContentFile(makePath('ai-safety/overview.mdx'), raw);
    expect(cf.isIndex).toBe(false);
  });

  it('sets slug correctly for regular files', () => {
    const raw = '---\ntitle: Test\n---\nBody';
    const cf = new ContentFile(makePath('ai-safety/overview.mdx'), raw);
    expect(cf.slug).toBe('ai-safety/overview');
  });

  it('sets slug correctly for index files (strips /index)', () => {
    const raw = '---\ntitle: Test\n---\nBody';
    const cf = new ContentFile(makePath('ai-safety/index.mdx'), raw);
    expect(cf.slug).toBe('ai-safety');
  });

  it('urlPath returns correct path with trailing slash', () => {
    const raw = '---\ntitle: Test\n---\nBody';
    const cf = new ContentFile(makePath('ai-safety/overview.mdx'), raw);
    expect(cf.urlPath).toBe('/ai-safety/overview/');
  });

  it('urlPath handles index files correctly', () => {
    const raw = '---\ntitle: Test\n---\nBody';
    const cf = new ContentFile(makePath('ai-safety/index.mdx'), raw);
    expect(cf.urlPath).toBe('/ai-safety/');
  });

  it('sets extension correctly', () => {
    const raw = '---\ntitle: Test\n---\nBody';
    const cf = new ContentFile(makePath('test.mdx'), raw);
    expect(cf.extension).toBe('mdx');
  });

  it('sets directory correctly', () => {
    const raw = '---\ntitle: Test\n---\nBody';
    const cf = new ContentFile(makePath('ai-safety/overview.mdx'), raw);
    expect(cf.directory).toBe('ai-safety');
  });

  it('stores raw content', () => {
    const raw = '---\ntitle: Test\n---\nBody';
    const cf = new ContentFile(makePath('test.mdx'), raw);
    expect(cf.raw).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// ValidationEngine.applyFixesToContentString
// ---------------------------------------------------------------------------

describe('ValidationEngine.applyFixesToContentString', () => {
  // Content with frontmatter. Body lines start at line 1 (from the body's
  // perspective). The frontmatter is:
  //   Line 0: ---
  //   Line 1: title: Test
  //   Line 2: ---
  // So frontmatterEndLine = 3. Body line 1 maps to absolute line 4 (index 3).
  const contentWithFm = '---\ntitle: Test\n---\nLine one\nLine two\nLine three';
  const contentNoFm = 'Line one\nLine two\nLine three';

  function makeEngine(): ValidationEngine {
    return new ValidationEngine();
  }

  function makeIssue(overrides: Partial<{ line: number; fix: any; rule: string; file: string; message: string; severity: string }>): Issue {
    return new Issue({
      rule: overrides.rule ?? 'test-rule',
      file: overrides.file ?? 'test.mdx',
      line: overrides.line,
      message: overrides.message ?? 'test',
      severity: overrides.severity ?? Severity.WARNING,
      fix: overrides.fix ?? null,
    });
  }

  it('REPLACE_TEXT fix works correctly', () => {
    const engine = makeEngine();
    const issues = [
      makeIssue({
        line: 1,
        fix: { type: FixType.REPLACE_TEXT, oldText: 'one', newText: 'ONE' },
      }),
    ];
    const result = engine.applyFixesToContentString(contentWithFm, issues);
    expect(result).toContain('Line ONE');
    expect(result).not.toContain('Line one');
  });

  it('REPLACE_LINE fix works correctly', () => {
    const engine = makeEngine();
    const issues = [
      makeIssue({
        line: 2,
        fix: { type: FixType.REPLACE_LINE, content: 'Replaced line two' },
      }),
    ];
    const result = engine.applyFixesToContentString(contentWithFm, issues);
    expect(result).toContain('Replaced line two');
    expect(result).not.toContain('Line two');
  });

  it('INSERT_LINE_BEFORE works', () => {
    const engine = makeEngine();
    const issues = [
      makeIssue({
        line: 2,
        fix: { type: FixType.INSERT_LINE_BEFORE, content: 'Inserted before two' },
      }),
    ];
    const result = engine.applyFixesToContentString(contentWithFm, issues);
    const lines = result.split('\n');
    const idx = lines.indexOf('Inserted before two');
    expect(idx).toBeGreaterThan(-1);
    expect(lines[idx + 1]).toBe('Line two');
  });

  it('INSERT_LINE_AFTER works', () => {
    const engine = makeEngine();
    const issues = [
      makeIssue({
        line: 2,
        fix: { type: FixType.INSERT_LINE_AFTER, content: 'Inserted after two' },
      }),
    ];
    const result = engine.applyFixesToContentString(contentWithFm, issues);
    const lines = result.split('\n');
    const idx = lines.indexOf('Line two');
    expect(idx).toBeGreaterThan(-1);
    expect(lines[idx + 1]).toBe('Inserted after two');
  });

  it('out-of-bounds line numbers are handled gracefully (no crash)', () => {
    const engine = makeEngine();
    const issues = [
      makeIssue({
        line: 999,
        fix: { type: FixType.REPLACE_LINE, content: 'Should not appear' },
      }),
    ];
    // Should not throw
    const result = engine.applyFixesToContentString(contentWithFm, issues);
    // Content should be unchanged
    expect(result).toBe(contentWithFm);
  });

  it('negative line numbers are handled gracefully', () => {
    const engine = makeEngine();
    const issues = [
      makeIssue({
        line: -5,
        fix: { type: FixType.REPLACE_LINE, content: 'Should not appear' },
      }),
    ];
    const result = engine.applyFixesToContentString(contentWithFm, issues);
    expect(result).toBe(contentWithFm);
  });

  it('issues without line numbers are skipped', () => {
    const engine = makeEngine();
    const issues = [
      makeIssue({
        fix: { type: FixType.REPLACE_TEXT, oldText: 'one', newText: 'ONE' },
        // no line
      }),
    ];
    const result = engine.applyFixesToContentString(contentWithFm, issues);
    expect(result).toBe(contentWithFm);
  });

  it('multiple fixes applied in correct order (reverse line order)', () => {
    const engine = makeEngine();
    const issues = [
      makeIssue({
        line: 1,
        fix: { type: FixType.REPLACE_TEXT, oldText: 'one', newText: 'ONE' },
      }),
      makeIssue({
        line: 3,
        fix: { type: FixType.REPLACE_TEXT, oldText: 'three', newText: 'THREE' },
      }),
    ];
    const result = engine.applyFixesToContentString(contentWithFm, issues);
    expect(result).toContain('Line ONE');
    expect(result).toContain('Line THREE');
    // Middle line should be unchanged
    expect(result).toContain('Line two');
  });

  it('dollar signs in fix.newText do not cause replacement issues', () => {
    // This is the $& regression test. String.replace treats $& as the matched
    // substring, $` as pre-match, $' as post-match. The indexOf+slice approach
    // should not have this problem.
    const engine = makeEngine();
    const content = '---\ntitle: Test\n---\nThe cost is $100 per unit.';
    const issues = [
      makeIssue({
        line: 1,
        fix: {
          type: FixType.REPLACE_TEXT,
          oldText: '$100',
          newText: '\\$100',
        },
      }),
    ];
    const result = engine.applyFixesToContentString(content, issues);
    expect(result).toContain('\\$100');
    expect(result).not.toContain('The cost is $100 per unit.');
  });

  it('dollar signs with special regex patterns in newText are treated literally', () => {
    const engine = makeEngine();
    const content = '---\ntitle: Test\n---\nPrice is $50.';
    const issues = [
      makeIssue({
        line: 1,
        fix: {
          type: FixType.REPLACE_TEXT,
          oldText: '$50',
          // $& would be problematic with String.replace
          newText: '$&escaped',
        },
      }),
    ];
    const result = engine.applyFixesToContentString(content, issues);
    expect(result).toContain('$&escaped');
  });

  it('non-fixable issues are filtered out', () => {
    const engine = makeEngine();
    const issues = [
      makeIssue({
        line: 1,
        // no fix - should be filtered by applyFixesToContentString
        fix: null,
      }),
    ];
    const result = engine.applyFixesToContentString(contentWithFm, issues);
    expect(result).toBe(contentWithFm);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter offset behavior (tests _getFrontmatterEndLine indirectly)
// ---------------------------------------------------------------------------

describe('frontmatter line offset', () => {
  function makeEngine(): ValidationEngine {
    return new ValidationEngine();
  }

  function makeIssue(line: number, fix: any): Issue {
    return new Issue({
      rule: 'test',
      file: 'test.mdx',
      line,
      message: 'test',
      fix,
    });
  }

  it('content with frontmatter: body line 1 targets the first body line', () => {
    // Frontmatter = lines 0-2 (---, title: T, ---), so frontmatterEndLine = 3
    // Body line 1 should map to absolute line 4 (index 3)
    const content = '---\ntitle: T\n---\nFirst body line\nSecond body line';
    const engine = makeEngine();
    const issues = [
      makeIssue(1, { type: FixType.REPLACE_LINE, content: 'REPLACED' }),
    ];
    const result = engine.applyFixesToContentString(content, issues);
    const lines = result.split('\n');
    expect(lines[3]).toBe('REPLACED');
    expect(lines[4]).toBe('Second body line');
  });

  it('content without frontmatter: line offset is 0', () => {
    // No frontmatter, so frontmatterEndLine = 0
    // Body line 1 should map to absolute line 1 (index 0)
    const content = 'First line\nSecond line';
    const engine = makeEngine();
    const issues = [
      makeIssue(1, { type: FixType.REPLACE_LINE, content: 'REPLACED' }),
    ];
    const result = engine.applyFixesToContentString(content, issues);
    const lines = result.split('\n');
    expect(lines[0]).toBe('REPLACED');
    expect(lines[1]).toBe('Second line');
  });

  it('multi-line frontmatter with extra fields offsets correctly', () => {
    // 5-line frontmatter: ---, title, description, tags, ---
    const content = '---\ntitle: T\ndescription: D\ntags: [a]\n---\nBody here';
    const engine = makeEngine();
    const issues = [
      makeIssue(1, { type: FixType.REPLACE_LINE, content: 'REPLACED BODY' }),
    ];
    const result = engine.applyFixesToContentString(content, issues);
    const lines = result.split('\n');
    // frontmatterEndLine should be 5 (lines 0-4 are frontmatter)
    expect(lines[5]).toBe('REPLACED BODY');
  });
});

// ---------------------------------------------------------------------------
// ValidationEngine.getSummary
// ---------------------------------------------------------------------------

describe('ValidationEngine.getSummary', () => {
  function makeEngine(): ValidationEngine {
    return new ValidationEngine();
  }

  it('returns correct counts by severity', () => {
    const engine = makeEngine();
    const issues = [
      new Issue({ rule: 'r1', file: 'f', message: 'm', severity: Severity.ERROR }),
      new Issue({ rule: 'r1', file: 'f', message: 'm', severity: Severity.ERROR }),
      new Issue({ rule: 'r2', file: 'f', message: 'm', severity: Severity.WARNING }),
      new Issue({ rule: 'r3', file: 'f', message: 'm', severity: Severity.INFO }),
      new Issue({ rule: 'r3', file: 'f', message: 'm', severity: Severity.INFO }),
      new Issue({ rule: 'r3', file: 'f', message: 'm', severity: Severity.INFO }),
    ];
    const summary = engine.getSummary(issues);
    expect(summary.bySeverity.error).toBe(2);
    expect(summary.bySeverity.warning).toBe(1);
    expect(summary.bySeverity.info).toBe(3);
  });

  it('returns correct total', () => {
    const engine = makeEngine();
    const issues = [
      new Issue({ rule: 'r1', file: 'f', message: 'm' }),
      new Issue({ rule: 'r2', file: 'f', message: 'm' }),
    ];
    const summary = engine.getSummary(issues);
    expect(summary.total).toBe(2);
  });

  it('groups counts by rule', () => {
    const engine = makeEngine();
    const issues = [
      new Issue({ rule: 'dollar-signs', file: 'f', message: 'm' }),
      new Issue({ rule: 'dollar-signs', file: 'f', message: 'm' }),
      new Issue({ rule: 'comparison-ops', file: 'f', message: 'm' }),
    ];
    const summary = engine.getSummary(issues);
    expect(summary.byRule['dollar-signs']).toBe(2);
    expect(summary.byRule['comparison-ops']).toBe(1);
  });

  it('hasErrors is true when there are error-severity issues', () => {
    const engine = makeEngine();
    const issues = [
      new Issue({ rule: 'r', file: 'f', message: 'm', severity: Severity.ERROR }),
    ];
    const summary = engine.getSummary(issues);
    expect(summary.hasErrors).toBe(true);
  });

  it('hasErrors is false when there are no error-severity issues', () => {
    const engine = makeEngine();
    const issues = [
      new Issue({ rule: 'r', file: 'f', message: 'm', severity: Severity.WARNING }),
      new Issue({ rule: 'r', file: 'f', message: 'm', severity: Severity.INFO }),
    ];
    const summary = engine.getSummary(issues);
    expect(summary.hasErrors).toBe(false);
  });

  it('handles empty issues array', () => {
    const engine = makeEngine();
    const summary = engine.getSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.bySeverity.error).toBe(0);
    expect(summary.bySeverity.warning).toBe(0);
    expect(summary.bySeverity.info).toBe(0);
    expect(summary.hasErrors).toBe(false);
    expect(Object.keys(summary.byRule)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ValidationEngine rule registration
// ---------------------------------------------------------------------------

describe('ValidationEngine.addRule', () => {
  it('registers a rule and retrieves it by id', () => {
    const engine = new ValidationEngine();
    const rule = {
      id: 'test-rule',
      name: 'Test Rule',
      description: 'A test',
      check: () => [],
    };
    engine.addRule(rule);
    expect(engine.getRule('test-rule')).toBe(rule);
  });

  it('throws when rule has no id', () => {
    const engine = new ValidationEngine();
    expect(() =>
      engine.addRule({ id: '', name: 'Bad', description: 'no id', check: () => [] })
    ).toThrow('Rule must have id and check function');
  });

  it('throws when rule has no check function', () => {
    const engine = new ValidationEngine();
    expect(() =>
      engine.addRule({ id: 'x', name: 'Bad', description: 'no check' } as any)
    ).toThrow('Rule must have id and check function');
  });

  it('addRules registers multiple rules', () => {
    const engine = new ValidationEngine();
    const rules = [
      { id: 'r1', name: 'R1', description: 'd', check: () => [] },
      { id: 'r2', name: 'R2', description: 'd', check: () => [] },
    ];
    engine.addRules(rules);
    expect(engine.getRule('r1')).toBeDefined();
    expect(engine.getRule('r2')).toBeDefined();
  });
});
