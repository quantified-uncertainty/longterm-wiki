import Link from "next/link";
import {
  RISK_DOMAIN_LABELS,
  RISK_DOMAIN_SHORT_LABELS,
  tierColor,
  type CanonicalRiskDomain,
} from "./risk-domain-constants";
import type { MatrixCell } from "./matrix-aggregation";
import type { FrameworkRow, FrameworkVersionRow } from "./frameworks-data";
import { frameworkSlug } from "./frameworks-data";

export interface MatrixRow {
  framework: FrameworkRow;
  /** Latest published version (if any). */
  latestVersion: FrameworkVersionRow | null;
  /** Aggregated cells per canonical domain for the latest published version. */
  cells: Partial<Record<CanonicalRiskDomain, MatrixCell>>;
}

export interface MatrixViewProps {
  rows: MatrixRow[];
  domains: CanonicalRiskDomain[];
}

export function MatrixView({ rows, domains }: MatrixViewProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
        No frameworks ingested yet.
      </div>
    );
  }
  if (domains.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
        Frameworks are registered but no published thresholds exist yet — the
        matrix will populate once published versions land. See the methodology
        page for context.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm border-separate border-spacing-0">
        <thead>
          <tr className="bg-muted/40">
            <th className="text-left text-xs font-semibold text-muted-foreground py-2.5 px-3 sticky left-0 bg-muted/40 border-b border-border/60">
              Framework
            </th>
            <th className="text-left text-xs font-semibold text-muted-foreground py-2.5 px-3 border-b border-border/60">
              Latest version
            </th>
            {domains.map((d) => (
              <th
                key={d}
                className="text-center text-[11px] font-semibold text-muted-foreground py-2.5 px-2 border-b border-border/60 whitespace-nowrap"
                title={RISK_DOMAIN_LABELS[d]}
              >
                {RISK_DOMAIN_SHORT_LABELS[d]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {rows.map(({ framework, latestVersion, cells }) => {
            const slug = frameworkSlug(framework);
            const cellCount = Object.keys(cells).length;
            return (
              <tr key={framework.id} className="hover:bg-muted/15 transition-colors">
                <td className="py-2.5 px-3 align-top sticky left-0 bg-background hover:bg-muted/15">
                  <Link
                    href={`/frontier-safety-frameworks/${slug}`}
                    className="text-foreground hover:text-primary font-medium block"
                  >
                    {framework.shortName ?? framework.name}
                  </Link>
                  <span className="text-[11px] text-muted-foreground block">
                    {framework.org.displayName}
                  </span>
                </td>
                <td className="py-2.5 px-3 align-top text-xs text-muted-foreground">
                  {latestVersion ? (
                    <>
                      <span className="font-medium text-foreground/80">
                        {latestVersion.versionLabel}
                      </span>
                      {latestVersion.publishedDate && (
                        <span className="block text-[11px]">
                          {latestVersion.publishedDate}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="italic">no published version</span>
                  )}
                </td>
                {domains.map((d) => {
                  const cell = cells[d];
                  if (!cell) {
                    return (
                      <td
                        key={d}
                        className="py-2 px-2 text-center text-[11px] text-muted-foreground/50"
                        title={`${RISK_DOMAIN_LABELS[d]} — no threshold defined`}
                      >
                        —
                      </td>
                    );
                  }
                  const styles = tierColor(cell.tierSortOrder);
                  return (
                    <td
                      key={d}
                      className="py-2 px-2 text-center"
                      title={`${RISK_DOMAIN_LABELS[d]} — ${cell.tierLabel}${
                        cell.count > 1 ? ` (${cell.count} thresholds)` : ""
                      }${cell.reviewed ? "" : " — pending review"}`}
                    >
                      <span
                        className={`inline-block min-w-[3.5rem] rounded px-1.5 py-0.5 text-[11px] font-semibold border ${styles.bg} ${styles.text} ${styles.border}`}
                      >
                        {cell.tierLabel}
                      </span>
                    </td>
                  );
                })}
                {cellCount === 0 && (
                  <td colSpan={Math.max(0, domains.length - 1)} />
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
