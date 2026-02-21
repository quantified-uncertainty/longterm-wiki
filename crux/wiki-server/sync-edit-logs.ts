/**
 * Wiki Server Edit Logs Sync
 *
 * Reads all data/edit-logs/*.yaml files and bulk-upserts them to the
 * wiki-server's /api/edit-logs/batch endpoint.
 *
 * Reuses the retry + health-check pattern from sync-pages.ts.
 *
 * Usage:
 *   pnpm crux wiki-server sync-edit-logs
 *   pnpm crux wiki-server sync-edit-logs --dry-run
 *   pnpm crux wiki-server sync-edit-logs --batch-size=200
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { parseCliArgs } from '../lib/cli.ts';
import { getServerUrl, getApiKey, buildHeaders, type EditLogApiEntry } from '../lib/wiki-server-client.ts';
import { waitForHealthy, fetchWithRetry } from './sync-pages.ts';

const PROJECT_ROOT = join(import.meta.dirname!, '../..');
const EDIT_LOGS_DIR = join(PROJECT_ROOT, 'data/edit-logs');

// --- Configuration ---
const DEFAULT_BATCH_SIZE = 200;
const MAX_CONSECUTIVE_FAILURES = 3;

// --- Types ---

interface YamlEditLogEntry {
  date: string | Date;
  tool: string;
  agency: string;
  requestedBy?: string;
  note?: string;
}

// --- Helpers ---

function normalizeDate(d: string | Date): string {
  if (d instanceof Date) return d.toISOString().split('T')[0];
  return String(d);
}

/**
 * Read all data/edit-logs/*.yaml files and return flattened entries.
 * Each YAML file is an array of entries for the page whose ID matches the filename.
 * Exported for testing.
 */
export function loadEditLogYamls(
  dir: string = EDIT_LOGS_DIR,
): { entries: EditLogApiEntry[]; fileCount: number; errorFiles: number } {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const entries: EditLogApiEntry[] = [];
  let errorFiles = 0;

  for (const file of files) {
    const pageId = file.replace('.yaml', '');
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw);

      if (!Array.isArray(parsed)) {
        console.warn(`  WARN: ${file} — not an array, skipping`);
        errorFiles++;
        continue;
      }

      for (const entry of parsed as YamlEditLogEntry[]) {
        if (!entry.date || !entry.tool || !entry.agency) {
          console.warn(`  WARN: ${file} — entry missing required fields, skipping`);
          continue;
        }
        entries.push({
          pageId,
          date: normalizeDate(entry.date),
          tool: String(entry.tool),
          agency: String(entry.agency),
          requestedBy: entry.requestedBy ? String(entry.requestedBy) : null,
          note: entry.note ? String(entry.note) : null,
        });
      }
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  return { entries, fileCount: files.length, errorFiles };
}

/**
 * Sync edit log entries to the wiki-server in batches.
 * Exported for testing.
 */
export async function syncEditLogs(
  serverUrl: string,
  items: EditLogApiEntry[],
  batchSize: number,
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ inserted: number; errors: number }> {
  let totalInserted = 0;
  let totalErrors = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);

    try {
      const res = await fetchWithRetry(
        `${serverUrl}/api/edit-logs/batch`,
        {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({ items: batch }),
        },
        { _sleep: options._sleep },
      );

      if (!res.ok) {
        const body = await res.text();
        console.error(
          `  Batch ${batchNum}/${totalBatches}: HTTP ${res.status} — ${body}`,
        );
        totalErrors += batch.length;
        consecutiveFailures++;
      } else {
        const result = (await res.json()) as { inserted: number };
        totalInserted += result.inserted;
        consecutiveFailures = 0;

        console.log(
          `  Batch ${batchNum}/${totalBatches}: ${result.inserted} inserted`,
        );
      }
    } catch (err) {
      console.error(
        `  Batch ${batchNum}/${totalBatches}: Failed after retries — ${err}`,
      );
      totalErrors += batch.length;
      consecutiveFailures++;
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const remaining = items.length - (i + batchSize);
      if (remaining > 0) {
        console.error(
          `\n  Aborting: ${MAX_CONSECUTIVE_FAILURES} consecutive batch failures. ` +
            `Skipping ${remaining} remaining entries.`,
        );
        totalErrors += remaining;
      }
      break;
    }
  }

  return { inserted: totalInserted, errors: totalErrors };
}

// --- CLI ---

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const batchSize = Number(args['batch-size']) || DEFAULT_BATCH_SIZE;

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    console.error('Error: LONGTERMWIKI_SERVER_URL environment variable is required');
    process.exit(1);
  }
  if (!apiKey) {
    console.error('Error: LONGTERMWIKI_SERVER_API_KEY environment variable is required');
    process.exit(1);
  }

  // Load edit logs
  console.log(`Reading edit logs from: ${EDIT_LOGS_DIR}`);
  const { entries, fileCount, errorFiles } = loadEditLogYamls();

  console.log(`  Found ${entries.length} entries across ${fileCount} files`);
  if (errorFiles > 0) {
    console.warn(`  ${errorFiles} file(s) had errors`);
  }

  console.log(
    `Syncing ${entries.length} edit log entries to ${serverUrl} (batch size: ${batchSize})`,
  );

  if (dryRun) {
    console.log('\n[dry-run] Would sync these edit log entries:');
    const uniquePages = new Set(entries.map((e) => e.pageId));
    console.log(`  ${entries.length} entries across ${uniquePages.size} pages`);
    for (const entry of entries.slice(0, 10)) {
      console.log(`  ${entry.pageId} — ${entry.date} — ${entry.tool} (${entry.agency})`);
    }
    if (entries.length > 10) {
      console.log(`  ... and ${entries.length - 10} more`);
    }
    process.exit(0);
  }

  // Pre-sync health check
  console.log('\nChecking server health...');
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error(
      `Error: Server at ${serverUrl} is not healthy after retries. Aborting sync.`,
    );
    process.exit(1);
  }

  // Sync
  const result = await syncEditLogs(serverUrl, entries, batchSize);

  console.log(`\nSync complete:`);
  console.log(`  Inserted: ${result.inserted}`);
  if (result.errors > 0) {
    console.log(`  Errors:  ${result.errors}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Sync failed:', err);
    process.exit(1);
  });
}
