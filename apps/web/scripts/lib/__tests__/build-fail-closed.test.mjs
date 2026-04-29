/**
 * Tests for build-data fail-closed behavior (QUA-772).
 *
 * Two complementary classes of fail-closed errors block the build before
 * `database.json` is written:
 *
 *   1. YAML parse errors in source data (`data/`, `packages/factbase/data/`)
 *   2. Wiki-server unreachable IN CI mode (full build only)
 *
 * Local dev and content-only builds keep degraded fallback behavior so
 * offline iteration / agent slots without prod creds aren't blocked.
 *
 * These tests verify the policy helpers used by build-data.mjs in isolation,
 * since exercising the full build script end-to-end is too expensive for unit
 * tests. The integration is covered by the `pnpm build` step that runs
 * automatically in CI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isStrictWikiServerMode,
  setFullBuildMode,
  getWikiServerWarningCount,
  getSkippedDataSources,
  _resetWikiServerWarningsForTests,
} from '../wiki-server-data.mjs';

describe('isStrictWikiServerMode — QUA-772 fail-closed CI policy', () => {
  it('is strict when CI=true and content-only is false (typical CI build)', () => {
    expect(isStrictWikiServerMode({ contentOnly: false, env: { CI: 'true' } })).toBe(true);
  });

  it('is NOT strict when CI=true but content-only is true', () => {
    // content-only mode explicitly opts out of server-dependent steps.
    // Treating wiki-server unavailability as fatal there would defeat the flag.
    expect(isStrictWikiServerMode({ contentOnly: true, env: { CI: 'true' } })).toBe(false);
  });

  it('is NOT strict in local dev (CI unset)', () => {
    // Agents working in slots may not have prod credentials; we don't want
    // a wiki-server outage to block their iteration loop.
    expect(isStrictWikiServerMode({ contentOnly: false, env: {} })).toBe(false);
  });

  it('is NOT strict when CI is set to anything other than the literal string "true"', () => {
    // Some CI providers set CI to "1" or "yes". We deliberately match the
    // GitHub Actions / Vercel convention (CI=true) to avoid false positives.
    expect(isStrictWikiServerMode({ contentOnly: false, env: { CI: '1' } })).toBe(false);
    expect(isStrictWikiServerMode({ contentOnly: false, env: { CI: 'yes' } })).toBe(false);
    expect(isStrictWikiServerMode({ contentOnly: false, env: { CI: 'TRUE' } })).toBe(false);
  });

  it('reads from process.env by default', () => {
    const original = process.env.CI;
    try {
      process.env.CI = 'true';
      expect(isStrictWikiServerMode({ contentOnly: false })).toBe(true);
      delete process.env.CI;
      expect(isStrictWikiServerMode({ contentOnly: false })).toBe(false);
    } finally {
      if (original !== undefined) process.env.CI = original;
      else delete process.env.CI;
    }
  });
});

describe('wiki-server warning counter — used by the pre-write CI gate', () => {
  beforeEach(() => {
    _resetWikiServerWarningsForTests();
    setFullBuildMode(false);
  });

  afterEach(() => {
    _resetWikiServerWarningsForTests();
    setFullBuildMode(false);
  });

  it('starts at zero with no skipped data sources', () => {
    expect(getWikiServerWarningCount()).toBe(0);
    expect(getSkippedDataSources()).toEqual([]);
  });

  it('returns a snapshot (not a live reference) of skipped sources', () => {
    // Defensive: ensure callers can't mutate internal state by holding the
    // returned array. A live reference would let a buggy consumer corrupt
    // the build-health summary.
    const snapshot = getSkippedDataSources();
    snapshot.push('not-a-real-source');
    expect(getSkippedDataSources()).toEqual([]);
  });
});
