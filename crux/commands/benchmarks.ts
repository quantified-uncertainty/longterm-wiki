/**
 * Benchmarks Command Handlers
 *
 * Ingest benchmark data from external sources (Epoch AI) into wiki-server.
 *
 * Usage:
 *   pnpm crux tb benchmarks ingest-epoch                  # Dry-run (default)
 *   pnpm crux tb benchmarks ingest-epoch --apply           # Sync to wiki-server
 *   pnpm crux tb benchmarks ingest-epoch --benchmark=mmlu  # Single benchmark
 *   pnpm crux tb benchmarks ingest-epoch --force-download  # Re-download data
 *   pnpm crux tb benchmarks ingest-epoch --data-dir=/path  # Use local data
 */

import { join } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import type { CommandResult, CommandOptions as BaseOptions } from "../lib/command-types.ts";

interface CommandOptions extends BaseOptions {
  apply?: boolean;
  forceDownload?: boolean;
  dataDir?: string;
  benchmark?: string;
  batchSize?: string;
}

const AI_MODELS_YAML = join(PROJECT_ROOT, "data/entities/ai-models.yaml");
const BENCHMARKS_YAML = join(PROJECT_ROOT, "data/entities/benchmarks.yaml");
const DEFAULT_CACHE_DIR = join(PROJECT_ROOT, ".cache/epoch-benchmarks");

async function ingestEpochCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const {
    downloadAndExtract,
    runIngestionPipeline,
  } = await import("../lib/epoch-benchmark/ingest.ts");

  const apply = options.apply === true;
  const forceDownload = options.forceDownload === true;
  const batchSize = Number(options.batchSize) || 100;
  const benchmarkFilter = options.benchmark
    ? options.benchmark.split(",").map((b) => b.trim())
    : undefined;

  // Use console.log for streaming output. Return empty output string
  // since the CLI framework would otherwise double-print it.
  const log = (msg: string) => {
    console.log(msg);
  };

  log("Epoch AI Benchmark Ingestion");
  log("============================\n");

  // Step 1: Get the data
  let dataDir: string;
  if (options.dataDir) {
    dataDir = options.dataDir;
    log(`Using local data directory: ${dataDir}`);
  } else {
    log("Downloading Epoch AI benchmark data...");
    dataDir = await downloadAndExtract(DEFAULT_CACHE_DIR, { forceDownload });
  }

  // Step 2: Run ingestion pipeline
  log("\nRunning ingestion pipeline...");
  const { summary, results } = runIngestionPipeline(dataDir, {
    modelsYamlPath: AI_MODELS_YAML,
    benchmarksYamlPath: BENCHMARKS_YAML,
    benchmarkFilter,
  });

  // Step 3: Print summary
  log("\n--- Summary ---");
  log(`Files processed: ${summary.filesProcessed}`);
  log(`  Mapped to our benchmarks: ${summary.filesMapped}`);
  log(`  Unmapped (skipped): ${summary.filesUnmapped}`);
  log(`Total CSV rows: ${summary.totalRows}`);
  log(`Matched results: ${summary.matchedResults}`);
  log(`Unmatched model rows: ${summary.unmatchedModelRows}`);

  if (summary.perBenchmark.length > 0) {
    log("\n--- Per-Benchmark Breakdown ---");
    for (const pb of summary.perBenchmark) {
      const pct =
        pb.totalRows > 0
          ? ((pb.matchedRows / pb.totalRows) * 100).toFixed(0)
          : "0";
      log(
        `  ${pb.benchmarkSlug.padEnd(30)} ${String(pb.matchedRows).padStart(4)}/${String(pb.totalRows).padStart(4)} rows matched (${pct}%)`,
      );
    }
  }

  if (summary.unmatchedModels.length > 0) {
    log(`\n--- Unmatched Models (${summary.unmatchedModels.length}) ---`);
    // Show the first 30 unmatched models
    const shown = summary.unmatchedModels.slice(0, 30);
    for (const m of shown) {
      log(`  - ${m}`);
    }
    if (summary.unmatchedModels.length > 30) {
      log(`  ... and ${summary.unmatchedModels.length - 30} more`);
    }
  }

  if (summary.unmappedBenchmarks.length > 0) {
    log(`\n--- Unmapped Benchmark Files (${summary.unmappedBenchmarks.length}) ---`);
    for (const b of summary.unmappedBenchmarks) {
      log(`  - ${b}`);
    }
  }

  // Step 4: Preview or sync
  if (results.length === 0) {
    log("\nNo results to sync.");
    return { exitCode: 0, output: "" };
  }

  if (!apply) {
    log(`\n--- Dry Run ---`);
    log(`Would sync ${results.length} benchmark results to wiki-server.`);
    log("Sample results:");
    for (const r of results.slice(0, 10)) {
      log(
        `  ${r.modelId} on ${r.benchmarkId}: ${r.score} (${r.notes})`,
      );
    }
    if (results.length > 10) {
      log(`  ... and ${results.length - 10} more`);
    }
    log("\nRun with --apply to sync to wiki-server.");
    return { exitCode: 0, output: "" };
  }

  // Sync to wiki-server
  log(`\n--- Syncing ${results.length} results to wiki-server ---`);

  const { getServerUrl, getApiKey } = await import(
    "../lib/wiki-server/client.ts"
  );
  const { waitForHealthy, batchSync } = await import(
    "../wiki-server/sync-common.ts"
  );

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    log("Error: LONGTERMWIKI_SERVER_URL is not set.");
    return { exitCode: 1, output: "" };
  }
  if (!apiKey) {
    log("Error: LONGTERMWIKI_SERVER_API_KEY is not set.");
    return { exitCode: 1, output: "" };
  }

  // Health check
  log("Checking server health...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    log(`Error: Server at ${serverUrl} is not healthy. Aborting.`);
    return { exitCode: 1, output: "" };
  }

  // Sync in batches via the existing benchmark-results/sync endpoint
  const syncResult = await batchSync(
    `${serverUrl}/api/benchmark-results/sync`,
    results,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "benchmark results",
    },
  );

  log(`\nSync complete: ${syncResult.count} upserted, ${syncResult.errors} errors.`);

  return {
    exitCode: syncResult.errors > 0 ? 1 : 0,
    output: "",
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export const commands: Record<
  string,
  (args: string[], options: Record<string, unknown>) => Promise<CommandResult>
> = {
  "ingest-epoch": ingestEpochCommand as (
    args: string[],
    options: Record<string, unknown>,
  ) => Promise<CommandResult>,
};

export function getHelp(): string {
  return `
Benchmarks — ingest benchmark data from external sources.

Commands:
  ingest-epoch     Ingest Epoch AI benchmark scores into wiki-server

Options (ingest-epoch):
  --apply           Sync results to wiki-server (default: dry-run)
  --force-download  Re-download data even if cached
  --data-dir=PATH   Use local extracted CSV directory instead of downloading
  --benchmark=SLUG  Only process specific benchmark(s), comma-separated
  --batch-size=N    Batch size for wiki-server sync (default: 100)

Examples:
  pnpm crux tb benchmarks ingest-epoch                     # Dry-run preview
  pnpm crux tb benchmarks ingest-epoch --apply              # Sync to wiki-server
  pnpm crux tb benchmarks ingest-epoch --benchmark=mmlu     # Single benchmark
  pnpm crux tb benchmarks ingest-epoch --force-download     # Refresh cached data
  pnpm crux tb benchmarks ingest-epoch --data-dir=/tmp/epoch_benchmarks
`.trim();
}
