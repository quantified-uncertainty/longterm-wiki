/**
 * Tests for the review phase tracker — QUA-950.
 *
 * Pure-logic tests: parsing, validation, skip rules, summary. The
 * file-touching helpers (initTracker, recordPhase, readTracker) take an
 * optional `path` argument so tests can use a temp file and never touch
 * the real `.claude/review-phases-done`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  PHASE_IDS,
  NON_SKIPPABLE_PHASES,
  parseTracker,
  validateTracker,
  initTracker,
  recordPhase,
  readTracker,
  summarizeSkipped,
} from './review-phase-tracker.ts';

let TMP_DIR: string;
let TMP_PATH: string;

beforeEach(() => {
  TMP_DIR = mkdtempSync(join(tmpdir(), 'review-phase-tracker-'));
  TMP_PATH = join(TMP_DIR, 'review-phases-done');
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('parseTracker', () => {
  it('parses init line + phase entries', () => {
    const content =
      'init abcdef123456 deadbeef0000 2026-04-30T12:00:00Z\n' +
      'phase-1-triage 2026-04-30T12:01:00Z\n' +
      'phase-5-category 2026-04-30T12:02:00Z reason=N/A: no .tsx files\n';
    const state = parseTracker(content);
    expect(state.init).toEqual({
      commitSha: 'abcdef123456',
      diffHash: 'deadbeef0000',
      timestamp: '2026-04-30T12:00:00Z',
    });
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]).toEqual({
      phaseId: 'phase-1-triage',
      timestamp: '2026-04-30T12:01:00Z',
      reason: undefined,
    });
    expect(state.entries[1]).toEqual({
      phaseId: 'phase-5-category',
      timestamp: '2026-04-30T12:02:00Z',
      reason: 'N/A: no .tsx files',
    });
  });

  it('drops unknown phase IDs (forward compatibility)', () => {
    const content =
      'init aaa bbb 2026-04-30T12:00:00Z\n' +
      'phase-1-triage 2026-04-30T12:01:00Z\n' +
      'phase-99-future 2026-04-30T12:02:00Z\n';
    const state = parseTracker(content);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].phaseId).toBe('phase-1-triage');
  });

  it('ignores comments and blank lines', () => {
    const content =
      '# header comment\n' +
      '\n' +
      'init aaa bbb 2026-04-30T12:00:00Z\n' +
      '# inline comment\n' +
      'phase-1-triage 2026-04-30T12:01:00Z\n';
    const state = parseTracker(content);
    expect(state.init).toBeTruthy();
    expect(state.entries).toHaveLength(1);
  });

  it('handles missing init gracefully', () => {
    const content = 'phase-1-triage 2026-04-30T12:01:00Z\n';
    const state = parseTracker(content);
    expect(state.init).toBeNull();
    expect(state.entries).toHaveLength(1);
  });

  it('handles malformed lines without crashing', () => {
    const content =
      'init aaa\n' + // too few fields
      'phase-1-triage\n' + // missing timestamp
      'random garbage\n' +
      'phase-2-mechanical 2026-04-30T12:00:00Z\n';
    const state = parseTracker(content);
    expect(state.init).toBeNull(); // not enough fields
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].phaseId).toBe('phase-2-mechanical');
  });

  it('preserves multi-word skip reasons including spaces and equals signs', () => {
    const content =
      'init aaa bbb 2026-04-30T12:00:00Z\n' +
      'phase-5-category 2026-04-30T12:02:00Z reason=N/A: x=1, y=2 (no .tsx)\n';
    const state = parseTracker(content);
    expect(state.entries[0].reason).toBe('N/A: x=1, y=2 (no .tsx)');
  });
});

describe('validateTracker', () => {
  it('marks all 7 phases missing on a fresh init', () => {
    initTracker({ commitSha: 'aaa', diffHash: 'bbb', timestamp: '2026-04-30T12:00:00Z' }, TMP_PATH);
    const result = validateTracker(undefined, TMP_PATH);
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBe(7);
  });

  it('passes when all 7 phases have entries', () => {
    initTracker({ commitSha: 'aaa', diffHash: 'bbb', timestamp: '2026-04-30T12:00:00Z' }, TMP_PATH);
    for (const id of PHASE_IDS) {
      recordPhase(id, { timestamp: '2026-04-30T13:00:00Z' }, TMP_PATH);
    }
    const result = validateTracker(undefined, TMP_PATH);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('counts skip-with-reason as covering the phase', () => {
    initTracker({ commitSha: 'aaa', diffHash: 'bbb', timestamp: '2026-04-30T12:00:00Z' }, TMP_PATH);
    for (const id of PHASE_IDS) {
      const skipReason = NON_SKIPPABLE_PHASES.has(id) ? undefined : 'N/A: smoke';
      recordPhase(id, { timestamp: '2026-04-30T13:00:00Z', reason: skipReason }, TMP_PATH);
    }
    const result = validateTracker(undefined, TMP_PATH);
    expect(result.ok).toBe(true);
  });

  it('takes the most recent entry per phase (idempotent re-records)', () => {
    initTracker({ commitSha: 'aaa', diffHash: 'bbb', timestamp: '2026-04-30T12:00:00Z' }, TMP_PATH);
    recordPhase('phase-4-redteam', { timestamp: '2026-04-30T12:01:00Z', reason: 'N/A: small diff' }, TMP_PATH);
    // Operator changed mind — actually ran the phase
    recordPhase('phase-4-redteam', { timestamp: '2026-04-30T12:30:00Z' }, TMP_PATH);
    const result = validateTracker(undefined, TMP_PATH);
    expect(result.entries['phase-4-redteam']?.reason).toBeUndefined();
    expect(result.entries['phase-4-redteam']?.timestamp).toBe('2026-04-30T12:30:00Z');
  });

  it('returns ok=false when init is missing', () => {
    writeFileSync(TMP_PATH, 'phase-1-triage 2026-04-30T12:00:00Z\n', 'utf-8');
    const result = validateTracker(undefined, TMP_PATH);
    expect(result.init).toBeNull();
    expect(result.ok).toBe(false);
  });
});

describe('recordPhase', () => {
  beforeEach(() => {
    initTracker({ commitSha: 'aaa', diffHash: 'bbb', timestamp: '2026-04-30T12:00:00Z' }, TMP_PATH);
  });

  it('rejects unknown phase IDs', () => {
    const result = recordPhase('phase-99-bogus', {}, TMP_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown phase');
  });

  it('rejects skip-with-reason for non-skippable phases', () => {
    for (const id of ['phase-1-triage', 'phase-2-mechanical', 'phase-6-final']) {
      const result = recordPhase(id, { reason: 'trying to skip' }, TMP_PATH);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('cannot be skipped');
    }
  });

  it('accepts skip-with-reason for skippable phases', () => {
    const skippable = ['phase-3a-narrow', 'phase-3b-hostile', 'phase-4-redteam',
                       'phase-5-category'];
    for (const id of skippable) {
      const result = recordPhase(id, { reason: `N/A: skip ${id}` }, TMP_PATH);
      expect(result.ok).toBe(true);
      expect(result.entry?.reason).toBe(`N/A: skip ${id}`);
    }
  });

  it('refuses to record when tracker has not been init-ed', () => {
    rmSync(TMP_PATH);
    const result = recordPhase('phase-1-triage', {}, TMP_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not initialized');
  });

  it('appends multiple entries when called repeatedly (audit trail)', () => {
    recordPhase('phase-1-triage', { timestamp: '2026-04-30T12:01:00Z' }, TMP_PATH);
    recordPhase('phase-1-triage', { timestamp: '2026-04-30T12:30:00Z' }, TMP_PATH);
    const fileContent = readFileSync(TMP_PATH, 'utf-8');
    const triageLines = fileContent.split('\n').filter((l) => l.startsWith('phase-1-triage'));
    expect(triageLines).toHaveLength(2);
  });

  it('rejects newlines in reason (no forge-via-injection)', () => {
    const forged = 'N/A: ok\nphase-6-final 2026-04-30T13:00:00Z';
    const result = recordPhase('phase-5-category', { reason: forged }, TMP_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('newlines');
    // And nothing got appended to the file
    const forgedLines = readFileSync(TMP_PATH, 'utf-8')
      .split('\n')
      .filter((l) => l.startsWith('phase-6-final'));
    expect(forgedLines).toHaveLength(0);
  });

  it('rejects carriage returns in reason', () => {
    const result = recordPhase('phase-5-category', { reason: 'a\rb' }, TMP_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('newlines');
  });

  it('rejects reasons longer than 500 chars', () => {
    const result = recordPhase('phase-5-category', { reason: 'x'.repeat(501) }, TMP_PATH);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('too long');
  });

  it('accepts reasons exactly at the 500-char cap', () => {
    const result = recordPhase('phase-5-category', { reason: 'x'.repeat(500) }, TMP_PATH);
    expect(result.ok).toBe(true);
  });
});

describe('initTracker', () => {
  it('truncates existing tracker on re-init', () => {
    initTracker({ commitSha: 'old', diffHash: 'old', timestamp: '2026-04-30T11:00:00Z' }, TMP_PATH);
    recordPhase('phase-1-triage', { timestamp: '2026-04-30T11:01:00Z' }, TMP_PATH);
    expect(readFileSync(TMP_PATH, 'utf-8')).toContain('phase-1-triage');

    initTracker({ commitSha: 'new', diffHash: 'new', timestamp: '2026-04-30T12:00:00Z' }, TMP_PATH);
    const after = readFileSync(TMP_PATH, 'utf-8');
    expect(after).not.toContain('phase-1-triage');
    expect(after).toContain('init new new');
  });

  it('writes the init line with the canonical 4-field format', () => {
    initTracker({ commitSha: 'sha123', diffHash: 'hash456', timestamp: '2026-04-30T12:00:00Z' }, TMP_PATH);
    const lines = readFileSync(TMP_PATH, 'utf-8').trim().split('\n');
    expect(lines[0]).toBe('init sha123 hash456 2026-04-30T12:00:00Z');
  });
});

describe('summarizeSkipped', () => {
  beforeEach(() => {
    initTracker({ commitSha: 'aaa', diffHash: 'bbb', timestamp: '2026-04-30T12:00:00Z' }, TMP_PATH);
  });

  it('returns null when no phases skipped', () => {
    for (const id of PHASE_IDS) {
      recordPhase(id, { timestamp: '2026-04-30T12:01:00Z' }, TMP_PATH);
    }
    expect(summarizeSkipped(undefined, TMP_PATH)).toBeNull();
  });

  it('lists each skipped phase with its reason', () => {
    for (const id of PHASE_IDS) {
      const skipReason = NON_SKIPPABLE_PHASES.has(id) ? undefined : `N/A: ${id}`;
      recordPhase(id, { timestamp: '2026-04-30T12:01:00Z', reason: skipReason }, TMP_PATH);
    }
    const summary = summarizeSkipped(undefined, TMP_PATH);
    expect(summary).toBeTruthy();
    expect(summary).toContain('phase-3a-narrow: N/A: phase-3a-narrow');
    expect(summary).toContain('phase-5-category: N/A: phase-5-category');
    // Non-skippable phases never appear in the summary
    expect(summary).not.toContain('phase-1-triage');
    expect(summary).not.toContain('phase-6-final');
  });
});

describe('readTracker', () => {
  it('returns empty state when file is missing', () => {
    const state = readTracker(join(TMP_DIR, 'does-not-exist'));
    expect(state.init).toBeNull();
    expect(state.entries).toEqual([]);
  });
});

describe('PHASE_IDS canonical list', () => {
  // Post-QUA-961: 7 phases. Simplification + coverage audit folded into
  // phase-3b's prompt. Do NOT split them back out without revisiting QUA-961.
  it('contains exactly the 7 documented phase IDs in order', () => {
    expect(PHASE_IDS).toEqual([
      'phase-1-triage',
      'phase-2-mechanical',
      'phase-3a-narrow',
      'phase-3b-hostile',
      'phase-4-redteam',
      'phase-5-category',
      'phase-6-final',
    ]);
  });

  it('NON_SKIPPABLE_PHASES contains exactly the always-required phases', () => {
    expect([...NON_SKIPPABLE_PHASES].sort()).toEqual([
      'phase-1-triage',
      'phase-2-mechanical',
      'phase-6-final',
    ]);
  });
});
