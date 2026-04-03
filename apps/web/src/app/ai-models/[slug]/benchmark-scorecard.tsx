import Link from "next/link";
import {
  getBenchmarkResultsFromModels,
  getBenchmarkSlugByName,
  getBenchmarkEntities,
  type BenchmarkResultRow,
} from "../../benchmarks/benchmark-utils";
import type { BenchmarkEntity } from "@/data";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface BenchmarkScore {
  name: string;
  score: number;
  unit?: string;
}

interface Props {
  /** The model's inline benchmark results (from entity.benchmarks) */
  benchmarks: BenchmarkScore[];
  /** The current model's entity ID */
  modelId: string;
}

interface EnrichedBenchmark {
  name: string;
  score: number;
  unit?: string;
  slug: string | null;
  category: string | null;
  higherIsBetter: boolean;
  /** 0-100, how the score ranks among all models for this benchmark */
  percentile: number;
  /** Total number of models with scores on this benchmark */
  totalModels: number;
  /** Rank position (1 = best) */
  rank: number;
}

// --------------------------------------------------------------------------
// Category config
// --------------------------------------------------------------------------

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

const CATEGORY_LABELS: Record<string, string> = {
  general: "General",
  knowledge: "Knowledge",
  reasoning: "Reasoning",
  math: "Math",
  coding: "Coding",
  agentic: "Agentic",
  multimodal: "Multimodal",
  safety: "Safety",
};

const CATEGORY_COLORS: Record<string, string> = {
  coding: "border-blue-300 dark:border-blue-800",
  reasoning: "border-violet-300 dark:border-violet-800",
  math: "border-amber-300 dark:border-amber-800",
  knowledge: "border-green-300 dark:border-green-800",
  multimodal: "border-pink-300 dark:border-pink-800",
  safety: "border-red-300 dark:border-red-800",
  agentic: "border-cyan-300 dark:border-cyan-800",
  general: "border-slate-300 dark:border-slate-800",
};

