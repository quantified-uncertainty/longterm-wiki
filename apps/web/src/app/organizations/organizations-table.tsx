"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import type { SortDir } from "@/lib/sort-utils";
import { compareOrgRows } from "@/app/organizations/org-sort";
import type { OrgSortKey } from "@/app/organizations/org-sort";
import { ORG_TYPE_LABELS, ORG_TYPE_COLORS } from "@/app/organizations/org-constants";

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

  /** Pre-computed lowercase text blob for full-text search across all fields */
  searchText: string;
}

type SortKey = OrgSortKey;

function formatCompactNumber(n: number | null): string {
  if (n == null) return "";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e10) return `$${(n / 1e9).toFixed(0)}B`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e7) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
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

export type StatFilterKey = "all" | "withRevenue" | "withValuation" | "withHeadcount";

export interface OrgStatDef {
  key: StatFilterKey;
  label: string;
  value: string;
}

export function OrganizationsTable({ rows, stats }: { rows: OrgRow[]; stats?: OrgStatDef[] }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statFilter, setStatFilter] = useState<StatFilterKey>("all");
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

    if (statFilter !== "all") {
      switch (statFilter) {
        case "withRevenue":
          result = result.filter((r) => r.revenueNum != null);
          break;
        case "withValuation":
          result = result.filter((r) => r.valuationNum != null);
          break;
        case "withHeadcount":
          result = result.filter((r) => r.headcount != null);
          break;
      }
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) => r.searchText.includes(q));
    }

    result = [...result].sort((a, b) =>
      compareOrgRows(a, b, sortKey, sortDir),
    );

    return result;
  }, [rows, search, typeFilter, statFilter, sortKey, sortDir]);

  return (
    <div>
      {/* Clickable stat cards */}
      {stats && stats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          {stats.map((stat) => (
            <button
              key={stat.key}
              type="button"
              onClick={() => setStatFilter(statFilter === stat.key ? "all" : stat.key)}
              className={`rounded-xl border p-4 text-left transition-all ${
                statFilter === stat.key
                  ? "border-primary/50 bg-primary/5 ring-2 ring-primary/20 shadow-sm"
                  : "border-border/60 bg-gradient-to-br from-card to-muted/30 hover:border-primary/30 hover:shadow-md"
              }`}
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5">
                {stat.label}
              </div>
              <div className="text-xl font-bold tabular-nums tracking-tight">
                {stat.value}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search name, type, people, funding programs, description..."
          aria-label="Search organizations"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-96"
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setTypeFilter("all")}
            aria-pressed={typeFilter === "all"}
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
              aria-pressed={typeFilter === t}
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
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader label="Organization" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Type" sortKey="orgType" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Revenue" sortKey="revenue" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Valuation" sortKey="valuation" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Headcount" sortKey="headcount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Total Funding" sortKey="totalFunding" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Founded" sortKey="founded" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
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
                      className="ml-2 text-xs text-muted-foreground hover:text-primary transition-colors"
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
                        ORG_TYPE_COLORS[row.orgType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {ORG_TYPE_LABELS[row.orgType] ?? row.orgType}
                    </span>
                  )}
                </td>

                {/* Revenue */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.revenueNum != null ? (
                    <>
                      <span className="font-semibold">{formatCompactNumber(row.revenueNum)}</span>
                      <DateHint date={row.revenueDate} />
                    </>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>

                {/* Valuation */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.valuationNum != null ? (
                    <>
                      <span className="font-semibold">{formatCompactNumber(row.valuationNum)}</span>
                      <DateHint date={row.valuationDate} />
                    </>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>

                {/* Headcount */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.headcount != null ? (
                    <>
                      <span>{formatHeadcount(row.headcount)}</span>
                      <DateHint date={row.headcountDate} />
                    </>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>

                {/* Total Funding */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.totalFundingNum != null ? (
                    <span className="font-semibold">{formatCompactNumber(row.totalFundingNum)}</span>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>

                {/* Founded */}
                <td className="py-2.5 px-3 text-center text-muted-foreground">
                  {row.foundedDate ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
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
