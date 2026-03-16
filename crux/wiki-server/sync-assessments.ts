/**
 * Wiki Server Assessment Sync
 *
 * Reads pages.json and produces assessment rows for each page:
 *   - 'structural' assessor: suggestedQuality, structuralScore, wordCount
 *   - 'frontmatter-sync' assessor: quality, importance, ratings from frontmatter
 *
 * Usage:
 *   pnpm crux wiki-server sync-assessments
 *   pnpm crux wiki-server sync-assessments --dry-run
 *   pnpm crux wiki-server sync-assessments --batch-size=100
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL     Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY Bearer token for authentication
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { batchSync, waitForHealthy } from "./sync-common.ts";
import type { PageAssessment } from "../../apps/wiki-server/src/api-types.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const PAGES_JSON_PATH = join(
  PROJECT_ROOT,
  "apps/web/src/data/pages.json"
);

// --- Types ---

interface PageData {
  id: string;
  numericId?: string;
  title: string;
  quality?: number | null;
  readerImportance?: number | null;
  researchImportance?: number | null;
  tacticalValue?: number | null;
  ratings?: {
    focus?: number;
    novelty?: number;
    rigor?: number;
    completeness?: number;
    concreteness?: number;
    actionability?: number;
    objectivity?: number;
  } | null;
  metrics?: {
    wordCount?: number;
    structuralScore?: number;
  };
  suggestedQuality?: number | null;
  wordCount?: number;
  category?: string;
}

// --- Transform ---

function buildAssessments(page: PageData): PageAssessment[] {
  const assessments: PageAssessment[] = [];

  // 1. Structural assessor: auto-computed quality from metrics
  if (page.metrics?.structuralScore != null || page.suggestedQuality != null) {
    assessments.push({
      pageId: page.id,
      assessor: "structural",
      method: "metrics-extractor-v1",
      quality: page.suggestedQuality ?? null,
      structuralScore: page.metrics?.structuralScore ?? null,
      wordCount: page.wordCount ?? page.metrics?.wordCount ?? null,
    });
  }

  // 2. Frontmatter-sync assessor: human/LLM-assigned scores from MDX frontmatter
  const hasFrontmatterScoring =
    page.quality != null ||
    page.readerImportance != null ||
    page.researchImportance != null ||
    page.tacticalValue != null ||
    page.ratings != null;

  if (hasFrontmatterScoring) {
    assessments.push({
      pageId: page.id,
      assessor: "frontmatter-sync",
      method: "frontmatter-manual",
      quality: page.quality ?? null,
      readerImportance: page.readerImportance ?? null,
      researchImportance: page.researchImportance ?? null,
      tacticalValue: page.tacticalValue ?? null,
      ratingFocus: page.ratings?.focus ?? null,
      ratingNovelty: page.ratings?.novelty ?? null,
      ratingRigor: page.ratings?.rigor ?? null,
      ratingCompleteness: page.ratings?.completeness ?? null,
      ratingConcreteness: page.ratings?.concreteness ?? null,
      ratingActionability: page.ratings?.actionability ?? null,
      ratingObjectivity: page.ratings?.objectivity ?? null,
      wordCount: page.wordCount ?? page.metrics?.wordCount ?? null,
    });
  }

  return assessments;
}

// --- Sync ---

/** @internal — exported for testing */
export async function syncAssessments(
  serverUrl: string,
  assessments: PageAssessment[],
  batchSize: number,
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ inserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/assessments/batch`,
    assessments,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "inserted",
      itemLabel: "assessments",
      onBatchSuccess: (responseJson, _batch, batchNum, totalBatches, count) => {
        const skipped = (responseJson.skipped as number) ?? 0;
        const msg = skipped > 0 ? ` (${skipped} skipped — page ID not found)` : "";
        console.log(
          `  Batch ${batchNum}/${totalBatches}: ${count} inserted${msg}`
        );
      },
      _sleep: options._sleep,
    },
  );

  return { inserted: result.count, errors: result.errors };
}

// --- Main ---

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || 100;

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_URL environment variable is required"
    );
    process.exit(1);
  }
  if (!apiKey) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_API_KEY environment variable is required"
    );
    process.exit(1);
  }

  // Load pages.json
  if (!existsSync(PAGES_JSON_PATH)) {
    console.error(
      `Error: ${PAGES_JSON_PATH} not found. Run 'pnpm build-data:content' first.`
    );
    process.exit(1);
  }

  const rawPages: PageData[] = JSON.parse(
    readFileSync(PAGES_JSON_PATH, "utf-8")
  );

  // Filter out schema pages (same as sync-pages.ts)
  const filteredPages = rawPages.filter((p) => p.category !== "schema");

  // Build assessment rows
  const assessments = filteredPages.flatMap(buildAssessments);

  const structuralCount = assessments.filter((a) => a.assessor === "structural").length;
  const frontmatterCount = assessments.filter((a) => a.assessor === "frontmatter-sync").length;

  console.log(
    `Built ${assessments.length} assessments from ${filteredPages.length} pages:`
  );
  console.log(`  structural:       ${structuralCount}`);
  console.log(`  frontmatter-sync: ${frontmatterCount}`);

  if (dryRun) {
    console.log("\n[dry-run] Would sync these assessments:");
    for (const a of assessments.slice(0, 10)) {
      console.log(
        `  ${a.pageId} [${a.assessor}] quality=${a.quality ?? "-"} importance=${a.readerImportance ?? "-"}`
      );
    }
    if (assessments.length > 10) {
      console.log(`  ... and ${assessments.length - 10} more`);
    }
    process.exit(0);
  }

  // Pre-sync health check
  console.log("\nChecking server health...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error(
      `Error: Server at ${serverUrl} is not healthy. Aborting sync.`
    );
    process.exit(1);
  }

  // Sync
  console.log(`\nSyncing ${assessments.length} assessments (batch size: ${batchSize})...`);
  const result = await syncAssessments(serverUrl, assessments, batchSize);

  console.log(`\nSync complete:`);
  console.log(`  Inserted: ${result.inserted}`);
  if (result.errors > 0) {
    console.log(`  Errors:   ${result.errors}`);
    console.error(
      `\nSync failed with ${result.errors} assessment errors.`
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Assessment sync failed:", err);
    process.exit(1);
  });
}
