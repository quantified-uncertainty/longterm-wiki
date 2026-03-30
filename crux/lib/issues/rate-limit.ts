/**
 * Issue creation rate limiting.
 *
 * Tracks daily issue creation count to prevent tracker flood by agents.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

/** Threshold for soft warning — not a hard limit */
export const DAILY_CREATE_LIMIT = 5;

/** Warn when >3 issues in one session reference the same entity type */
export const ENTITY_TYPE_THRESHOLD = 3;

const RATE_LIMIT_FILE = join(dirname(new URL(import.meta.url).pathname), '../../../.claude/issue-creates.json');

interface RateLimitRecord {
  timestamps: string[]; // ISO date strings of issue creation times
  /** Entity types mentioned in today's issues, keyed by type name → count */
  entityTypeCounts?: Record<string, number>;
}

/**
 * Check how many issues have been created today (in UTC). Returns the count.
 */
export function getCreatesToday(): number {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (!existsSync(RATE_LIMIT_FILE)) return 0;
    const data: RateLimitRecord = JSON.parse(readFileSync(RATE_LIMIT_FILE, 'utf-8'));
    return data.timestamps.filter(t => t.startsWith(today)).length;
  } catch {
    return 0;
  }
}

/**
 * Record that an issue was just created, optionally with entity types it references.
 */
export function recordCreate(entityTypes?: string[]): void {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let data: RateLimitRecord = { timestamps: [] };
  try {
    if (existsSync(RATE_LIMIT_FILE)) {
      data = JSON.parse(readFileSync(RATE_LIMIT_FILE, 'utf-8'));
    }
  } catch { /* start fresh */ }
  // Keep only timestamps from the last 7 days (self-cleaning)
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  data.timestamps = data.timestamps.filter(t => t.slice(0, 10) >= cutoff);
  data.timestamps.push(now);

  // Track entity types for today's session
  if (!data.entityTypeCounts) data.entityTypeCounts = {};
  // Reset counts if they're from a previous day (check first timestamp today)
  const todayTimestamps = data.timestamps.filter(t => t.startsWith(today));
  if (todayTimestamps.length <= 1) {
    data.entityTypeCounts = {};
  }
  if (entityTypes) {
    for (const t of entityTypes) {
      const key = t.toLowerCase();
      data.entityTypeCounts[key] = (data.entityTypeCounts[key] || 0) + 1;
    }
  }

  writeFileSync(RATE_LIMIT_FILE, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Get entity types that have exceeded the threshold for today's session.
 * Returns an array of [entityType, count] pairs that are over the limit.
 */
export function getOverrepresentedEntityTypes(): Array<[string, number]> {
  try {
    if (!existsSync(RATE_LIMIT_FILE)) return [];
    const data: RateLimitRecord = JSON.parse(readFileSync(RATE_LIMIT_FILE, 'utf-8'));
    if (!data.entityTypeCounts) return [];
    return Object.entries(data.entityTypeCounts).filter(
      ([, count]) => count > ENTITY_TYPE_THRESHOLD,
    );
  } catch {
    return [];
  }
}
