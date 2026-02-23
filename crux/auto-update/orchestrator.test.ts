/**
 * Tests for crux/auto-update/orchestrator.ts
 *
 * Focus: file-persistence helpers that must work on a fresh runner
 * where data/auto-update/runs/ may not yet exist.
 *
 * Regression guard for: ENOENT crash in saveRunDetails because mkdirSync
 * was missing (saveRunReport had it; saveRunDetails didn't).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveRunReport, saveRunDetails } from './orchestrator.ts';
import type { RunReport, NewsDigest, UpdatePlan } from './types.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = '2026-01-15T07:00:36.000Z';

const minimalDigest: NewsDigest = {
  date: '2026-01-15',
  itemCount: 0,
  items: [],
  fetchedSources: [],
  failedSources: [],
};

const minimalPlan: UpdatePlan = {
  date: '2026-01-15',
  pageUpdates: [],
  newPageSuggestions: [],
  skippedReasons: [],
  estimatedCost: 0,
};

const minimalReport: RunReport = {
  date: '2026-01-15',
  startedAt: NOW,
  completedAt: NOW,
  trigger: 'manual',
  budget: { limit: 30, spent: 0 },
  digest: { sourcesChecked: 0, sourcesFailed: 0, itemsFetched: 0, itemsRelevant: 0 },
  plan: { pagesPlanned: 0, newPagesSuggested: 0 },
  execution: { pagesUpdated: 0, pagesFailed: 0, pagesSkipped: 0, results: [] },
  newPagesCreated: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a unique temp directory path that does NOT yet exist on disk. */
function freshTmpDir(): string {
  return join(tmpdir(), `au-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const dirsToCleanup: string[] = [];

afterEach(() => {
  for (const dir of dirsToCleanup.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('saveRunDetails', () => {
  it('creates the runs directory if it does not exist', () => {
    const dir = freshTmpDir();
    dirsToCleanup.push(dir);

    expect(existsSync(dir)).toBe(false); // pre-condition: dir must not exist
    saveRunDetails(NOW, minimalDigest, minimalPlan, dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('writes a -details.yaml file with the correct timestamp prefix', () => {
    const dir = freshTmpDir();
    dirsToCleanup.push(dir);

    saveRunDetails(NOW, minimalDigest, minimalPlan, dir);

    const expected = join(dir, '2026-01-15T07-00-36-details.yaml');
    expect(existsSync(expected)).toBe(true);
  });

  it('does not throw when called a second time (dir already exists)', () => {
    const dir = freshTmpDir();
    dirsToCleanup.push(dir);

    expect(() => {
      saveRunDetails(NOW, minimalDigest, minimalPlan, dir);
      saveRunDetails(NOW, minimalDigest, minimalPlan, dir); // second call — no throw
    }).not.toThrow();
  });
});

describe('saveRunReport', () => {
  it('creates the runs directory if it does not exist', () => {
    const dir = freshTmpDir();
    dirsToCleanup.push(dir);

    expect(existsSync(dir)).toBe(false);
    saveRunReport(minimalReport, dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('writes a .yaml file (no -details suffix) with the correct timestamp prefix', () => {
    const dir = freshTmpDir();
    dirsToCleanup.push(dir);

    saveRunReport(minimalReport, dir);

    const expected = join(dir, '2026-01-15T07-00-36.yaml');
    expect(existsSync(expected)).toBe(true);
  });

  it('returns the path of the written file', () => {
    const dir = freshTmpDir();
    dirsToCleanup.push(dir);

    const result = saveRunReport(minimalReport, dir);
    expect(result).toBe(join(dir, '2026-01-15T07-00-36.yaml'));
    expect(existsSync(result)).toBe(true);
  });
});
