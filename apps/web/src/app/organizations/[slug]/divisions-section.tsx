/**
 * Divisions section for organization profile pages.
 * Shows org subdivisions with optional team lead resolution to person links.
 */
import Link from "next/link";
import { titleCase, formatKBDate } from "@/components/wiki/kb/format";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedDivisionRecord } from "./org-data";

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

/** Divisions section for org pages. */
export function DivisionsSection({
  divisions,
  leadResolved,
}: {
  divisions: ParsedDivisionRecord[];
  leadResolved?: Map<string, { name: string; href: string | null }>;
}) {
  if (divisions.length === 0) return null;

  // Group by type: departments first, then teams
  const departments = divisions.filter((d) => d.divisionType === "department");
  const teams = divisions.filter((d) => d.divisionType === "team");
  const other = divisions.filter((d) => d.divisionType !== "department" && d.divisionType !== "team");
  const grouped = [...departments, ...teams, ...other];

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
              <th scope="col" className="text-center py-2.5 px-3 font-medium">Status</th>
              <th scope="col" className="text-center py-2.5 px-3 font-medium">Since</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grouped.map((d) => {
              const resolvedLead = leadResolved?.get(d.key);
              return (
                <tr key={d.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2.5 px-3">
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
