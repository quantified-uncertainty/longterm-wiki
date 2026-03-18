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
  wikiId: string | null;
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
 * Always starts with inline benchmark data from ai-model entities, then
 * overlays PG-sourced results where available. PG data takes priority for
 * any (model, benchmark) pair it covers, ensuring authoritative/recent scores
 * win. Inline data fills gaps for benchmarks not yet synced to PG.
 *
 * This merge strategy fixes a bug where benchmarks present in ai-model YAML
 * but absent from PG showed "0 models tested" on the benchmark detail page
 * when PG had any data at all (making hasPGData=true and skipping inline).
 */
export function getBenchmarkResultsFromModels(): Map<string, BenchmarkResultRow[]> {
  const allEntities = getTypedEntities();
  const entityById = new Map(allEntities.map((e) => [e.id, e]));

  // Start with inline data from ai-model entities (always available)
  const inlineResults = buildFromInlineData(allEntities, entityById);

  // Overlay PG data where available: PG wins for covered (benchmark, model) pairs
  const pgResults = getBenchmarkResults();
  const hasPGData = Object.keys(pgResults).length > 0;

  if (!hasPGData) {
    return inlineResults;
  }

  return mergeWithPGResults(inlineResults, pgResults, entityById);
}

/**
 * Merge inline results with PG-sourced results.
 *
 * Strategy: start from inline data, then for each (benchmark, model) pair
 * present in PG, replace the inline entry with the PG value. This ensures:
 * - Benchmarks fully absent from PG still show inline data (fixing the bug)
 * - PG data wins for benchmarks it does cover (more authoritative/recent)
 */
function mergeWithPGResults(
  inlineResults: Map<string, BenchmarkResultRow[]>,
  pgResults: Record<string, Array<{ benchmarkId: string; score: number; unit: string | null }>>,
  entityById: Map<string, AnyEntity>,
): Map<string, BenchmarkResultRow[]> {
  // Deep-copy inline results so we don't mutate the original
  const merged = new Map<string, BenchmarkResultRow[]>();
  for (const [benchmarkId, rows] of inlineResults) {
    merged.set(benchmarkId, [...rows]);
  }

  // Build a set of (benchmarkId, modelId) pairs covered by PG
  const pgCoveredPairs = new Set<string>();
  for (const [modelId, scores] of Object.entries(pgResults)) {
    for (const s of scores) {
      pgCoveredPairs.add(`${s.benchmarkId}:${modelId}`);
    }
  }

  // Remove inline entries where PG has data for that (benchmark, model) pair
  for (const [benchmarkId, rows] of merged) {
    const filtered = rows.filter(
      (row) => !pgCoveredPairs.has(`${benchmarkId}:${row.modelId}`)
    );
    if (filtered.length > 0) {
      merged.set(benchmarkId, filtered);
    } else {
      merged.delete(benchmarkId);
    }
  }

  // Add PG entries
  for (const [modelId, scores] of Object.entries(pgResults)) {
    const model = entityById.get(modelId);
    if (!model) continue;

    const developerField = isAiModel(model) ? model.developer : undefined;
    const developerEntity = developerField ? entityById.get(developerField) : null;

    for (const s of scores) {
      const row: BenchmarkResultRow = {
        modelId: model.id,
        modelTitle: model.title,
        wikiId: model.wikiId ?? null,
        developer: developerField ?? null,
        developerName: developerEntity?.title ?? null,
        score: s.score,
        unit: s.unit ?? undefined,
      };

      const arr = merged.get(s.benchmarkId) ?? [];
      arr.push(row);
      merged.set(s.benchmarkId, arr);
    }
  }

  return merged;
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
        wikiId: entity.wikiId ?? null,
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
