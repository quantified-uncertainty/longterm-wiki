/**
 * Wiki Server Benchmarks Sync
 *
 * Reads data/entities/benchmarks.yaml and inline benchmark results from
 * data/entities/ai-models.yaml, then syncs both to the wiki-server:
 *   - Benchmark definitions → /api/benchmarks/sync
 *   - Benchmark results (model scores) → /api/benchmark-results/sync
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
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { waitForHealthy, batchSync } from "./sync-common.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const ENTITIES_DIR = join(PROJECT_ROOT, "data/entities");

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

interface YamlAiModel {
  id: string;
  type: string;
  title: string;
  developer?: string;
  benchmarks?: Array<{ name: string; score: number; unit?: string }>;
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

// --- Alias map: inline benchmark name → benchmark entity ID ---
const BENCHMARK_NAME_ALIASES: Record<string, string> = {
  mmlu: "mmlu",
  "swe-bench": "swe-bench-verified",
  "swe-bench verified": "swe-bench-verified",
  math: "math-benchmark",
  humaneval: "humaneval",
  "gpqa diamond": "gpqa-diamond",
  gpqa: "gpqa-diamond",
  "arc-agi": "arc-agi",
  "arc-agi-2": "arc-agi-2",
  "aime 2025": "aime-2025",
  aime: "aime-2025",
  osworld: "osworld",
  "terminal-bench hard": "terminal-bench-hard",
  "terminal-bench 2": "terminal-bench-2",
  "artificial analysis intelligence index":
    "artificial-analysis-intelligence-index",
};

// --- Helpers ---

/**
 * Generate a deterministic 10-char ID for a benchmark result
 * from the (benchmarkId, modelId) pair.
 */
function generateResultId(benchmarkId: string, modelId: string): string {
  const hash = createHash("md5")
    .update(`br:${benchmarkId}:${modelId}`)
    .digest("hex");
  return hash.slice(0, 10);
}

function transformBenchmark(b: YamlBenchmark): SyncBenchmark {
  return {
    id: b.id,
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

/**
 * Load benchmark entities from benchmarks.yaml.
 */
export function loadBenchmarks(): YamlBenchmark[] {
  const filePath = join(ENTITIES_DIR, "benchmarks.yaml");
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  if (!Array.isArray(parsed)) {
    console.warn("  WARN: benchmarks.yaml is not an array");
    return [];
  }
  return parsed.filter(
    (e: YamlBenchmark) => e.id && e.type === "benchmark" && e.title,
  );
}

/**
 * Load ai-model entities and extract inline benchmark results.
 */
export function loadBenchmarkResults(
  benchmarkIds: Set<string>,
): SyncBenchmarkResult[] {
  const filePath = join(ENTITIES_DIR, "ai-models.yaml");
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw) as YamlAiModel[];
  if (!Array.isArray(parsed)) return [];

  // Build name-to-slug map from benchmarkIds + aliases
  const nameToSlug = new Map<string, string>();
  for (const id of benchmarkIds) {
    nameToSlug.set(id.toLowerCase(), id);
  }
  for (const [alias, slug] of Object.entries(BENCHMARK_NAME_ALIASES)) {
    if (benchmarkIds.has(slug)) {
      nameToSlug.set(alias, slug);
    }
  }

  const results: SyncBenchmarkResult[] = [];
  for (const model of parsed) {
    if (model.type !== "ai-model" || !model.benchmarks) continue;

    for (const b of model.benchmarks) {
      const benchmarkId = nameToSlug.get(b.name.toLowerCase());
      if (!benchmarkId) continue;

      results.push({
        id: generateResultId(benchmarkId, model.id),
        benchmarkId,
        modelId: model.id,
        score: b.score,
        unit: b.unit ?? null,
        date: null,
        sourceUrl: null,
        notes: null,
      });
    }
  }

  return results;
}

// --- CLI ---

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || DEFAULT_BATCH_SIZE;

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_URL environment variable is required",
    );
    process.exit(1);
  }
  if (!apiKey) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_API_KEY environment variable is required",
    );
    process.exit(1);
  }

  // Load benchmarks
  console.log(`Reading benchmarks from: ${ENTITIES_DIR}`);
  const benchmarks = loadBenchmarks();
  const syncBenchmarks = benchmarks.map(transformBenchmark);
  console.log(`  Found ${syncBenchmarks.length} benchmark definitions`);

  // Load benchmark results from ai-model inline data
  const benchmarkIds = new Set(benchmarks.map((b) => b.id));
  const results = loadBenchmarkResults(benchmarkIds);
  console.log(`  Found ${results.length} benchmark results from ai-models`);

  if (dryRun) {
    console.log("\n[dry-run] Benchmark definitions:");
    for (const b of syncBenchmarks) {
      console.log(`  ${b.id} [${b.category ?? "?"}] — ${b.name}`);
    }
    console.log("\n[dry-run] Benchmark results (first 20):");
    for (const r of results.slice(0, 20)) {
      console.log(`  ${r.benchmarkId} / ${r.modelId}: ${r.score}`);
    }
    if (results.length > 20) {
      console.log(`  ... and ${results.length - 20} more`);
    }
    process.exit(0);
  }

  // Pre-sync health check
  console.log("\nChecking server health...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error(
      `Error: Server at ${serverUrl} is not healthy after retries. Aborting sync.`,
    );
    process.exit(1);
  }

  // Sync benchmark definitions first (results have FK to benchmarks)
  console.log(
    `\nSyncing ${syncBenchmarks.length} benchmarks to ${serverUrl}...`,
  );
  const benchmarkResult = await batchSync(
    `${serverUrl}/api/benchmarks/sync`,
    syncBenchmarks,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "benchmarks",
    },
  );
  console.log(`  Benchmarks upserted: ${benchmarkResult.count}`);
  if (benchmarkResult.errors > 0) {
    console.error(`  Benchmark errors: ${benchmarkResult.errors}`);
    process.exit(1);
  }

  // Sync benchmark results
  console.log(`\nSyncing ${results.length} benchmark results...`);
  const resultsResult = await batchSync(
    `${serverUrl}/api/benchmark-results/sync`,
    results,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "benchmark results",
    },
  );
  console.log(`  Results upserted: ${resultsResult.count}`);
  if (resultsResult.errors > 0) {
    console.error(`  Result errors: ${resultsResult.errors}`);
    process.exit(1);
  }

  console.log("\nSync complete.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
}
