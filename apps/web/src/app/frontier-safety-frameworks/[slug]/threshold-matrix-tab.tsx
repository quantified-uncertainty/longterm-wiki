import {
  RISK_DOMAIN_LABELS,
  tierColor,
} from "../risk-domain-constants";
import type { ThresholdRow } from "../frameworks-data";

interface ThresholdMatrixTabProps {
  thresholds: ThresholdRow[];
  versionLabel: string;
}

/**
 * Renders the threshold matrix for a single framework version: rows ordered
 * by tier severity, columns showing threshold + trigger + source quote.
 */
export function ThresholdMatrixTab({
  thresholds,
  versionLabel,
}: ThresholdMatrixTabProps) {
  if (thresholds.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
        No thresholds extracted for {versionLabel} yet.
      </div>
    );
  }

  const sorted = [...thresholds].sort((a, b) => {
    if (a.tierSortOrder !== b.tierSortOrder) {
      return b.tierSortOrder - a.tierSortOrder;
    }
    return a.riskDomainCanonical.localeCompare(b.riskDomainCanonical);
  });

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-border/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 text-xs text-muted-foreground">
              <th className="text-left py-2 px-3 font-semibold">Domain</th>
              <th className="text-left py-2 px-3 font-semibold">Tier</th>
              <th className="text-left py-2 px-3 font-semibold">Trigger</th>
              <th className="text-left py-2 px-3 font-semibold w-24">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {sorted.map((t) => {
              const styles = tierColor(t.tierSortOrder);
              return (
                <tr key={t.id} className="hover:bg-muted/15 transition-colors">
                  <td className="py-2.5 px-3 align-top">
                    <span className="font-medium text-foreground">
                      {RISK_DOMAIN_LABELS[t.riskDomainCanonical]}
                    </span>
                    {t.riskDomainLabel !== RISK_DOMAIN_LABELS[t.riskDomainCanonical] && (
                      <span className="block text-[11px] text-muted-foreground italic">
                        “{t.riskDomainLabel}” in source
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 align-top">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold border ${styles.bg} ${styles.text} ${styles.border}`}
                    >
                      {t.tierLabel}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 align-top text-foreground/80 max-w-2xl">
                    <div className="text-sm leading-relaxed">
                      {t.triggerDescription}
                    </div>
                    {t.sourceQuote && (
                      <blockquote className="mt-1.5 text-xs text-muted-foreground border-l-2 border-border/60 pl-2 italic">
                        “{t.sourceQuote}”
                        {t.sourcePageHint && (
                          <span className="not-italic ml-1 text-muted-foreground/60">
                            ({t.sourcePageHint})
                          </span>
                        )}
                      </blockquote>
                    )}
                  </td>
                  <td className="py-2.5 px-3 align-top text-[11px]">
                    {t.humanReviewed ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-700">
                        Reviewed
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-50 text-amber-900 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-200">
                        Pending
                      </span>
                    )}
                    {t.commitmentLanguage && (
                      <span className="block mt-1 text-muted-foreground capitalize">
                        {t.commitmentLanguage}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Each row is grounded in a source quote from the framework document.
        “Pending” rows have not yet been spot-checked against the source — see
        the methodology page for review criteria.
      </p>
    </div>
  );
}
