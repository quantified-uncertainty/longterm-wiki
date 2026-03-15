/**
 * Funding Programs section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { titleCase } from "@/components/wiki/factbase/format";
import { formatCompactCurrency } from "@/lib/format-compact";
import { getRecordVerdict } from "@data/database";
import { VerificationBadge } from "@/components/directory/VerificationBadge";
import { PROGRAM_TYPE_LABELS, PROGRAM_TYPE_COLORS, DEFAULT_ORG_TYPE_COLOR } from "@/app/organizations/org-constants";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedFundingProgramRecord } from "./org-data";

/** Funding Programs section for org pages. */
export function FundingProgramsSection({
  programs,
}: {
  programs: ParsedFundingProgramRecord[];
}) {
  if (programs.length === 0) return null;

  const totalBudget = programs.reduce((sum, p) => sum + (p.totalBudget ?? 0), 0);

  return (
    <section>
      <SectionHeader title="Funding Programs" count={programs.length} />
      {totalBudget > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total budget tracked: {formatCompactCurrency(totalBudget)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2 px-3 font-medium">Program</th>
              <th scope="col" className="text-left py-2 px-3 font-medium">Type</th>
              <th scope="col" className="text-right py-2 px-3 font-medium">Budget</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">Status</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">Deadline</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {programs.map((p) => {
              const verdict = getRecordVerdict("funding-program", String(p.key));
              return (
                <tr key={p.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    <span className="font-medium text-foreground text-xs">
                      <Link
                        href={`/funding-programs/${p.key}`}
                        className="text-primary hover:underline"
                      >
                        {p.name}
                      </Link>
                    </span>
                    {p.source && (
                      <a
                        href={safeHref(p.source)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                      >
                        source
                      </a>
                    )}
                    <VerificationBadge verdict={verdict} />
                    {p.description && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                        {p.description}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                        PROGRAM_TYPE_COLORS[p.programType] ?? DEFAULT_ORG_TYPE_COLOR
                      }`}
                    >
                      {PROGRAM_TYPE_LABELS[p.programType] ?? p.programType}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                    {p.totalBudget != null && (
                      <span className="font-semibold">{formatCompactCurrency(p.totalBudget)}</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-center text-xs">
                    {p.status && (
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${
                          p.status === "open"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                            : p.status === "awarded"
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                              : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                        }`}
                      >
                        {titleCase(p.status)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                    {p.deadline ?? p.openDate ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
