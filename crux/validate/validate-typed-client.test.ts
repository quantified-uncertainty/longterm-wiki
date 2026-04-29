import { describe, it, expect } from 'vitest';
import { lineHasViolation, extractInlineComment, isInsideStringAt } from './validate-typed-client.ts';

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

// ---------------------------------------------------------------------------
// isInsideStringAt — string literal detection
// ---------------------------------------------------------------------------

describe('isInsideStringAt — string-state walking', () => {
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
// extractInlineComment — sanity (mirrors validate-dangerous-patterns)
// ---------------------------------------------------------------------------

describe('extractInlineComment', () => {
  it('returns text after //', () => {
    expect(extractInlineComment('const x = 1; // hello')).toBe(' hello');
  });

  it('returns null when no inline comment', () => {
    expect(extractInlineComment('const x = 1;')).toBe(null);
  });

  it('does not treat // inside string as comment', () => {
    expect(extractInlineComment('const url = "http://example.com";')).toBe(null);
  });
});
