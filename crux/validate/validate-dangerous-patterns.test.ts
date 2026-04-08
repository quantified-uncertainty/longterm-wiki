import { describe, it, expect } from 'vitest';
import { checkLine, runCheck } from './validate-dangerous-patterns.ts';

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

  it('does NOT flag `as string` or `as number`', () => {
    expect(checkLine('  const x = y as string;', { isRouteFile: true })).not.toContain('as-any-in-route');
    expect(checkLine('  const x = y as number;', { isRouteFile: true })).not.toContain('as-any-in-route');
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
  it('flags `skipEntityValidation=true` in URL strings', () => {
    const result = checkLine(
      '  const url = "/api/foo?skipEntityValidation=true";',
      { isRouteFile: false },
    );
    expect(result).toContain('skip-entity-validation');
  });

  it('flags `skipEntityValidation: true` in object literals', () => {
    const result = checkLine(
      '  syncPersonnel(items, { skipEntityValidation: true });',
      { isRouteFile: false },
    );
    expect(result).toContain('skip-entity-validation');
  });

  it('suppresses with same-line skipEntityValidation-ok marker', () => {
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
