/**
 * Scanner Results Sync — runs a full TableBase scan and persists results to wiki-server.
 *
 * Transforms the scanner's TableProfile output into rows for the
 * tablebase_scanner_results PG table, grouped under a single scan_run_id.
 *
 * Usage:
 *   pnpm crux wiki-server sync-scanner-results [--dry-run] [--batch-size=N]
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { batchSync, waitForHealthy } from "./sync-common.ts";
import { runFullScan } from "../tablebase/scanner.ts";
import type { ScanSummary, TableProfile } from "../tablebase/types.ts";

interface ScannerResultItem {
  scanRunId: string;
  recordType: string;
  entityId: string;
  entityName: string;
  entityType: string;
  totalRecords: number;
  verifiedRecords: number;
  completenessPct: number;
  missingFields: string[];
  entityImportance: number | null;
  scannedAt: string;
}

/**
 * Transform a ScanSummary into flat rows for the scanner_results table.
 * Each TableProfile becomes one row, all sharing the same scanRunId.
 */
export function transformScanToItems(
  scan: ScanSummary,
  scanRunId: string,
): ScannerResultItem[] {
  const items: ScannerResultItem[] = [];

  for (const table of scan.tables) {
    for (const profile of table.profiles) {
      // Compute verified records as totalRecords * completeness / 100
      const verifiedRecords = Math.round(
        profile.totalRecords * profile.completenessPercent / 100,
      );

      items.push({
        scanRunId,
        recordType: table.table,
        entityId: profile.entityId,
        entityName: profile.entityName,
        entityType: profile.entityType,
        totalRecords: profile.totalRecords,
        verifiedRecords,
        completenessPct: profile.completenessPercent,
        missingFields: profile.missingFields,
        entityImportance: profile.entityImportance ?? null,
        scannedAt: scan.timestamp,
      });
    }
  }

  return items;
}

/**
 * Sync scanner results to the wiki-server.
 * Exported for testing and for use by the --persist flag in the scan command.
 */
export async function syncScannerResults(
  serverUrl: string,
  items: ScannerResultItem[],
  batchSize: number = 200,
  options: { _sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ inserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/scanner-results/sync`,
    items,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "scanner results",
      _sleep: options._sleep,
    },
  );

  return { inserted: result.count, errors: result.errors };
}

// --- CLI ---

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || 200;

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

  console.log("Running full TableBase scan...");
  const scan = await runFullScan();
  const scanRunId = randomUUID();
  const items = transformScanToItems(scan, scanRunId);

  console.log(`  Scan completed: ${scan.tables.length} tables, ${items.length} entity profiles`);
  console.log(`  Scan run ID: ${scanRunId}`);

  // Summary per table
  for (const table of scan.tables) {
    console.log(
      `    ${table.table}: ${table.profiles.length} entities, ${table.totalRecords} records, avg ${table.avgCompleteness}% complete`,
    );
  }

  if (dryRun) {
    console.log(`\n[dry-run] Would sync ${items.length} scanner result rows`);
    process.exit(0);
  }

  console.log(`\nSyncing ${items.length} scanner results to ${serverUrl}...`);
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error("Server is not healthy, aborting");
    process.exit(1);
  }

  const result = await syncScannerResults(serverUrl, items, batchSize);
  console.log(`\nDone: ${result.inserted} synced, ${result.errors} errors`);
  if (result.errors > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
