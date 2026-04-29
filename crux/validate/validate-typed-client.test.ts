import { describe, it, expect } from 'vitest';
import { lineHasViolation } from './validate-typed-client.ts';

// Note: extractInlineComment, findInlineCommentStart, isInsideStringAt, and
// buildSuppressionRegex are tested directly in `lib/comment-utils.test.ts`.
// This file focuses on lineHasViolation, which composes those helpers.

// ---------------------------------------------------------------------------
// lineHasViolation — typed-client violations and suppression
// ---------------------------------------------------------------------------

describe('lineHasViolation — flags direct apiRequest<T> calls', () => {
  it('flags inline-type-literal apiRequest<{ id: string }>', () => {
    expect(lineHasViolation('const r = await apiRequest<{ id: string }>("POST", "/foo", body);')).toBe(true);
  });

  it('flags named-type apiRequest<MyType>', () => {
    expect(lineHasViolation('  const r = await apiRequest<MyType>("GET", "/foo");')).toBe(true);
  });

  it('flags multi-line apiRequest<{ ... }>(', () => {
    expect(lineHasViolation('    const result = await apiRequest<{ ok: boolean }>(')).toBe(true);
  });

  it('flags whitespace between apiRequest and <', () => {
    expect(lineHasViolation('await apiRequest <T>("GET", "/x");')).toBe(true);
  });
});

describe('lineHasViolation — does NOT flag', () => {
  it('untyped apiRequest( without type parameter', () => {
    expect(lineHasViolation('await apiRequest("GET", "/foo");')).toBe(false);
  });

  it('apiRequest mentioned in a string literal', () => {
    expect(lineHasViolation('const msg = "use apiRequest<T> here";')).toBe(false);
  });

  it('apiRequest mentioned in a template literal', () => {
    expect(lineHasViolation('console.log(`Found apiRequest<T> calls`);')).toBe(false);
  });

  // Regression: prior to the comment-position check, this line was
  // flagged because the regex matched inside the comment. The fix
  // skips matches that fall after the inline comment opener.
  it('apiRequest mentioned in an inline comment after real code', () => {
    expect(
      lineHasViolation('foo(); // see apiRequest<T> docs for details'),
    ).toBe(false);
  });

  it('apiRequest mentioned in a trailing block comment', () => {
    expect(
      lineHasViolation('foo(); /* TODO: switch to apiRequest<T> here */'),
    ).toBe(false);
  });

  it('does flag when real code call precedes a comment-only mention', () => {
    expect(
      lineHasViolation(
        'await apiRequest<T>("GET", "/x"); // see apiRequest<T> docs',
      ),
    ).toBe(true);
  });

  it('different function (myApiRequest<T>)', () => {
    // The \b boundary still matches "apiRequest" inside "myApiRequest" because
    // \b requires a word boundary, which exists between "my" and "ApiRequest".
    // Since "myApiRequest" is camelCase, \bapiRequest does NOT match (no word
    // boundary at "y|A"). This is correct.
    expect(lineHasViolation('await myApiRequest<T>("GET", "/x");')).toBe(false);
  });

  it('commented-out lines (single-line comment)', () => {
    expect(lineHasViolation('// const r = apiRequest<T>("GET", "/x");')).toBe(false);
  });

  it('commented-out lines (jsdoc star)', () => {
    expect(lineHasViolation(' * const r = apiRequest<T>("GET", "/x");')).toBe(false);
  });

  it('block-comment-style lines', () => {
    expect(lineHasViolation('/* apiRequest<T> example */')).toBe(false);
  });
});

describe('lineHasViolation — suppression with typed-client-ok marker', () => {
  it('suppresses with same-line marker', () => {
    expect(
      lineHasViolation(
        'await apiRequest<T>("GET", "/x"); // typed-client-ok: legacy script',
      ),
    ).toBe(false);
  });

  it('suppresses with previous-line marker', () => {
    expect(
      lineHasViolation('await apiRequest<T>("GET", "/x");', {
        previousLine: '  // typed-client-ok: internal worker control plane',
      }),
    ).toBe(false);
  });

  it('does NOT suppress without a colon-reason format', () => {
    // Marker without "<marker>: <reason>" is NOT a valid suppression.
    expect(
      lineHasViolation('await apiRequest<T>("GET", "/x"); // typed-client-ok'),
    ).toBe(true);
  });

  it('does NOT suppress when marker is in a string literal', () => {
    expect(
      lineHasViolation(
        'await apiRequest<T>("GET", "typed-client-ok: not a real comment");',
      ),
    ).toBe(true);
  });

  it('does NOT suppress when previous line is code (not a comment)', () => {
    expect(
      lineHasViolation('await apiRequest<T>("GET", "/x");', {
        previousLine: '  const marker = "typed-client-ok: x";',
      }),
    ).toBe(true);
  });

  it('suppresses with previous-line block-comment marker', () => {
    expect(
      lineHasViolation('await apiRequest<T>("GET", "/x");', {
        previousLine: '  /* typed-client-ok: jsdoc reason */',
      }),
    ).toBe(false);
  });
});

