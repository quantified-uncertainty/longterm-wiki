/**
 * Divisions section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { titleCase, formatKBDate } from "@/components/wiki/kb/format";
import { getRecordVerdict } from "@data/database";
import { VerificationBadge } from "@/components/directory/VerificationBadge";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedDivisionRecord } from "./org-data";

const DIVISION_TYPE_LABELS: Record<string, string> = {
  fund: "Fund",
  team: "Team",
  department: "Department",
  lab: "Lab",
  "program-area": "Program Area",
};

const DIVISION_TYPE_COLORS: Record<string, string> = {
  fund: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  team: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  department: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  lab: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "program-area": "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

/** Divisions section for org pages. */
export function DivisionsSection({
  divisions,
}: {
  divisions: ParsedDivisionRecord[];
}) {
  if (divisions.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Divisions" count={divisions.length} />
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2 px-3 font-medium">Name</th>
              <th scope="col" className="text-left py-2 px-3 font-medium">Type</th>
              <th scope="col" className="text-left py-2 px-3 font-medium">Lead</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">Status</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">Dates</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {divisions.map((d) => {
              const verdict = getRecordVerdict("division", String(d.key));
              return (
                <tr key={d.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    <span className="font-medium text-foreground text-xs">
                      {d.slug ? (
                        <Link
                          href={`/divisions/${d.slug}`}
                          className="text-primary hover:underline"
                        >
                          {d.name}
                        </Link>
                      ) : (
                        d.name
                      )}
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
                    <VerificationBadge verdict={verdict} />
                  </td>
                  <td className="py-2 px-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                        DIVISION_TYPE_COLORS[d.divisionType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {DIVISION_TYPE_LABELS[d.divisionType] ?? d.divisionType}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {d.lead ?? ""}
                  </td>
                  <td className="py-2 px-3 text-center text-xs">
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
                  <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                    {d.startDate && (
                      <span>
                        {formatKBDate(d.startDate)}
                        {d.endDate ? ` \u2013 ${formatKBDate(d.endDate)}` : " \u2013 present"}
                      </span>
                    )}
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
