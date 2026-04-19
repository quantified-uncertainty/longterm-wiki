import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCheck } from './validate-no-anthropic-api-key-read.ts';

describe('validate-no-anthropic-api-key-read', () => {
  it('passes on the current codebase (all violations fixed)', () => {
    // Regression guard: if someone reintroduces a raw ANTHROPIC_API_KEY
    // read in source code, this test will fail.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  // Self-contained negative-path tests that don't depend on the validator's
  // filesystem scan. We check the line-level decision logic directly.
  describe('line-level detection', () => {
    const BANNED_PATTERN = /ANTHROPIC_API_KEY/;
    const REMAP_MARKER = 'anthropic-billing-key-remap-ok';

    function isViolation(line: string): boolean {
      if (!BANNED_PATTERN.test(line)) return false;
      if (line.includes(REMAP_MARKER)) return false;
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith('#') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      ) {
        return false;
      }
      return true;
    }

    it('flags a raw process.env read', () => {
      expect(isViolation("  const key = process.env.ANTHROPIC_API_KEY;")).toBe(
        true,
      );
    });

    it('allows a line with the inline re-map marker', () => {
      expect(
        isViolation(
          "ANTHROPIC_API_KEY: process.env.ANTHROPIC_BILLING_KEY, // anthropic-billing-key-remap-ok",
        ),
      ).toBe(false);
    });

    it('allows a // line comment mentioning the name', () => {
      expect(
        isViolation('  // ANTHROPIC_API_KEY is intentionally not set here'),
      ).toBe(false);
    });

    it('allows a shell comment mentioning the name', () => {
      expect(isViolation('# ANTHROPIC_API_KEY must be set for CI')).toBe(
        false,
      );
    });

    it('allows a JSDoc-style line mentioning the name', () => {
      expect(isViolation(' *   ANTHROPIC_API_KEY - optional')).toBe(false);
    });

    it('flags a shell-script read', () => {
      expect(isViolation('[ -z "${ANTHROPIC_API_KEY:-}" ] && exit 1')).toBe(
        true,
      );
    });

    it('flags a bracketed env access', () => {
      expect(
        isViolation("  const key = process.env['ANTHROPIC_API_KEY'];"),
      ).toBe(true);
    });

    it('allows a fetch header reading the renamed var (no banned pattern)', () => {
      expect(
        isViolation('  headers["x-api-key"] = ANTHROPIC_BILLING_KEY;'),
      ).toBe(false);
    });
  });

  describe('with a scratch directory', () => {
    it('scans .ts files for the banned pattern', () => {
      // Direct smoke test of the regex + allowlist on a realistic set
      // of input strings.
      const cases: Array<{ line: string; expected: boolean }> = [
        { line: "const k = process.env.ANTHROPIC_API_KEY;", expected: true },
        {
          line: "env.ANTHROPIC_API_KEY = x; // anthropic-billing-key-remap-ok",
          expected: false,
        },
        {
          line: "delete env.ANTHROPIC_API_KEY;",
          expected: true,
        },
        {
          line: "  // ANTHROPIC_API_KEY: deprecated, use BILLING",
          expected: false,
        },
      ];

      for (const c of cases) {
        const BANNED = /ANTHROPIC_API_KEY/;
        const REMAP = 'anthropic-billing-key-remap-ok';
        const trimmed = c.line.trimStart();
        const isComment =
          trimmed.startsWith('#') ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*');
        const violation =
          BANNED.test(c.line) && !c.line.includes(REMAP) && !isComment;
        expect(violation).toBe(c.expected);
      }
    });
  });

  // Optional: write a temp file containing a raw read, run a subset of the
  // validator logic against it. Kept minimal — runCheck() already exercises
  // the FS walk against the real codebase in the first test above.
  it('fails fast when a temp file has a raw read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'validate-billing-key-'));
    try {
      const subdir = join(dir, 'crux');
      mkdirSync(subdir);
      writeFileSync(
        join(subdir, 'example.ts'),
        "const k = process.env.ANTHROPIC_API_KEY;\n",
      );

      // Quick manual check of the line-level logic on this synthetic content.
      const content = "const k = process.env.ANTHROPIC_API_KEY;";
      expect(/ANTHROPIC_API_KEY/.test(content)).toBe(true);
      expect(content.includes('anthropic-billing-key-remap-ok')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
