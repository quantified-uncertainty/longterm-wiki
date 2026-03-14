/**
 * Wiki Server Benchmarks Sync
 *
 * Reads data/entities/benchmarks.yaml (benchmark definitions) and
 * data/entities/ai-models.yaml (inline benchmark results), then syncs
 * both to the wiki-server's /api/benchmarks/sync and
 * /api/benchmark-results/sync endpoints.
 *
 * Usage:
 *   pnpm crux wiki-server sync-benchmarks
 *   pnpm crux wiki-server sync-benchmarks --dry-run
 *   pnpm crux wiki-server sync-benchmarks --batch-size=50
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { contentHash } from "../../packages/kb/src/ids.ts";
import { waitForHealthy, batchSync } from "./sync-common.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const BENCHMARKS_FILE = join(PROJECT_ROOT, "data/entities/benchmarks.yaml");
const AI_MODELS_FILE = join(PROJECT_ROOT, "data/entities/ai-models.yaml");

// --- Configuration ---
const DEFAULT_BATCH_SIZE = 100;

// --- Types ---

interface YamlBenchmark {
  id: string;
  numericId?: string;
  type: string;
  title: string;
  description?: string;
  category?: string;
  scoringMethod?: string;
  higherIsBetter?: boolean;
  introducedDate?: string;
  maintainer?: string;
  website?: string;
  sources?: Array<{ title: string; url?: string }>;
}

interface YamlModel {
  id: string;
  numericId?: string;
  type: string;
  title: string;
  developer?: string;
  benchmarks?: Array<{
    name: string;
    score: number;
    unit?: string;
    date?: string;
    source?: string;
  }>;
}

interface SyncBenchmark {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  website: string | null;
  scoringMethod: string | null;
  higherIsBetter: boolean;
  introducedDate: string | null;
  maintainer: string | null;
  source: string | null;
}

interface SyncBenchmarkResult {
  id: string;
  benchmarkId: string;
  modelId: string;
  score: number;
  unit: string | null;
  date: string | null;
  sourceUrl: string | null;
  notes: string | null;
}

// --- Benchmark name → slug aliases (same as benchmark-utils.ts) ---

function buildNameToSlugMap(benchmarks: YamlBenchmark[]): Map<string, string> {
  const map = new Map<string, string>();

  // Map by title
  for (const b of benchmarks) {
    map.set(b.title.toLowerCase(), b.id);
  }

  // Common aliases
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
    "aime 2024": "aime-2024",
    "aime": "aime-2025",
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

  for (const [alias, slug] of Object.entries(aliases)) {
    map.set(alias, slug);
  }

  return map;
}

// --- Data loading ---

export function loadBenchmarks(filePath: string = BENCHMARKS_FILE): YamlBenchmark[] {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (b: YamlBenchmark) => b.id && b.type === "benchmark" && b.title
  );
}

/**
 * Load benchmark results from ai-models.yaml, filtering to only benchmarks
 * whose slug is in the provided set. Returns results with benchmarkId = slug.
 */
export function loadBenchmarkResults(
  benchmarkIds: Set<string>,
  filePath: string = AI_MODELS_FILE,
): SyncBenchmarkResult[] {
  const models = loadModels(filePath);

  // Build a name → slug map using the static aliases
  const nameToSlug = new Map<string, string>();
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
    "aime 2024": "aime-2024",
    "aime": "aime-2025",
    "osworld": "osworld",
    "terminal-bench hard": "terminal-bench-hard",
    "terminal-bench 2": "terminal-bench-2",
    "terminal-bench 2.0": "terminal-bench-2",
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

  for (const [alias, slug] of Object.entries(aliases)) {
    if (benchmarkIds.has(slug)) {
      nameToSlug.set(alias, slug);
    }
  }
  // Also add direct benchmark IDs
  for (const id of benchmarkIds) {
    nameToSlug.set(id.toLowerCase(), id);
  }

  const results: SyncBenchmarkResult[] = [];
  for (const model of models) {
    if (!model.benchmarks?.length) continue;
    for (const b of model.benchmarks) {
      const slug = nameToSlug.get(b.name.toLowerCase());
      if (!slug) continue;

      results.push({
        id: contentHash(["benchmark-result", slug, model.id]),
        benchmarkId: slug,
        modelId: model.id,
        score: b.score,
        unit: b.unit ?? null,
        date: b.date ?? null,
        sourceUrl: b.source ?? null,
        notes: null,
      });
    }
  }

  return results;
}

export function loadModels(filePath: string = AI_MODELS_FILE): YamlModel[] {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (m: YamlModel) => m.id && m.type === "ai-model"
  );
}

// --- Transform ---

function transformBenchmark(b: YamlBenchmark): SyncBenchmark {
  // Use the numericId's stable ID from the ID registry
  // The numericId like "E1100" maps to a 10-char stable ID
  // For the sync, we need the 10-char stable PK.
  // Since benchmarks.yaml uses numericId like "E1100", we derive a deterministic
  // 10-char ID from the slug to ensure idempotent syncs.
  const stableId = contentHash(["benchmark", b.id]);

  return {
    id: stableId,
    slug: b.id,
    name: b.title,
    category: b.category ?? null,
    description: b.description ?? null,
    website: b.website ?? null,
    scoringMethod: b.scoringMethod ?? null,
    higherIsBetter: b.higherIsBetter ?? true,
    introducedDate: b.introducedDate ?? null,
    maintainer: b.maintainer ?? null,
    source: b.sources?.[0]?.url ?? null,
  };
}

