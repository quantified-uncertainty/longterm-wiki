import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  diffSnapshots,
  formatDiff,
  type MatrixSnapshot,
} from './matrix-snapshot.ts';
import { PROJECT_ROOT } from './content-types.ts';

const SNAPSHOT_DIR = join(PROJECT_ROOT, '.matrix-snapshots');

// Sample scores for testing
const sampleScores: MatrixSnapshot['scores'] = [
  { type: 'organization', contentScore: 55, qualityScore: 60, coverageScore: 50, pageCount: 30, avgWordCount: 1200 },
  { type: 'person', contentScore: 40, qualityScore: 45, coverageScore: 35, pageCount: 80, avgWordCount: 800 },
  { type: 'risk', contentScore: 70, qualityScore: 65, coverageScore: 75, pageCount: 15, avgWordCount: 1500 },
];

const improvedScores: MatrixSnapshot['scores'] = [
  { type: 'organization', contentScore: 60, qualityScore: 65, coverageScore: 55, pageCount: 32, avgWordCount: 1300 },
  { type: 'person', contentScore: 48, qualityScore: 50, coverageScore: 42, pageCount: 82, avgWordCount: 900 },
  { type: 'risk', contentScore: 72, qualityScore: 68, coverageScore: 76, pageCount: 15, avgWordCount: 1550 },
];

// Clean up snapshot dir before/after each test
beforeEach(() => {
  if (existsSync(SNAPSHOT_DIR)) {
    rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  }
});

afterEach(() => {
  if (existsSync(SNAPSHOT_DIR)) {
    rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  }
});

describe('saveSnapshot', () => {
  it('creates the snapshot directory if it does not exist', () => {
    expect(existsSync(SNAPSHOT_DIR)).toBe(false);
    saveSnapshot(sampleScores);
    expect(existsSync(SNAPSHOT_DIR)).toBe(true);
  });

  it('writes a valid JSON file', () => {
    const path = saveSnapshot(sampleScores);
    expect(existsSync(path)).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.scores).toHaveLength(3);
    expect(content.timestamp).toBeDefined();
  });

  it('includes the label in the snapshot data', () => {
    const path = saveSnapshot(sampleScores, 'baseline');
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.label).toBe('baseline');
  });

  it('includes the label in the filename', () => {
    const path = saveSnapshot(sampleScores, 'v1');
    expect(path).toContain('v1-');
  });

  it('returns a full file path', () => {
    const path = saveSnapshot(sampleScores);
    expect(path.startsWith('/')).toBe(true);
    expect(path.endsWith('.json')).toBe(true);
  });
});

describe('loadSnapshot', () => {
  it('loads by full path', () => {
    const path = saveSnapshot(sampleScores, 'test');
    const loaded = loadSnapshot(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.scores).toHaveLength(3);
    expect(loaded!.label).toBe('test');
  });

  it('loads by label (finds latest matching file)', () => {
    saveSnapshot(sampleScores, 'weekly');
    // Save a second snapshot with the same label — should get the latest
    saveSnapshot(improvedScores, 'weekly');
    const loaded = loadSnapshot('weekly');
    expect(loaded).not.toBeNull();
    // The latest should have improved scores
    const org = loaded!.scores.find((s) => s.type === 'organization');
    expect(org!.contentScore).toBe(60);
  });

  it('returns null for non-existent label', () => {
    expect(loadSnapshot('nonexistent')).toBeNull();
  });

  it('returns null for non-existent path', () => {
    expect(loadSnapshot('/tmp/no-such-file.json')).toBeNull();
  });

  it('returns null for corrupted JSON', () => {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const path = join(SNAPSHOT_DIR, 'bad.json');
    writeFileSync(path, 'not valid json{{{', 'utf-8');
    expect(loadSnapshot(path)).toBeNull();
  });

  it('loads by filename (relative to snapshot dir)', () => {
    const path = saveSnapshot(sampleScores, 'rel');
    const filename = path.split('/').pop()!;
    const loaded = loadSnapshot(filename);
    expect(loaded).not.toBeNull();
    expect(loaded!.label).toBe('rel');
  });
});

