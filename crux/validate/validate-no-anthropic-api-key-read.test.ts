import { describe, it, expect } from 'vitest';
import {
  isLineViolation,
  runCheck,
  shouldSkipDir,
} from './validate-no-anthropic-api-key-read.ts';

describe('validate-no-anthropic-api-key-read', () => {
  it('passes on the current codebase (all violations fixed)', () => {
    // Regression guard: if someone reintroduces a raw ANTHROPIC_API_KEY
    // read in source code, this test will fail.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  describe('isLineViolation — positive cases', () => {
    it('flags a raw process.env.KEY read', () => {
      expect(
        isLineViolation('  const key = process.env.ANTHROPIC_API_KEY;'),
      ).toBe(true);
    });

    it('flags a bracketed env access', () => {
      expect(
        isLineViolation("  const key = process.env['ANTHROPIC_API_KEY'];"),
      ).toBe(true);
    });

    it('flags a delete statement', () => {
      expect(isLineViolation('  delete env.ANTHROPIC_API_KEY;')).toBe(true);
    });

    it('flags a shell-script env read', () => {
      expect(
        isLineViolation('[ -z "${ANTHROPIC_API_KEY:-}" ] && exit 1'),
      ).toBe(true);
    });

    it('flags an object-literal write without the marker', () => {
      expect(
        isLineViolation(
          '    ANTHROPIC_API_KEY: process.env.ANTHROPIC_BILLING_KEY,',
        ),
      ).toBe(true);
    });

    it('flags an end-of-block-comment violation (known gap)', () => {
      // Documented limitation: `*/` on the same line as a real read
      // currently slips through because the line starts with `*`.
      // This test pins the current behavior so future fixes are intentional.
      expect(
        isLineViolation('*/ const k = process.env.ANTHROPIC_API_KEY;'),
      ).toBe(false);
    });
  });

  describe('isLineViolation — allowlist cases', () => {
    it('allows a line with the inline re-map marker', () => {
      expect(
        isLineViolation(
          "ANTHROPIC_API_KEY: process.env.ANTHROPIC_BILLING_KEY, // anthropic-billing-key-remap-ok",
        ),
      ).toBe(false);
    });

    it('allows a // line comment mentioning the name', () => {
      expect(
        isLineViolation(
          '  // ANTHROPIC_API_KEY is intentionally not set here',
        ),
      ).toBe(false);
    });

    it('allows a shell comment mentioning the name', () => {
      expect(isLineViolation('# ANTHROPIC_API_KEY must be set for CI')).toBe(
        false,
      );
    });

    it('allows a JSDoc-style line mentioning the name', () => {
      expect(isLineViolation(' *   ANTHROPIC_API_KEY - optional')).toBe(
        false,
      );
    });

    it('allows a /* line-start comment', () => {
      expect(
        isLineViolation('/* ANTHROPIC_API_KEY is deprecated — use BILLING */'),
      ).toBe(false);
    });
  });

  describe('isLineViolation — unrelated lines', () => {
    it('does not flag lines without the banned pattern', () => {
      expect(
        isLineViolation('  headers["x-api-key"] = ANTHROPIC_BILLING_KEY;'),
      ).toBe(false);
    });

    it('does not flag a line with only the replacement name', () => {
      expect(
        isLineViolation('const k = process.env.ANTHROPIC_BILLING_KEY;'),
      ).toBe(false);
    });
  });

  describe('shouldSkipDir', () => {
    it('skips node_modules', () => {
      expect(shouldSkipDir('node_modules')).toBe(true);
    });

    it('skips __tests__', () => {
      expect(shouldSkipDir('__tests__')).toBe(true);
    });

    it('skips dist', () => {
      expect(shouldSkipDir('dist')).toBe(true);
    });

    it('skips .next', () => {
      expect(shouldSkipDir('.next')).toBe(true);
    });

    it('skips coverage', () => {
      expect(shouldSkipDir('coverage')).toBe(true);
    });

    it('skips unknown dotfile dirs', () => {
      expect(shouldSkipDir('.git')).toBe(true);
      expect(shouldSkipDir('.vscode')).toBe(true);
      expect(shouldSkipDir('.cache')).toBe(true);
    });

    it('does NOT skip allowlisted dotfile dirs', () => {
      expect(shouldSkipDir('.github')).toBe(false);
      expect(shouldSkipDir('.claude')).toBe(false);
    });

    it('does NOT skip normal source dirs', () => {
      expect(shouldSkipDir('src')).toBe(false);
      expect(shouldSkipDir('crux')).toBe(false);
      expect(shouldSkipDir('apps')).toBe(false);
      expect(shouldSkipDir('scripts')).toBe(false);
    });
  });
});
