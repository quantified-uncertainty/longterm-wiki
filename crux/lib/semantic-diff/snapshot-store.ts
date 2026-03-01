/**
 * Snapshot Store
 *
 * Stores before/after content snapshots for audit trail purposes.
 * Snapshots are stored locally as JSON files in .claude/snapshots/.
 *
 * Design decisions:
 * - Local filesystem storage initially (can migrate to wiki-server later)
 * - JSON format for easy programmatic access
 * - Files are gitignored (audit trail, not source code)
 * - Retention: last 30 snapshots per page (older ones pruned automatically)
 * - Snapshots are stored synchronously to avoid race conditions on apply
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { PROJECT_ROOT } from '../content-types.ts';
import type { ContentSnapshot, SemanticDiff, ContradictionResult } from './types.ts';

// ---------------------------------------------------------------------------
// Storage configuration
// ---------------------------------------------------------------------------

const SNAPSHOTS_DIR = path.join(PROJECT_ROOT, '.claude', 'snapshots');
const MAX_SNAPSHOTS_PER_PAGE = 30;

// ---------------------------------------------------------------------------
// Snapshot utilities
// ---------------------------------------------------------------------------

/**
 * Compute a short hash of content for change detection.
 */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Get the snapshot directory for a page.
 */
function getPageSnapshotDir(pageId: string): string {
  return path.join(SNAPSHOTS_DIR, pageId);
}

/**
 * Get a timestamped filename for a snapshot.
 */
function getSnapshotFilename(timestamp: string): string {
  // Replace colons and dots to make a valid filename
  return `${timestamp.replace(/[:.]/g, '-')}.json`;
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Prune old snapshots if a page has more than MAX_SNAPSHOTS_PER_PAGE.
 * Deletes the oldest files (by filename sort, which is chronological since we use ISO timestamps).
 */
function pruneOldSnapshots(pageDir: string): void {
  try {
    const files = fs.readdirSync(pageDir)
      .filter(f => f.endsWith('.json'))
      .sort(); // ISO timestamp sort = chronological

    if (files.length > MAX_SNAPSHOTS_PER_PAGE) {
      const toDelete = files.slice(0, files.length - MAX_SNAPSHOTS_PER_PAGE);
      for (const file of toDelete) {
        try {
          fs.unlinkSync(path.join(pageDir, file));
        } catch {
          // Best effort — don't fail if we can't delete
        }
      }
    }
  } catch {
    // Ignore pruning errors — this is a non-critical operation
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StoreSnapshotOptions {
  /** Agent or pipeline that made the change. Default: 'unknown'. */
  agent?: string;
  /** Tier used for the improvement. */
  tier?: string;
  /** Semantic diff result to include in snapshot. */
  diff?: SemanticDiff;
  /** Contradiction detection result to include in snapshot. */
  contradictions?: ContradictionResult;
}

/**
 * Store a before/after content snapshot for a page modification.
 *
 * Creates a JSON file in .claude/snapshots/<pageId>/<timestamp>.json.
 * Returns the path to the stored snapshot file.
 *
 * This function is safe to call even if the snapshots directory doesn't exist —
 * it creates it as needed. Errors are logged but never thrown.
 */
export function storeSnapshot(
  pageId: string,
  beforeContent: string,
  afterContent: string,
  options: StoreSnapshotOptions = {},
): string | null {
  try {
    const timestamp = new Date().toISOString();
    const pageDir = getPageSnapshotDir(pageId);

    // Create directory structure
    fs.mkdirSync(pageDir, { recursive: true });

    const snapshot: ContentSnapshot = {
      pageId,
      timestamp,
      agent: options.agent ?? 'unknown',
      tier: options.tier,
      beforeContent,
      afterContent,
      diff: options.diff,
      contradictions: options.contradictions,
    };

    const filename = getSnapshotFilename(timestamp);
    const snapshotPath = path.join(pageDir, filename);

    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

    // Prune old snapshots (keep MAX_SNAPSHOTS_PER_PAGE)
    pruneOldSnapshots(pageDir);

    return snapshotPath;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[semantic-diff] Failed to store snapshot for ${pageId}: ${error.message}`);
    return null;
  }
}

/**
 * Load a specific snapshot by page ID and timestamp.
 * Returns null if not found or unreadable.
 */
export function loadSnapshot(pageId: string, timestamp: string): ContentSnapshot | null {
  try {
    const pageDir = getPageSnapshotDir(pageId);
    const filename = getSnapshotFilename(timestamp);
    const snapshotPath = path.join(pageDir, filename);

    if (!fs.existsSync(snapshotPath)) return null;

    const raw = fs.readFileSync(snapshotPath, 'utf-8');
    return JSON.parse(raw) as ContentSnapshot;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[semantic-diff] Failed to load snapshot for ${pageId}: ${error.message}`);
    return null;
  }
}

/**
 * List all snapshots for a page, ordered chronologically (newest first).
 * Returns an array of snapshot metadata (without content for efficiency).
 */
export function listSnapshots(pageId: string): Array<{
  timestamp: string;
  agent: string;
  tier?: string;
  path: string;
  beforeHash: string;
  afterHash: string;
}> {
  try {
    const pageDir = getPageSnapshotDir(pageId);
    if (!fs.existsSync(pageDir)) return [];

    const files = fs.readdirSync(pageDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse(); // Newest first

    return files
      .map(filename => {
        try {
          const snapshotPath = path.join(pageDir, filename);
          const raw = fs.readFileSync(snapshotPath, 'utf-8');
          const snapshot = JSON.parse(raw) as ContentSnapshot;

          return {
            timestamp: snapshot.timestamp,
            agent: snapshot.agent,
            tier: snapshot.tier,
            path: snapshotPath,
            beforeHash: contentHash(snapshot.beforeContent),
            afterHash: contentHash(snapshot.afterContent),
          };
        } catch {
          return null;
        }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  } catch {
    return [];
  }
}

/**
 * Get the most recent snapshot for a page, if any.
 */
export function getLatestSnapshot(pageId: string): ContentSnapshot | null {
  try {
    const pageDir = getPageSnapshotDir(pageId);
    if (!fs.existsSync(pageDir)) return null;

    const files = fs.readdirSync(pageDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    if (files.length === 0) return null;

    const latest = files[files.length - 1];
    const raw = fs.readFileSync(path.join(pageDir, latest), 'utf-8');
    return JSON.parse(raw) as ContentSnapshot;
  } catch {
    return null;
  }
}

/**
 * Get the snapshots directory path (for informational purposes).
 */
export function getSnapshotsDir(): string {
  return SNAPSHOTS_DIR;
}