describe('listSnapshots', () => {
  it('returns empty array when no snapshots exist', () => {
    expect(listSnapshots()).toEqual([]);
  });

  it('returns all snapshots sorted by timestamp', () => {
    saveSnapshot(sampleScores, 'first');
    saveSnapshot(improvedScores, 'second');
    const list = listSnapshots();
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe('first');
    expect(list[1].label).toBe('second');
  });

  it('includes path, label, and timestamp for each snapshot', () => {
    saveSnapshot(sampleScores, 'check');
    const list = listSnapshots();
    expect(list).toHaveLength(1);
    expect(list[0].path).toContain('.matrix-snapshots');
    expect(list[0].label).toBe('check');
    expect(list[0].timestamp).toBeDefined();
  });

  it('skips corrupted files', () => {
    saveSnapshot(sampleScores, 'good');
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(join(SNAPSHOT_DIR, 'bad.json'), '{{{', 'utf-8');
    const list = listSnapshots();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('good');
  });
});

describe('diffSnapshots', () => {
  it('computes per-type deltas', () => {
    const before: MatrixSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      label: 'before',
      scores: sampleScores,
    };
    const after: MatrixSnapshot = {
      timestamp: '2026-03-01T00:00:00.000Z',
      label: 'after',
      scores: improvedScores,
    };

    const diff = diffSnapshots(before, after);

    expect(diff.changes).toHaveLength(3);

    const org = diff.changes.find((c) => c.type === 'organization')!;
    expect(org.contentDelta).toBe(5); // 60 - 55
    expect(org.qualityDelta).toBe(5); // 65 - 60
    expect(org.coverageDelta).toBe(5); // 55 - 50
    expect(org.pageCountDelta).toBe(2); // 32 - 30

    const person = diff.changes.find((c) => c.type === 'person')!;
    expect(person.contentDelta).toBe(8); // 48 - 40
    expect(person.qualityDelta).toBe(5); // 50 - 45
    expect(person.coverageDelta).toBe(7); // 42 - 35

    const risk = diff.changes.find((c) => c.type === 'risk')!;
    expect(risk.contentDelta).toBe(2); // 72 - 70
  });

  it('computes overall delta as average of content deltas', () => {
    const before: MatrixSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      scores: sampleScores,
    };
    const after: MatrixSnapshot = {
      timestamp: '2026-03-01T00:00:00.000Z',
      scores: improvedScores,
    };

    const diff = diffSnapshots(before, after);
    // (5 + 8 + 2) / 3 = 5.0
    expect(diff.overallDelta).toBe(5);
  });

  it('handles entity types that only appear in one snapshot', () => {
    const before: MatrixSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      scores: [
        { type: 'organization', contentScore: 50, qualityScore: 50, coverageScore: 50, pageCount: 10, avgWordCount: 1000 },
      ],
    };
    const after: MatrixSnapshot = {
      timestamp: '2026-03-01T00:00:00.000Z',
      scores: [
        { type: 'organization', contentScore: 60, qualityScore: 55, coverageScore: 55, pageCount: 12, avgWordCount: 1100 },
        { type: 'ai-model', contentScore: 45, qualityScore: 40, coverageScore: 50, pageCount: 5, avgWordCount: 900 },
      ],
    };

    const diff = diffSnapshots(before, after);
    expect(diff.changes).toHaveLength(2);

    const newType = diff.changes.find((c) => c.type === 'ai-model')!;
    expect(newType.contentDelta).toBe(45); // 45 - 0
    expect(newType.pageCountDelta).toBe(5); // 5 - 0
  });

  it('handles entity types removed in the after snapshot', () => {
    const before: MatrixSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      scores: [
        { type: 'organization', contentScore: 50, qualityScore: 50, coverageScore: 50, pageCount: 10, avgWordCount: 1000 },
        { type: 'legacy', contentScore: 30, qualityScore: 25, coverageScore: 20, pageCount: 2, avgWordCount: 500 },
      ],
    };
    const after: MatrixSnapshot = {
      timestamp: '2026-03-01T00:00:00.000Z',
      scores: [
        { type: 'organization', contentScore: 55, qualityScore: 55, coverageScore: 55, pageCount: 11, avgWordCount: 1050 },
      ],
    };

    const diff = diffSnapshots(before, after);
    const removed = diff.changes.find((c) => c.type === 'legacy')!;
    expect(removed.contentDelta).toBe(-30); // 0 - 30
    expect(removed.pageCountDelta).toBe(-2); // 0 - 2
  });

  it('returns zero overall delta when nothing changes', () => {
    const snap: MatrixSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      scores: sampleScores,
    };
    const diff = diffSnapshots(snap, snap);
    expect(diff.overallDelta).toBe(0);
    for (const c of diff.changes) {
      expect(c.contentDelta).toBe(0);
      expect(c.qualityDelta).toBe(0);
      expect(c.coverageDelta).toBe(0);
      expect(c.pageCountDelta).toBe(0);
    }
  });

  it('returns empty changes and zero delta for empty snapshots', () => {
    const empty: MatrixSnapshot = { timestamp: '2026-01-01T00:00:00.000Z', scores: [] };
    const diff = diffSnapshots(empty, empty);
    expect(diff.changes).toHaveLength(0);
    expect(diff.overallDelta).toBe(0);
  });

  it('sorts changes by absolute content delta descending', () => {
    const before: MatrixSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      scores: sampleScores,
    };
    const after: MatrixSnapshot = {
      timestamp: '2026-03-01T00:00:00.000Z',
      scores: improvedScores,
    };

    const diff = diffSnapshots(before, after);
    // person has +8 (biggest), org has +5, risk has +2
    expect(diff.changes[0].type).toBe('person');
    expect(diff.changes[1].type).toBe('organization');
    expect(diff.changes[2].type).toBe('risk');
  });
});

