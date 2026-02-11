/**
 * Duplicate Detection Module
 *
 * Checks if a similar page already exists in the wiki using fuzzy string matching.
 */

import fs from 'fs';
import path from 'path';

interface DuplicateMatch {
  title: string;
  path: string;
  similarity: number;
  type: string;
}

interface DuplicateCheckResult {
  exists: boolean;
  matches: DuplicateMatch[];
}

interface DatabaseEntity {
  title?: string;
  name?: string;
  path?: string;
}

/**
 * Calculate Levenshtein distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Calculate similarity ratio (0-1, where 1 is identical)
 */
export function similarity(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const distance = levenshteinDistance(aLower, bLower);
  const maxLen = Math.max(aLower.length, bLower.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

/**
 * Normalize a string to a slug for comparison
 */
export function toSlug(str: string): string {
  return str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Check if a page with similar name already exists
 * Returns { exists: boolean, matches: Array<{title, path, similarity}> }
 */
export async function checkForExistingPage(topic: string, ROOT: string): Promise<DuplicateCheckResult> {
  const registryPath = path.join(ROOT, 'app/src/data/pathRegistry.json');
  const databasePath = path.join(ROOT, 'app/src/data/database.json');

  const matches: DuplicateMatch[] = [];
  const topicSlug = toSlug(topic);
  const topicLower = topic.toLowerCase();

  // Check pathRegistry for slug matches
  if (fs.existsSync(registryPath)) {
    const registry: Record<string, string> = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    for (const [id, urlPath] of Object.entries(registry)) {
      if (id.startsWith('__index__')) continue;

      // Exact slug match
      if (id === topicSlug) {
        matches.push({ title: id, path: urlPath, similarity: 1.0, type: 'exact-id' });
        continue;
      }

      // Fuzzy slug match
      const sim = similarity(id, topicSlug);
      if (sim >= 0.7) {
        matches.push({ title: id, path: urlPath, similarity: sim, type: 'fuzzy-id' });
      }
    }
  }

  // Check database.json for title matches
  if (fs.existsSync(databasePath)) {
    const database: Record<string, DatabaseEntity[]> = JSON.parse(fs.readFileSync(databasePath, 'utf-8'));
    const allEntities = Object.values(database).flat();

    for (const entity of allEntities) {
      if (!entity.path) continue;

      const entityName = entity.title || entity.name;
      if (!entityName) continue;

      const entityNameLower = entityName.toLowerCase();

      // Exact title match
      if (entityNameLower === topicLower) {
        const existingMatch = matches.find(m => m.path === entity.path);
        if (!existingMatch) {
          matches.push({ title: entityName, path: entity.path, similarity: 1.0, type: 'exact-title' });
        }
        continue;
      }

      // Fuzzy title match
      const sim = similarity(entityName, topic);
      if (sim >= 0.7) {
        const existingMatch = matches.find(m => m.path === entity.path);
        if (!existingMatch) {
          matches.push({ title: entityName, path: entity.path, similarity: sim, type: 'fuzzy-title' });
        }
      }
    }
  }

  // Sort by similarity descending
  matches.sort((a, b) => b.similarity - a.similarity);

  return {
    exists: matches.some(m => m.similarity >= 0.9),
    matches: matches.slice(0, 5)
  };
}
