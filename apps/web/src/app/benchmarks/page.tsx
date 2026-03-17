import { Suspense } from "react";
import type { Metadata } from "next";
import { getBenchmarkEntities, getBenchmarkResultsFromModels } from "./benchmark-utils";
import type { BenchmarkRow } from "./benchmarks-table";
import type { MatrixBenchmark, MatrixModel, ScoreGrid } from "./comparison-matrix";
import { BenchmarksView } from "./benchmarks-view";
import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";

export const metadata: Metadata = {
  title: "AI Benchmarks",
  description:
    "Directory of AI evaluation benchmarks with model scores, leaderboards, and methodology details.",
};

// ── Types for API response ────────────────────────────────────────────────

interface DirectoryEntity {
  id: string;
  wikiId: string | null;
  stableId: string | null;
  entityType: string;
  title: string;
  description: string | null;
  website: string | null;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
  facts: Record<string, unknown>;
  resolvedRefs: Record<string, { name: string; entityId: string }>;
  counts: { careerHistory: number; grantsGiven: number; grantsReceived: number };
}

interface DirectoryResult {
  entities: DirectoryEntity[];
  total: number;
}

// ── Data shape ────────────────────────────────────────────────────────────

interface BenchmarksPageData {
  rows: BenchmarkRow[];
  matrixBenchmarks: MatrixBenchmark[];
  matrixModels: MatrixModel[];
  matrixScores: ScoreGrid;
  stats: StatDef[];
}

interface StatDef {
  label: string;
  value: string;
}

// ── API-first data loading ────────────────────────────────────────────────

function apiEntityToRow(
  e: DirectoryEntity,
  modelsCount: number,
): BenchmarkRow {
  const meta = e.metadata ?? {};
  return {
    id: e.id,
    title: e.title,
    wikiId: e.wikiId ?? null,
    category: (meta.category as string | undefined) ?? null,
    scoringMethod: (meta.scoringMethod as string | undefined) ?? null,
    higherIsBetter: (meta.higherIsBetter as boolean | undefined) ?? true,
    introducedDate: (meta.introducedDate as string | undefined) ?? null,
    maintainer: (meta.maintainer as string | undefined) ?? null,
    description: e.description ?? null,
    modelsCount,
  };
}

async function loadFromApi(): Promise<FetchResult<BenchmarksPageData>> {
  const result = await fetchDetailed<DirectoryResult>(
    "/api/entities/directory?entityType=benchmark",
    { revalidate: 60 },
  );

  if (!result.ok) return result;

  // Matrix data requires cross-entity model results — always built from local/PG data
  const { matrixData, resultsByBenchmark } = buildMatrixData();

  const rows: BenchmarkRow[] = result.data.entities.map((e) => {
    const results = resultsByBenchmark.get(e.id) ?? [];
    return apiEntityToRow(e, results.length);
  });

  const stats = buildStats(rows, resultsByBenchmark);

  return {
    ok: true,
    data: {
      rows,
      ...matrixData,
      stats,
    },
  };
}

// ── Local data loading (fallback) ─────────────────────────────────────────

function loadFromLocal(): BenchmarksPageData {
  const benchmarks = getBenchmarkEntities();
  const resultsByBenchmark = getBenchmarkResultsFromModels();

  const rows: BenchmarkRow[] = benchmarks.map((entity) => {
    const results = resultsByBenchmark.get(entity.id) ?? [];
    return {
      id: entity.id,
      title: entity.title,
      wikiId: entity.wikiId ?? null,
      category: entity.category ?? null,
      scoringMethod: entity.scoringMethod ?? null,
      higherIsBetter: entity.higherIsBetter,
      introducedDate: entity.introducedDate ?? null,
      maintainer: entity.maintainer ?? null,
      description: entity.description ?? null,
      modelsCount: results.length,
    };
  });

  const { matrixData } = buildMatrixData();
  const stats = buildStats(rows, resultsByBenchmark);

  return { rows, ...matrixData, stats };
}

// ── Shared helpers ────────────────────────────────────────────────────────

/** Build matrix data from model benchmark results (always from local/PG data). */
function buildMatrixData() {
  const benchmarks = getBenchmarkEntities();
  const resultsByBenchmark = getBenchmarkResultsFromModels();

  const matrixBenchmarks: MatrixBenchmark[] = benchmarks.map((b) => ({
    id: b.id,
    title: b.title,
    category: b.category ?? null,
    higherIsBetter: b.higherIsBetter ?? true,
  }));

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
          wikiId: r.wikiId,
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

  return {
    matrixData: { matrixBenchmarks, matrixModels, matrixScores },
    resultsByBenchmark,
  };
}

function buildStats(
  rows: BenchmarkRow[],
  resultsByBenchmark: Map<string, unknown[]>,
): StatDef[] {
  const totalBenchmarks = rows.length;
  const totalResults = [...resultsByBenchmark.values()].reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  const categoriesSet = new Set<string>();
  for (const r of rows) {
    if (r.category) categoriesSet.add(r.category);
  }
  const categoriesCount = categoriesSet.size;
  const withResults = rows.filter((r) => r.modelsCount > 0).length;

  return [
    { label: "Benchmarks", value: String(totalBenchmarks) },
    { label: "Model Scores", value: String(totalResults) },
    { label: "Categories", value: String(categoriesCount) },
    { label: "With Results", value: String(withResults) },
  ];
}

// ── Page component ────────────────────────────────────────────────────────

export default async function BenchmarksPage() {
  const { data, source, apiError } = await withApiFallback(
    () => loadFromApi(),
    () => loadFromLocal(),
  );

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

      <DataSourceBanner source={source} apiError={apiError} />

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {data.stats.map((stat) => (
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

      <Suspense fallback={<div>Loading...</div>}>
        <BenchmarksView
          rows={data.rows}
          matrixBenchmarks={data.matrixBenchmarks}
          matrixModels={data.matrixModels}
          matrixScores={data.matrixScores}
        />
      </Suspense>
    </div>
  );
}
