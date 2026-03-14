/**
 * Divisions section for organization profile pages.
 * Shows org subdivisions with optional team lead resolution to person links.
 */
import Link from "next/link";
import { titleCase, formatKBDate } from "@/components/wiki/kb/format";
import { formatCompactCurrency } from "@/lib/format-compact";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedDivisionRecord } from "./org-data";
import { getDivisionHref } from "@/app/divisions/[slug]/division-data";

type LeadMap = Map<string, { name: string; href: string | null }>;

const DIVISION_TYPE_LABELS: Record<string, string> = {
  fund: "Fund",
  team: "Team",
  department: "Dept",
  lab: "Lab",
  "program-area": "Program",
};

const DIVISION_TYPE_COLORS: Record<string, string> = {
  fund: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  team: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  department: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  lab: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "program-area": "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

/** Left-border accent color per division type (solid Tailwind border colors). */
const DIVISION_ACCENT_BORDER: Record<string, string> = {
  fund: "border-l-emerald-400 dark:border-l-emerald-600",
  team: "border-l-blue-400 dark:border-l-blue-600",
  department: "border-l-purple-400 dark:border-l-purple-600",
  lab: "border-l-orange-400 dark:border-l-orange-600",
  "program-area": "border-l-cyan-400 dark:border-l-cyan-600",
};

/** Compact divisions overview for the Overview tab. */
export function DivisionsOverview({
  divisions,
  leadResolved,
}: {
  divisions: ParsedDivisionRecord[];
  leadResolved?: LeadMap;
}) {
  if (divisions.length === 0) return null;

  // Show active divisions first, then inactive
  const active = divisions.filter((d) => d.status === "active" || !d.status);
  const inactive = divisions.filter((d) => d.status && d.status !== "active");

  return (
    <section>
      <SectionHeader title="Divisions" count={divisions.length} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {active.map((d) => (
          <DivisionCard key={d.key} division={d} leadResolved={leadResolved} />
        ))}
      </div>
      {inactive.length > 0 && (
        <details className="mt-3 group">
          <summary className="text-xs text-muted-foreground/60 cursor-pointer hover:text-muted-foreground transition-colors select-none">
            {inactive.length} inactive {inactive.length === 1 ? "division" : "divisions"}
          </summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-2 opacity-60">
            {inactive.map((d) => (
              <DivisionCard key={d.key} division={d} leadResolved={leadResolved} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function DivisionCard({
  division: d,
  leadResolved,
}: {
  division: ParsedDivisionRecord;
  leadResolved?: LeadMap;
}) {
  const resolvedLead = leadResolved?.get(d.key);
  const leadDisplay = resolvedLead?.name ?? d.lead;
  const accentBorder = DIVISION_ACCENT_BORDER[d.divisionType] ?? "border-l-gray-300 dark:border-l-gray-600";

  const inner = (
    <div
      className={`border border-border/50 border-l-[3px] ${accentBorder} rounded-md px-3 py-2 hover:bg-muted/40 hover:border-border transition-all group/card`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-[13px] text-foreground truncate leading-tight">
          {d.name}
        </span>
        {getDivisionHref(d) && (
          <svg
            className="shrink-0 w-3.5 h-3.5 text-muted-foreground/30 group-hover/card:text-muted-foreground/60 transition-colors"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        )}
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
          {DIVISION_TYPE_LABELS[d.divisionType] ?? d.divisionType}
        </span>
        {leadDisplay && (
          <>
            <span className="text-muted-foreground/30">&middot;</span>
            <span className="text-xs text-muted-foreground truncate">
              {leadDisplay}
            </span>
          </>
        )}
      </div>
    </div>
  );

  const divHref = getDivisionHref(d);
  return divHref ? (
    <Link href={divHref} className="block">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}

type SpendingMap = Map<string, { totalAmount: number; grantCount: number }>;

/** Divisions section for org pages. */
export function DivisionsSection({
  divisions,
  leadResolved,
  spending,
}: {
  divisions: ParsedDivisionRecord[];
  leadResolved?: LeadMap;
  spending?: SpendingMap;
}) {
  if (divisions.length === 0) return null;

  // Group by type: departments first, then teams
  const departments = divisions.filter((d) => d.divisionType === "department");
  const teams = divisions.filter((d) => d.divisionType === "team");
  const other = divisions.filter((d) => d.divisionType !== "department" && d.divisionType !== "team");
  const grouped = [...departments, ...teams, ...other];

  const hasSpending = spending && spending.size > 0;

  return (
    <section>
      <SectionHeader title="Divisions & Teams" count={divisions.length} />
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2.5 px-3 font-medium">Name</th>
              <th scope="col" className="text-left py-2.5 px-3 font-medium">Type</th>
              <th scope="col" className="text-left py-2.5 px-3 font-medium">Lead</th>
              {hasSpending && (
                <th scope="col" className="text-right py-2.5 px-3 font-medium">Total Spending</th>
              )}
              {hasSpending && (
                <th scope="col" className="text-center py-2.5 px-3 font-medium">Grants</th>
              )}
              <th scope="col" className="text-center py-2.5 px-3 font-medium">Status</th>
              <th scope="col" className="text-center py-2.5 px-3 font-medium">Since</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grouped.map((d) => {
              const resolvedLead = leadResolved?.get(d.key);
              const stats = spending?.get(d.key);
              return (
                <tr key={d.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2.5 px-3">
                    <span className="font-medium text-foreground text-xs">
                      {(() => {
                        const href = getDivisionHref(d);
                        return href ? (
                          <Link
                            href={href}
                            className="text-primary hover:underline"
                          >
                            {d.name}
                          </Link>
                        ) : (
                          d.name
                        );
                      })()}
                    </span>
                    {d.source && (
                      <a
                        href={safeHref(d.source)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                      >
                        source
                      </a>
                    )}
                  </td>
                  <td className="py-2.5 px-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                        DIVISION_TYPE_COLORS[d.divisionType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {DIVISION_TYPE_LABELS[d.divisionType] ?? d.divisionType}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-xs text-muted-foreground">
                    {resolvedLead ? (
                      resolvedLead.href ? (
                        <Link
                          href={resolvedLead.href}
                          className="text-primary hover:underline"
                        >
                          {resolvedLead.name}
                        </Link>
                      ) : (
                        resolvedLead.name
                      )
                    ) : (
                      d.lead ?? ""
                    )}
                  </td>
                  {hasSpending && (
                    <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                      {stats && stats.totalAmount > 0 && (
                        <span className="font-semibold">
                          {formatCompactCurrency(stats.totalAmount)}
                        </span>
                      )}
                    </td>
                  )}
                  {hasSpending && (
                    <td className="py-2.5 px-3 text-center tabular-nums text-xs text-muted-foreground">
                      {stats ? stats.grantCount : ""}
                    </td>
                  )}
                  <td className="py-2.5 px-3 text-center text-xs">
                    {d.status && (
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${
                          d.status === "active"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                            : d.status === "inactive"
                              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                              : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                        }`}
                      >
                        {titleCase(d.status)}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-center text-muted-foreground text-xs">
                    {d.startDate && formatKBDate(d.startDate)}
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
