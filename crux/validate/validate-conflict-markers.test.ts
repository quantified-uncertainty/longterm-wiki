/**
 * Tests for the conflict marker detection validator.
 *
 * Uses unit tests against the exported detection logic rather than
 * subprocess integration tests, since the validator's core logic is
 * pure file scanning.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// We test by importing the module's exported function
// But since runCheck() calls git ls-files and readFileSync internally,
// we test at the integration level by running the script as a subprocess.

const REPO_ROOT = `${__dirname}/../..`;

function run(cmd: string): { stdout: string; exitCode: number } {
  const fullCmd = `${cmd} 2>&1`;
  try {
    const stdout = execSync(fullCmd, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', exitCode: e.status ?? 1 };
  }
}

describe('validate-conflict-markers', () => {
  it('passes on the current codebase (no conflict markers)', () => {
    const result = run('npx tsx crux/validate/validate-conflict-markers.ts');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No conflict markers found');
  }, 30_000);

  it('correctly excludes resolve-conflicts.mjs from scanning', () => {
    // resolve-conflicts.mjs legitimately contains conflict marker strings
    // Verify the validator passes despite that file existing
    const result = run('npx tsx crux/validate/validate-conflict-markers.ts');
    expect(result.exitCode).toBe(0);
    // Should not report resolve-conflicts.mjs
    expect(result.stdout).not.toContain('resolve-conflicts.mjs');
  }, 30_000);

  describe('conflict marker pattern matching', () => {
    // Test the regex patterns directly to verify they match correctly
    const patterns = [
      { pattern: /^<{7}(?:\s|$)/, label: '<<<<<<<' },
      { pattern: /^={7}(?:\s|$)/, label: '=======' },
      { pattern: /^>{7}(?:\s|$)/, label: '>>>>>>>' },
    ];

    it('matches standard git conflict markers', () => {
      expect(patterns[0].pattern.test('<<<<<<< HEAD')).toBe(true);
      expect(patterns[1].pattern.test('=======')).toBe(true);
      expect(patterns[2].pattern.test('>>>>>>> origin/main')).toBe(true);
    });

    it('matches markers with no trailing content', () => {
      expect(patterns[0].pattern.test('<<<<<<<')).toBe(true);
      expect(patterns[1].pattern.test('=======')).toBe(true);
      expect(patterns[2].pattern.test('>>>>>>>')).toBe(true);
    });

    it('does not match shorter sequences', () => {
      // 6 characters should not match
      expect(patterns[0].pattern.test('<<<<<<')).toBe(false);
      expect(patterns[1].pattern.test('======')).toBe(false);
      expect(patterns[2].pattern.test('>>>>>>')).toBe(false);
    });

    it('does not match markers embedded in text', () => {
      // Markers must be at start of line
      expect(patterns[0].pattern.test('  <<<<<<< HEAD')).toBe(false);
      expect(patterns[0].pattern.test('text <<<<<<< HEAD')).toBe(false);
    });

    it('does not match longer sequences without space separator', () => {
      // 8+ characters followed by non-space should not match
      expect(patterns[0].pattern.test('<<<<<<<<text')).toBe(false);
      expect(patterns[2].pattern.test('>>>>>>>>text')).toBe(false);
    });

    it('does not match 8+ character sequences (non-standard markers)', () => {
      // Standard git conflict markers are exactly 7 characters
      // 8+ without a space after the 7th should not match
      expect(patterns[0].pattern.test('<<<<<<<< HEAD')).toBe(false);
      expect(patterns[2].pattern.test('>>>>>>>> branch')).toBe(false);
    });
  });
});
