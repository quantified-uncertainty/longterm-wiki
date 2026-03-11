"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

export interface OrgRow {
  id: string;
  slug: string | null;
  name: string;
  numericId: string | null;
  orgType: string | null;
  wikiPageId: string | null;

  revenue: string | null;
  revenueNum: number | null;
  revenueDate: string | null;

  valuation: string | null;
  valuationNum: number | null;
  valuationDate: string | null;

  headcount: number | null;
  headcountDate: string | null;

  totalFunding: string | null;
  totalFundingNum: number | null;

  foundedDate: string | null;
  fundingRoundsCount: number;
  keyPeopleCount: number;
}

const ORG_TYPE_LABELS: Record<string, string> = {
  "frontier-lab": "Frontier Lab",
  "safety-org": "Safety Org",
  academic: "Academic",
  startup: "Startup",
  generic: "Lab",
  funder: "Funder",
  government: "Government",
  other: "Other",
};

const ORG_TYPE_COLORS: Record<string, string> = {
  "frontier-lab": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "safety-org": "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  academic: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  startup: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  generic: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  funder: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  government: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
};

type SortKey =
  | "name"
  | "orgType"
  | "revenue"
  | "valuation"
  | "headcount"
  | "totalFunding"
  | "founded"
  | "fundingRounds"
  | "keyPeople";

type SortDir = "asc" | "desc";

function formatCompactNumber(n: number | null): string {
  if (n == null) return "";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

function formatHeadcount(n: number | null): string {
  if (n == null) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

function DateHint({ date }: { date: string | null }) {
  if (!date) return null;
  const parts = date.split("-");
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const label = parts.length >= 2
    ? `${MONTHS[parseInt(parts[1], 10) - 1]} ${parts[0]}`
    : date;
  return (
    <span className="text-[10px] text-muted-foreground/50 ml-1">
      {label}
    </span>
  );
}

function SortHeader({
  label,
  sortKey,
  currentSort,
  currentDir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  currentSort: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = currentSort === sortKey;
  const ariaSort = isActive
    ? currentDir === "asc"
      ? ("ascending" as const)
      : ("descending" as const)
    : ("none" as const);

  return (
    <th
      className={`py-2.5 px-3 font-medium ${className ?? ""}`}
      aria-sort={ariaSort}
    >
      <button
        type="button"
        className={`inline-flex items-center gap-1 cursor-pointer select-none hover:text-foreground transition-colors ${
          isActive ? "text-foreground" : ""
        }`}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {isActive && (
          <span className="text-[10px]">
            {currentDir === "asc" ? "\u25B2" : "\u25BC"}
          </span>
        )}
      </button>
    </th>
  );
}

export function OrganizationsTable({ rows }: { rows: OrgRow[] }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Collect unique org types for filter
  const orgTypes = useMemo(() => {
    const types = new Set<string>();
    for (const r of rows) {
      if (r.orgType) types.add(r.orgType);
    }
    return [...types].sort();
  }, [rows]);

  // Count by type for badges
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      const t = r.orgType ?? "unknown";
      counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (typeFilter !== "all") {
      result = result.filter((r) => r.orgType === typeFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) => r.name.toLowerCase().includes(q));
    }

    const dir = sortDir === "asc" ? 1 : -1;
    result = [...result].sort((a, b) => {
      const getValue = (row: OrgRow): string | number | null => {
        switch (sortKey) {
          case "name": return row.name.toLowerCase();
          case "orgType": return row.orgType ?? "";
          case "revenue": return row.revenueNum;
          case "valuation": return row.valuationNum;
          case "headcount": return row.headcount;
          case "totalFunding": return row.totalFundingNum;
          case "founded": return row.foundedDate;
          case "fundingRounds": return row.fundingRoundsCount;
          case "keyPeople": return row.keyPeopleCount;
        }
      };

      const va = getValue(a);
      const vb = getValue(b);

      // Nulls sort last regardless of direction
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;

      if (typeof va === "string" && typeof vb === "string") {
        return va.localeCompare(vb) * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });

    return result;
  }, [rows, search, typeFilter, sortKey, sortDir]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search organizations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setTypeFilter("all")}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
              typeFilter === "all"
                ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
            }`}
          >
            All
            <span className="ml-1 text-[10px] opacity-60">{typeCounts.all}</span>
          </button>
          {orgTypes.map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(typeFilter === t ? "all" : t)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                typeFilter === t
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              {ORG_TYPE_LABELS[t] ?? t}
              <span className="ml-1 text-[10px] opacity-60">
                {typeCounts[t] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Results count */}
      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} organizations
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <SortHeader label="Organization" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Type" sortKey="orgType" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Revenue" sortKey="revenue" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Valuation" sortKey="valuation" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Headcount" sortKey="headcount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Total Funding" sortKey="totalFunding" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Founded" sortKey="founded" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              <SortHeader label="Rounds" sortKey="fundingRounds" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              <SortHeader label="People" sortKey="keyPeople" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {filtered.map((row) => (
              <tr
                key={row.id}
                className="hover:bg-muted/20 transition-colors"
              >
                {/* Name */}
                <td className="py-2.5 px-3">
                  {row.slug ? (
                    <Link
                      href={`/organizations/${row.slug}`}
                      className="font-medium text-foreground hover:text-primary transition-colors"
                    >
                      {row.name}
                    </Link>
                  ) : (
                    <span className="font-medium text-foreground">{row.name}</span>
                  )}
                  {row.wikiPageId && (
                    <Link
                      href={`/wiki/${row.wikiPageId}`}
                      className="ml-2 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                      title="Wiki page"
                    >
                      wiki
                    </Link>
                  )}
                </td>

                {/* Type */}
                <td className="py-2.5 px-3">
                  {row.orgType && (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        ORG_TYPE_COLORS[row.orgType] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {ORG_TYPE_LABELS[row.orgType] ?? row.orgType}
                    </span>
                  )}
                </td>

                {/* Revenue */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.revenueNum != null && (
                    <>
                      <span className="font-semibold">{formatCompactNumber(row.revenueNum)}</span>
                      <DateHint date={row.revenueDate} />
                    </>
                  )}
                </td>

                {/* Valuation */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.valuationNum != null && (
                    <>
                      <span className="font-semibold">{formatCompactNumber(row.valuationNum)}</span>
                      <DateHint date={row.valuationDate} />
                    </>
                  )}
                </td>

                {/* Headcount */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.headcount != null && (
                    <>
                      <span>{formatHeadcount(row.headcount)}</span>
                      <DateHint date={row.headcountDate} />
                    </>
                  )}
                </td>

                {/* Total Funding */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.totalFundingNum != null && (
                    <span className="font-semibold">{formatCompactNumber(row.totalFundingNum)}</span>
                  )}
                </td>

                {/* Founded */}
                <td className="py-2.5 px-3 text-center text-muted-foreground">
                  {row.foundedDate ?? ""}
                </td>

                {/* Funding Rounds */}
                <td className="py-2.5 px-3 text-center">
                  {row.fundingRoundsCount > 0 && (
                    <span className="tabular-nums">{row.fundingRoundsCount}</span>
                  )}
                </td>

                {/* Key People */}
                <td className="py-2.5 px-3 text-center">
                  {row.keyPeopleCount > 0 && (
                    <span className="tabular-nums">{row.keyPeopleCount}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No organizations match your search.
        </div>
      )}
    </div>
  );
}
