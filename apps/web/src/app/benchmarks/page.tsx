import type { Metadata } from "next";
import { getBenchmarkEntities, getBenchmarkResultsFromModels } from "./benchmark-utils";
import type { BenchmarkRow } from "./benchmarks-table";
import type { MatrixBenchmark, MatrixModel, ScoreGrid } from "./comparison-matrix";
import { BenchmarksView } from "./benchmarks-view";

export const metadata: Metadata = {
  title: "AI Benchmarks",
  description:
    "Directory of AI evaluation benchmarks with model scores, leaderboards, and methodology details.",
};

export default function BenchmarksPage() {
  const benchmarks = getBenchmarkEntities();
  const resultsByBenchmark = getBenchmarkResultsFromModels();

  // Collect unique categories
  const categoriesSet = new Set<string>();
  for (const b of benchmarks) {
    if (b.category) categoriesSet.add(b.category);
  }

  const rows: BenchmarkRow[] = benchmarks.map((entity) => {
    const results = resultsByBenchmark.get(entity.id) ?? [];
    return {
      id: entity.id,
      title: entity.title,
      numericId: entity.numericId ?? null,
      category: entity.category ?? null,
      scoringMethod: entity.scoringMethod ?? null,
      higherIsBetter: entity.higherIsBetter,
      introducedDate: entity.introducedDate ?? null,
      maintainer: entity.maintainer ?? null,
      description: entity.description ?? null,
      modelsCount: results.length,
    };
  });

  // Build matrix data
  const matrixBenchmarks: MatrixBenchmark[] = benchmarks.map((b) => ({
    id: b.id,
    title: b.title,
    category: b.category ?? null,
    higherIsBetter: b.higherIsBetter ?? true,
    resultCount: (resultsByBenchmark.get(b.id) ?? []).length,
  }));

  // Collect unique models and build score grid
  const modelsMap = new Map<string, MatrixModel>();
  const matrixScores: ScoreGrid = {};

  for (const [benchmarkSlug, results] of resultsByBenchmark.entries()) {
    for (const r of results) {
      if (!modelsMap.has(r.modelId)) {
        modelsMap.set(r.modelId, {
          id: r.modelId,
          title: r.modelTitle,
          developer: r.developer,
          developerName: r.developerName,
          numericId: r.numericId,
        });
      }
      if (!matrixScores[r.modelId]) {
        matrixScores[r.modelId] = {};
      }
      matrixScores[r.modelId][benchmarkSlug] = {
        score: r.score,
        unit: r.unit,
      };
    }
  }

  const matrixModels = [...modelsMap.values()];

  // Stats
  const totalBenchmarks = benchmarks.length;
  const totalResults = [...resultsByBenchmark.values()].reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  const categoriesCount = categoriesSet.size;
  const withResults = rows.filter((r) => r.modelsCount > 0).length;

  const stats = [
    { label: "Benchmarks", value: String(totalBenchmarks) },
    { label: "Model Scores", value: String(totalResults) },
    { label: "Categories", value: String(categoriesCount) },
    { label: "With Results", value: String(withResults) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          AI Benchmarks
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of AI evaluation benchmarks tracked in the knowledge base,
          with model scores and leaderboards.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4"
          >
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
              {stat.label}
            </div>
            <div className="text-2xl font-bold tabular-nums tracking-tight">
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <BenchmarksView
        rows={rows}
        matrixBenchmarks={matrixBenchmarks}
        matrixModels={matrixModels}
        matrixScores={matrixScores}
      />
    </div>
  );
}
