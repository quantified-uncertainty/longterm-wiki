import Link from "next/link";
import {
  RISK_DOMAIN_LABELS,
  RISK_DOMAIN_SHORT_LABELS,
  tierColor,
  type CanonicalRiskDomain,
} from "../risk-domain-constants";
import type { ThresholdRow, FrameworkVersionRow } from "../frameworks-data";
import { rowsToCellsForVersion, activeDomains } from "../matrix-aggregation";

interface LatestVersionTabProps {
  version: FrameworkVersionRow | null;
  thresholds: ThresholdRow[];
}

export function LatestVersionTab({ version, thresholds }: LatestVersionTabProps) {
  if (!version) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground space-y-2">
        <p className="font-medium text-foreground">
          No published version yet.
        </p>
        <p>
          The framework has been registered but no version has reached
          published status. Pending versions appear under{" "}
          <span className="font-medium">Version History</span>.
        </p>
      </div>
    );
  }

  const cells = rowsToCellsForVersion(thresholds);
  const domains = activeDomains([cells]) as CanonicalRiskDomain[];
  const reviewedCount = thresholds.filter((t) => t.humanReviewed).length;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border/60 bg-card p-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
          <h2 className="text-xl font-semibold">{version.versionLabel}</h2>
          {version.publishedDate && (
            <span className="text-sm text-muted-foreground tabular-nums">
              published {version.publishedDate}
            </span>
          )}
        </div>
        {version.summary && (
          <p className="text-sm text-foreground/90 leading-relaxed mb-3 max-w-3xl">
            {version.summary}
          </p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <a
            href={version.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Read source ↗
          </a>
          {version.waybackSnapshotUrl && (
            <a
              href={version.waybackSnapshotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Wayback ↗
            </a>
          )}
          {version.pdfArchiveUrl && (
            <a
              href={version.pdfArchiveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              PDF ↗
            </a>
          )}
        </div>
      </div>

      {domains.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">
            Capability domains at a glance
          </h3>
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-xs text-muted-foreground">
                  <th className="text-left py-2 px-3 font-semibold">Domain</th>
                  {domains.map((d) => (
                    <th
                      key={d}
                      className="text-center py-2 px-2 font-semibold whitespace-nowrap"
                      title={RISK_DOMAIN_LABELS[d]}
                    >
                      {RISK_DOMAIN_SHORT_LABELS[d]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="py-2.5 px-3 text-xs text-muted-foreground italic">
                    Most-severe tier
                  </td>
                  {domains.map((d) => {
                    const cell = cells[d];
                    if (!cell) {
                      return (
                        <td key={d} className="py-2 px-2 text-center text-[11px] text-muted-foreground/40">
                          —
                        </td>
                      );
                    }
                    const styles = tierColor(cell.tierSortOrder);
                    return (
                      <td key={d} className="py-2 px-2 text-center">
                        <span
                          className={`inline-block min-w-[3rem] rounded px-1.5 py-0.5 text-[11px] font-semibold border ${styles.bg} ${styles.text} ${styles.border}`}
                          title={cell.reviewed ? "" : "Pending review"}
                        >
                          {cell.tierLabel}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            See the <Link href="#threshold-matrix" className="underline">Threshold Matrix tab</Link> for trigger language and source quotes.
          </p>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        {thresholds.length} threshold{thresholds.length === 1 ? "" : "s"} extracted ·
        {reviewedCount} human-reviewed.
      </p>
    </div>
  );
}
