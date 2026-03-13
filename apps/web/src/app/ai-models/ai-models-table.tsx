"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { compareByValue, type SortDir } from "@/lib/sort-utils";

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

const DEVELOPER_COLORS: Record<string, string> = {
  anthropic: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  openai: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  deepmind: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "meta-ai": "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  "mistral-ai": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  xai: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  deepseek: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

type SortKey =
  | "name"
  | "developer"
  | "releaseDate"
  | "inputPrice"
  | "outputPrice"
  | "contextWindow"
  | "sweBench"
  | "mmlu"
  | "gpqa"
  | "params";

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
      result = result.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.developerName?.toLowerCase().includes(q) ||
          r.modelFamily?.toLowerCase().includes(q),
      );
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
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setDeveloperFilter("all")}
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
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <SortHeader label="Model" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Developer" sortKey="developer" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Released" sortKey="releaseDate" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Params" sortKey="params" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Input $/MTok" sortKey="inputPrice" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Output $/MTok" sortKey="outputPrice" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Context" sortKey="contextWindow" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
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
                    {row.openWeight && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                        Open
                      </span>
                    )}
                  </div>
                </td>

                {/* Developer */}
                <td className="py-2.5 px-3">
                  {row.developer && row.developerName && (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        DEVELOPER_COLORS[row.developer] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      }`}
                    >
                      {row.developerName}
                    </span>
                  )}
                </td>

                {/* Release Date */}
                <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                  {row.releaseDate ?? ""}
                </td>

                {/* Parameter Count */}
                <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">
                  {row.parameterCount ?? ""}
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

                {/* MMLU */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.mmluScore != null ? (
                    <span className="font-semibold">{row.mmluScore}%</span>
                  ) : (
                    ""
                  )}
                </td>

                {/* GPQA Diamond */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.gpqaScore != null ? (
                    <span className="font-semibold">{row.gpqaScore}%</span>
                  ) : (
                    ""
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

/** Parse a parameter count string like "70B" or "1.8T" to a numeric value for sorting. */
function parseParamCount(s: string): number {
  const match = s.match(/^([\d.]+)\s*([KMBT])?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const suffix = (match[2] ?? "").toUpperCase();
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return num * (multipliers[suffix] ?? 1);
}
