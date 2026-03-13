import { getTypedEntities, isBenchmark, isAiModel, getBenchmarkResults, type BenchmarkEntity, type AnyEntity } from "@/data";

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

// Name aliases mapping inline benchmark names to benchmark entity IDs
const BENCHMARK_NAME_ALIASES: Record<string, string> = {
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

/**
 * Build a map of benchmarkId -> model results.
 *
 * Uses PG-sourced benchmark results from database.json when available,
 * falling back to extracting inline `benchmarks[]` from ai-model entities.
 */
export function getBenchmarkResultsFromModels(): Map<string, BenchmarkResultRow[]> {
  const allEntities = getTypedEntities();
  const entityById = new Map(allEntities.map((e) => [e.id, e]));

  // Try PG data first
  const pgResults = getBenchmarkResults();
  const hasPGData = Object.keys(pgResults).length > 0;

  if (hasPGData) {
    return buildFromPGResults(pgResults, entityById);
  }

  // Fallback: extract from inline ai-model benchmarks arrays
  return buildFromInlineData(allEntities, entityById);
}

/**
 * Build results map from PG-sourced benchmark_results (keyed by model ID).
 */
function buildFromPGResults(
  pgResults: Record<string, Array<{ benchmarkId: string; score: number; unit: string | null }>>,
  entityById: Map<string, AnyEntity>,
): Map<string, BenchmarkResultRow[]> {
  const results = new Map<string, BenchmarkResultRow[]>();

  for (const [modelId, scores] of Object.entries(pgResults)) {
    const model = entityById.get(modelId);
    if (!model) continue;

    const developerField = isAiModel(model) ? model.developer : undefined;
    const developerEntity = developerField ? entityById.get(developerField) : null;

    for (const s of scores) {
      const row: BenchmarkResultRow = {
        modelId: model.id,
        modelTitle: model.title,
        numericId: model.numericId ?? null,
        developer: developerField ?? null,
        developerName: developerEntity?.title ?? null,
        score: s.score,
        unit: s.unit ?? undefined,
      };

      const arr = results.get(s.benchmarkId) ?? [];
      arr.push(row);
      results.set(s.benchmarkId, arr);
    }
  }

  return results;
}

/**
 * Build results map by parsing inline `benchmarks[]` from ai-model entities.
 * Used as fallback when PG data is not available.
 */
function buildFromInlineData(
  allEntities: AnyEntity[],
  entityById: Map<string, AnyEntity>,
): Map<string, BenchmarkResultRow[]> {
  const results = new Map<string, BenchmarkResultRow[]>();

  // Build name-to-slug map from benchmark entities + aliases
  const nameToSlug = new Map<string, string>();
  for (const e of allEntities) {
    if (isBenchmark(e)) {
      nameToSlug.set(e.title.toLowerCase(), e.id);
    }
  }
  for (const [alias, slug] of Object.entries(BENCHMARK_NAME_ALIASES)) {
    nameToSlug.set(alias, slug);
  }

  for (const entity of allEntities) {
    if (!isAiModel(entity)) continue;
    if (!entity.benchmarks?.length) continue;

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
