/**
 * Renders the per-field verdict header on the public sourcing detail page.
 * Headline label and disagreement explainer derive from the same
 * `AggregationResult`, so they cannot drift (QUA-792).
 */

import type { SourcingVerdictType } from "@/components/shared/verdict-styles";

export interface ContributingVerdict {
  verdict: SourcingVerdictType;
  weight: number;
  rowCount: number;
}

export interface AggregationResultLike {
  verdict: SourcingVerdictType;
  confidence: number | null;
  sourcesChecked: number;
  contributing: readonly ContributingVerdict[];
  droppedLowRelevance: readonly ContributingVerdict[];
  droppedNotApplicable: number;
}

export interface VerdictHeaderProps {
  verdict: {
    fieldName: string | null;
    verdict: string;
    confidence: number | null;
    reasoning: string | null;
    lastComputedAt: string | Date | null;
    needsRecheck: boolean | null;
  };
  /** Fresh aggregation; null when no evidence rows exist for this field. */
  aggregation: AggregationResultLike | null;
  evidenceCount: number;
  uniqueSourceCount: number;
  stripInternalTags?: (s: string) => string;
}

const VERDICT_COLORS: Record<string, string> = {
  confirmed: "text-emerald-700 dark:text-emerald-400",
  contradicted: "text-red-700 dark:text-red-400",
  outdated: "text-amber-700 dark:text-amber-400",
  partial: "text-amber-700 dark:text-amber-400",
};

function describeContributor(
  c: ContributingVerdict,
  tier: "high" | "low",
): string {
  const sourceWord = c.rowCount === 1 ? "source" : "sources";
  const tag = tier === "high" ? "high-relevance" : "low-relevance";
  return `${c.rowCount} ${tag} ${sourceWord} ${c.verdict}`;
}

/**
 * Returns `null` when there's no disagreement to explain — single contributing
 * bucket with no filtered low-relevance dissent, or the aggregate is `unchecked`.
 */
export function buildDisagreementExplainer(
  aggregation: AggregationResultLike,
): string | null {
  if (aggregation.verdict === "unchecked") return null;
  const dropped = aggregation.droppedLowRelevance ?? [];
  if (aggregation.contributing.length <= 1 && dropped.length === 0) return null;
  const [winner, ...dissent] = aggregation.contributing;
  const parts: string[] = [
    describeContributor(winner, "high"),
    ...dissent.map((d) => describeContributor(d, "high")),
    ...dropped.map((d) => describeContributor(d, "low")),
  ];
  return `Headline ${aggregation.verdict} — ${parts.join(", ")}.`;
}

export function VerdictHeader({
  verdict,
  aggregation,
  evidenceCount,
  uniqueSourceCount,
  stripInternalTags,
}: VerdictHeaderProps) {
  // When aggregation collapses to "unchecked" but the persisted verdict
  // was substantive, fall back to the persisted row — every other surface
  // on the site shows the persisted value, and rendering "unchecked 90% —
  // All sources confirmed" would self-contradict.
  const liveAggregation =
    aggregation != null && aggregation.verdict !== "unchecked"
      ? aggregation
      : null;
  const headlineVerdict = liveAggregation?.verdict ?? verdict.verdict;
  const headlineConfidence =
    liveAggregation?.confidence ?? verdict.confidence;
  const verdictColor =
    VERDICT_COLORS[headlineVerdict] ?? "text-muted-foreground";
  const explainer = liveAggregation
    ? buildDisagreementExplainer(liveAggregation)
    : null;

  const lastComputedAt = verdict.lastComputedAt
    ? new Date(verdict.lastComputedAt)
    : null;

  const reasoningText = verdict.reasoning
    ? (stripInternalTags?.(verdict.reasoning) ?? verdict.reasoning)
    : null;

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <div className="flex items-baseline gap-3">
        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono">
          Verdict
        </span>
        <span
          data-testid="verdict-headline"
          className={`text-xl font-semibold tracking-tight ${verdictColor}`}
        >
          {headlineVerdict}
        </span>
        {headlineConfidence != null && (
          <span className="text-sm tabular-nums text-foreground/70">
            {Math.round(headlineConfidence * 100)}%
          </span>
        )}
      </div>
      {verdict.fieldName && (
        <span className="text-xs text-muted-foreground">
          field: {verdict.fieldName}
        </span>
      )}
      <span className="ml-auto text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-mono">
        {evidenceCount > 0 && (
          <>
            {evidenceCount} check{evidenceCount !== 1 ? "s" : ""}
            {uniqueSourceCount > 0 && uniqueSourceCount !== evidenceCount && (
              <> · {uniqueSourceCount} src</>
            )}
          </>
        )}
        {lastComputedAt && <> · {lastComputedAt.toLocaleDateString()}</>}
        {verdict.needsRecheck && (
          <>
            {" "}
            · <span className="text-amber-600 font-semibold">recheck</span>
          </>
        )}
      </span>
      {explainer && (
        <div className="basis-full mt-1">
          <span
            data-testid="verdict-explainer"
            className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded px-2 py-0.5"
          >
            ⚠ {explainer}
          </span>
        </div>
      )}
      {reasoningText && (
        <p className="basis-full text-sm text-muted-foreground italic leading-relaxed mt-1">
          {reasoningText}
        </p>
      )}
    </div>
  );
}
