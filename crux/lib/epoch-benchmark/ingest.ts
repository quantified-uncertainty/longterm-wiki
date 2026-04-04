/**
 * Epoch AI Benchmark Ingestion Orchestrator
 *
 * Downloads the Epoch AI benchmark data ZIP, parses each CSV,
 * maps benchmarks and models to our entities, deduplicates by
 * picking best scores, and prepares results for wiki-server sync.
 *
 * Usage:
 *   import { runIngestion } from "./ingest.ts";
 *   const result = await runIngestion({ cacheDir: "/tmp/epoch" });
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { parseEpochBenchmarkCsv } from "./csv-parser.ts";
import {
  EPOCH_FILENAME_TO_SLUG,
  EPOCH_SKIP_FILES,
  getEpochSourceUrl,
} from "./benchmark-map.ts";
import { buildModelMatcher, pickBestScore } from "./model-matcher.ts";
import type {
  EpochBenchmarkFile,
  EpochBenchmarkRow,
  PreparedBenchmarkResult,
  IngestSummary,
} from "./types.ts";
import { contentHash } from "../../../packages/factbase/src/ids.ts";

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface ModelEntity {
  id: string;
  stableId: string;
  title: string;
}

interface BenchmarkEntity {
  id: string;
  stableId: string;
  title: string;
  higherIsBetter?: boolean;
  scoringMethod?: string;
}

/**
 * Load our AI model entities from YAML.
 */
export function loadModelEntities(yamlPath: string): ModelEntity[] {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((m: Record<string, unknown>) => m.id && m.stableId && m.type === "ai-model")
    .map((m: Record<string, unknown>) => ({
      id: m.id as string,
      stableId: m.stableId as string,
      title: (m.title as string) || (m.id as string),
    }));
}

/**
 * Load our benchmark entities from YAML.
 */
export function loadBenchmarkEntities(yamlPath: string): BenchmarkEntity[] {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((b: Record<string, unknown>) => b.id && b.type === "benchmark")
    .map((b: Record<string, unknown>) => ({
      id: b.id as string,
      stableId: b.stableId as string || "",
      title: (b.title as string) || (b.id as string),
      higherIsBetter: b.higherIsBetter !== false,
      scoringMethod: (b.scoringMethod as string) || undefined,
    }));
}

// ---------------------------------------------------------------------------
// ZIP download and extraction
// ---------------------------------------------------------------------------

const EPOCH_BENCHMARK_ZIP_URL = "https://epoch.ai/data/benchmark_data.zip";

/**
 * Download and extract the Epoch benchmark ZIP to a cache directory.
 * Skips download if the cache is fresh (less than maxAgeHours old).
 */
