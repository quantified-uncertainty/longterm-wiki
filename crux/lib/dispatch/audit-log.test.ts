/**
 * Tests for the dispatch audit-log writer.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { appendDispatchLog } from './audit-log.ts';

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-log-'));
  return join(dir, 'log.jsonl');
}

describe('appendDispatchLog', () => {
  it('writes one JSON line per entry and creates parent dirs', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dispatch-log-')), 'nested', 'log.jsonl');
    appendDispatchLog(
      {
        linearId: 'QUA-437',
        slot: 7,
        outcome: 'dispatched',
        force: false,
        forceReason: null,
        dispatcherSlot: 10,
        dispatcherBranch: 'claude/qua-437',
        pid: 12345,
        blockers: [],
        briefPath: null,
      },
      { file, now: () => '2026-04-17T12:00:00Z' },
    );
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf-8').trim());
    expect(parsed.linearId).toBe('QUA-437');
    expect(parsed.outcome).toBe('dispatched');
    expect(parsed.timestamp).toBe('2026-04-17T12:00:00Z');
    rmSync(file, { recursive: false, force: true });
  });

  it('appends without clobbering prior entries', () => {
    const file = tmpFile();
    const base = {
      slot: 7,
      force: false,
      forceReason: null,
      dispatcherSlot: 10,
      dispatcherBranch: 'claude/x',
      pid: 1,
      blockers: [] as string[],
      briefPath: null,
    };
    appendDispatchLog({ ...base, linearId: 'QUA-1', outcome: 'dispatched' }, { file });
    appendDispatchLog({ ...base, linearId: 'QUA-2', outcome: 'refused', blockers: ['open-pr'] }, { file });
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).linearId).toBe('QUA-1');
    expect(JSON.parse(lines[1]).linearId).toBe('QUA-2');
    expect(JSON.parse(lines[1]).blockers).toEqual(['open-pr']);
  });

  it('does not throw when the destination is unwritable', () => {
    // Point at a path where the parent cannot be created. On macOS,
    // mkdirSync under /dev/null/x throws EEXIST/ENOTDIR — we just need
    // any path that will blow up inside the try block.
    expect(() =>
      appendDispatchLog(
        {
          linearId: 'QUA-1',
          slot: 1,
          outcome: 'refused',
          force: false,
          forceReason: null,
          dispatcherSlot: null,
          dispatcherBranch: 'main',
          pid: 1,
          blockers: [],
          briefPath: null,
        },
        { file: '/dev/null/unwritable/log.jsonl' },
      ),
    ).not.toThrow();
  });
});
