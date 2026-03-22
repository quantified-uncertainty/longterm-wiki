/**
 * Issue scoring, ranking, and blocking detection.
 *
 * Pure functions for computing issue priority scores used by list/next/cleanup commands.
 */

import type { ScoreBreakdown, RankedIssue } from './types.ts';
import {
  PRIORITY_SCORES,
  PRIORITY_LABELS,
  BUG_LABELS,
  CLAUDE_READY_LABEL,
  HIGH_EFFORT_LABELS,
  LOW_EFFORT_LABELS,
  BLOCKED_LABELS,
  BLOCKED_BODY_PATTERNS,
} from './types.ts';

export function issuePriority(labels: string[]): number {
  let best = 99;
  for (const label of labels) {
    const p = PRIORITY_LABELS[label];
    if (p !== undefined && p < best) best = p;
  }
  return best;
}

export function scoreIssue(labels: string[], body: string, createdAt: string, updatedAt: string): ScoreBreakdown {
  // 1. Priority base score
  let priorityScore = 50; // unlabeled default
  for (const label of labels) {
    const s = PRIORITY_SCORES[label];
    if (s !== undefined && s > priorityScore) priorityScore = s;
  }

  // 2. Bug bonus (+50 for bugs — concrete failures are actionable)
  const bugBonus = labels.some(l => BUG_LABELS.has(l)) ? 50 : 0;

  // 3. Claude-ready multiplier (1.5×, applied after other bonuses)
  const isClaudeReady = labels.includes(CLAUDE_READY_LABEL);

  // 4. Effort adjustment
  let effortAdjustment = 0;
  if (labels.some(l => LOW_EFFORT_LABELS.has(l))) effortAdjustment = +20;
  else if (labels.some(l => HIGH_EFFORT_LABELS.has(l))) effortAdjustment = -20;

  // 5. Recency bonus (+15 if updated within 7 days — someone cares about it)
  const daysSinceUpdate = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  const recencyBonus = daysSinceUpdate <= 7 ? 15 : 0;

  // 6. Age bonus (older issues get up to +10 — avoid starvation)
  const daysSinceCreate = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const ageBonus = Math.min(10, Math.floor(daysSinceCreate / 30)); // +1 per month, cap 10

  const baseTotal = priorityScore + bugBonus + effortAdjustment + recencyBonus + ageBonus;
  const claudeReadyBonus = isClaudeReady ? Math.round(baseTotal * 0.5) : 0;
  const total = baseTotal + claudeReadyBonus;

  return {
    priority: priorityScore,
    bugBonus,
    claudeReadyBonus,
    effortAdjustment,
    recencyBonus,
    ageBonus,
    total,
  };
}

export function isBlocked(labels: string[], body: string): boolean {
  if (labels.some(l => BLOCKED_LABELS.has(l))) return true;
  return BLOCKED_BODY_PATTERNS.some(p => p.test(body));
}

export function rankIssues(issues: RankedIssue[]): RankedIssue[] {
  return [...issues].sort((a, b) => {
    // Higher score = higher priority
    if (a.score !== b.score) return b.score - a.score;
    // Tiebreak: older issues first
    return a.createdAt.localeCompare(b.createdAt);
  });
}