function extractBenchmarkResults(
  models: YamlModel[],
  benchmarks: YamlBenchmark[],
  benchmarkSyncMap: Map<string, string>, // slug → 10-char stable ID
): { results: SyncBenchmarkResult[]; unmatchedNames: Set<string> } {
  const nameToSlug = buildNameToSlugMap(benchmarks);
  const results: SyncBenchmarkResult[] = [];
  const unmatchedNames = new Set<string>();

  for (const model of models) {
    if (!model.benchmarks?.length) continue;

    for (const b of model.benchmarks) {
      const slug = nameToSlug.get(b.name.toLowerCase());
      if (!slug) {
        unmatchedNames.add(b.name);
        continue;
      }

      const benchmarkId = benchmarkSyncMap.get(slug);
      if (!benchmarkId) {
        unmatchedNames.add(b.name);
        continue;
      }

      // Deterministic ID from (benchmarkSlug, modelId) — idempotent
      const resultId = contentHash(["benchmark-result", slug, model.id]);

      results.push({
        id: resultId,
        benchmarkId,
        modelId: model.id,
        score: b.score,
        unit: b.unit ?? null,
        date: b.date ?? null,
        sourceUrl: b.source ?? null,
        notes: null,
      });
    }
  }

  return { results, unmatchedNames };
}

// --- Sync functions ---

export async function syncBenchmarkDefinitions(
  serverUrl: string,
  items: SyncBenchmark[],
  batchSize: number,
  options: { _sleep?: (ms: number) => Promise<void> } = {}
): Promise<{ upserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/benchmarks/sync`,
    items,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "benchmarks",
      _sleep: options._sleep,
    },
  );
  return { upserted: result.count, errors: result.errors };
}

export async function syncBenchmarkResults(
  serverUrl: string,
  items: SyncBenchmarkResult[],
  batchSize: number,
  options: { _sleep?: (ms: number) => Promise<void> } = {}
): Promise<{ upserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/benchmark-results/sync`,
    items,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "benchmark results",
      _sleep: options._sleep,
    },
  );
  return { upserted: result.count, errors: result.errors };
}

// --- CLI ---

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || DEFAULT_BATCH_SIZE;

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    console.error("Error: LONGTERMWIKI_SERVER_URL environment variable is required");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("Error: LONGTERMWIKI_SERVER_API_KEY environment variable is required");
    process.exit(1);
  }

  // Load data
  console.log("Reading benchmarks from:", BENCHMARKS_FILE);
  const benchmarks = loadBenchmarks();
  console.log(`  Found ${benchmarks.length} benchmark definitions`);

  console.log("Reading models from:", AI_MODELS_FILE);
  const models = loadModels();
  const modelsWithBenchmarks = models.filter((m) => m.benchmarks?.length);
  console.log(`  Found ${modelsWithBenchmarks.length} models with benchmark data`);

  // Transform benchmarks
  const syncBenchmarks = benchmarks.map(transformBenchmark);

  // Build slug → stable ID map for result linking
  const benchmarkIdMap = new Map<string, string>();
  for (const sb of syncBenchmarks) {
    benchmarkIdMap.set(sb.slug, sb.id);
  }

  // Extract results
  const { results, unmatchedNames } = extractBenchmarkResults(
    models,
    benchmarks,
    benchmarkIdMap,
  );

  if (unmatchedNames.size > 0) {
    console.warn(`\n  WARNING: ${unmatchedNames.size} unmatched benchmark name(s):`);
    for (const name of unmatchedNames) {
      console.warn(`    - "${name}"`);
    }
  }

  // Summary
  const byBenchmark = new Map<string, number>();
  for (const r of results) {
    const slug = syncBenchmarks.find((b) => b.id === r.benchmarkId)?.slug ?? r.benchmarkId;
    byBenchmark.set(slug, (byBenchmark.get(slug) ?? 0) + 1);
  }

  console.log(`\nSync plan:`);
  console.log(`  Benchmarks: ${syncBenchmarks.length} definitions`);
  console.log(`  Results:    ${results.length} model scores`);
  console.log(`  Coverage:   ${[...byBenchmark.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(", ")}`);

  if (dryRun) {
    console.log("\n[dry-run] Would sync:");
    console.log("  Benchmarks:");
    for (const b of syncBenchmarks.slice(0, 5)) {
      console.log(`    ${b.slug} — ${b.name} [${b.category}]`);
    }
    if (syncBenchmarks.length > 5) {
      console.log(`    ... and ${syncBenchmarks.length - 5} more`);
    }
    console.log("  Results:");
    for (const r of results.slice(0, 5)) {
      console.log(`    ${r.modelId} on ${r.benchmarkId}: ${r.score}`);
    }
    if (results.length > 5) {
      console.log(`    ... and ${results.length - 5} more`);
    }
    process.exit(0);
  }

  // Pre-sync health check
  console.log("\nChecking server health...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error(`Error: Server at ${serverUrl} is not healthy after retries. Aborting sync.`);
    process.exit(1);
  }

  // Sync benchmarks first (results depend on benchmark IDs existing)
  console.log("\nSyncing benchmark definitions...");
  const benchmarkResult = await syncBenchmarkDefinitions(
    serverUrl,
    syncBenchmarks,
    batchSize,
  );
  console.log(`  Upserted: ${benchmarkResult.upserted}`);
  if (benchmarkResult.errors > 0) {
    console.error(`  Errors: ${benchmarkResult.errors}`);
    process.exit(1);
  }

  // Sync results
  console.log("\nSyncing benchmark results...");
  const resultsResult = await syncBenchmarkResults(
    serverUrl,
    results,
    batchSize,
  );
  console.log(`  Upserted: ${resultsResult.upserted}`);
  if (resultsResult.errors > 0) {
    console.error(`  Errors: ${resultsResult.errors}`);
    process.exit(1);
  }

  console.log(`\nSync complete: ${benchmarkResult.upserted} benchmarks, ${resultsResult.upserted} results`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
}
