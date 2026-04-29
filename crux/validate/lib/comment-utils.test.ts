import { describe, it, expect } from 'vitest';
import {
  extractInlineComment,
  findInlineCommentStart,
  isInsideStringAt,
  buildSuppressionRegex,
} from './comment-utils.ts';

// ---------------------------------------------------------------------------
// extractInlineComment
// ---------------------------------------------------------------------------

describe('extractInlineComment', () => {
  it('returns text after //', () => {
    expect(extractInlineComment('const x = 1; // hello')).toBe(' hello');
  });

  it('returns text after /*', () => {
    expect(extractInlineComment('const x = 1; /* block */')).toBe(' block */');
  });

  it('returns null when no inline comment', () => {
    expect(extractInlineComment('const x = 1;')).toBe(null);
  });

  it('does not treat // inside double-quoted string as comment', () => {
    expect(extractInlineComment('const url = "http://example.com";')).toBe(null);
  });

  it('does not treat // inside single-quoted string as comment', () => {
    expect(extractInlineComment("const url = 'http://example.com';")).toBe(null);
  });

  it('does not treat // inside template literal as comment', () => {
    expect(extractInlineComment('const url = `http://example.com`;')).toBe(null);
  });

  it('handles escaped quotes correctly', () => {
    expect(
      extractInlineComment('const x = "with \\"//\\" inside"; // real'),
    ).toBe(' real');
  });
});

// ---------------------------------------------------------------------------
// findInlineCommentStart
// ---------------------------------------------------------------------------

describe('findInlineCommentStart', () => {
  it('returns index of // opener', () => {
    const line = 'const x = 1; // hello';
    expect(findInlineCommentStart(line)).toBe(line.indexOf('//'));
  });

  it('returns index of /* opener', () => {
    const line = 'const x = 1; /* block */';
    expect(findInlineCommentStart(line)).toBe(line.indexOf('/*'));
  });

  it('returns -1 when no inline comment', () => {
    expect(findInlineCommentStart('const x = 1;')).toBe(-1);
  });

  it('returns -1 when // is inside a string', () => {
    expect(findInlineCommentStart('const url = "http://example.com";')).toBe(-1);
  });

  it('returns -1 inside a template literal', () => {
    expect(findInlineCommentStart('console.log(`http://x`);')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// isInsideStringAt
// ---------------------------------------------------------------------------

describe('isInsideStringAt', () => {
  it('reports outside strings as false', () => {
    const line = 'const x = apiRequest<T>(';
    const idx = line.indexOf('apiRequest');
    expect(isInsideStringAt(line, idx)).toBe(false);
  });

  it('reports inside double-quoted string as true', () => {
    const line = 'const x = "use apiRequest<T> here";';
    const idx = line.indexOf('apiRequest');
    expect(isInsideStringAt(line, idx)).toBe(true);
  });

  it('reports inside single-quoted string as true', () => {
    const line = "const x = 'apiRequest<T>';";
    const idx = line.indexOf('apiRequest');
    expect(isInsideStringAt(line, idx)).toBe(true);
  });

  it('reports inside template literal as true', () => {
    const line = 'const x = `Found apiRequest<T> calls`;';
    const idx = line.indexOf('apiRequest');
    expect(isInsideStringAt(line, idx)).toBe(true);
  });

  it('handles escaped quotes correctly', () => {
    const line = 'const x = "with \\"quotes\\""; const y = apiRequest<T>(';
    const idx = line.indexOf('apiRequest');
    expect(isInsideStringAt(line, idx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSuppressionRegex
// ---------------------------------------------------------------------------

describe('buildSuppressionRegex', () => {
  it('matches marker followed by colon and reason', () => {
    const re = buildSuppressionRegex('catch-ok');
    expect(re.test('catch-ok: stream cancel')).toBe(true);
  });

  it('does not match marker without colon-reason', () => {
    const re = buildSuppressionRegex('catch-ok');
    expect(re.test('catch-ok')).toBe(false);
  });

  it('does not match marker with empty reason', () => {
    const re = buildSuppressionRegex('catch-ok');
    expect(re.test('catch-ok:  ')).toBe(false);
  });

  it('escapes regex metacharacters in marker', () => {
    const re = buildSuppressionRegex('skipEntityValidation-ok');
    expect(re.test('skipEntityValidation-ok: see SKIP_REASON above')).toBe(true);
  });

  it('requires word-boundary at marker start', () => {
    const re = buildSuppressionRegex('typed-client-ok');
    // No word boundary before the marker (preceded by another word char)
    expect(re.test('xyztyped-client-ok: foo')).toBe(false);
  });
});
