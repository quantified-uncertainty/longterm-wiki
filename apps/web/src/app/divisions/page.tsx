import type { Metadata } from "next";
import Link from "next/link";
import { getAllKBRecords } from "@/data/factbase";
import { ProfileStatCard } from "@/components/directory";
import {
  parseDivision,
  resolveEntityLink,
  getDivisionHref,
  DIVISION_TYPE_LABELS,
  DIVISION_TYPE_COLORS,
  STATUS_COLORS,
} from "./[slug]/division-data";
import { titleCase } from "@/components/wiki/factbase/format";

export const metadata: Metadata = {
  title: "Divisions",
  description:
    "Directory of organizational divisions, teams, departments, and program areas tracked in the knowledge base.",
};

interface DivisionRow {
  key: string;
  name: string;
  parentName: string;
  parentHref: string | null;
  divisionType: string;
  status: string | null;
  lead: string | null;
  leadName: string;
  leadHref: string | null;
  href: string | null;
}

export default function DivisionsPage() {
  const allRecords = getAllKBRecords("divisions");

  // Deduplicate by owner+name (same logic as division-data.ts)
  const seen = new Map<string, DivisionRow>();
  for (const record of allRecords) {
    const division = parseDivision(record);
    const mapKey = `${division.ownerEntityId}::${division.name}`;
    if (seen.has(mapKey)) continue;

    const parent = resolveEntityLink(division.ownerEntityId);
    const href = getDivisionHref(division);

    let leadName = "";
    let leadHref: string | null = null;
    if (division.lead) {
      const resolved = resolveEntityLink(division.lead);
      leadName = resolved.name;
      leadHref = resolved.href;
    }

    seen.set(mapKey, {
      key: division.key,
      name: division.name,
      parentName: parent.name,
      parentHref: parent.href,
      divisionType: division.divisionType,
      status: division.status,
      lead: division.lead,
      leadName,
      leadHref,
      href,
    });
  }

  const rows = [...seen.values()].sort(
    (a, b) =>
      a.parentName.localeCompare(b.parentName) ||
      a.name.localeCompare(b.name),
  );

  // Summary stats
  const totalDivisions = rows.length;
  const uniqueOrgs = new Set(rows.map((r) => r.parentName)).size;
  const activeCount = rows.filter((r) => r.status === "active").length;

  // Type breakdown
  const typeCounts = new Map<string, number>();
  for (const r of rows) {
    typeCounts.set(r.divisionType, (typeCounts.get(r.divisionType) ?? 0) + 1);
  }
  const typeSummary = [...typeCounts.entries()]
    .map(([type, count]) => ({
      type,
      label: DIVISION_TYPE_LABELS[type] ?? titleCase(type),
      count,
    }))
    .sort((a, b) => b.count - a.count);

  const stats = [
    { label: "Divisions", value: totalDivisions.toLocaleString() },
    { label: "Organizations", value: String(uniqueOrgs) },
    { label: "Active", value: String(activeCount) },
    { label: "Types", value: String(typeCounts.size) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Divisions
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of organizational divisions, teams, departments, and program
          areas tracked in the knowledge base.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      {/* By type summary */}
      {typeSummary.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">By Type</h2>
          <div className="flex gap-3 flex-wrap">
            {typeSummary.map((t) => (
              <div
                key={t.type}
                className="rounded-lg border border-border/60 px-4 py-2 flex items-center gap-2"
              >
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                    DIVISION_TYPE_COLORS[t.type] ??
                    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                  }`}
                >
                  {t.label}
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {t.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      {totalDivisions > 0 ? (
        <div className="border border-border/60 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                <th className="text-left py-2.5 px-3 font-medium">Division</th>
                <th className="text-left py-2.5 px-3 font-medium">
                  Organization
                </th>
                <th className="text-left py-2.5 px-3 font-medium">Type</th>
                <th className="text-left py-2.5 px-3 font-medium">Status</th>
                <th className="text-left py-2.5 px-3 font-medium">Lead</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className="hover:bg-muted/20 transition-colors"
                >
                  <td className="py-2 px-3">
                    {row.href ? (
                      <Link
                        href={row.href}
                        className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                      >
                        {row.name}
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground text-xs">
                        {row.name}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {row.parentHref ? (
                      <Link
                        href={row.parentHref}
                        className="text-primary hover:underline"
                      >
                        {row.parentName}
                      </Link>
                    ) : (
                      <span className="text-foreground">{row.parentName}</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        DIVISION_TYPE_COLORS[row.divisionType] ??
                        "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {DIVISION_TYPE_LABELS[row.divisionType] ??
                        titleCase(row.divisionType)}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {row.status && (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          STATUS_COLORS[row.status] ??
                          "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                        }`}
                      >
                        {titleCase(row.status)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {row.leadHref ? (
                      <Link
                        href={row.leadHref}
                        className="text-primary hover:underline"
                      >
                        {row.leadName}
                      </Link>
                    ) : row.leadName ? (
                      <span className="text-muted-foreground">
                        {row.leadName}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No divisions available</p>
          <p className="text-sm">
            Division data is loaded from the knowledge base during the build
            process.
          </p>
        </div>
      )}
    </div>
  );
}
