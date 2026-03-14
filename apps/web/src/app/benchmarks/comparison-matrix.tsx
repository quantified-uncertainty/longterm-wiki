"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

export interface MatrixBenchmark {
  id: string;
  title: string;
  category: string | null;
  higherIsBetter: boolean;
}

export interface MatrixModel {
  id: string;
  title: string;
  developer: string | null;
  developerName: string | null;
  numericId: string | null;
}

export interface MatrixScore {
  score: number;
  unit?: string;
}

/** modelId → benchmarkSlug → score */
export type ScoreGrid = Record<string, Record<string, MatrixScore>>;

interface Props {
  benchmarks: MatrixBenchmark[];
  models: MatrixModel[];
  scores: ScoreGrid;
}

const CATEGORY_ORDER = [
  "general",
  "knowledge",
  "reasoning",
  "math",
  "coding",
  "agentic",
  "multimodal",
  "safety",
];

const CATEGORY_HEADER_COLORS: Record<string, string> = {
  coding: "bg-blue-50 dark:bg-blue-950/30",
  reasoning: "bg-violet-50 dark:bg-violet-950/30",
  math: "bg-amber-50 dark:bg-amber-950/30",
  knowledge: "bg-green-50 dark:bg-green-950/30",
  multimodal: "bg-pink-50 dark:bg-pink-950/30",
  safety: "bg-red-50 dark:bg-red-950/30",
  agentic: "bg-cyan-50 dark:bg-cyan-950/30",
  general: "bg-slate-50 dark:bg-slate-950/30",
};

type SortMode = "score" | "name" | "developer";

function formatScore(score: number, unit?: string): string {
  if (unit === "%" || unit === "percentage" || unit === "accuracy") {
    return `${score}%`;
  }
  if (score >= 1000) {
    return score.toLocaleString();
  }
  return String(score);
}

/** Normalize a score to 0-1 within a benchmark column. */
function normalizeScore(
  score: number,
  min: number,
  max: number,
  higherIsBetter: boolean,
): number {
  if (max === min) return 0.5;
  const normalized = (score - min) / (max - min);
  return higherIsBetter ? normalized : 1 - normalized;
}

/** Map 0-1 to a background color class. */
function getHeatColor(normalized: number): string {
  if (normalized >= 0.9) return "bg-emerald-200 dark:bg-emerald-900/50 text-emerald-900 dark:text-emerald-100";
  if (normalized >= 0.7) return "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200";
  if (normalized >= 0.5) return "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200";
  if (normalized >= 0.3) return "bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200";
  return "bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200";
}

