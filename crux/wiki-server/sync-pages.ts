/**
 * Wiki Server Page Sync
 *
 * Reads pages.json metadata and per-page .txt content files,
 * then bulk-upserts them to the wiki-server's /api/pages/sync endpoint.
 *
 * Usage:
 *   pnpm crux wiki-server sync
 *   pnpm crux wiki-server sync --dry-run
 *   pnpm crux wiki-server sync --batch-size=50
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseCliArgs } from "../lib/cli.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const PAGES_JSON_PATH = join(
  PROJECT_ROOT,
  "apps/web/src/data/pages.json"
);
const WIKI_DIR = join(PROJECT_ROOT, "apps/web/public/wiki");

interface PageData {
  id: string;
  numericId?: string;
  title: string;
  description?: string;
  llmSummary?: string;
  category?: string;
  subcategory?: string;
  entityType?: string;
  tags?: string[];
  quality?: number;
  readerImportance?: number;
  hallucinationRisk?: {
    level?: string;
    score?: number;
  };
  wordCount?: number;
  lastUpdated?: string;
  contentFormat?: string;
}

interface SyncPage {
  id: string;
  numericId: string | null;
  title: string;
  description: string | null;
  llmSummary: string | null;
  category: string | null;
  subcategory: string | null;
  entityType: string | null;
  tags: string | null;
  quality: number | null;
  readerImportance: number | null;
  hallucinationRiskLevel: string | null;
  hallucinationRiskScore: number | null;
  contentPlaintext: string | null;
  wordCount: number | null;
  lastUpdated: string | null;
  contentFormat: string | null;
}

async function syncPages(
  serverUrl: string,
  apiKey: string,
  pages: SyncPage[],
  batchSize: number
): Promise<{ upserted: number; errors: number }> {
  let totalCreated = 0;
  let totalErrors = 0;

  for (let i = 0; i < pages.length; i += batchSize) {
    const batch = pages.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(pages.length / batchSize);

    try {
      const res = await fetch(`${serverUrl}/api/pages/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ pages: batch }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(
          `  Batch ${batchNum}/${totalBatches}: HTTP ${res.status} — ${body}`
        );
        totalErrors += batch.length;
        continue;
      }

      const result = (await res.json()) as {
        upserted: number;
        totalIndexed: number;
      };
      totalCreated += result.upserted;

      console.log(
        `  Batch ${batchNum}/${totalBatches}: ${result.upserted} upserted (${result.totalIndexed} indexed)`
      );
    } catch (err) {
      console.error(
        `  Batch ${batchNum}/${totalBatches}: Network error — ${err}`
      );
      totalErrors += batch.length;
    }
  }

  return { upserted: totalCreated, errors: totalErrors };
}

function loadContent(numericId: string | undefined): string | null {
  if (!numericId) return null;

  const txtPath = join(WIKI_DIR, `${numericId}.txt`);
  if (!existsSync(txtPath)) return null;

  try {
    return readFileSync(txtPath, "utf-8");
  } catch {
    return null;
  }
}

function transformPage(page: PageData): SyncPage {
  const content = loadContent(page.numericId);

  return {
    id: page.id,
    numericId: page.numericId ?? null,
    title: page.title,
    description: page.description ?? null,
    llmSummary: page.llmSummary ?? null,
    category: page.category ?? null,
    subcategory: page.subcategory ?? null,
    entityType: page.entityType ?? null,
    tags: page.tags ? JSON.stringify(page.tags) : null,
    quality: page.quality ?? null,
    readerImportance: page.readerImportance ?? null,
    hallucinationRiskLevel: page.hallucinationRisk?.level ?? null,
    hallucinationRiskScore: page.hallucinationRisk?.score ?? null,
    contentPlaintext: content,
    wordCount: page.wordCount ?? null,
    lastUpdated: page.lastUpdated ?? null,
    contentFormat: page.contentFormat ?? null,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || 50;

  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

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
      `Error: ${PAGES_JSON_PATH} not found. Run 'node apps/web/scripts/build-data.mjs' first.`
    );
    process.exit(1);
  }

  const rawPages: PageData[] = JSON.parse(
    readFileSync(PAGES_JSON_PATH, "utf-8")
  );

  // Filter out internal/schema pages
  const filteredPages = rawPages.filter(
    (p) => p.category !== "internal" && p.category !== "schema"
  );

  console.log(
    `Syncing ${filteredPages.length} pages to ${serverUrl} (batch size: ${batchSize})`
  );

  // Transform pages
  const syncPayloads = filteredPages.map(transformPage);

  const withContent = syncPayloads.filter((p) => p.contentPlaintext);
  const totalContentSize = syncPayloads.reduce(
    (sum, p) => sum + (p.contentPlaintext?.length ?? 0),
    0
  );

  console.log(
    `  ${withContent.length}/${syncPayloads.length} pages have content (~${(totalContentSize / 1024 / 1024).toFixed(1)} MB)`
  );

  if (dryRun) {
    console.log("\n[dry-run] Would sync these pages:");
    for (const p of syncPayloads.slice(0, 10)) {
      console.log(`  ${p.id} (${p.numericId}) — ${p.title}`);
    }
    if (syncPayloads.length > 10) {
      console.log(`  ... and ${syncPayloads.length - 10} more`);
    }
    process.exit(0);
  }

  // Sync
  const result = await syncPages(serverUrl, apiKey, syncPayloads, batchSize);

  console.log(`\nSync complete:`);
  console.log(`  Upserted: ${result.upserted}`);
  if (result.errors > 0) {
    console.log(`  Errors:  ${result.errors}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
