import {
  isVerdictPublished,
  REVIEW_VERDICT_LABELS,
} from "@/app/frontier-safety-frameworks/risk-domain-constants";
import type {
  DiffRow,
  DiffItemRow,
  FrameworkVersionRow,
} from "@/app/frontier-safety-frameworks/frameworks-data";

export interface DiffWithItems {
  diff: DiffRow;
  items: DiffItemRow[];
}

interface DiffsTabProps {
  /** Diffs ordered by chronological direction (newest pair first). */
  diffs: DiffWithItems[];
  versionsById: Map<string, FrameworkVersionRow>;
}

function diffHeaderBadge(diff: DiffRow) {
  if (isVerdictPublished(diff.reviewVerdict)) {
    if (diff.reviewVerdict === "confirmed_weakening") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-800 border border-red-300 dark:bg-red-950/40 dark:text-red-200">
          Weakening
        </span>
      );
    }
    if (diff.reviewVerdict === "confirmed_strengthening") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200">
          Strengthening
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-900 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-200">
        Nuanced
      </span>
    );
  }
  // Unreviewed and false_positive: NEVER show directional language. The
  // factual change list below is what users see.
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground border border-border/50"
      title={REVIEW_VERDICT_LABELS[diff.reviewVerdict] ?? diff.reviewVerdict}
    >
      Pending review
    </span>
  );
}

function snapshotPretty(snapshot: Record<string, unknown> | null) {
  if (!snapshot) return null;
  const tier =
    typeof snapshot.tierLabel === "string"
      ? snapshot.tierLabel
      : typeof snapshot.tier === "string"
      ? snapshot.tier
      : null;
  const trigger =
    typeof snapshot.triggerDescription === "string"
      ? snapshot.triggerDescription
      : typeof snapshot.trigger === "string"
      ? snapshot.trigger
      : null;
  return { tier, trigger };
}

export function DiffsTab({ diffs, versionsById }: DiffsTabProps) {
  if (diffs.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
        No diffs computed yet — diffs require at least two published
        versions.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {diffs.map(({ diff, items }) => {
        const fromV = versionsById.get(diff.fromVersionId);
        const toV = versionsById.get(diff.toVersionId);
        const verdictPublished = isVerdictPublished(diff.reviewVerdict);
        return (
          <details
            key={diff.id}
            className="rounded-lg border border-border/60 bg-card overflow-hidden"
            open={items.length <= 6}
          >
            <summary className="cursor-pointer px-4 py-3 hover:bg-muted/20 transition-colors">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-foreground">
                  {fromV?.versionLabel ?? "Earlier"}
                  <span className="mx-1.5 text-muted-foreground">→</span>
                  {toV?.versionLabel ?? "Later"}
                </span>
                {diffHeaderBadge(diff)}
                <span className="text-xs text-muted-foreground">
                  {items.length} change{items.length === 1 ? "" : "s"}
                </span>
                {(toV?.publishedDate || toV?.discoveredDate) && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {toV.publishedDate ?? toV.discoveredDate}
                  </span>
                )}
              </div>
              {verdictPublished ? (
                <p className="text-sm text-foreground/80 mt-2 max-w-3xl leading-relaxed">
                  {diff.changeSummary}
                </p>
              ) : (
                // Unreviewed: no narrative summary — only show the factual
                // change list below. This satisfies the QUA-709 acceptance
                // criterion that unreviewed diffs never display "weakened"
                // or "strengthened" without verdict.
                <p className="text-xs text-muted-foreground mt-2 italic">
                  Showing factual change list — diff has not been
                  reviewer-confirmed yet, so no directional summary is shown.
                </p>
              )}
              {diff.reviewNotes && verdictPublished && (
                <p className="text-xs text-muted-foreground mt-1.5 italic">
                  Reviewer notes: {diff.reviewNotes}
                </p>
              )}
            </summary>
            <div className="border-t border-border/60 divide-y divide-border/30">
              {items.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted-foreground italic">
                  No itemized changes recorded.
                </p>
              ) : (
                items.map((item) => {
                  const before = snapshotPretty(item.beforeSnapshot);
                  const after = snapshotPretty(item.afterSnapshot);
                  return (
                    <div
                      key={item.id}
                      className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-3"
                    >
                      <div>
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {item.changeType.replace(/_/g, " ")}
                          </span>
                          {item.riskDomainCanonical && (
                            <span className="text-[10px] text-muted-foreground">
                              {item.riskDomainCanonical}
                            </span>
                          )}
                        </div>
                        {before ? (
                          <div>
                            <p className="text-[11px] text-muted-foreground mb-0.5">
                              Before
                            </p>
                            {before.tier && (
                              <p className="text-xs font-medium">{before.tier}</p>
                            )}
                            {before.trigger && (
                              <p className="text-xs text-foreground/80 leading-relaxed">
                                {before.trigger}
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">
                            (no prior version of this row)
                          </p>
                        )}
                      </div>
                      <div>
                        {after ? (
                          <div>
                            <p className="text-[11px] text-muted-foreground mb-0.5">
                              After
                            </p>
                            {after.tier && (
                              <p className="text-xs font-medium">{after.tier}</p>
                            )}
                            {after.trigger && (
                              <p className="text-xs text-foreground/80 leading-relaxed">
                                {after.trigger}
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">
                            (removed)
                          </p>
                        )}
                        {item.rationale && (
                          <p className="text-[11px] text-muted-foreground mt-1.5 italic">
                            {item.rationale}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