describe('formatDiff', () => {
  it('produces output with header, per-type rows, and overall delta', () => {
    const before: MatrixSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      label: 'v1',
      scores: sampleScores,
    };
    const after: MatrixSnapshot = {
      timestamp: '2026-03-01T00:00:00.000Z',
      label: 'v2',
      scores: improvedScores,
    };

    const diff = diffSnapshots(before, after);
    const output = formatDiff(diff);

    // Contains header
    expect(output).toContain('v1');
    expect(output).toContain('v2');

    // Contains entity type names
    expect(output).toContain('organization');
    expect(output).toContain('person');
    expect(output).toContain('risk');

    // Contains overall delta
    expect(output).toContain('Overall content delta');
  });

  it('includes green color codes for positive deltas', () => {
    const before: MatrixSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      scores: [{ type: 'org', contentScore: 40, qualityScore: 40, coverageScore: 40, pageCount: 5, avgWordCount: 500 }],
    };
    const after: MatrixSnapshot = {
      timestamp: '2026-03-01T00:00:00.000Z',
      scores: [{ type: 'org', contentScore: 60, qualityScore: 55, coverageScore: 50, pageCount: 7, avgWordCount: 600 }],
    };

    const diff = diffSnapshots(before, after);
    const output = formatDiff(diff);
    // Green ANSI code
    expect(output).toContain('\x1b[32m');
  });

  it('includes red color codes for negative deltas', () => {
    const before: MatrixSnapshot = {
      timestamp: '2026-01-01T00:00:00.000Z',
      scores: [{ type: 'org', contentScore: 60, qualityScore: 55, coverageScore: 50, pageCount: 7, avgWordCount: 600 }],
    };
    const after: MatrixSnapshot = {
      timestamp: '2026-03-01T00:00:00.000Z',
      scores: [{ type: 'org', contentScore: 40, qualityScore: 40, coverageScore: 40, pageCount: 5, avgWordCount: 500 }],
    };

    const diff = diffSnapshots(before, after);
    const output = formatDiff(diff);
    // Red ANSI code
    expect(output).toContain('\x1b[31m');
  });
});
