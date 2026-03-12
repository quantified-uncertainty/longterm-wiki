"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

export interface AiModelRow {
  id: string;
  title: string;
  numericId: string | null;
  modelFamily: string | null;
  modelTier: string | null;
  generation: string | null;
  developer: string | null;
  developerName: string | null;
  releaseDate: string | null;
  inputPrice: number | null;
  outputPrice: number | null;
  contextWindow: number | null;
  safetyLevel: string | null;
  sweBenchScore: number | null;
  topBenchmark: { name: string; score: number; unit?: string } | null;
  capabilities: string[];
  isFamily: boolean;
}

const TIER_LABELS: Record<string, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};

const TIER_COLORS: Record<string, string> = {
  haiku: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  sonnet: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  opus: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
};

type SortKey =
  | "name"
  | "tier"
  | "releaseDate"
  | "inputPrice"
  | "outputPrice"
  | "contextWindow"
  | "sweBench";

type SortDir = "asc" | "desc";

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000) return `${tokens / 1_000}K`;
  return String(tokens);
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

export function AiModelsTable({ rows }: { rows: AiModelRow[] }) {
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [showFamilies, setShowFamilies] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("releaseDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const tiers = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.modelTier) set.add(r.modelTier);
    }
    return [...set].sort();
  }, [rows]);

  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.filter((r) => !r.isFamily).length };
    for (const r of rows) {
      if (r.isFamily) continue;
      const t = r.modelTier ?? "other";
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

    if (!showFamilies) {
      result = result.filter((r) => !r.isFamily);
    }

    if (tierFilter !== "all") {
      result = result.filter((r) => r.modelTier === tierFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.developerName?.toLowerCase().includes(q),
      );
    }

    const dir = sortDir === "asc" ? 1 : -1;
    result = [...result].sort((a, b) => {
      const getValue = (row: AiModelRow): string | number | null => {
        switch (sortKey) {
          case "name":
            return row.title.toLowerCase();
          case "tier":
            return row.modelTier ?? "";
          case "releaseDate":
            return row.releaseDate;
          case "inputPrice":
            return row.inputPrice;
          case "outputPrice":
            return row.outputPrice;
          case "contextWindow":
            return row.contextWindow;
          case "sweBench":
            return row.sweBenchScore;
        }
      };

      const va = getValue(a);
      const vb = getValue(b);

      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;

      if (typeof va === "string" && typeof vb === "string") {
        return va.localeCompare(vb) * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });

    return result;
  }, [rows, search, tierFilter, showFamilies, sortKey, sortDir]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search models..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setTierFilter("all")}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
              tierFilter === "all"
                ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
            }`}
          >
            All
            <span className="ml-1 text-[10px] opacity-60">{tierCounts.all}</span>
          </button>
          {tiers.map((t) => (
            <button
              key={t}
              onClick={() => setTierFilter(tierFilter === t ? "all" : t)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                tierFilter === t
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              {TIER_LABELS[t] ?? t}
              <span className="ml-1 text-[10px] opacity-60">
                {tierCounts[t] ?? 0}
              </span>
            </button>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-2">
            <input
              type="checkbox"
              checked={showFamilies}
              onChange={(e) => setShowFamilies(e.target.checked)}
              className="rounded"
            />
            Show families
          </label>
        </div>
      </div>

      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} models
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <SortHeader label="Model" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Tier" sortKey="tier" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Released" sortKey="releaseDate" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Input $/MTok" sortKey="inputPrice" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Output $/MTok" sortKey="outputPrice" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Context" sortKey="contextWindow" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <th className="py-2.5 px-3 font-medium text-left">Safety</th>
              <SortHeader label="SWE-bench" sortKey="sweBench" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {filtered.map((row) => (
              <tr
                key={row.id}
                className={`hover:bg-muted/20 transition-colors ${row.isFamily ? "bg-muted/10" : ""}`}
              >
                {/* Name */}
                <td className="py-2.5 px-3">
                  {row.numericId ? (
                    <Link
                      href={`/wiki/${row.numericId}`}
                      className={`font-medium hover:text-primary transition-colors ${row.isFamily ? "text-foreground/80" : "text-foreground"}`}
                    >
                      {row.title}
                    </Link>
                  ) : (
                    <span className="font-medium text-foreground">{row.title}</span>
                  )}
                  {row.developerName && (
                    <span className="ml-2 text-[10px] text-muted-foreground/60">
                      {row.developerName}
                    </span>
                  )}
                </td>

                {/* Tier */}
                <td className="py-2.5 px-3">
                  {row.modelTier && (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        TIER_COLORS[row.modelTier] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {TIER_LABELS[row.modelTier] ?? row.modelTier}
                    </span>
                  )}
                </td>

                {/* Release Date */}
                <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                  {row.releaseDate ?? ""}
                </td>

                {/* Input Price */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.inputPrice != null ? `$${row.inputPrice}` : ""}
                </td>

                {/* Output Price */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.outputPrice != null ? `$${row.outputPrice}` : ""}
                </td>

                {/* Context Window */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.contextWindow != null ? formatContext(row.contextWindow) : ""}
                </td>

                {/* Safety Level */}
                <td className="py-2.5 px-3 whitespace-nowrap">
                  {row.safetyLevel && (
                    <span className="text-xs text-muted-foreground">
                      {row.safetyLevel}
                    </span>
                  )}
                </td>

                {/* SWE-bench */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.sweBenchScore != null ? (
                    <span className="font-semibold">{row.sweBenchScore}%</span>
                  ) : (
                    ""
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No models match your search.
        </div>
      )}
    </div>
  );
}
