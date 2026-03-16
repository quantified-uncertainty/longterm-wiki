/**
 * Matrix Snapshot — save, load, list, and diff entity matrix score snapshots.
 *
 * Snapshots are stored as JSON files in `.matrix-snapshots/` (gitignored).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { PROJECT_ROOT } from './content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatrixSnapshot {
  timestamp: string;
  label?: string;
  scores: Array<{
    type: string;
    contentScore: number;
    qualityScore: number;
    coverageScore: number;
    pageCount: number;
    avgWordCount: number;
  }>;
}

export interface MatrixDiff {
  before: MatrixSnapshot;
  after: MatrixSnapshot;
  changes: Array<{
    type: string;
    contentDelta: number;
    qualityDelta: number;
    coverageDelta: number;
    pageCountDelta: number;
  }>;
  overallDelta: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOT_DIR = join(PROJECT_ROOT, '.matrix-snapshots');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!existsSync(SNAPSHOT_DIR)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
}

function toFilename(label: string | undefined, timestamp: string): string {
  const ts = timestamp.replace(/[:.]/g, '-');
  return label ? `${label}-${ts}.json` : `${ts}.json`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save a snapshot to `.matrix-snapshots/<label-or-timestamp>.json`.
 * Returns the full file path.
 */
export function saveSnapshot(
  scores: MatrixSnapshot['scores'],
  label?: string,
): string {
  ensureDir();

  const timestamp = new Date().toISOString();
  const snapshot: MatrixSnapshot = { timestamp, label, scores };
  const filename = toFilename(label, timestamp);
  const filepath = join(SNAPSHOT_DIR, filename);

  writeFileSync(filepath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  return filepath;
}

/**
 * Load a snapshot by label (finds the latest matching file) or by full path.
 */
export function loadSnapshot(labelOrPath: string): MatrixSnapshot | null {
  // If it looks like a full path or ends with .json, try loading directly
  if (labelOrPath.endsWith('.json') || labelOrPath.includes('/')) {
    const fullPath = labelOrPath.startsWith('/')
      ? labelOrPath
      : join(SNAPSHOT_DIR, labelOrPath);
    if (!existsSync(fullPath)) return null;
    try {
      return JSON.parse(readFileSync(fullPath, 'utf-8')) as MatrixSnapshot;
    } catch {
      return null;
    }
  }

  // Otherwise treat as a label — find the latest matching file
  if (!existsSync(SNAPSHOT_DIR)) return null;

  const files = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.startsWith(labelOrPath + '-') && f.endsWith('.json'))
    .sort();

  if (files.length === 0) return null;

  // Last file alphabetically = latest timestamp
  const latest = files[files.length - 1];
  try {
    return JSON.parse(
      readFileSync(join(SNAPSHOT_DIR, latest), 'utf-8'),
    ) as MatrixSnapshot;
  } catch {
    return null;
  }
}

/**
 * List all snapshots sorted by timestamp (oldest first).
 */
export function listSnapshots(): Array<{
  label: string;
  timestamp: string;
  path: string;
}> {
  if (!existsSync(SNAPSHOT_DIR)) return [];

  const files = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const results: Array<{ label: string; timestamp: string; path: string }> = [];

  for (const f of files) {
    const fullPath = join(SNAPSHOT_DIR, f);
    try {
      const snap = JSON.parse(readFileSync(fullPath, 'utf-8')) as MatrixSnapshot;
      results.push({
        label: snap.label || basename(f, '.json'),
        timestamp: snap.timestamp,
        path: fullPath,
      });
    } catch {
      // Skip corrupted files
    }
  }

  return results;
}

/**
 * Compute per-type deltas and an overall delta between two snapshots.
 *
 * The overall delta is the average of contentScore changes across all
 * entity types that appear in either snapshot.
 */
export function diffSnapshots(
  before: MatrixSnapshot,
  after: MatrixSnapshot,
): MatrixDiff {
  const beforeMap = new Map(before.scores.map((s) => [s.type, s]));
  const afterMap = new Map(after.scores.map((s) => [s.type, s]));

  // Union of all entity types
  const allTypes = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  const changes: MatrixDiff['changes'] = [];

  for (const type of allTypes) {
    const b = beforeMap.get(type);
    const a = afterMap.get(type);

    changes.push({
      type,
      contentDelta: (a?.contentScore ?? 0) - (b?.contentScore ?? 0),
      qualityDelta: (a?.qualityScore ?? 0) - (b?.qualityScore ?? 0),
      coverageDelta: (a?.coverageScore ?? 0) - (b?.coverageScore ?? 0),
      pageCountDelta: (a?.pageCount ?? 0) - (b?.pageCount ?? 0),
    });
  }

  // Sort by absolute content delta descending — biggest movers first
  changes.sort(
    (a, b) => Math.abs(b.contentDelta) - Math.abs(a.contentDelta),
  );

  const overallDelta =
    changes.length > 0
      ? Math.round(
          (changes.reduce((sum, c) => sum + c.contentDelta, 0) /
            changes.length) *
            100,
        ) / 100
      : 0;

  return { before, after, changes, overallDelta };
}

/**
 * Format a diff as a colored string for terminal output.
 */
export function formatDiff(diff: MatrixDiff): string {
  const lines: string[] = [];

  const beforeLabel = diff.before.label || diff.before.timestamp;
  const afterLabel = diff.after.label || diff.after.timestamp;

  lines.push(`\x1b[1mMatrix Diff: ${beforeLabel} → ${afterLabel}\x1b[0m`);
  lines.push('');

  // Header
  lines.push(
    `${'Type'.padEnd(22)} ${'Content'.padStart(8)} ${'Quality'.padStart(8)} ${'Coverage'.padStart(9)} ${'Pages'.padStart(6)}`,
  );
  lines.push(
    `${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(9)} ${'─'.repeat(6)}`,
  );

  for (const c of diff.changes) {
    const contentStr = formatDelta(c.contentDelta);
    const qualityStr = formatDelta(c.qualityDelta);
    const coverageStr = formatDelta(c.coverageDelta);
    const pagesStr = formatDelta(c.pageCountDelta);

    lines.push(
      `${c.type.padEnd(22)} ${contentStr.padStart(8)} ${qualityStr.padStart(8)} ${coverageStr.padStart(9)} ${pagesStr.padStart(6)}`,
    );
  }

  lines.push('');

  const overallColor =
    diff.overallDelta > 0
      ? '\x1b[32m'
      : diff.overallDelta < 0
        ? '\x1b[31m'
        : '\x1b[0m';
  const sign = diff.overallDelta > 0 ? '+' : '';
  lines.push(
    `\x1b[1mOverall content delta: ${overallColor}${sign}${diff.overallDelta}\x1b[0m`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal formatting
// ---------------------------------------------------------------------------

function formatDelta(delta: number): string {
  if (delta === 0) return '\x1b[2m0\x1b[0m';
  const sign = delta > 0 ? '+' : '';
  const color = delta > 0 ? '\x1b[32m' : '\x1b[31m';
  return `${color}${sign}${delta}\x1b[0m`;
}
