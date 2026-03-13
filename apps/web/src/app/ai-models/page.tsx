import type { Metadata } from "next";
import { getTypedEntities, getTypedEntityById, isAiModel } from "@/data";
import { AiModelsTable, type AiModelRow } from "./ai-models-table";

export const metadata: Metadata = {
  title: "AI Models",
  description:
    "Comparison table of AI models with benchmarks, pricing, context windows, and safety levels.",
};

export default function AiModelsPage() {
  const allEntities = getTypedEntities();
  const aiModels = allEntities.filter(isAiModel);

  const rows: AiModelRow[] = aiModels.map((entity) => {
    // Resolve developer name from entity reference
    const developerEntity = entity.developer
      ? getTypedEntityById(entity.developer)
      : null;

    // Find SWE-bench score (accept both "SWE-bench" and "SWE-bench Verified")
    const isSweBench = (name: string) =>
      name === "SWE-bench" || name === "SWE-bench Verified";
    const sweBench = entity.benchmarks?.find((b) => isSweBench(b.name));

    // Find MMLU score
    const mmlu = entity.benchmarks?.find((b) => b.name === "MMLU");

    // Find GPQA Diamond score
    const gpqa = entity.benchmarks?.find(
      (b) => b.name === "GPQA Diamond" || b.name === "GPQA",
    );

    // Find top non-SWE benchmark for display
    const topBenchmark =
      entity.benchmarks?.find((b) => !isSweBench(b.name)) ?? null;

    // Is this a family entry (no tier, no release date)?
    const isFamily = !entity.modelTier && !entity.releaseDate;

    return {
      id: entity.id,
      title: entity.title,
      numericId: entity.numericId ?? null,
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

  // Stats
  const nonFamilyRows = rows.filter((r) => !r.isFamily);
  const modelCount = nonFamilyRows.length;
  const withPricing = nonFamilyRows.filter((r) => r.inputPrice != null).length;
  const withBenchmarks = nonFamilyRows.filter((r) => r.sweBenchScore != null).length;
  const withSafety = nonFamilyRows.filter((r) => r.safetyLevel != null).length;

  const stats = [
    { label: "Models", value: String(modelCount) },
    { label: "With Pricing", value: String(withPricing) },
    { label: "With SWE-bench", value: String(withBenchmarks) },
    { label: "With Safety Level", value: String(withSafety) },
  ];

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

      <AiModelsTable rows={rows} />
    </div>
  );
}
