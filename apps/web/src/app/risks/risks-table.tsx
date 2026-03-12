"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";

export interface RiskRow {
  id: string;
  slug: string | null;
  name: string;
  numericId: string | null;
  wikiPageId: string | null;
  riskCategory: string | null;
  severity: string | null;
  likelihood: string | null;
  timeHorizon: string | null;
}

const RISK_CATEGORY_LABELS: Record<string, string> = {
  accident: "Accident",
  misuse: "Misuse",
  structural: "Structural",
  epistemic: "Epistemic",
};

const RISK_CATEGORY_COLORS: Record<string, string> = {
  accident: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  misuse: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  structural: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  epistemic: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

type SortKey = "name" | "category" | "severity" | "likelihood" | "timeHorizon";
type SortDir = "asc" | "desc";

const SEVERITY_ORDER: Record<string, number> = {
  low: 1,
  medium: 2,
  "medium-high": 3,
  high: 4,
  critical: 5,
  catastrophic: 6,
};

export function RisksTable({ rows }: { rows: RiskRow[] }) {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Collect unique categories for filter
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const r of rows) {
      if (r.riskCategory) cats.add(r.riskCategory);
    }
    return [...cats].sort();
  }, [rows]);

  // Count by category for badges
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      const c = r.riskCategory ?? "unknown";
      counts[c] = (counts[c] ?? 0) + 1;
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

    if (categoryFilter !== "all") {
      result = result.filter((r) => r.riskCategory === categoryFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) => r.name.toLowerCase().includes(q));
    }

    const dir = sortDir === "asc" ? 1 : -1;
    result = [...result].sort((a, b) => {
      const getValue = (row: RiskRow): string | number | null => {
        switch (sortKey) {
          case "name":
            return row.name.toLowerCase();
          case "category":
            return row.riskCategory ?? "";
          case "severity":
            return row.severity ? (SEVERITY_ORDER[row.severity] ?? 0) : null;
          case "likelihood":
            return row.likelihood ?? null;
          case "timeHorizon":
            return row.timeHorizon ?? null;
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
  }, [rows, search, categoryFilter, sortKey, sortDir]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search risks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setCategoryFilter("all")}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
              categoryFilter === "all"
                ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
            }`}
          >
            All
            <span className="ml-1 text-[10px] opacity-60">{categoryCounts.all}</span>
          </button>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategoryFilter(categoryFilter === c ? "all" : c)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                categoryFilter === c
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              {RISK_CATEGORY_LABELS[c] ?? c}
              <span className="ml-1 text-[10px] opacity-60">
                {categoryCounts[c] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Results count */}
      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} risks
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <SortHeader label="Risk" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Category" sortKey="category" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Severity" sortKey="severity" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Likelihood" sortKey="likelihood" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Time Horizon" sortKey="timeHorizon" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
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
                      href={`/risks/${row.slug}`}
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

                {/* Category */}
                <td className="py-2.5 px-3">
                  {row.riskCategory && (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        RISK_CATEGORY_COLORS[row.riskCategory] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {RISK_CATEGORY_LABELS[row.riskCategory] ?? row.riskCategory}
                    </span>
                  )}
                </td>

                {/* Severity */}
                <td className="py-2.5 px-3 text-sm capitalize">
                  {row.severity ?? <span className="text-muted-foreground/40">&mdash;</span>}
                </td>

                {/* Likelihood */}
                <td className="py-2.5 px-3 text-sm capitalize">
                  {row.likelihood ?? <span className="text-muted-foreground/40">&mdash;</span>}
                </td>

                {/* Time Horizon */}
                <td className="py-2.5 px-3 text-sm">
                  {row.timeHorizon ?? <span className="text-muted-foreground/40">&mdash;</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No risks match your search.
        </div>
      )}
    </div>
  );
}
