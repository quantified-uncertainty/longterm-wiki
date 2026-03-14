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

// Common name aliases for benchmark resolution
const BENCHMARK_ALIASES: Record<string, string> = {
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
  "aime 2024": "aime-2024",
  "osworld": "osworld",
  "terminal-bench hard": "terminal-bench-hard",
  "terminal-bench 2": "terminal-bench-2",
  "terminal-bench 2.0": "terminal-bench-2",
  "artificial analysis intelligence index": "artificial-analysis-intelligence-index",
  "mmlu-pro": "mmlu-pro",
  "simpleqa": "simpleqa",
  "humanity's last exam": "humanitys-last-exam",
  "hle": "humanitys-last-exam",
  "ifeval": "ifeval",
  "chatbot arena elo": "chatbot-arena-elo",
  "chatbot arena": "chatbot-arena-elo",
  "livecodebench": "livecodebench",
  "livebench": "livebench",
  "bfcl": "bfcl",
  "frontiermath": "frontiermath",
  "bbh": "bbh",
  "big-bench hard": "bbh",
  "hellaswag": "hellaswag",
  "re-bench": "re-bench",
  "mle-bench": "mle-bench",
  "webarena": "webarena",
  "tau-bench": "tau-bench",
  "mgsm": "mgsm",
  "mathvista": "mathvista",
  "codeforces": "codeforces-rating",
  "codeforces rating": "codeforces-rating",
};

/**
 * Build the full name→slug lookup map (benchmark titles + aliases).
 */
export function buildBenchmarkNameToSlugMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of getTypedEntities()) {
    if (isBenchmark(e)) {
      map.set(e.title.toLowerCase(), e.id);
    }
  }
  for (const [alias, slug] of Object.entries(BENCHMARK_ALIASES)) {
    map.set(alias, slug);
  }
  return map;
}

/**
 * Resolve a benchmark display name to its slug.
 */
export function resolveBenchmarkName(name: string): string | undefined {
  return buildBenchmarkNameToSlugMap().get(name.toLowerCase());
}


/**
 * Resolve a benchmark display name to its slug for linking.
 * Returns undefined if no matching benchmark is found.
 */
export function getBenchmarkSlugByName(name: string): string | undefined {
  const lower = name.toLowerCase();
  const fromAlias = BENCHMARK_ALIASES[lower];
  if (fromAlias) return fromAlias;
  for (const e of getBenchmarkEntities()) {
    if (e.title.toLowerCase() === lower) return e.id;
  }
  return undefined;
}


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

  const nameToSlug = buildBenchmarkNameToSlugMap();

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
