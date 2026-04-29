/**
 * Reconciles the disagree-warning with the headline verdict (QUA-792).
 *
 * Both the headline verdict label and the "checks disagree" explainer are
 * derived from the same `AggregationResult` so the page never shows a
 * headline that contradicts its own dissent breakdown. The aggregation is
 * computed by `aggregateEvidence()` on the wiki-server side
 * (`apps/wiki-server/src/routes/sourcing/sourcing-aggregation.ts`) and
 * delivered alongside the persisted verdict row.
 *
 * When `aggregation` is missing (legacy callers, or no evidence rows yet),
 * the component falls back to the persisted `verdict.verdict` and never
 * renders the explainer — there's nothing to explain without contributing
 * counts.
 */

import { DEFAULT_MIN_RELEVANCE } from "./aggregation-constants";

/**
 * The aggregate verdicts that the canonical aggregation function can emit.
 * Must stay in sync with `AggregateVerdict` in
 * `apps/wiki-server/src/routes/sourcing/sourcing-aggregation-types.ts`.
 */
export type AggregateVerdict =
  | "confirmed"
  | "contradicted"
  | "outdated"
  | "partial"
  | "unverifiable"
  | "unchecked";

export interface ContributingVerdict {
  verdict: AggregateVerdict;
  weight: number;
  rowCount: number;
}

export interface AggregationResultLike {
  verdict: AggregateVerdict;
  confidence: number | null;
  sourcesChecked: number;
  contributing: readonly ContributingVerdict[];
  droppedNotApplicable: number;
}

export interface VerdictHeaderProps {
  /** Persisted verdict row metadata (fieldName, lastComputedAt, needsRecheck, reasoning). */
  verdict: {
    fieldName: string | null;
    verdict: string;
    confidence: number | null;
    reasoning: string | null;
    lastComputedAt: string | Date | null;
    needsRecheck: boolean | null;
  };
  /**
   * Fresh aggregation of underlying evidence. When non-null, this is the
   * single source of truth for both the headline label and the explainer.
   */
  aggregation: AggregationResultLike | null;
  /** Total field-level evidence rows (pre-filter). Used for the "n checks" caption. */
  evidenceCount: number;
  /** Distinct source URLs across the field-level evidence. */
  uniqueSourceCount: number;
  /** Optional internal-tag stripper for the persisted reasoning text. */
  stripInternalTags?: (s: string) => string;
}

const VERDICT_COLORS: Record<string, string> = {
  confirmed: "text-emerald-700 dark:text-emerald-400",
  contradicted: "text-red-700 dark:text-red-400",
  outdated: "text-amber-700 dark:text-amber-400",
  partial: "text-amber-700 dark:text-amber-400",
};

function getVerdictColor(verdict: string): string {
  return VERDICT_COLORS[verdict] ?? "text-muted-foreground";
}

/**
 * Format a single contributing bucket for the explainer line. Annotates
 * relevance qualitatively so the reader can see *why* low-relevance dissent
 * didn't move the headline.
 */
function describeContributor(c: ContributingVerdict): string {
  const avgWeight = c.rowCount > 0 ? c.weight / c.rowCount : 0;
  const relevanceTag =
    avgWeight >= DEFAULT_MIN_RELEVANCE ? "high-relevance" : "low-relevance";
  const sourceWord = c.rowCount === 1 ? "source" : "sources";
  return `${c.rowCount} ${relevanceTag} ${sourceWord} ${c.verdict}`;
}

/**
 * Build the disagreement-explainer sentence. Returns `null` when there's
 * no disagreement (only one contributing bucket, or the aggregate is
 * `unchecked`). Keeps the string locale-neutral and parseable in tests.
 */
export function buildDisagreementExplainer(
  aggregation: AggregationResultLike,
): string | null {
  if (aggregation.verdict === "unchecked") return null;
  if (aggregation.contributing.length <= 1) return null;
  const [winner, ...dissent] = aggregation.contributing;
  const parts = [describeContributor(winner), ...dissent.map(describeContributor)];
  return `Headline ${aggregation.verdict} — ${parts.join(", ")}.`;
}

export function VerdictHeader({
  verdict,
  aggregation,
  evidenceCount,
  uniqueSourceCount,
  stripInternalTags,
}: VerdictHeaderProps) {
  const headlineVerdict = aggregation?.verdict ?? verdict.verdict;
  const headlineConfidence =
    aggregation?.confidence != null ? aggregation.confidence : verdict.confidence;
  const verdictColor = getVerdictColor(headlineVerdict);
  const explainer = aggregation ? buildDisagreementExplainer(aggregation) : null;
  const hasDisagreement = explainer !== null;

  const lastComputedAt =
    verdict.lastComputedAt instanceof Date
      ? verdict.lastComputedAt
      : verdict.lastComputedAt
        ? new Date(verdict.lastComputedAt)
        : null;

  const reasoningText = verdict.reasoning
    ? stripInternalTags
      ? stripInternalTags(verdict.reasoning)
      : verdict.reasoning
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
        {lastComputedAt && (
          <> · {lastComputedAt.toLocaleDateString()}</>
        )}
        {verdict.needsRecheck && (
          <>
            {" "}
            · <span className="text-amber-600 font-semibold">recheck</span>
          </>
        )}
      </span>
      {hasDisagreement && (
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
