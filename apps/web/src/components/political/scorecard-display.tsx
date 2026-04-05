/**
 * ScorecardDisplay — shows a politician's interest group scorecard ratings.
 *
 * Server component that accepts pre-fetched score data as props.
 * Scores are grouped by scoreType and color-coded by percentage.
 *
 * Usage:
 *   import { ScorecardDisplay, fetchPoliticalScores } from "@/components/political";
 *   const scores = await fetchPoliticalScores(entityId);
 *   <ScorecardDisplay scores={scores} />
 */

import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/format-compact";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import type { PoliticalScore } from "./types";

// ── Score color logic ────────────────────────────────────────────────

function scorePercent(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  return (score / maxScore) * 100;
}

function scoreColorClass(pct: number): string {
  if (pct >= 70)
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (pct >= 40)
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
}

function scoreBgBar(pct: number): string {
  if (pct >= 70) return "bg-emerald-500/20";
  if (pct >= 40) return "bg-amber-500/20";
  return "bg-red-500/20";
}

function scoreFillBar(pct: number): string {
  if (pct >= 70) return "bg-emerald-500";
  if (pct >= 40) return "bg-amber-500";
  return "bg-red-500";
}

// ── Label formatting ─────────────────────────────────────────────────

const SCORE_TYPE_LABELS: Record<string, string> = {
  environmental: "Environmental",
  animal_welfare: "Animal Welfare",
  foreign_policy: "Foreign Policy",
  nuclear: "Nuclear",
  civil_liberties: "Civil Liberties",
  conservative: "Conservative",
  progressive: "Progressive",
  business: "Business",
  labor: "Labor",
  overall: "Overall",
};

function scoreTypeLabel(scoreType: string | null): string {
  if (!scoreType) return "General";
  return SCORE_TYPE_LABELS[scoreType] ?? titleCase(scoreType);
}

function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Group scores by type ─────────────────────────────────────────────

interface ScoreGroup {
  type: string;
  label: string;
  scores: PoliticalScore[];
}

function groupScoresByType(scores: PoliticalScore[]): ScoreGroup[] {
  const map = new Map<string, PoliticalScore[]>();
  for (const score of scores) {
    const key = score.scoreType ?? "general";
    const existing = map.get(key);
    if (existing) {
      existing.push(score);
    } else {
      map.set(key, [score]);
    }
  }

  return Array.from(map.entries())
    .map(([type, scores]) => ({
      type,
      label: scoreTypeLabel(type === "general" ? null : type),
      // Sort within group by year descending, then scorer name
      scores: scores.sort((a, b) => {
        if (b.year !== a.year) return b.year - a.year;
        return a.scorerOrg.localeCompare(b.scorerOrg);
      }),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── Component ────────────────────────────────────────────────────────

export interface ScorecardDisplayProps {
  scores: PoliticalScore[];
}

export function ScorecardDisplay({ scores }: ScorecardDisplayProps) {
  if (scores.length === 0) return null;

  const groups = groupScoresByType(scores);

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Scorecard Ratings
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {scores.length} {scores.length === 1 ? "rating" : "ratings"}
        </span>
      </h2>
      <div className="space-y-4">
        {groups.map((group) => (
          <ScoreGroupSection key={group.type} group={group} />
        ))}
      </div>
    </section>
  );
}

// ── Score group section ──────────────────────────────────────────────

function ScoreGroupSection({ group }: { group: ScoreGroup }) {
  return (
    <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-2 bg-muted/30 border-b border-border/60">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {group.label}
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 bg-muted/10">
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Scorer
              </th>
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Score
              </th>
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground w-32">
                Rating
              </th>
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Year
              </th>
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Source
              </th>
              <th className="px-4 py-2 w-8" />
            </tr>
          </thead>
          <tbody>
            {group.scores.map((score) => (
              <ScoreRow key={score.id} score={score} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Individual score row ─────────────────────────────────────────────

function ScoreRow({ score }: { score: PoliticalScore }) {
  const pct = scorePercent(score.score, score.maxScore);
  const clampedPct = Math.min(100, Math.max(0, pct));

  return (
    <tr className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors">
      <td className="px-4 py-2.5 font-medium">
        {score.scorer.slug ? (
          <a
            href={`/organizations/${score.scorer.slug}`}
            className="text-foreground hover:text-primary transition-colors"
          >
            {score.scorerOrg}
          </a>
        ) : (
          score.scorerOrg
        )}
      </td>
      <td className="px-4 py-2.5">
        <span
          className={cn(
            "inline-block px-2 py-0.5 rounded-full text-xs font-semibold tabular-nums",
            scoreColorClass(pct)
          )}
        >
          {score.score}/{score.maxScore}
        </span>
      </td>
      <td className="px-4 py-2.5">
        <div
          className={cn("h-2 rounded-full w-full", scoreBgBar(pct))}
          role="progressbar"
          aria-valuenow={clampedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${score.scorerOrg} score: ${score.score} out of ${score.maxScore}`}
        >
          <div
            className={cn("h-full rounded-full transition-all", scoreFillBar(pct))}
            style={{ width: `${clampedPct}%` }}
          />
        </div>
      </td>
      <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
        {score.year}
      </td>
      <td className="px-4 py-2.5 text-xs">
        {score.sourceUrl ? (
          <a
            href={safeHref(score.sourceUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Source
          </a>
        ) : (
          <span className="text-muted-foreground/40">&mdash;</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-center">
        <SourceCheckDot status="not_run" size="md" />
      </td>
    </tr>
  );
}
