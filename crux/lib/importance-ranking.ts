/**
 * Importance Ranking Library
 *
 * Core functions for managing the importance ranking — an ordered list of page IDs
 * sorted by importance to AI safety (most important first).
 *
 * The ranking is the source of truth. Numeric 0-100 importance scores in page
 * frontmatter are derived from ranking position via `deriveScores()`.
 *
 * Data file: data/importance-ranking.yaml
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT, CONTENT_DIR_ABS } from './content-types.ts';
import { findMdxFiles } from './file-utils.ts';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const RANKING_FILE = join(PROJECT_ROOT, 'data', 'importance-ranking.yaml');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RankingData {
  /** Ordered list of page IDs, most important first. */
  ranking: string[];
}

export interface RankedPage {
  id: string;
  position: number; // 1-based
  score: number; // derived 0-100
}

export interface DerivedScore {
  id: string;
  position: number;
  score: number;
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/** Load the ranking from YAML. Returns empty ranking if file doesn't exist. */
export function loadRanking(): RankingData {
  if (!existsSync(RANKING_FILE)) {
    return { ranking: [] };
  }
  const raw = readFileSync(RANKING_FILE, 'utf-8');
  const data = parseYaml(raw) as RankingData;
  if (!data || !Array.isArray(data.ranking)) {
    return { ranking: [] };
  }
  return data;
}

/** Save the ranking to YAML. */
export function saveRanking(data: RankingData): void {
  const header = [
    '# Importance Ranking',
    '# Pages ordered by importance to AI safety (most important first).',
    '# This list is the source of truth for importance scores.',
    '# Run `pnpm crux importance sync` to derive 0-100 scores from this ordering.',
    '#',
    '# To rank a new page: read the list, decide where it belongs relative to',
    '# its neighbors, and insert it. The position IS the importance judgment.',
    '#',
    `# Total ranked: ${data.ranking.length}`,
    '',
  ].join('\n');

  const yaml = stringifyYaml(data, { lineWidth: 0 });
  writeFileSync(RANKING_FILE, header + yaml, 'utf-8');
}

// ---------------------------------------------------------------------------
// Score derivation
// ---------------------------------------------------------------------------

/**
 * Derive 0-100 importance scores from ranking positions.
 *
 * Uses percentile mapping: position 1 → ~95, last position → ~5.
 * The range is [5, 95] to avoid extremes.
 */
export function deriveScores(ranking: string[]): DerivedScore[] {
  const n = ranking.length;
  if (n === 0) return [];
  if (n === 1) return [{ id: ranking[0], position: 1, score: 50 }];

  return ranking.map((id, index) => {
    // Linear interpolation: position 0 → 95, position n-1 → 5
    const score = Math.round((95 - 90 * index / (n - 1)) * 2) / 2; // round to 0.5
    return { id, position: index + 1, score };
  });
}

// ---------------------------------------------------------------------------
// Page discovery
// ---------------------------------------------------------------------------

/** Get all page IDs from the content directory. */
export function getAllPageIds(): string[] {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  return files
    .map((f) => {
      const match = f.match(/([^/]+)\.mdx?$/);
      return match ? match[1] : null;
    })
    .filter((id): id is string => id !== null && id !== 'index');
}

/** Find pages that are not yet in the ranking. */
export function findUnrankedPages(ranking: string[]): string[] {
  const ranked = new Set(ranking);
  const allPages = getAllPageIds();
  return allPages.filter((id) => !ranked.has(id));
}

/** Find IDs in the ranking that don't correspond to existing pages. */
export function findOrphanedEntries(ranking: string[]): string[] {
  const allPages = new Set(getAllPageIds());
  return ranking.filter((id) => !allPages.has(id));
}

// ---------------------------------------------------------------------------
// Ranking manipulation
// ---------------------------------------------------------------------------

/** Insert a page at a specific position (1-based). */
export function insertAt(ranking: string[], pageId: string, position: number): string[] {
  const filtered = ranking.filter((id) => id !== pageId);
  const idx = Math.max(0, Math.min(filtered.length, position - 1));
  filtered.splice(idx, 0, pageId);
  return filtered;
}

/** Move a page to a new position (1-based). */
export function moveTo(ranking: string[], pageId: string, position: number): string[] {
  return insertAt(ranking, pageId, position);
}

/** Remove a page from the ranking. */
export function removeFromRanking(ranking: string[], pageId: string): string[] {
  return ranking.filter((id) => id !== pageId);
}

/** Get a page's current position (1-based), or null if not ranked. */
export function getPosition(ranking: string[], pageId: string): number | null {
  const idx = ranking.indexOf(pageId);
  return idx === -1 ? null : idx + 1;
}

/** Get context around a position: the few pages above and below. */
export function getNeighbors(
  ranking: string[],
  position: number,
  radius: number = 3,
): { above: string[]; below: string[] } {
  const idx = position - 1;
  const above = ranking.slice(Math.max(0, idx - radius), idx);
  const below = ranking.slice(idx + 1, Math.min(ranking.length, idx + 1 + radius));
  return { above, below };
}
