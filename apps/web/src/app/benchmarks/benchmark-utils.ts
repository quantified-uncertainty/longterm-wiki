import { getTypedEntities, isBenchmark, isAiModel, type BenchmarkEntity } from "@/data";

/**
 * Get all benchmark entities.
 */
export function getBenchmarkEntities(): BenchmarkEntity[] {
  return getTypedEntities().filter(isBenchmark);
}

/**
 * Get all benchmark slugs for generateStaticParams.
 */
export function getBenchmarkSlugs(): string[] {
  return getBenchmarkEntities().map((e) => e.id);
}

/**
 * Resolve a benchmark entity by its slug (entity ID).
 */
export function resolveBenchmarkBySlug(slug: string): BenchmarkEntity | undefined {
  return getBenchmarkEntities().find((e) => e.id === slug);
}

/**
 * Get inline benchmark results from ai-model entities.
 * Returns a map of benchmarkSlug -> array of { modelId, modelTitle, developer, score, unit }.
 */
export interface BenchmarkResultRow {
  modelId: string;
  modelTitle: string;
  numericId: string | null;
  developer: string | null;
  developerName: string | null;
  score: number;
  unit?: string;
}

/**
 * Build a map of benchmark name -> model results, sourced from inline
 * `benchmarks[]` arrays on ai-model entities.
 */
export function getBenchmarkResultsFromModels(): Map<string, BenchmarkResultRow[]> {
  const allEntities = getTypedEntities();
  const results = new Map<string, BenchmarkResultRow[]>();

  // Map benchmark display names to benchmark entity slugs
  const nameToSlug = new Map<string, string>();
  for (const e of allEntities) {
    if (isBenchmark(e)) {
      // Map both exact title and common aliases
      nameToSlug.set(e.title.toLowerCase(), e.id);
    }
  }

  // Also set up common name aliases
  const aliases: Record<string, string> = {
    "mmlu": "mmlu",
    "swe-bench": "swe-bench-verified",
    "swe-bench verified": "swe-bench-verified",
    "math": "math-benchmark",
    "humaneval": "humaneval",
    "gpqa diamond": "gpqa-diamond",
    "gpqa": "gpqa-diamond",
    "arc-agi": "arc-agi",
    "arc-agi-2": "arc-agi-2",
    "aime 2025": "aime-2025",
    "aime": "aime-2025",
    "osworld": "osworld",
    "terminal-bench hard": "terminal-bench-hard",
    "terminal-bench 2": "terminal-bench-2",
    "artificial analysis intelligence index": "artificial-analysis-intelligence-index",
  };
  for (const [alias, slug] of Object.entries(aliases)) {
    nameToSlug.set(alias, slug);
  }

  // Build entity lookup map for developer resolution
  const entityById = new Map(allEntities.map((e) => [e.id, e]));

  for (const entity of allEntities) {
    if (!isAiModel(entity)) continue;
    if (!entity.benchmarks?.length) continue;

    // Resolve developer name once per model
    const developerEntity = entity.developer
      ? entityById.get(entity.developer)
      : null;

    for (const b of entity.benchmarks) {
      const slug = nameToSlug.get(b.name.toLowerCase());
      if (!slug) continue;

      const row: BenchmarkResultRow = {
        modelId: entity.id,
        modelTitle: entity.title,
        numericId: entity.numericId ?? null,
        developer: entity.developer ?? null,
        developerName: developerEntity?.title ?? null,
        score: b.score,
        unit: b.unit,
      };

      const arr = results.get(slug) ?? [];
      arr.push(row);
      results.set(slug, arr);
    }
  }

  return results;
}
