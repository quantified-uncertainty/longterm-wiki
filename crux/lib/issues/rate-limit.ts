/**
 * Issue creation rate limiting.
 *
 * Tracks daily issue creation count to prevent tracker flood by agents.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

/** Threshold for soft warning — not a hard limit */
export const DAILY_CREATE_LIMIT = 5;
const RATE_LIMIT_FILE = join(dirname(new URL(import.meta.url).pathname), '../../../.claude/issue-creates.json');

interface RateLimitRecord {
  timestamps: string[]; // ISO date strings of issue creation times
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
 * Record that an issue was just created.
 */
export function recordCreate(): void {
  const now = new Date().toISOString();
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
  writeFileSync(RATE_LIMIT_FILE, JSON.stringify(data, null, 2) + '\n');
}
