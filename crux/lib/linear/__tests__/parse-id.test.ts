import { describe, it, expect } from 'vitest';
import { findAllLinearIds, parseLinearId, resolveLinearId } from '../parse-id.ts';

describe('parseLinearId', () => {
  it('extracts ID from a canonical claude branch name', () => {
    expect(parseLinearId('claude/qua-184-linear-integration')).toBe('QUA-184');
  });

  it('case-insensitive branch matching (uppercase QUA in branch)', () => {
    expect(parseLinearId('claude/QUA-17-foo')).toBe('QUA-17');
  });

  it('extracts a bare QUA-NNN token from a task description', () => {
    expect(parseLinearId('working on QUA-200 today')).toBe('QUA-200');
  });

  it('handles punctuation around a bare token', () => {
    expect(parseLinearId('(see QUA-91) for context')).toBe('QUA-91');
  });

  it('branch-pattern match is restricted to known team keys (QUA)', () => {
    // Unknown team keys inside a `claude/` prefix are NOT matched — tightened
    // to prevent GitHub-flavored branches from polluting Linear metadata.
    expect(parseLinearId('claude/abc-5-test')).toBeNull();
  });

  it('does not misclassify GitHub-style fix branches as Linear IDs', () => {
    // Regression test for CodeRabbit finding: `claude/fix-239-...` must NOT
    // parse as `FIX-239`, which would pollute Linear checklist metadata and
    // trigger failing start/done calls against a non-existent team.
    expect(parseLinearId('claude/fix-239-broken-test')).toBeNull();
    expect(parseLinearId('claude/cve-2024-foo')).toBeNull();
    expect(parseLinearId('claude/pr-1234-fix')).toBeNull();
  });

  it('bare-token match is restricted to known team keys (QUA)', () => {
    expect(parseLinearId('refs QUA-999')).toBe('QUA-999');
    // Other keys are not matched as bare tokens — avoids false positives.
    expect(parseLinearId('refs XYZ-999')).toBeNull();
    expect(parseLinearId('refs ABC-5')).toBeNull();
  });

  it('does not false-match common tokens that look like Linear IDs', () => {
    expect(parseLinearId('fix UTF-8 encoding bug')).toBeNull();
    expect(parseLinearId('patches CVE-2024 vulnerability')).toBeNull();
    expect(parseLinearId('see RFC-8446 section 4')).toBeNull();
    expect(parseLinearId('upgrade HTTP2-3 fallback')).toBeNull();
    expect(parseLinearId('serialize ISO-8601 timestamps')).toBeNull();
    expect(parseLinearId('PR-1234 is open')).toBeNull();
  });

  it('returns null when no ID is present', () => {
    expect(parseLinearId('no id here')).toBeNull();
    expect(parseLinearId('')).toBeNull();
    expect(parseLinearId(null)).toBeNull();
    expect(parseLinearId(undefined)).toBeNull();
  });

  it('does not match false positives with lowercase bare text', () => {
    // bare lowercase "qua-184" is not a valid Linear identifier form — we
    // only accept it inside a `claude/` branch prefix.
    expect(parseLinearId('qua-184 lowercase')).toBeNull();
  });

  it('does not match 7+ digit numbers (out of range for team identifiers)', () => {
    expect(parseLinearId('QUA-1234567')).toBeNull();
  });

  it('does not match keys with too many letters (branch pattern)', () => {
    expect(parseLinearId('claude/teamname-5-foo')).toBeNull();
  });

  it('prefers the branch-pattern match when both appear', () => {
    // `claude/qua-184-foo` resolves before the bare `QUA-200` appears
    expect(
      parseLinearId('claude/qua-184-foo references QUA-200')
    ).toBe('QUA-184');
  });
});

describe('resolveLinearId', () => {
  it('returns the first match across multiple sources', () => {
    const id = resolveLinearId([
      'claude/qua-184-foo',
      'working on QUA-200 today',
    ]);
    expect(id).toBe('QUA-184');
  });

  it('falls through to later sources', () => {
    const id = resolveLinearId([
      null,
      'just a branch name',
      'task is QUA-91 cleanup',
    ]);
    expect(id).toBe('QUA-91');
  });

  it('returns null when no source has a match', () => {
    expect(resolveLinearId([null, undefined, 'plain text'])).toBeNull();
    expect(resolveLinearId([])).toBeNull();
  });
});

describe('findAllLinearIds', () => {
  it('finds every QUA reference in a multi-line string', () => {
    const body = `Fixes QUA-100\nAlso touches QUA-200 and QUA-300.\n(see QUA-100 again)`;
    expect(findAllLinearIds(body).sort()).toEqual(['QUA-100', 'QUA-200', 'QUA-300']);
  });

  it('includes branch-pattern hits', () => {
    expect(findAllLinearIds('claude/qua-42-rename')).toContain('QUA-42');
  });

  it('returns empty for null/undefined/empty', () => {
    expect(findAllLinearIds(null)).toEqual([]);
    expect(findAllLinearIds(undefined)).toEqual([]);
    expect(findAllLinearIds('')).toEqual([]);
  });

  it('dedupes case variants to canonical form', () => {
    const body = 'QUA-1 qua-1 Qua-1';
    expect(findAllLinearIds(body)).toEqual(['QUA-1']);
  });
});
