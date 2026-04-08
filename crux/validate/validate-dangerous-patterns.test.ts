import { describe, it, expect } from 'vitest';
import { checkLine, extractInlineComment, runCheck } from './validate-dangerous-patterns.ts';

// ---------------------------------------------------------------------------
// Pure-function tests for checkLine — no filesystem
// ---------------------------------------------------------------------------

describe('checkLine — silent-catch', () => {
  it('flags .catch(() => {})', () => {
    const result = checkLine('foo().catch(() => {});', { isRouteFile: false });
    expect(result).toContain('silent-catch');
  });

  it('flags .catch(() => { })', () => {
    const result = checkLine('await foo().catch(() => { });', { isRouteFile: false });
    expect(result).toContain('silent-catch');
  });

  // PR #4023 review HIGH — original regex missed parameterized empty bodies.
  it('flags .catch((e) => {}) — parameterized empty body', () => {
    const result = checkLine('foo().catch((e) => {});', { isRouteFile: false });
    expect(result).toContain('silent-catch');
  });

  it('flags .catch((_e) => {}) — underscore-prefixed param', () => {
    const result = checkLine('foo().catch((_e) => {});', { isRouteFile: false });
    expect(result).toContain('silent-catch');
  });

  it('flags .catch((e: unknown) => {}) — typed param', () => {
    const result = checkLine('foo().catch((e: unknown) => {});', { isRouteFile: false });
    expect(result).toContain('silent-catch');
  });

  it('flags .catch(e => {}) — bare identifier param (no parens)', () => {
    const result = checkLine('foo().catch(e => {});', { isRouteFile: false });
    expect(result).toContain('silent-catch');
  });

  it('does NOT flag .catch with a body', () => {
    const result = checkLine('foo().catch((e) => { logger.error(e); });', { isRouteFile: false });
    expect(result).not.toContain('silent-catch');
  });

  it('suppresses with same-line catch-ok marker', () => {
    const result = checkLine('foo().catch(() => {}); // catch-ok: stream cancel', { isRouteFile: false });
    expect(result).not.toContain('silent-catch');
  });

  it('suppresses with previous-line catch-ok marker', () => {
    const result = checkLine('foo().catch(() => {});', {
      isRouteFile: false,
      previousLine: '  // catch-ok: stream cancel after early-exit',
    });
    expect(result).not.toContain('silent-catch');
  });

  it('does NOT suppress when previous line is code (not a comment)', () => {
    const result = checkLine('foo().catch(() => {});', {
      isRouteFile: false,
      previousLine: '  const marker = "catch-ok";', // contains the string but is code
    });
    expect(result).toContain('silent-catch');
  });
});

describe('checkLine — warn-only-catch', () => {
  it('flags .catch((e) => console.warn(...))', () => {
    const result = checkLine(
      'foo().catch((e) => console.warn("oops", e));',
      { isRouteFile: false },
    );
    expect(result).toContain('warn-only-catch');
  });

  it('flags .catch((e: unknown) => logger.warn(...))', () => {
    const result = checkLine(
      '}).catch((e: unknown) => logger.warn({ error: e }, "Failed"));',
      { isRouteFile: false },
    );
    expect(result).toContain('warn-only-catch');
  });

  it('does NOT flag .catch with a brace body that does multiple things', () => {
    const result = checkLine(
      'foo().catch((e) => { errors++; logger.warn("err", e); });',
      { isRouteFile: false },
    );
    expect(result).not.toContain('warn-only-catch');
  });

  it('does not double-count silent + warn-only', () => {
    const result = checkLine('foo().catch(() => {})', { isRouteFile: false });
    expect(result).toContain('silent-catch');
    expect(result).not.toContain('warn-only-catch');
  });

  it('suppresses with catch-ok marker', () => {
    const result = checkLine(
      '}).catch((e) => logger.warn({ error: e }, "heartbeat fail")); // catch-ok: telemetry',
      { isRouteFile: false },
    );
    expect(result).not.toContain('warn-only-catch');
  });
});

