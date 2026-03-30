/**
 * Tests for the display names validator.
 *
 * Tests the exported detection functions directly (unit tests) and
 * runs the validator against the current codebase (integration test).
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import {
  looksLikeStableId,
  looksLikeHashId,
  isPureNumericId,
  isUnknownPlaceholder,
} from './validate-display-names.ts';

const REPO_ROOT = `${__dirname}/../..`;

function run(cmd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout || '') + (e.stderr || ''), exitCode: e.status ?? 1 };
  }
}

describe('looksLikeStableId', () => {
  it('detects sid_-prefixed stableIds', () => {
    expect(looksLikeStableId('sid_mK9pX3rQ7n')).toBe(true);
    expect(looksLikeStableId('sid_A4XoubikkQ')).toBe(true);
    expect(looksLikeStableId('sid_Z62bQynY4g')).toBe(true);
    expect(looksLikeStableId('sid_0u4J70VqFY')).toBe(true);
  });

  it('rejects bare 10-char strings (legacy format no longer detected)', () => {
    expect(looksLikeStableId('mK9pX3rQ7n')).toBe(false);
    expect(looksLikeStableId('A4XoubikkQ')).toBe(false);
    expect(looksLikeStableId('Z62bQynY4g')).toBe(false);
  });

  it('rejects real names', () => {
    expect(looksLikeStableId('Washington')).toBe(false);
    expect(looksLikeStableId('Regulation')).toBe(false);
    expect(looksLikeStableId('abcdefghij')).toBe(false);
    expect(looksLikeStableId('ABCDEFGHIJ')).toBe(false);
  });

  it('rejects strings without sid_ prefix', () => {
    expect(looksLikeStableId('abc')).toBe(false);
    expect(looksLikeStableId('')).toBe(false);
    expect(looksLikeStableId('mK9pX3r.7n')).toBe(false);
  });
});

describe('looksLikeHashId', () => {
  it('detects hash-like strings', () => {
    expect(looksLikeHashId('aB3cD4eF5gH6')).toBe(true); // 12 chars, pure alphanumeric, mixed case + digits
    expect(looksLikeHashId('xY9kL2mN0pQr')).toBe(true); // 12 chars
  });

  it('rejects hyphenated product names', () => {
    // These should NOT be flagged — they're real product/model names
    expect(looksLikeHashId('GPT-4o-mini')).toBe(false);
    expect(looksLikeHashId('Llama-3-70B')).toBe(false);
    expect(looksLikeHashId('Claude-3-Opus')).toBe(false);
  });

  it('rejects strings with underscores', () => {
    // Conservative: underscores excluded to avoid false positives
    expect(looksLikeHashId('person_xY9kL2mN0p')).toBe(false);
  });

  it('rejects real names', () => {
    expect(looksLikeHashId('Anthropic')).toBe(false); // too short, no digits
    expect(looksLikeHashId('John Smith')).toBe(false); // has space
    expect(looksLikeHashId('Buck Shlegeris')).toBe(false); // has space
    expect(looksLikeHashId('OpenAI')).toBe(false); // too short
  });

  it('rejects strings that are too short or too long', () => {
    expect(looksLikeHashId('aB3c')).toBe(false); // too short
    expect(looksLikeHashId('aB3cD4eF5g')).toBe(false); // 10 chars — too short (caught by stableId check)
    expect(looksLikeHashId('a'.repeat(31))).toBe(false); // too long
  });

  it('rejects strings with spaces', () => {
    expect(looksLikeHashId('aB3 cD4 eF5g')).toBe(false);
  });
});

describe('isPureNumericId', () => {
  it('detects pure numbers', () => {
    expect(isPureNumericId('12345')).toBe(true);
    expect(isPureNumericId('0')).toBe(true);
    expect(isPureNumericId('999999')).toBe(true);
    expect(isPureNumericId(' 123 ')).toBe(true); // trims whitespace
  });

  it('rejects non-numeric strings', () => {
    expect(isPureNumericId('abc')).toBe(false);
    expect(isPureNumericId('123abc')).toBe(false);
    expect(isPureNumericId('$100')).toBe(false);
    expect(isPureNumericId('')).toBe(false);
  });
});

describe('isUnknownPlaceholder', () => {
  it('detects "Unknown" in various cases', () => {
    expect(isUnknownPlaceholder('Unknown')).toBe(true);
    expect(isUnknownPlaceholder('unknown')).toBe(true);
    expect(isUnknownPlaceholder('UNKNOWN')).toBe(true);
    expect(isUnknownPlaceholder(' Unknown ')).toBe(true); // trims whitespace
  });

  it('rejects non-placeholder strings', () => {
    expect(isUnknownPlaceholder('Unknown Person')).toBe(false);
    expect(isUnknownPlaceholder('The Unknown')).toBe(false);
    expect(isUnknownPlaceholder('Anthropic')).toBe(false);
    expect(isUnknownPlaceholder('')).toBe(false);
  });
});

describe('validate-display-names integration', () => {
  it('passes on the current codebase', () => {
    const result = run('npx tsx crux/validate/validate-display-names.ts');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No raw machine IDs found');
  }, 30_000);
});
