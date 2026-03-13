/**
 * AI Models table section for organization profile pages.
 * Combines typed entity data (pricing, context) with KB model-release data (ASL level, notes).
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

/** Pick the most recognizable benchmark score to show in the table. */
function pickKeyBenchmark(
  benchmarks?: Array<{ name: string; score: number; unit?: string }> | null,
): string | null {
  if (!benchmarks || benchmarks.length === 0) return null;
  // Prefer SWE-bench, then MMLU, then GPQA, then first available
  const preferred = ["SWE-bench Verified", "SWE-bench", "MMLU", "GPQA Diamond"];
  for (const name of preferred) {
    const b = benchmarks.find((bm) => bm.name === name);
    if (b) return `${b.score}${b.unit === "%" || b.score <= 100 ? "%" : ""} ${b.name}`;
  }
  const first = benchmarks[0];
  return `${first.score}${first.unit === "%" || first.score <= 100 ? "%" : ""} ${first.name}`;
}

export function AiModelsSection({
  models,
}: {
  models: AiModelEntry[];
}) {
  if (models.length === 0) return null;

  const hasSafetyLevel = models.some((m) => m.safetyLevel);
  const hasBenchmarks = models.some((m) => m.benchmarks && m.benchmarks.length > 0);

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
                <th scope="col" className="py-2 px-3 text-left font-medium hidden lg:table-cell">Benchmark</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {models.map((model) => {
              const href = model.numericId ? `/wiki/${model.numericId}` : getEntityHref(model.id, model.entityType);
              const benchmark = pickKeyBenchmark(model.benchmarks);
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
                    <td className="py-2 px-3 text-muted-foreground text-xs hidden lg:table-cell">
                      {benchmark}
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
