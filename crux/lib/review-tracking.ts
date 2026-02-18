/**
 * Human Review Tracking
 *
 * Tracks which pages have been reviewed by humans, distinguishing
 * AI-drafted content from human-verified content. Stored in
 * data/reviews/<page-id>.yaml alongside edit logs.
 *
 * Usage:
 *   import { markReviewed, getReviewStatus, listReviews } from './review-tracking.ts';
 *
 *   markReviewed('open-philanthropy', {
 *     reviewer: 'ozzie',
 *     note: 'Verified funding figures and founding date',
 *   });
 *
 *   const status = getReviewStatus('open-philanthropy');
 *   const allReviews = listReviews();
 *
 * Part of the hallucination risk reduction initiative (issue #200, Phase 4).
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewEntry {
  date: string;           // YYYY-MM-DD
  reviewer: string;       // Name of human reviewer
  scope?: string;         // What was reviewed: 'full' | 'citations' | 'facts' | 'partial'
  note?: string;          // Free-text description of what was checked
}

export interface ReviewFile {
  pageId: string;
  reviews: ReviewEntry[];
}

export interface ReviewStatus {
  pageId: string;
  reviewed: boolean;
  lastReviewDate: string | null;
  lastReviewer: string | null;
  reviewCount: number;
  daysSinceReview: number | null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const REVIEWS_DIR = path.join(ROOT, 'data/reviews');

function reviewFilePath(pageId: string): string {
  return path.join(REVIEWS_DIR, `${pageId}.yaml`);
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Read all review entries for a page.
 */
export function readReviews(pageId: string): ReviewEntry[] {
  const filePath = reviewFilePath(pageId);
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

/**
 * Mark a page as reviewed by a human.
 */
export function markReviewed(
  pageId: string,
  opts: { reviewer: string; scope?: string; note?: string; date?: string },
): ReviewEntry {
  // Ensure directory exists
  if (!fs.existsSync(REVIEWS_DIR)) {
    fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  }

  const entry: ReviewEntry = {
    date: opts.date || new Date().toISOString().slice(0, 10),
    reviewer: opts.reviewer,
    ...(opts.scope && { scope: opts.scope }),
    ...(opts.note && { note: opts.note }),
  };

  const existing = readReviews(pageId);
  existing.push(entry);

  const yaml = stringifyYaml(existing, { lineWidth: 0 });
  fs.writeFileSync(reviewFilePath(pageId), yaml, 'utf-8');

  return entry;
}

/**
 * Get review status for a specific page.
 */
export function getReviewStatus(pageId: string): ReviewStatus {
  const reviews = readReviews(pageId);

  if (reviews.length === 0) {
    return {
      pageId,
      reviewed: false,
      lastReviewDate: null,
      lastReviewer: null,
      reviewCount: 0,
      daysSinceReview: null,
    };
  }

  const last = reviews[reviews.length - 1];
  const today = new Date();
  const lastDate = new Date(last.date);
  const daysSince = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

  return {
    pageId,
    reviewed: true,
    lastReviewDate: last.date,
    lastReviewer: last.reviewer,
    reviewCount: reviews.length,
    daysSinceReview: daysSince,
  };
}

/**
 * List all pages with review records.
 */
export function listAllReviews(): ReviewStatus[] {
  if (!fs.existsSync(REVIEWS_DIR)) return [];

  try {
    const files = fs.readdirSync(REVIEWS_DIR)
      .filter((f: string) => f.endsWith('.yaml'))
      .map((f: string) => f.replace(/\.yaml$/, ''));

    return files.map(getReviewStatus).sort((a, b) => {
      // Sort by most recent review first
      if (!a.lastReviewDate) return 1;
      if (!b.lastReviewDate) return -1;
      return b.lastReviewDate.localeCompare(a.lastReviewDate);
    });
  } catch {
    return [];
  }
}

/**
 * Get the total count of reviewed vs unreviewed pages.
 */
export function getReviewStats(allPageIds: string[]): {
  totalPages: number;
  reviewedCount: number;
  unreviewedCount: number;
  staleCount: number;
  reviewedIds: string[];
  unreviewedIds: string[];
} {
  const reviewed: string[] = [];
  const unreviewed: string[] = [];
  let staleCount = 0;

  for (const id of allPageIds) {
    const status = getReviewStatus(id);
    if (status.reviewed) {
      reviewed.push(id);
      // Count reviews older than 90 days as stale
      if (status.daysSinceReview !== null && status.daysSinceReview > 90) {
        staleCount++;
      }
    } else {
      unreviewed.push(id);
    }
  }

  return {
    totalPages: allPageIds.length,
    reviewedCount: reviewed.length,
    unreviewedCount: unreviewed.length,
    staleCount,
    reviewedIds: reviewed,
    unreviewedIds: unreviewed,
  };
}
