"use client";

/**
 * PoliticianScoresCell — compact scorecard summary for politicians directory tables.
 *
 * Shows 2-3 key scores inline with a tooltip on hover for the full breakdown.
 * This is a client component because it uses hover state for the tooltip.
 *
 * Usage in a directory table:
 *   import { PoliticianScoresCell } from "@/components/political";
 *   <PoliticianScoresCell scores={scores} />
 */

import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { PoliticalScore } from "./types";

// ── Score formatting ─────────────────────────────────────────────────

function scorePercent(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  return (score / maxScore) * 100;
}

function compactScoreColor(pct: number): string {
  if (pct >= 70)
    return "text-emerald-700 dark:text-emerald-400";
  if (pct >= 40)
    return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

function tooltipScoreColor(pct: number): string {
  if (pct >= 70)
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (pct >= 40)
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
}

/**
 * Abbreviate a scorer org name for compact display.
 * Uses the first word or acronym-like pattern.
 */
function abbreviateOrg(org: string): string {
  // If it's already short (4 chars or less), use as-is
  if (org.length <= 4) return org;

  // If it looks like an acronym (all caps, possibly with dots)
  const cleaned = org.replace(/\./g, "");
  if (cleaned === cleaned.toUpperCase() && cleaned.length <= 6) return cleaned;

  // Use first word
  const firstWord = org.split(/\s+/)[0];
  if (firstWord.length <= 6) return firstWord;

  // Fall back to first 4 chars
  return org.slice(0, 4);
}

// ── Pick representative scores ───────────────────────────────────────

/**
 * Select up to `count` representative scores to display inline.
 * Prefers the most recent year and distinct scorer orgs.
 */
function pickTopScores(
  scores: PoliticalScore[],
  count: number
): PoliticalScore[] {
  if (scores.length <= count) return scores;

  // Group by scorer org, pick most recent for each
  const byOrg = new Map<string, PoliticalScore>();
  for (const s of scores) {
    const existing = byOrg.get(s.scorerOrg);
    if (!existing || s.year > existing.year) {
      byOrg.set(s.scorerOrg, s);
    }
  }

  // Sort by year descending, then score descending for variety
  const representative = Array.from(byOrg.values()).sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return b.score - a.score;
  });

  return representative.slice(0, count);
}

// ── Component ────────────────────────────────────────────────────────

export interface PoliticianScoresCellProps {
  scores: PoliticalScore[];
  /** Max number of inline scores to show (default: 3) */
  maxInline?: number;
}

export function PoliticianScoresCell({
  scores,
  maxInline = 3,
}: PoliticianScoresCellProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setShowTooltip(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setShowTooltip(false), 150);
  }, []);

  if (scores.length === 0) {
    return <span className="text-muted-foreground/40">&ndash;</span>;
  }

  const topScores = pickTopScores(scores, maxInline);

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center gap-1.5"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Inline compact scores */}
      <span className="flex items-center gap-1 text-xs tabular-nums">
        {topScores.map((s, i) => {
          const pct = scorePercent(s.score, s.maxScore);
          return (
            <span key={s.id} className="flex items-center gap-0.5">
              {i > 0 && (
                <span className="text-muted-foreground/30 mx-0.5">|</span>
              )}
              <span className="text-muted-foreground text-[10px]">
                {abbreviateOrg(s.scorerOrg)}:
              </span>
              <span className={cn("font-semibold", compactScoreColor(pct))}>
                {s.score}
              </span>
            </span>
          );
        })}
        {scores.length > maxInline && (
          <span className="text-muted-foreground text-[10px] ml-0.5">
            +{scores.length - maxInline}
          </span>
        )}
      </span>

      {/* Tooltip with full breakdown */}
      {showTooltip && scores.length > 0 && (
        <div
          className={cn(
            "absolute z-50 bottom-full left-0 mb-2",
            "bg-popover text-popover-foreground border border-border rounded-lg shadow-lg",
            "p-3 min-w-[240px] max-w-[320px]"
          )}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
            All Ratings ({scores.length})
          </p>
          <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
            {scores
              .sort((a, b) => {
                if (b.year !== a.year) return b.year - a.year;
                return a.scorerOrg.localeCompare(b.scorerOrg);
              })
              .map((s) => {
                const pct = scorePercent(s.score, s.maxScore);
                return (
                  <div key={s.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-foreground">
                      {s.scorerOrg}
                      <span className="text-muted-foreground ml-1">
                        ({s.year})
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums",
                        tooltipScoreColor(pct)
                      )}
                    >
                      {s.score}/{s.maxScore}
                    </span>
                  </div>
                );
              })}
          </div>
          {/* Tooltip arrow */}
          <div className="absolute top-full left-4 w-2 h-2 -mt-1 rotate-45 bg-popover border-r border-b border-border" />
        </div>
      )}
    </div>
  );
}
