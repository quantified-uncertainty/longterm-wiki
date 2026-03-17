import { Suspense } from "react";
import type { Metadata } from "next";
import { getTypedEntities, getTypedEntityById, isAiModel } from "@/data";
import { AiModelsTable, type AiModelRow } from "./ai-models-table";
import { isModelFamily } from "./ai-model-utils";
import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";

export const metadata: Metadata = {
  title: "AI Models",
  description:
    "Comparison table of AI models with benchmarks, pricing, context windows, and safety levels.",
};

// ── Types for API response ────────────────────────────────────────────────

interface DirectoryFact {
  value: string | null;
  numeric: number | null;
  asOf: string | null;
  label: string | null;
  format: string | null;
  formatDivisor: number | null;
}

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
  facts: Record<string, DirectoryFact>;
  resolvedRefs: Record<string, { name: string; entityId: string }>;
  counts: { careerHistory: number; grantsGiven: number; grantsReceived: number };
}

interface DirectoryResult {
  entities: DirectoryEntity[];
  total: number;
}

// ── Benchmark types from metadata ─────────────────────────────────────────

interface MetadataBenchmark {
  name: string;
  score: number;
  unit?: string;
}

// ── Data shape ────────────────────────────────────────────────────────────

interface AiModelsPageData {
  rows: AiModelRow[];
  stats: StatDef[];
}

interface StatDef {
  label: string;
  value: string;
}

// ── API-first data loading ────────────────────────────────────────────────

function apiEntityToRow(e: DirectoryEntity): AiModelRow {
  const meta = e.metadata ?? {};
  const developer = e.resolvedRefs["developer"];
  const benchmarks = (meta.benchmarks as MetadataBenchmark[] | undefined) ?? [];

  const isSweBench = (name: string) =>
    name === "SWE-bench" || name === "SWE-bench Verified";
  const sweBench = benchmarks.find((b) => isSweBench(b.name));
  const mmlu = benchmarks.find((b) => b.name === "MMLU");
  const gpqa = benchmarks.find(
    (b) => b.name === "GPQA Diamond" || b.name === "GPQA",
  );
  const topBenchmark = benchmarks.find((b) => !isSweBench(b.name)) ?? null;

  const modelTier = (meta.modelTier as string | undefined) ?? null;
  const releaseDate = (meta.releaseDate as string | undefined) ?? null;
  const isFamily = !modelTier && !releaseDate;

  return {
    id: e.id,
    title: e.title,
    wikiId: e.wikiId ?? null,
    modelFamily: (meta.modelFamily as string | undefined) ?? null,
    modelTier,
    generation: (meta.generation as string | undefined) ?? null,
    developer: developer?.entityId ?? (meta.developer as string | undefined) ?? null,
    developerName: developer?.name ?? null,
    releaseDate,
    inputPrice: (meta.inputPrice as number | undefined) ?? null,
    outputPrice: (meta.outputPrice as number | undefined) ?? null,
    contextWindow: (meta.contextWindow as number | undefined) ?? null,
    safetyLevel: (meta.safetyLevel as string | undefined) ?? null,
    sweBenchScore: sweBench?.score ?? null,
    mmluScore: mmlu?.score ?? null,
    gpqaScore: gpqa?.score ?? null,
    topBenchmark: topBenchmark
      ? { name: topBenchmark.name, score: topBenchmark.score, unit: topBenchmark.unit }
      : null,
    capabilities: (meta.capabilities as string[] | undefined) ?? [],
    isFamily,
    openWeight: (meta.openWeight as boolean | undefined) ?? null,
    parameterCount: (meta.parameterCount as string | undefined) ?? null,
  };
}

async function loadFromApi(): Promise<FetchResult<AiModelsPageData>> {
  const result = await fetchDetailed<DirectoryResult>(
    "/api/entities/directory?entityType=ai-model&measures=developer",
    { revalidate: 60 },
  );

  if (!result.ok) return result;

  const rows = result.data.entities.map(apiEntityToRow);
  const stats = buildStats(rows);

  return { ok: true, data: { rows, stats } };
}

// ── Local data loading (fallback) ─────────────────────────────────────────

function loadFromLocal(): AiModelsPageData {
  const allEntities = getTypedEntities();
  const aiModels = allEntities.filter(isAiModel);

  const rows: AiModelRow[] = aiModels.map((entity) => {
    const developerEntity = entity.developer
      ? getTypedEntityById(entity.developer)
      : null;

    const isSweBench = (name: string) =>
      name === "SWE-bench" || name === "SWE-bench Verified";
    const sweBench = entity.benchmarks?.find((b) => isSweBench(b.name));
    const mmlu = entity.benchmarks?.find((b) => b.name === "MMLU");
    const gpqa = entity.benchmarks?.find(
      (b) => b.name === "GPQA Diamond" || b.name === "GPQA",
    );
    const topBenchmark =
      entity.benchmarks?.find((b) => !isSweBench(b.name)) ?? null;

    const isFamily = isModelFamily(entity);

    return {
      id: entity.id,
      title: entity.title,
      wikiId: entity.wikiId ?? null,
      modelFamily: entity.modelFamily ?? null,
      modelTier: entity.modelTier ?? null,
      generation: entity.generation ?? null,
      developer: entity.developer ?? null,
      developerName: developerEntity?.title ?? null,
      releaseDate: entity.releaseDate ?? null,
      inputPrice: entity.inputPrice ?? null,
      outputPrice: entity.outputPrice ?? null,
      contextWindow: entity.contextWindow ?? null,
      safetyLevel: entity.safetyLevel ?? null,
      sweBenchScore: sweBench?.score ?? null,
      mmluScore: mmlu?.score ?? null,
      gpqaScore: gpqa?.score ?? null,
      topBenchmark: topBenchmark
        ? { name: topBenchmark.name, score: topBenchmark.score, unit: topBenchmark.unit }
        : null,
      capabilities: entity.capabilities ?? [],
      isFamily,
      openWeight: entity.openWeight ?? null,
      parameterCount: entity.parameterCount ?? null,
    };
  });

  const stats = buildStats(rows);
  return { rows, stats };
}

// ── Shared stats computation ──────────────────────────────────────────────

function buildStats(rows: AiModelRow[]): StatDef[] {
  const nonFamilyRows = rows.filter((r) => !r.isFamily);
  const modelCount = nonFamilyRows.length;
  const withPricing = nonFamilyRows.filter((r) => r.inputPrice != null).length;
  const withBenchmarks = nonFamilyRows.filter((r) => r.sweBenchScore != null).length;
  const withSafety = nonFamilyRows.filter((r) => r.safetyLevel != null).length;

  return [
    { label: "Models", value: String(modelCount) },
    { label: "With Pricing", value: String(withPricing) },
    { label: "With SWE-bench", value: String(withBenchmarks) },
    { label: "With Safety Level", value: String(withSafety) },
  ];
}

// ── Page component ────────────────────────────────────────────────────────

export default async function AiModelsPage() {
  const { data, source, apiError } = await withApiFallback(
    () => loadFromApi(),
    () => loadFromLocal(),
  );

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          AI Models
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Comparison of AI models tracked in the knowledge base, including
          benchmarks, pricing, context windows, and safety classifications.
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
        <AiModelsTable rows={data.rows} />
      </Suspense>
    </div>
  );
}