export async function downloadAndExtract(
  cacheDir: string,
  options: { maxAgeHours?: number; forceDownload?: boolean } = {},
): Promise<string> {
  const { maxAgeHours = 24, forceDownload = false } = options;
  const extractDir = join(cacheDir, "epoch_benchmarks");
  const zipPath = join(cacheDir, "benchmark_data.zip");
  const timestampPath = join(cacheDir, ".download_timestamp");

  mkdirSync(cacheDir, { recursive: true });

  // Check cache freshness
  if (!forceDownload && existsSync(timestampPath) && existsSync(extractDir)) {
    const timestamp = parseInt(readFileSync(timestampPath, "utf-8").trim(), 10);
    const ageMs = Date.now() - timestamp;
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours < maxAgeHours) {
      console.log(
        `  Using cached data (${ageHours.toFixed(1)}h old, max ${maxAgeHours}h)`,
      );
      return extractDir;
    }
  }

  // Download
  console.log(`  Downloading from ${EPOCH_BENCHMARK_ZIP_URL}...`);
  const response = await fetch(EPOCH_BENCHMARK_ZIP_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to download Epoch benchmark data: HTTP ${response.status}`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(zipPath, buffer);

  // Extract using unzip command (available on macOS and Linux)
  const { execSync } = await import("child_process");
  mkdirSync(extractDir, { recursive: true });
  execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, {
    stdio: "pipe",
  });

  // Write timestamp
  writeFileSync(timestampPath, String(Date.now()));

  const files = readdirSync(extractDir).filter((f) => f.endsWith(".csv"));
  console.log(`  Extracted ${files.length} CSV files`);

  return extractDir;
}

// ---------------------------------------------------------------------------
// Ingestion pipeline
// ---------------------------------------------------------------------------

export interface IngestOptions {
  /** Directory containing extracted CSV files, OR path to single CSV */
  dataDir?: string;
  /** Path to ai-models.yaml */
  modelsYamlPath: string;
  /** Path to benchmarks.yaml */
  benchmarksYamlPath: string;
  /** Only process these benchmark slugs (if set) */
  benchmarkFilter?: string[];
}

export interface IngestResult {
  summary: IngestSummary;
  results: PreparedBenchmarkResult[];
}

// ---------------------------------------------------------------------------
// Score normalization
// ---------------------------------------------------------------------------

/**
 * Scoring methods where Epoch stores scores as 0-1 fractions but we store
 * them as 0-100 percentages. Scores > 1 are already in the correct range
 * (e.g., Codeforces rating = 2700, or Chatbot Arena ELO = 1350).
 */
const PERCENTAGE_SCORING_METHODS = new Set([
  "accuracy",
  "percentage",
  "pass_at_1",
]);

/**
 * Benchmarks where scores should NOT be normalized even if they look like
 * fractions. These use absolute scales (ELO, rating, index).
 */
const ABSOLUTE_SCORE_BENCHMARKS = new Set([
  "chatbot-arena-elo",
  "codeforces-rating",
  "artificial-analysis-intelligence-index",
]);

/**
 * Normalize an Epoch score to our storage format.
 *
 * Epoch stores most accuracy/percentage benchmarks as 0-1 fractions.
 * Our system stores them as 0-100 percentages. This function:
 *   - Converts 0-1 fractions to 0-100 for percentage-type benchmarks
 *   - Leaves absolute scores (ELO, ratings) unchanged
 *   - Rounds to 2 decimal places for clean storage
 */
function normalizeScore(
  score: number,
  benchmarkSlug: string,
  scoringMethodMap: Map<string, string>,
): number {
  // Never normalize absolute-scale benchmarks
  if (ABSOLUTE_SCORE_BENCHMARKS.has(benchmarkSlug)) {
    return Math.round(score * 100) / 100;
  }

  const method = scoringMethodMap.get(benchmarkSlug) || "accuracy";

  // Only normalize if:
  // 1. The scoring method is a percentage type
  // 2. The score is in the 0-1 range (exclusive of 0, to avoid normalizing actual 0 scores)
  if (PERCENTAGE_SCORING_METHODS.has(method) && score > 0 && score <= 1) {
    return Math.round(score * 100 * 100) / 100; // scale to percentage, round to 2dp
  }

  return Math.round(score * 100) / 100;
}

/**
 * Run the full ingestion pipeline.
 *
 * 1. Load our entity definitions
 * 2. Parse each Epoch CSV
 * 3. Map benchmarks (filename → slug) and models (version → stableId)
 * 4. Deduplicate (pick best score per model per benchmark)
 * 5. Generate deterministic IDs and return prepared results
 */
export function runIngestionPipeline(
  dataDir: string,
  options: IngestOptions,
): IngestResult {
  const { modelsYamlPath, benchmarksYamlPath, benchmarkFilter } = options;

  // Load our entities
  const modelEntities = loadModelEntities(modelsYamlPath);
  const benchmarkEntities = loadBenchmarkEntities(benchmarksYamlPath);
  const matchModel = buildModelMatcher(modelEntities);

  // Build set of known benchmark slugs and metadata lookups
  const knownBenchmarkSlugs = new Set(benchmarkEntities.map((b) => b.id));
  const benchmarkHigherIsBetter = new Map(
    benchmarkEntities.map((b) => [b.id, b.higherIsBetter !== false]),
  );
  const benchmarkScoringMethod = new Map(
    benchmarkEntities.map((b) => [b.id, b.scoringMethod || "accuracy"]),
  );

  // Find and parse CSV files
  const csvFiles = readdirSync(dataDir)
    .filter((f) => f.endsWith(".csv"))
    .filter((f) => {
      const name = f.replace(".csv", "");
      return !EPOCH_SKIP_FILES.has(name);
    });

  const parsedFiles: EpochBenchmarkFile[] = [];
  const unmappedBenchmarks: string[] = [];

  for (const file of csvFiles) {
    const filename = file.replace(".csv", "");
    const slug = EPOCH_FILENAME_TO_SLUG[filename] ?? null;

    // Skip if the slug is not in our known benchmarks
    if (!slug || !knownBenchmarkSlugs.has(slug)) {
      if (slug && !knownBenchmarkSlugs.has(slug)) {
        unmappedBenchmarks.push(`${filename} → ${slug} (slug not in benchmarks.yaml)`);
      } else if (!slug) {
        unmappedBenchmarks.push(`${filename} (no mapping defined)`);
      }
      continue;
    }

    // Apply benchmark filter if set
    if (benchmarkFilter && !benchmarkFilter.includes(slug)) {
      continue;
    }

    const csvText = readFileSync(join(dataDir, file), "utf-8");
    const rows = parseEpochBenchmarkCsv(csvText);

    parsedFiles.push({
      filename,
      benchmarkSlug: slug,
      rowCount: rows.length,
      rows,
    });
  }

  // Collect all rows grouped by benchmark slug (multiple CSV files may map to the same slug)
  type RowEntry = { score: number; epochModelVersion: string; row: EpochBenchmarkRow; filename: string };
  const rowsByBenchmark = new Map<string, RowEntry[]>();
  const unmatchedModelSet = new Set<string>();
  let totalRows = 0;
  let unmatchedModelRows = 0;

  const perBenchmark: IngestSummary["perBenchmark"] = [];

  for (const file of parsedFiles) {
    const slug = file.benchmarkSlug!;
    totalRows += file.rows.length;
    let fileMatchedCount = 0;

    for (const row of file.rows) {
      const match = matchModel(row.modelVersion);
      if (!match) {
        unmatchedModelSet.add(row.modelVersion);
        unmatchedModelRows++;
        continue;
      }

      if (!rowsByBenchmark.has(slug)) {
        rowsByBenchmark.set(slug, []);
      }
      rowsByBenchmark.get(slug)!.push({
        score: row.score,
        epochModelVersion: row.modelVersion,
        row,
        filename: file.filename,
      });
      fileMatchedCount++;
    }

    perBenchmark.push({
      benchmarkSlug: slug,
      filename: file.filename,
      totalRows: file.rows.length,
      matchedRows: fileMatchedCount,
    });
  }

  // Deduplicate across all files per benchmark slug: pick best score per model
  const allResults: PreparedBenchmarkResult[] = [];
  let matchedResultCount = 0;

  for (const [slug, entries] of rowsByBenchmark) {
    const higherIsBetter = benchmarkHigherIsBetter.get(slug) ?? true;

    // Group by model stableId
    const byModel = new Map<string, RowEntry[]>();
    for (const entry of entries) {
      const match = matchModel(entry.row.modelVersion);
      if (!match) continue; // already counted as unmatched above
      if (!byModel.has(match.stableId)) {
        byModel.set(match.stableId, []);
      }
      byModel.get(match.stableId)!.push(entry);
    }

    // Pick best score per model across all source files
    for (const [stableId, modelEntries] of byModel) {
      const best = pickBestScore(modelEntries, higherIsBetter);
      const bestEntry = modelEntries.find(
        (e) => e.epochModelVersion === best.epochModelVersion,
      )!;

      const benchmarkId = contentHash(["benchmark", slug]);
      const resultId = contentHash(["epoch", slug, stableId]);

      // Normalize score: Epoch stores accuracy/percentage as 0-1 fractions,
      // but our system stores them as 0-100 percentages.
      const normalizedScore = normalizeScore(best.score, slug, benchmarkScoringMethod);

      allResults.push({
        id: resultId,
        benchmarkId,
        modelId: stableId,
        score: normalizedScore,
        unit: null,
        date: bestEntry.row.releaseDate,
        sourceUrl: getEpochSourceUrl(bestEntry.filename),
        notes: `Epoch AI (model: ${best.epochModelVersion})`,
      });

      matchedResultCount++;
    }
  }

  const summary: IngestSummary = {
    filesProcessed: csvFiles.length,
    filesMapped: parsedFiles.length,
    filesUnmapped: csvFiles.length - parsedFiles.length,
    totalRows,
    matchedResults: matchedResultCount,
    unmatchedModelRows,
    unmatchedModels: [...unmatchedModelSet].sort(),
    unmappedBenchmarks: unmappedBenchmarks.sort(),
    perBenchmark: perBenchmark.sort((a, b) => b.matchedRows - a.matchedRows),
  };

  return { summary, results: allResults };
}
