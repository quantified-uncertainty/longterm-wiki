"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { compareByValue, type SortDir } from "@/lib/sort-utils";

export interface BenchmarkRow {
  id: string;
  title: string;
  numericId: string | null;
  category: string | null;
  scoringMethod: string | null;
  higherIsBetter: boolean;
  introducedDate: string | null;
  maintainer: string | null;
  description: string | null;
  modelsCount: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  coding: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  reasoning: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  math: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  knowledge: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  multimodal: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
  safety: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  agentic: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  general: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
};

type SortKey = "name" | "category" | "modelsCount" | "introducedDate" | "maintainer";

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
  return (
    <th className={`py-2.5 px-3 font-medium ${className ?? ""}`}>
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

export function BenchmarksTable({ rows }: { rows: BenchmarkRow[] }) {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("modelsCount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.category) set.add(r.category);
    }
    return [...set].sort();
  }, [rows]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      if (r.category) {
        counts[r.category] = (counts[r.category] ?? 0) + 1;
      }
    }
    return counts;
  }, [rows]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "category" || key === "maintainer" ? "asc" : "desc");
    }
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (categoryFilter !== "all") {
      result = result.filter((r) => r.category === categoryFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q) ||
          r.maintainer?.toLowerCase().includes(q),
      );
    }

    const getValue = (row: BenchmarkRow): string | number | null => {
      switch (sortKey) {
        case "name":
          return row.title.toLowerCase();
        case "category":
          return (row.category ?? "").toLowerCase();
        case "modelsCount":
          return row.modelsCount;
        case "introducedDate":
          return row.introducedDate;
        case "maintainer":
          return (row.maintainer ?? "").toLowerCase();
      }
    };
    result = [...result].sort((a, b) =>
      compareByValue(a, b, getValue, sortDir),
    );

    return result;
  }, [rows, search, categoryFilter, sortKey, sortDir]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col gap-3 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search benchmarks..."
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
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(categoryFilter === cat ? "all" : cat)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  categoryFilter === cat
                    ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                {cat.charAt(0).toUpperCase() + cat.slice(1)}
                <span className="ml-1 text-[10px] opacity-60">
                  {categoryCounts[cat] ?? 0}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} benchmarks
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <SortHeader label="Benchmark" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Category" sortKey="category" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Models Tested" sortKey="modelsCount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <th className="py-2.5 px-3 font-medium text-left">Scoring</th>
              <SortHeader label="Introduced" sortKey="introducedDate" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Maintainer" sortKey="maintainer" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
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
                  <Link
                    href={`/benchmarks/${row.id}`}
                    className="font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {row.title}
                  </Link>
                  {row.description && (
                    <p className="text-xs text-muted-foreground/70 mt-0.5 line-clamp-1 max-w-md">
                      {row.description}
                    </p>
                  )}
                </td>

                {/* Category */}
                <td className="py-2.5 px-3">
                  {row.category && (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        CATEGORY_COLORS[row.category] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      }`}
                    >
                      {row.category.charAt(0).toUpperCase() + row.category.slice(1)}
                    </span>
                  )}
                </td>

                {/* Models Count */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.modelsCount > 0 ? row.modelsCount : ""}
                </td>

                {/* Scoring */}
                <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                  {row.scoringMethod ?? ""}
                </td>

                {/* Introduced */}
                <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                  {row.introducedDate ?? ""}
                </td>

                {/* Maintainer */}
                <td className="py-2.5 px-3 text-muted-foreground">
                  {row.maintainer ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No benchmarks match your search.
        </div>
      )}
    </div>
  );
}
