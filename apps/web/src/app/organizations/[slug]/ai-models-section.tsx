/**
 * AI Models table section for organization profile pages.
 * Shows models with optional benchmark scores and safety levels.
 */
import Link from "next/link";
import { getEntityHref } from "@/data/entity-nav";
import { formatCompactNumber } from "@/lib/format-compact";
import { formatKBDate } from "@/components/wiki/kb/format";
import { Badge } from "./org-shared";
import { SAFETY_LEVEL_COLORS } from "./org-data";

interface AiModelEntry {
  id: string;
  title: string;
  entityType: string;
  numericId?: string;
  releaseDate?: string | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  contextWindow?: number | null;
  safetyLevel?: string | null;
  benchmarks?: Array<{ name: string; score: number; unit?: string }> | null;
}

interface BenchmarkScore {
  name: string;
  score: number;
  unit?: string;
}

/** Benchmarks we prefer to show, in priority order. */
const FEATURED_BENCHMARKS = [
  "MMLU",
  "HumanEval",
  "GPQA Diamond",
  "SWE-bench",
  "MATH",
  "HellaSwag",
  "ARC-Challenge",
  "TruthfulQA",
  "GSM8K",
];

/** Pick top N benchmark scores, preferring featured benchmarks. */
function pickTopBenchmarks(
  benchmarks: BenchmarkScore[],
  maxCount = 3,
): BenchmarkScore[] {
  if (benchmarks.length === 0) return [];

  const picked: BenchmarkScore[] = [];
  const used = new Set<string>();

  // First pass: pick featured benchmarks in priority order
  for (const name of FEATURED_BENCHMARKS) {
    if (picked.length >= maxCount) break;
    const match = benchmarks.find(
      (b) => b.name.toLowerCase() === name.toLowerCase(),
    );
    if (match) {
      picked.push(match);
      used.add(match.name);
    }
  }

  // Second pass: fill remaining slots with highest-scoring non-featured benchmarks
  if (picked.length < maxCount) {
    const remaining = benchmarks
      .filter((b) => !used.has(b.name))
      .sort((a, b) => b.score - a.score);
    for (const b of remaining) {
      if (picked.length >= maxCount) break;
      picked.push(b);
    }
  }

  return picked;
}

export function AiModelsSection({
  models,
  benchmarksByModel,
}: {
  models: AiModelEntry[];
  benchmarksByModel?: Map<string, BenchmarkScore[]>;
}) {
  if (models.length === 0) return null;

  const hasSafetyLevel = models.some((m) => m.safetyLevel);
  const hasBenchmarks =
    benchmarksByModel && benchmarksByModel.size > 0;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold tracking-tight">
          AI Models ({models.length})
        </h2>
        <Link
          href={`/ai-models`}
          className="text-xs text-primary hover:underline"
        >
          View all models &rarr;
        </Link>
      </div>
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Model</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Released</th>
              {hasSafetyLevel && (
                <th scope="col" className="py-2 px-3 text-left font-medium">Safety</th>
              )}
              <th scope="col" className="py-2 px-3 text-right font-medium">Pricing (in/out)</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Context</th>
              {hasBenchmarks && (
                <th scope="col" className="py-2 px-3 text-left font-medium">Benchmarks</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {models.map((model) => {
              const href = model.numericId ? `/wiki/${model.numericId}` : getEntityHref(model.id, model.entityType);
              const benchmarks = benchmarksByModel?.get(model.id);
              const topBenchmarks = benchmarks
                ? pickTopBenchmarks(benchmarks)
                : [];
              return (
                <tr key={model.id} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    <Link href={href} className="font-medium text-foreground hover:text-primary transition-colors">
                      {model.title}
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                    {model.releaseDate ? formatKBDate(model.releaseDate) : ""}
                  </td>
                  {hasSafetyLevel && (
                    <td className="py-2 px-3">
                      {model.safetyLevel && (
                        <Badge
                          color={
                            SAFETY_LEVEL_COLORS[model.safetyLevel] ??
                            "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                          }
                        >
                          {model.safetyLevel}
                        </Badge>
                      )}
                    </td>
                  )}
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                    {model.inputPrice != null && model.outputPrice != null
                      ? `$${model.inputPrice} / $${model.outputPrice}`
                      : ""}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                    {model.contextWindow != null
                      ? `${formatCompactNumber(model.contextWindow)} tokens`
                      : ""}
                  </td>
                  {hasBenchmarks && (
                    <td className="py-2 px-3">
                      {topBenchmarks.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {topBenchmarks.map((b) => (
                            <span
                              key={b.name}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50 text-[10px] text-muted-foreground"
                              title={`${b.name}: ${b.score}${b.unit ? ` ${b.unit}` : ""}`}
                            >
                              <span className="font-medium text-foreground/80">{b.name}</span>
                              <span className="tabular-nums">{b.score}{b.unit === "%" ? "%" : ""}</span>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
