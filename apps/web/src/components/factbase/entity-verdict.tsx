import type { VerdictRow, VerdictType } from "./entity-detail-shared";
import { VERDICT_STYLES } from "./entity-detail-shared";

export function VerdictBadge({ verdict }: { verdict: VerdictRow }) {
  const style = VERDICT_STYLES[verdict.verdict as VerdictType] ?? VERDICT_STYLES.unchecked;
  const confidence = verdict.confidence != null ? Math.round(verdict.confidence * 100) : null;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight ${style.className}`}
      title={verdict.reasoning ?? undefined}
    >
      {style.label}
      {confidence != null && <span className="opacity-70">{confidence}%</span>}
    </span>
  );
}

export function SourceCheckSummary({
  verdicts,
  totalFacts,
}: {
  verdicts: Map<string, VerdictRow>;
  totalFacts: number;
}) {
  const counts: Record<string, number> = {};
  for (const v of verdicts.values()) {
    counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
  }
  const checked = verdicts.size;
  const unchecked = totalFacts - checked;

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        {checked}/{totalFacts} checked
      </span>
      {(["confirmed", "contradicted", "outdated", "partial", "unverifiable"] as const).map(
        (v) =>
          counts[v] ? (
            <span
              key={v}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium leading-tight ${VERDICT_STYLES[v].className}`}
            >
              {counts[v]} {VERDICT_STYLES[v].label.toLowerCase()}
            </span>
          ) : null,
      )}
      {unchecked > 0 && (
        <span className="text-muted-foreground">{unchecked} unchecked</span>
      )}
    </span>
  );
}