describe('checkLine — as-any-in-route', () => {
  it('flags `as any` only in route files', () => {
    const code = '  const foo = bar as any;';
    expect(checkLine(code, { isRouteFile: true })).toContain('as-any-in-route');
    expect(checkLine(code, { isRouteFile: false })).not.toContain('as-any-in-route');
  });

  it('flags `as unknown as any` in routes', () => {
    const result = checkLine(
      '  const x = thing as unknown as any;',
      { isRouteFile: true },
    );
    expect(result).toContain('as-any-in-route');
  });

  // PR #4023 review HIGH — broadened to catch ALL `as unknown as <Type>` casts,
  // not just when the final type is `any`.
  it('flags `as unknown as Row` (concrete target type)', () => {
    const result = checkLine(
      '  const row = result as unknown as Row;',
      { isRouteFile: true },
    );
    expect(result).toContain('as-any-in-route');
  });

  it('flags `as unknown as MyType` (qualified target type)', () => {
    const result = checkLine(
      '  const x = thing as unknown as MyNamespace.MyType;',
      { isRouteFile: true },
    );
    expect(result).toContain('as-any-in-route');
  });

  it('does NOT flag `as string` or `as number`', () => {
    expect(checkLine('  const x = y as string;', { isRouteFile: true })).not.toContain('as-any-in-route');
    expect(checkLine('  const x = y as number;', { isRouteFile: true })).not.toContain('as-any-in-route');
  });

  it('does NOT flag `as const` (compile-time literal narrowing)', () => {
    const result = checkLine(
      '  const list = ["a", "b"] as const;',
      { isRouteFile: true },
    );
    expect(result).not.toContain('as-any-in-route');
  });

  it('suppresses with as-any-ok marker', () => {
    const result = checkLine(
      '  .where(eq((table as any).id, sourceId)) // as-any-ok: generic table',
      { isRouteFile: true },
    );
    expect(result).not.toContain('as-any-in-route');
  });
});

describe('checkLine — skip-entity-validation', () => {
  it('flags `?skipEntityValidation=true` in URL string literals (single quotes)', () => {
    const result = checkLine(
      "  const url = '/api/foo?skipEntityValidation=true';",
      { isRouteFile: false },
    );
    expect(result).toContain('skip-entity-validation');
  });

  it('flags `?skipEntityValidation=true` in URL string literals (double quotes)', () => {
    const result = checkLine(
      '  const url = "/api/foo?skipEntityValidation=true";',
      { isRouteFile: false },
    );
    expect(result).toContain('skip-entity-validation');
  });

  it('flags `?skipEntityValidation=true` in template literals', () => {
    const result = checkLine(
      '  const url = `/api/foo?skipEntityValidation=true&batch=${id}`;',
      { isRouteFile: false },
    );
    expect(result).toContain('skip-entity-validation');
  });

  it('flags `&skipEntityValidation=true` mid-querystring', () => {
    const result = checkLine(
      '  const url = "/api/foo?batch=1&skipEntityValidation=true";',
      { isRouteFile: false },
    );
    expect(result).toContain('skip-entity-validation');
  });

  it('does NOT flag option-passing code (typed wrapper enforces it at runtime)', () => {
    // The narrowed regex (PR review HIGH#3) intentionally only matches URL string
    // literals. Object-literal option passing goes through the typed wrapper,
    // which throws if a reason is missing.
    const result = checkLine(
      '  syncPersonnel(items, { skipEntityValidation: true });',
      { isRouteFile: false },
    );
    expect(result).not.toContain('skip-entity-validation');
  });

  it('does NOT flag default param values', () => {
    const result = checkLine(
      '  function foo(options = { skipEntityValidation: true }) {',
      { isRouteFile: false },
    );
    expect(result).not.toContain('skip-entity-validation');
  });

  it('suppresses with same-line marker form `// skipEntityValidation-ok: <reason>`', () => {
    const result = checkLine(
      '  const url = "/api/foo?skipEntityValidation=true"; // skipEntityValidation-ok: backfill',
      { isRouteFile: false },
    );
    expect(result).not.toContain('skip-entity-validation');
  });

  it('suppresses with previous-line marker', () => {
    const result = checkLine(
      '  const url = "/api/foo?skipEntityValidation=true";',
      {
        isRouteFile: false,
        previousLine: '  // skipEntityValidation-ok: backfill, see SKIP_REASON',
      },
    );
    expect(result).not.toContain('skip-entity-validation');
  });

  it('does NOT flag plain mentions of the keyword without =true', () => {
    const result = checkLine(
      '  // documents the skipEntityValidation parameter',
      { isRouteFile: false },
    );
    expect(result).not.toContain('skip-entity-validation');
  });
});

describe('checkLine — strict suppression marker form (PR review HIGH#1)', () => {
  // The substring `catch-ok` no longer suppresses unless it appears in the
  // strict `// catch-ok: <reason>` form. This prevents accidental suppression
  // by mentioning the keyword in unrelated contexts.

  it('does NOT suppress when marker substring appears in a string literal', () => {
    const result = checkLine(
      '  const msg = "catch-ok pattern"; foo().catch(() => {});',
      { isRouteFile: false },
    );
    expect(result).toContain('silent-catch');
  });

  it('does NOT suppress when marker has no reason after the colon', () => {
    const result = checkLine(
      '  foo().catch(() => {}); // catch-ok:',
      { isRouteFile: false },
    );
    expect(result).toContain('silent-catch');
  });

  it('does NOT suppress when marker uses wrong separator (no colon)', () => {
    const result = checkLine(
      '  foo().catch(() => {}); // catch-ok stream cancel',
      { isRouteFile: false },
    );
    expect(result).toContain('silent-catch');
  });

  it('suppresses with strict `// catch-ok: <reason>` form', () => {
    const result = checkLine(
      '  foo().catch(() => {}); // catch-ok: stream cancel',
      { isRouteFile: false },
    );
    expect(result).not.toContain('silent-catch');
  });

  it('suppresses with `/* catch-ok: <reason> */` block-comment form', () => {
    const result = checkLine(
      '  foo().catch(() => {}); /* catch-ok: stream cancel */',
      { isRouteFile: false },
    );
    expect(result).not.toContain('silent-catch');
  });

  it('does NOT suppress when only the marker is in code (e.g. variable name)', () => {
    const result = checkLine(
      '  const catch_ok_count = 0; foo().catch(() => {});',
      { isRouteFile: false },
    );
    expect(result).toContain('silent-catch');
  });
});

