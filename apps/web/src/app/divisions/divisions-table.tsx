"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { ProfileStatCard } from "@/components/directory/ProfileStatCard";
import { SourceCheckBadge } from "@/components/directory/SourceCheckBadge";
import type { RecordVerdict } from "@/data/tablebase";
import { titleCase } from "@/components/wiki/factbase/format";
import {
  DIVISION_TYPE_COLORS,
  DIVISION_TYPE_LABELS,
  STATUS_COLORS,
} from "./division-constants";

// ── Types ──────────────────────────────────────────────────────────────

export interface DivisionRow {
  key: string;
  name: string;
  parentName: string;
  parentHref: string | null;
  divisionType: string;
  status: string | null;
  href: string | null;
  /** Whether this division has meaningful data (personnel, grants, programs, lead, etc.) */
  hasData: boolean;
  /** Source-check verification verdict, if available */
  verdict: RecordVerdict | null;
}

export interface TypeSummary {
  type: string;
  label: string;
  count: number;
}

// ── Component ──────────────────────────────────────────────────────────

export function DivisionsTable({
  rows,
  typeSummary,
  totalDivisions,
  uniqueOrgs,
  divisionsWithData,
}: {
  rows: DivisionRow[];
  typeSummary: TypeSummary[];
  totalDivisions: number;
  uniqueOrgs: number;
  divisionsWithData: number;
}) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const filteredRows = useMemo(() => {
    let result = rows;

    // Filter by data presence (default: only show divisions with data)
    if (!showAll) {
      result = result.filter((r) => r.hasData);
    }

    // Filter by type
    if (selectedType) {
      result = result.filter((r) => r.divisionType === selectedType);
    }

    return result;
  }, [rows, selectedType, showAll]);

  // Recompute type counts based on current showAll filter
  const filteredTypeSummary = useMemo(() => {
    const base = showAll ? rows : rows.filter((r) => r.hasData);
    const typeCounts = new Map<string, number>();
    for (const r of base) {
      typeCounts.set(r.divisionType, (typeCounts.get(r.divisionType) ?? 0) + 1);
    }
    return [...typeCounts.entries()]
      .map(([type, count]) => ({
        type,
        label: DIVISION_TYPE_LABELS[type] ?? titleCase(type),
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [rows, showAll]);

  const stubCount = totalDivisions - divisionsWithData;

  // Compute stats
  const stats = [
    {
      label: "With Data",
      value: String(divisionsWithData),
    },
    { label: "Total", value: totalDivisions.toLocaleString() },
    { label: "Organizations", value: String(uniqueOrgs) },
    { label: "Types", value: String(filteredTypeSummary.length) },
  ];

  return (
    <>
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

      {/* By type filter badges */}
      {filteredTypeSummary.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">By Type</h2>
          <div className="flex gap-3 flex-wrap">
            {/* "All" badge */}
            <button
              type="button"
              aria-pressed={selectedType === null}
              onClick={() => setSelectedType(null)}
              className={`rounded-lg border px-4 py-2 flex items-center gap-2 transition-all cursor-pointer ${
                selectedType === null
                  ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                  : "border-border/60 hover:border-primary/30"
              }`}
            >
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                All
              </span>
              <span className="text-sm tabular-nums text-muted-foreground">
                {showAll ? rows.length : divisionsWithData}
              </span>
            </button>
            {filteredTypeSummary.map((t) => (
              <button
                type="button"
                key={t.type}
                aria-pressed={selectedType === t.type}
                onClick={() =>
                  setSelectedType(selectedType === t.type ? null : t.type)
                }
                className={`rounded-lg border px-4 py-2 flex items-center gap-2 transition-all cursor-pointer ${
                  selectedType === t.type
                    ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                    : "border-border/60 hover:border-primary/30"
                }`}
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
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Show all toggle */}
      {stubCount > 0 && (
        <div className="mb-4 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={showAll}
              onChange={() => setShowAll(!showAll)}
              className="rounded border-border"
            />
            Show {stubCount} stub{stubCount !== 1 ? "s" : ""} without data
          </label>
          <span className="text-xs text-muted-foreground/60">
            Showing {filteredRows.length} of {totalDivisions} divisions
          </span>
        </div>
      )}

      {/* Table */}
      {filteredRows.length > 0 ? (
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
                <th className="text-center py-2.5 px-3 font-medium">Verified</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {filteredRows.map((row) => (
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
                  <td className="py-2 px-3 text-center">
                    <SourceCheckBadge verdict={row.verdict} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No matching divisions</p>
          <p className="text-sm">
            {selectedType
              ? "Try selecting a different type filter."
              : "No divisions with data found."}
          </p>
        </div>
      )}
    </>
  );
}