export function ComparisonMatrix({ benchmarks, models, scores }: Props) {
  const [sortMode, setSortMode] = useState<SortMode>("score");
  const [developerFilter, setDeveloperFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  // Sort benchmarks by category order, then alphabetically
  const sortedBenchmarks = useMemo(() => {
    let filtered = [...benchmarks];
    if (categoryFilter !== "all") {
      filtered = filtered.filter((b) => b.category === categoryFilter);
    }
    return filtered.sort((a, b) => {
      const catA = CATEGORY_ORDER.indexOf(a.category ?? "");
      const catB = CATEGORY_ORDER.indexOf(b.category ?? "");
      const orderA = catA >= 0 ? catA : 99;
      const orderB = catB >= 0 ? catB : 99;
      if (orderA !== orderB) return orderA - orderB;
      return a.title.localeCompare(b.title);
    });
  }, [benchmarks, categoryFilter]);

  // Compute min/max per benchmark for normalization
  const benchmarkRanges = useMemo(() => {
    const ranges: Record<string, { min: number; max: number }> = {};
    for (const b of sortedBenchmarks) {
      let min = Infinity;
      let max = -Infinity;
      for (const model of models) {
        const s = scores[model.id]?.[b.id];
        if (s) {
          min = Math.min(min, s.score);
          max = Math.max(max, s.score);
        }
      }
      if (min !== Infinity) {
        ranges[b.id] = { min, max };
      }
    }
    return ranges;
  }, [sortedBenchmarks, models, scores]);

  // Unique developers
  const developers = useMemo(() => {
    const devs = new Map<string, string>();
    for (const m of models) {
      if (m.developer && m.developerName) {
        devs.set(m.developer, m.developerName);
      }
    }
    return [...devs.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [models]);

  // Unique categories
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const b of benchmarks) {
      if (b.category) cats.add(b.category);
    }
    return [...cats].sort(
      (a, b) =>
        (CATEGORY_ORDER.indexOf(a) >= 0 ? CATEGORY_ORDER.indexOf(a) : 99) -
        (CATEGORY_ORDER.indexOf(b) >= 0 ? CATEGORY_ORDER.indexOf(b) : 99),
    );
  }, [benchmarks]);

  // Filter & sort models
  const sortedModels = useMemo(() => {
    let filtered = models.filter((m) => {
      // Only show models that have at least one score in the visible benchmarks
      const hasScore = sortedBenchmarks.some((b) => scores[m.id]?.[b.id]);
      if (!hasScore) return false;
      if (developerFilter !== "all" && m.developer !== developerFilter) return false;
      return true;
    });

    if (sortMode === "name") {
      filtered.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortMode === "developer") {
      filtered.sort((a, b) => {
        const devCmp = (a.developerName ?? "").localeCompare(b.developerName ?? "");
        if (devCmp !== 0) return devCmp;
        return a.title.localeCompare(b.title);
      });
    } else {
      // Sort by average normalized score (descending)
      filtered.sort((a, b) => {
        const avgA = averageNormalized(a.id);
        const avgB = averageNormalized(b.id);
        return avgB - avgA;
      });
    }

    return filtered;
  }, [models, sortedBenchmarks, scores, sortMode, developerFilter]);

  function averageNormalized(modelId: string): number {
    let sum = 0;
    let count = 0;
    for (const b of sortedBenchmarks) {
      const s = scores[modelId]?.[b.id];
      const range = benchmarkRanges[b.id];
      if (s && range) {
        sum += normalizeScore(s.score, range.min, range.max, b.higherIsBetter);
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  // Coverage stats
  const totalCells = sortedModels.length * sortedBenchmarks.length;
  const filledCells = sortedModels.reduce(
    (sum, m) => sum + sortedBenchmarks.filter((b) => scores[m.id]?.[b.id]).length,
    0,
  );
  const coveragePct = totalCells > 0 ? Math.round((filledCells / totalCells) * 100) : 0;

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-col gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Sort:</label>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="text-xs px-2 py-1.5 rounded-lg border border-border bg-card"
            >
              <option value="score">Avg Score</option>
              <option value="name">Model Name</option>
              <option value="developer">Developer</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Developer:</label>
            <select
              value={developerFilter}
              onChange={(e) => setDeveloperFilter(e.target.value)}
              className="text-xs px-2 py-1.5 rounded-lg border border-border bg-card"
            >
              <option value="all">All</option>
              {developers.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Category:</label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="text-xs px-2 py-1.5 rounded-lg border border-border bg-card"
            >
              <option value="all">All</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="text-xs text-muted-foreground">
          {sortedModels.length} models, {sortedBenchmarks.length} benchmarks, {coveragePct}% coverage ({filledCells}/{totalCells} cells)
        </div>
      </div>

      {/* Matrix */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="text-xs border-collapse">
          {/* Column headers — benchmark names */}
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="sticky left-0 z-20 bg-muted/30 backdrop-blur-sm py-2 px-3 text-left font-medium text-muted-foreground min-w-[180px]">
                Model
              </th>
              {sortedBenchmarks.map((b) => (
                <th
                  key={b.id}
                  className={`py-2 px-1.5 text-center font-medium min-w-[60px] max-w-[80px] ${
                    CATEGORY_HEADER_COLORS[b.category ?? ""] ?? ""
                  }`}
                >
                  <Link
                    href={`/benchmarks/${b.id}`}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title={b.title}
                  >
                    <span className="block truncate text-[10px] leading-tight">
                      {abbreviate(b.title)}
                    </span>
                  </Link>
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="divide-y divide-border/30">
            {sortedModels.map((model) => (
              <tr key={model.id} className="hover:bg-muted/10 transition-colors">
                {/* Model name (sticky) */}
                <td className="sticky left-0 z-10 bg-background/95 backdrop-blur-sm py-1.5 px-3 whitespace-nowrap border-r border-border/30">
                  <div className="flex items-center gap-2">
                    {model.numericId ? (
                      <Link
                        href={`/wiki/${model.numericId}`}
                        className="font-medium hover:text-primary transition-colors truncate max-w-[140px]"
                        title={model.title}
                      >
                        {model.title}
                      </Link>
                    ) : (
                      <span className="font-medium truncate max-w-[140px]" title={model.title}>
                        {model.title}
                      </span>
                    )}
                    {model.developerName && (
                      <span className="text-[9px] text-muted-foreground/60 truncate max-w-[60px]" title={model.developerName}>
                        {model.developerName}
                      </span>
                    )}
                  </div>
                </td>

                {/* Score cells */}
                {sortedBenchmarks.map((b) => {
                  const s = scores[model.id]?.[b.id];
                  if (!s) {
                    return (
                      <td
                        key={b.id}
                        className="py-1.5 px-1 text-center text-muted-foreground/20"
                      >
                        --
                      </td>
                    );
                  }

                  const range = benchmarkRanges[b.id];
                  const norm = range
                    ? normalizeScore(s.score, range.min, range.max, b.higherIsBetter)
                    : 0.5;
                  const colorClass = getHeatColor(norm);

                  return (
                    <td
                      key={b.id}
                      className={`py-1.5 px-1 text-center tabular-nums font-medium ${colorClass}`}
                      title={`${model.title} on ${b.title}: ${formatScore(s.score, s.unit)}`}
                    >
                      {formatScore(s.score, s.unit)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sortedModels.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No models match your filters.
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-3 mt-4 text-xs text-muted-foreground">
        <span>Score percentile:</span>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-red-100 dark:bg-red-900/30" />
          <span>Low</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-orange-100 dark:bg-orange-900/30" />
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-yellow-100 dark:bg-yellow-900/30" />
          <span>Mid</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-emerald-100 dark:bg-emerald-900/30" />
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-emerald-200 dark:bg-emerald-900/50" />
          <span>High</span>
        </div>
      </div>
    </div>
  );
}

/** Shorten benchmark names for column headers. */
function abbreviate(title: string): string {
  const abbrevs: Record<string, string> = {
    "SWE-bench Verified": "SWE-b",
    "GPQA Diamond": "GPQA-D",
    "Chatbot Arena Elo": "Arena",
    "Codeforces Rating": "CF",
    "Artificial Analysis Intelligence Index": "AA-Idx",
    "Humanity's Last Exam": "HLE",
    "Terminal-Bench Hard": "TB-Hard",
    "Terminal-Bench 2": "TB-2",
  };
  return abbrevs[title] ?? title;
}