describe('extractInlineComment — string-literal awareness (PR review HIGH#1)', () => {
  it('returns the comment for a simple inline comment', () => {
    expect(extractInlineComment('foo(); // hello')).toBe(' hello');
  });

  it('returns null when there is no inline comment', () => {
    expect(extractInlineComment('foo();')).toBeNull();
  });

  it('does NOT see // inside a single-quoted string', () => {
    expect(extractInlineComment("const x = '// fake';")).toBeNull();
  });

  it('does NOT see // inside a double-quoted string', () => {
    expect(extractInlineComment('const x = "// fake";')).toBeNull();
  });

  it('does NOT see // inside a backtick string', () => {
    expect(extractInlineComment('const x = `// fake`;')).toBeNull();
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractInlineComment('const x = "say \\"// fake\\""; // real')).toBe(' real');
  });

  it('returns block-comment text for /* */', () => {
    expect(extractInlineComment('foo(); /* note */')).toBe(' note */');
  });

  it('finds the comment after a string literal', () => {
    expect(extractInlineComment('const x = "hello"; // real')).toBe(' real');
  });
});

describe('checkLine — string-literal-aware suppression (PR review HIGH#1 follow-up)', () => {
  // The marker check now operates on extracted comment text only, so a marker
  // substring inside a string literal cannot suppress a real violation.

  it('does NOT suppress when marker is inside a string literal', () => {
    const result = checkLine(
      '  const msg = "// catch-ok: real"; foo().catch(() => {});',
      { isRouteFile: false },
    );
    expect(result).toContain('silent-catch');
  });

  it('does NOT suppress when escaped marker appears in a string', () => {
    const result = checkLine(
      `  const x = "say \\"// catch-ok: fake\\""; foo().catch(() => {});`,
      { isRouteFile: false },
    );
    expect(result).toContain('silent-catch');
  });

  it('does NOT suppress when previous line is code (not a comment)', () => {
    const result = checkLine(
      '  foo().catch(() => {});',
      {
        isRouteFile: false,
        previousLine: '  const x = "catch-ok: hi";',
      },
    );
    expect(result).toContain('silent-catch');
  });

  it('flags template-literal URL bypasses (not just plain strings)', () => {
    const result = checkLine(
      '  await fetch(`/api/foo?skipEntityValidation=true&x=${y}`);',
      { isRouteFile: false },
    );
    expect(result).toContain('skip-entity-validation');
  });
});

describe('checkLine — warn-only-catch tightened (PR review HIGH#2)', () => {
  // The bare `warn(` alternative was removed; only `console.warn` and
  // `logger.warn` are matched.

  it('does NOT flag a bare warn() call (no console./logger. prefix)', () => {
    const result = checkLine(
      '  foo().catch((e) => warn(e));',
      { isRouteFile: false },
    );
    expect(result).not.toContain('warn-only-catch');
  });

  it('still flags console.warn and logger.warn', () => {
    expect(
      checkLine('  foo().catch((e) => console.warn(e));', { isRouteFile: false }),
    ).toContain('warn-only-catch');
    expect(
      checkLine('  foo().catch((e) => logger.warn({}, "fail"));', { isRouteFile: false }),
    ).toContain('warn-only-catch');
  });
});

describe('checkLine — comments are ignored', () => {
  it('skips // comment lines', () => {
    const result = checkLine(
      '  // example: foo().catch(() => {})',
      { isRouteFile: true },
    );
    expect(result).toEqual([]);
  });

  it('skips /* */ block comment lines', () => {
    const result = checkLine(
      ' * Example: foo as any;',
      { isRouteFile: true },
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Whole-codebase regression test
// ---------------------------------------------------------------------------

describe('runCheck — whole-codebase regression guard', () => {
  it('passes on the current codebase (all known violations fixed or suppressed)', () => {
    const result = runCheck();
    if (!result.passed) {
      // Surface the violations in the test output for easier debugging.
      const summary = result.violations
        .map((v) => `  ${v.pattern} ${v.file}:${v.line} — ${v.text.slice(0, 100)}`)
        .join('\n');
      throw new Error(
        `validate-dangerous-patterns failed with ${result.errors} violation(s):\n${summary}`,
      );
    }
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});
