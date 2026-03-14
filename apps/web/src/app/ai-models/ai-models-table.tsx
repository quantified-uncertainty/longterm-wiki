"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { compareByValue, type SortDir } from "@/lib/sort-utils";
import { SortHeader } from "@/components/directory/SortHeader";
import { DEVELOPER_COLORS, formatContext } from "./ai-model-constants";

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
  mmluScore: number | null;
  gpqaScore: number | null;
  topBenchmark: { name: string; score: number; unit?: string } | null;
  capabilities: string[];
  isFamily: boolean;
  openWeight: boolean | null;
  parameterCount: string | null;
}

type SortKey =
  | "name"
  | "developer"
  | "releaseDate"
  | "inputPrice"
  | "outputPrice"
  | "contextWindow"
  | "safetyLevel"
  | "sweBench"
  | "mmlu"
  | "gpqa"
  | "params";

export function AiModelsTable({ rows }: { rows: AiModelRow[] }) {
  const [search, setSearch] = useState("");
  const [developerFilter, setDeveloperFilter] = useState<string>("all");
  const [showFamilies, setShowFamilies] = useState(false);
  const [showOpenWeightOnly, setShowOpenWeightOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("releaseDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const developers = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.developer && r.developerName) {
        map.set(r.developer, r.developerName);
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const developerCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    for (const r of rows) {
      if (!showFamilies && r.isFamily) continue;
      counts.all += 1;
      if (r.developer) {
        counts[r.developer] = (counts[r.developer] ?? 0) + 1;
      }
    }
    return counts;
  }, [rows, showFamilies]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "developer" ? "asc" : "desc");
    }
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (!showFamilies) {
      result = result.filter((r) => !r.isFamily);
    }

    if (developerFilter !== "all") {
      result = result.filter((r) => r.developer === developerFilter);
    }

    if (showOpenWeightOnly) {
      result = result.filter((r) => r.openWeight === true);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) => {
        const searchable = `${r.title} ${r.developerName ?? ""} ${r.modelFamily ?? ""} ${r.safetyLevel ?? ""} ${r.capabilities.join(" ")}`.toLowerCase();
        return searchable.includes(q);
      });
    }

    const getValue = (row: AiModelRow): string | number | null => {
      switch (sortKey) {
        case "name":
          return row.title.toLowerCase();
        case "developer":
          return (row.developerName ?? "").toLowerCase();
        case "releaseDate":
          return row.releaseDate;
        case "inputPrice":
          return row.inputPrice;
        case "outputPrice":
          return row.outputPrice;
        case "contextWindow":
          return row.contextWindow;
        case "safetyLevel":
          return row.safetyLevel;
        case "sweBench":
          return row.sweBenchScore;
        case "mmlu":
          return row.mmluScore;
        case "gpqa":
          return row.gpqaScore;
        case "params":
          return row.parameterCount ? parseParamCount(row.parameterCount) : null;
      }
    };
    result = [...result].sort((a, b) =>
      compareByValue(a, b, getValue, sortDir),
    );

    return result;
  }, [rows, search, developerFilter, showFamilies, showOpenWeightOnly, sortKey, sortDir]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col gap-3 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search models..."
            aria-label="Search models"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setDeveloperFilter("all")}
              aria-pressed={developerFilter === "all"}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                developerFilter === "all"
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              All
              <span className="ml-1 text-[10px] opacity-60">{developerCounts.all}</span>
            </button>
            {developers.map(([devId, devName]) => (
              <button
                key={devId}
                onClick={() => setDeveloperFilter(developerFilter === devId ? "all" : devId)}
                aria-pressed={developerFilter === devId}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  developerFilter === devId
                    ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                {devName}
                <span className="ml-1 text-[10px] opacity-60">
                  {developerCounts[devId] ?? 0}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showFamilies}
              onChange={(e) => setShowFamilies(e.target.checked)}
              className="rounded"
            />
            Show families
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showOpenWeightOnly}
              onChange={(e) => setShowOpenWeightOnly(e.target.checked)}
              className="rounded"
            />
            Open weight only
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
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader label="Model" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Developer" sortKey="developer" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Released" sortKey="releaseDate" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Params" sortKey="params" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Input $/MTok" sortKey="inputPrice" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Output $/MTok" sortKey="outputPrice" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Context" sortKey="contextWindow" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Safety" sortKey="safetyLevel" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="MMLU" sortKey="mmlu" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="GPQA" sortKey="gpqa" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
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
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/ai-models/${row.id}`}
                      className={`font-medium hover:text-primary transition-colors ${row.isFamily ? "text-foreground/80" : "text-foreground"}`}
                    >
                      {row.title}
                    </Link>
                    {row.openWeight && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                        Open
                      </span>
                    )}
                  </div>
                </td>

                {/* Developer */}
                <td className="py-2.5 px-3">
                  {row.developer && row.developerName ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        DEVELOPER_COLORS[row.developer] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      }`}
                    >
                      {row.developerName}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Release Date */}
                <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                  {row.releaseDate ?? <span className="text-muted-foreground/40">&mdash;</span>}
                </td>

                {/* Parameter Count */}
                <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">
                  {row.parameterCount ?? <span className="text-muted-foreground/40">&mdash;</span>}
                </td>

                {/* Input Price */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.inputPrice != null ? (
                    `$${row.inputPrice}`
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Output Price */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.outputPrice != null ? (
                    `$${row.outputPrice}`
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Context Window */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.contextWindow != null ? (
                    formatContext(row.contextWindow)
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Safety Level */}
                <td className="py-2.5 px-3">
                  {row.safetyLevel ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
                      {row.safetyLevel}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* MMLU */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.mmluScore != null ? (
                    <Link href="/benchmarks/mmlu" className="font-semibold hover:text-primary transition-colors">{row.mmluScore}%</Link>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* GPQA Diamond */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.gpqaScore != null ? (
                    <Link href="/benchmarks/gpqa-diamond" className="font-semibold hover:text-primary transition-colors">{row.gpqaScore}%</Link>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* SWE-bench */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.sweBenchScore != null ? (
                    <Link href="/benchmarks/swe-bench-verified" className="font-semibold hover:text-primary transition-colors">{row.sweBenchScore}%</Link>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
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

/** Parse a parameter count string like "70B" or "1.8T" to a numeric value for sorting. */
function parseParamCount(s: string): number {
  const match = s.match(/^([\d.]+)\s*([KMBT])?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const suffix = (match[2] ?? "").toUpperCase();
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return num * (multipliers[suffix] ?? 1);
}
