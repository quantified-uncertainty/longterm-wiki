/**
 * Auto-Update Watchlist
 *
 * Manages scheduled page updates independent of news routing.
 * Pages in data/auto-update/watchlist.yaml are force-included in every
 * auto-update run that falls within their scheduled window.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { PageUpdate } from './types.ts';

const WATCHLIST_PATH = join(PROJECT_ROOT, 'data/auto-update/watchlist.yaml');

// ── Types ────────────────────────────────────────────────────────────────────

export interface WatchlistEntry {
  pageId: string;
  frequency_days: number;
  expires: string;        // YYYY-MM-DD
  tier: 'polish' | 'standard' | 'deep';
  directions: string;
  last_run: string | null;  // YYYY-MM-DD or null
}

interface WatchlistFile {
  entries: WatchlistEntry[];
}

// ── Load / Save ──────────────────────────────────────────────────────────────

function loadWatchlist(): WatchlistFile {
  if (!existsSync(WATCHLIST_PATH)) {
    return { entries: [] };
  }
  const raw = readFileSync(WATCHLIST_PATH, 'utf-8');
  const parsed = parseYaml(raw) as WatchlistFile;
  return parsed ?? { entries: [] };
}

function saveWatchlist(wl: WatchlistFile): void {
  writeFileSync(WATCHLIST_PATH, stringifyYaml(wl, { lineWidth: 100 }));
}

// ── Due-Date Logic ───────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / msPerDay);
}

function isEntryDue(entry: WatchlistEntry, today: string): boolean {
  // Expired?
  if (today > entry.expires) return false;

  // Never run before → always due
  if (!entry.last_run) return true;

  // Due when frequency_days have elapsed since last_run
  return daysBetween(entry.last_run, today) >= entry.frequency_days;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return watchlist entries that are due for update today.
 * Also returns their directions as PageUpdate objects (without relevantNews).
 */
export function getDueWatchlistUpdates(
  today: string,
  verbose = false,
): PageUpdate[] {
  const wl = loadWatchlist();
  const due: PageUpdate[] = [];

  for (const entry of wl.entries) {
    const isDue = isEntryDue(entry, today);

    if (verbose) {
      const status = today > entry.expires
        ? 'expired'
        : isDue
          ? 'DUE'
          : `next in ${entry.frequency_days - daysBetween(entry.last_run!, today)}d`;
      console.log(`  Watchlist: ${entry.pageId} [${status}]`);
    }

    if (!isDue) continue;

    due.push({
      pageId: entry.pageId,
      pageTitle: entry.pageId,   // caller can enrich with real title
      reason: `Watchlist: scheduled ${entry.frequency_days}-day update (expires ${entry.expires})`,
      suggestedTier: entry.tier,
      relevantNews: [],
      directions: entry.directions.trim(),
    });
  }

  return due;
}

/**
 * Mark watchlist entries as updated (set last_run = today).
 * Call this after successfully executing watchlist-driven updates.
 */
export function markWatchlistUpdated(pageIds: string[], today: string): void {
  const wl = loadWatchlist();

  for (const entry of wl.entries) {
    if (pageIds.includes(entry.pageId)) {
      entry.last_run = today;
    }
  }

  saveWatchlist(wl);
}
