/**
 * Importance Ranking Library
 *
 * Core functions for managing importance rankings — ordered lists of page IDs
 * that serve as the source of truth for importance scores.
 *
 * Two ranking dimensions:
 *   - readership: How important is this page for readers navigating AI safety?
 *   - research:   How much value would deeper investigation of this topic yield?
 *
 * Numeric 0-100 scores in page frontmatter are derived from ranking positions.
 *
 * Data files:
 *   data/reader-importance-ranking.yaml (readership ranking)
 *   data/research-ranking.yaml        (research importance ranking)
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT, CONTENT_DIR_ABS } from './content-types.ts';
import { findMdxFiles } from './file-utils.ts';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const RANKING_DIR = join(PROJECT_ROOT, 'data');

export const RANKING_FILES: Record<string, string> = {
  readership: join(RANKING_DIR, 'reader-importance-ranking.yaml'),
  research: join(RANKING_DIR, 'research-ranking.yaml'),
};

/** Default ranking dimension (backward compat). */
export const DEFAULT_DIMENSION = 'readership';

/** Get path for a ranking dimension. Falls back to readership. */
export function getRankingFile(dimension: string = DEFAULT_DIMENSION): string {
  return RANKING_FILES[dimension] || RANKING_FILES.readership;
}

// Backward compat alias
export const RANKING_FILE = RANKING_FILES.readership;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RankingData {
  /** Ordered list of page IDs, most important first. */
  ranking: string[];
}

export interface DerivedScore {
  id: string;
  position: number;
  score: number;
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/** Load a ranking from YAML. Returns empty ranking if file doesn't exist. */
export function loadRanking(dimension: string = DEFAULT_DIMENSION): RankingData {
  const file = getRankingFile(dimension);
  if (!existsSync(file)) {
    return { ranking: [] };
  }
  const raw = readFileSync(file, 'utf-8');
  const data = parseYaml(raw) as RankingData;
  if (!data || !Array.isArray(data.ranking)) {
    return { ranking: [] };
  }
  // Deduplicate — keep first occurrence of each page ID
  const seen = new Set<string>();
  data.ranking = data.ranking.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return data;
}

const DIMENSION_LABELS: Record<string, { title: string; description: string }> = {
  readership: {
    title: 'Readership Importance Ranking',
    description: 'Pages ordered by how important they are for readers navigating AI safety.',
  },
  research: {
    title: 'Research Importance Ranking',
    description: 'Pages ordered by how much value deeper investigation would yield.',
  },
};

/** Save a ranking to YAML. */
export function saveRanking(data: RankingData, dimension: string = DEFAULT_DIMENSION): void {
  const file = getRankingFile(dimension);
  const label = DIMENSION_LABELS[dimension] || DIMENSION_LABELS.readership;

  const header = [
    `# ${label.title}`,
    `# ${label.description}`,
    '#',
    '# This list is the source of truth. Scores are derived from position.',
    `# Run \`pnpm crux importance sync --apply\` to write scores to frontmatter.`,
    '#',
    `# Total ranked: ${data.ranking.length}`,
    '',
  ].join('\n');

  const yaml = stringifyYaml(data, { lineWidth: 0 });
  const content = header + yaml;
  // Atomic write: write to temp file in same directory, then rename
  const tmpFile = join(dirname(file), `.ranking-${Date.now()}.tmp`);
  writeFileSync(tmpFile, content, 'utf-8');
  renameSync(tmpFile, file);
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

/** Get all available ranking dimensions. */
export function getAvailableDimensions(): string[] {
  return Object.keys(RANKING_FILES).filter((dim) =>
    existsSync(RANKING_FILES[dim]),
  );
}
