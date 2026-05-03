import { describe, it, expect } from 'vitest';
import { lineHasBannedFormatter, runCheck } from './validate-table-formatting.ts';

describe('validate-table-formatting — runCheck (regression guard)', () => {
  it('passes on the current codebase — directory tables use shared formatters', () => {
    // QUA-1006 regression guard: if someone adds new ad-hoc
    // .toLocaleString / .toLocaleDateString / Intl.NumberFormat calls to a
    // user-facing *-table.tsx without the table-formatting-ok marker, this
    // test will fail.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});

describe('lineHasBannedFormatter — banned patterns', () => {
  it('flags .toLocaleString', () => {
    const hit = lineHasBannedFormatter('  return n.toLocaleString();');
    expect(hit?.label).toBe('.toLocaleString');
  });

  it('flags .toLocaleDateString', () => {
    const hit = lineHasBannedFormatter('  return new Date(s).toLocaleDateString();');
    expect(hit?.label).toBe('.toLocaleDateString');
  });

  it('flags Intl.NumberFormat', () => {
    const hit = lineHasBannedFormatter('  const fmt = new Intl.NumberFormat();');
    expect(hit?.label).toBe('Intl.NumberFormat');
  });

  it('flags Intl.DateTimeFormat', () => {
    const hit = lineHasBannedFormatter('  const fmt = new Intl.DateTimeFormat();');
    expect(hit?.label).toBe('Intl.DateTimeFormat');
  });

  it('returns null for clean lines', () => {
    expect(lineHasBannedFormatter('  return formatCount(n);')).toBeNull();
    expect(lineHasBannedFormatter('  const x = 42;')).toBeNull();
    expect(lineHasBannedFormatter('')).toBeNull();
  });
});

describe('lineHasBannedFormatter — comment + allow-marker handling', () => {
  it('skips //-comment lines', () => {
    expect(lineHasBannedFormatter('// example: n.toLocaleString()')).toBeNull();
  });

  it('skips /*-comment lines', () => {
    expect(lineHasBannedFormatter('/* docstring with n.toLocaleString() */')).toBeNull();
  });

  it('skips *-prefixed JSDoc continuation lines', () => {
    expect(lineHasBannedFormatter(' * docstring with n.toLocaleString()')).toBeNull();
  });

  it('honors same-line allow marker', () => {
    const hit = lineHasBannedFormatter(
      '  return n.toLocaleString(); // table-formatting-ok: legacy interop',
    );
    expect(hit).toBeNull();
  });

  it('honors previous-line allow marker', () => {
    const hit = lineHasBannedFormatter(
      '  return n.toLocaleString();',
      '  // table-formatting-ok: legacy interop',
    );
    expect(hit).toBeNull();
  });

  it('does NOT honor an allow marker on a non-comment previous line', () => {
    // A code line that mentions the marker as a string literal should not
    // grant exemption to the next line. The marker is recognized only when
    // it appears in a comment.
    const hit = lineHasBannedFormatter(
      '  return n.toLocaleString();',
      '  const tag = "table-formatting-ok";',
    );
    expect(hit?.label).toBe('.toLocaleString');
  });

  it('reports the FIRST banned pattern when multiple appear on one line', () => {
    // The implementation iterates patterns in BANNED_PATTERNS order and
    // breaks on first match, so a line with both .toLocaleString AND
    // Intl.NumberFormat reports only the toLocaleString hit.
    const hit = lineHasBannedFormatter(
      '  return n.toLocaleString() + new Intl.NumberFormat().format(0);',
    );
    expect(hit?.label).toBe('.toLocaleString');
  });
});