const CATEGORY_BG: Record<string, string> = {
  coding: "bg-blue-50 dark:bg-blue-950/20",
  reasoning: "bg-violet-50 dark:bg-violet-950/20",
  math: "bg-amber-50 dark:bg-amber-950/20",
  knowledge: "bg-green-50 dark:bg-green-950/20",
  multimodal: "bg-pink-50 dark:bg-pink-950/20",
  safety: "bg-red-50 dark:bg-red-950/20",
  agentic: "bg-cyan-50 dark:bg-cyan-950/20",
  general: "bg-slate-50 dark:bg-slate-950/20",
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function formatScore(score: number, unit?: string): string {
  const rounded = Number(score.toFixed(2));
  if (unit === "%" || unit === "percentage" || unit === "accuracy") {
    return `${parseFloat(score.toFixed(2))}%`;
  }
  if (rounded >= 1000) {
    return rounded.toLocaleString();
  }
  return String(rounded);
}

/**
 * Compute the percentile (0-100) of a score within a list of all scores.
 * higherIsBetter controls direction: if true, scoring above more models = higher percentile.
 */
function computePercentile(
  score: number,
  allScores: number[],
  higherIsBetter: boolean,
): number {
  if (allScores.length <= 1) return 50;
  const sorted = [...allScores].sort((a, b) => a - b);
  // Count how many scores are strictly less than this score
  const below = sorted.filter((s) => s < score).length;
  // Count how many are equal
  const equal = sorted.filter((s) => s === score).length;
  // Percentile using midpoint of equal-ranked scores
  const pctile = ((below + equal / 2) / sorted.length) * 100;
  return higherIsBetter ? pctile : 100 - pctile;
}

/**
 * Compute rank position (1 = best) for a score among all scores.
 */
function computeRank(
  score: number,
  allScores: number[],
  higherIsBetter: boolean,
): number {
  const sorted = higherIsBetter
    ? [...allScores].sort((a, b) => b - a)
    : [...allScores].sort((a, b) => a - b);
  return sorted.indexOf(score) + 1;
}

/** Get the Tailwind classes for a percentile-based bar color. */
function getBarColor(percentile: number): string {
  if (percentile >= 75) return "bg-emerald-400 dark:bg-emerald-500";
  if (percentile >= 50) return "bg-yellow-400 dark:bg-yellow-500";
  if (percentile >= 25) return "bg-orange-400 dark:bg-orange-500";
  return "bg-red-400 dark:bg-red-500";
}

/** Get the Tailwind classes for a percentile badge. */
function getPercentileBadge(percentile: number): string {
  if (percentile >= 75)
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (percentile >= 50)
    return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300";
  if (percentile >= 25)
    return "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300";
  return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
}

// --------------------------------------------------------------------------
// Data enrichment
// --------------------------------------------------------------------------

function enrichBenchmarks(
  benchmarks: BenchmarkScore[],
  modelId: string,
): EnrichedBenchmark[] {
  const allResults = getBenchmarkResultsFromModels();
  const benchmarkEntities = getBenchmarkEntities();
  const entityBySlug = new Map<string, BenchmarkEntity>(
    benchmarkEntities.map((e) => [e.id, e]),
  );

  return benchmarks.map((b) => {
    const slug = getBenchmarkSlugByName(b.name) ?? null;
    const benchEntity = slug ? entityBySlug.get(slug) : null;
    const category = benchEntity?.category ?? null;
    const higherIsBetter = benchEntity?.higherIsBetter ?? true;

    // Get all model scores for this benchmark
    const resultsForBenchmark: BenchmarkResultRow[] = slug
      ? (allResults.get(slug) ?? [])
      : [];
    const allScores = resultsForBenchmark.map((r) => r.score);

    // If the current model's score isn't in the cross-model data, add it
    if (!allScores.includes(b.score) && resultsForBenchmark.every(r => r.modelId !== modelId)) {
      allScores.push(b.score);
    }

    const percentile = computePercentile(b.score, allScores, higherIsBetter);
    const rank = computeRank(b.score, allScores, higherIsBetter);

    return {
      name: b.name,
      score: b.score,
      unit: b.unit,
      slug,
      category,
      higherIsBetter,
      percentile,
      totalModels: allScores.length,
      rank,
    };
  });
}

/**
 * Group enriched benchmarks by category, sorted by category order.
 * Benchmarks without a resolved category go into "other".
 */
function groupByCategory(
  benchmarks: EnrichedBenchmark[],
): Array<{ category: string; label: string; items: EnrichedBenchmark[] }> {
  const groups = new Map<string, EnrichedBenchmark[]>();

  for (const b of benchmarks) {
    const cat = b.category ?? "other";
    const arr = groups.get(cat) ?? [];
    arr.push(b);
    groups.set(cat, arr);
  }

  // Sort each group by percentile descending (show strongest results first)
  for (const items of groups.values()) {
    items.sort((a, b) => b.percentile - a.percentile);
  }

  // Sort groups by category order
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const orderA = CATEGORY_ORDER.indexOf(a);
      const orderB = CATEGORY_ORDER.indexOf(b);
      return (orderA >= 0 ? orderA : 99) - (orderB >= 0 ? orderB : 99);
    })
    .map(([cat, items]) => ({
      category: cat,
      label: CATEGORY_LABELS[cat] ?? "Other",
      items,
    }));
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export function BenchmarkScorecard({ benchmarks, modelId }: Props) {
  const enriched = enrichBenchmarks(benchmarks, modelId);
  const groups = groupByCategory(enriched);

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.category}>
          {/* Category header */}
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </h3>
            <span className="text-[10px] text-muted-foreground/60">
              {group.items.length}{" "}
              {group.items.length === 1 ? "benchmark" : "benchmarks"}
            </span>
          </div>

          {/* Benchmark rows */}
          <div
            className={`rounded-xl border overflow-hidden divide-y divide-border/40 ${
              CATEGORY_COLORS[group.category] ?? "border-border/60"
            }`}
          >
            {group.items.map((b) => (
              <BenchmarkRow key={b.name} benchmark={b} category={group.category} />
            ))}
          </div>
        </div>
      ))}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground pt-1">
        <span className="font-medium">Percentile among tested models:</span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-400 dark:bg-emerald-500" />
          Top 25%
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-yellow-400 dark:bg-yellow-500" />
          50-75%
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-orange-400 dark:bg-orange-500" />
          25-50%
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-400 dark:bg-red-500" />
          Bottom 25%
        </span>
      </div>
    </div>
  );
}

function BenchmarkRow({
  benchmark,
  category,
}: {
  benchmark: EnrichedBenchmark;
  category: string;
}) {
  const barColor = getBarColor(benchmark.percentile);
  const badgeClasses = getPercentileBadge(benchmark.percentile);
  const barWidth = Math.max(5, benchmark.percentile);

  const nameContent = benchmark.slug ? (
    <Link
      href={`/benchmarks/${benchmark.slug}`}
      className="text-sm font-medium hover:text-primary transition-colors truncate"
      title={`View ${benchmark.name} leaderboard`}
    >
      {benchmark.name}
    </Link>
  ) : (
    <span className="text-sm font-medium truncate">{benchmark.name}</span>
  );

  return (
    <div
      className={`px-4 py-3 ${
        CATEGORY_BG[category] ?? "bg-card"
      }`}
    >
      {/* Top: name, score, and rank */}
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">{nameContent}</div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-sm font-bold tabular-nums">
            {formatScore(benchmark.score, benchmark.unit)}
          </span>
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${badgeClasses}`}
            title={`Rank ${benchmark.rank} of ${benchmark.totalModels} models`}
          >
            #{benchmark.rank}/{benchmark.totalModels}
          </span>
        </div>
      </div>

      {/* Bar */}
      <div className="relative h-2 rounded-full bg-muted/40 overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${barColor} transition-all`}
          style={{ width: `${barWidth}%` }}
        />
      </div>

      {/* Bottom: percentile label */}
      <div className="flex justify-end mt-1">
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {Math.round(benchmark.percentile)}th percentile
        </span>
      </div>
    </div>
  );
}
