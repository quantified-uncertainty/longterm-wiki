/**
 * Wiki Server Auto-Update Runs Sync
 *
 * Reads all data/auto-update/runs/*.yaml files and POSTs each one to the
 * wiki-server's /api/auto-update-runs endpoint.
 *
 * Unlike edit-logs and sessions which have batch endpoints, auto-update runs
 * are POSTed individually (each run is a complex object with nested results).
 *
 * Reuses the retry + health-check pattern from sync-pages.ts.
 *
 * Usage:
 *   pnpm crux wiki-server sync-auto-update-runs
 *   pnpm crux wiki-server sync-auto-update-runs --dry-run
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
import {
  getServerUrl,
  getApiKey,
  buildHeaders,
  type RecordAutoUpdateRunInput,
  type AutoUpdateRunResultEntry,
} from '../lib/wiki-server-client.ts';
import { waitForHealthy, fetchWithRetry } from './sync-pages.ts';

const PROJECT_ROOT = join(import.meta.dirname!, '../..');
const RUNS_DIR = join(PROJECT_ROOT, 'data/auto-update/runs');

// --- Configuration ---
const MAX_CONSECUTIVE_FAILURES = 3;

// --- Types ---

interface YamlAutoUpdateRun {
  date: string | Date;
  startedAt: string | Date;
  completedAt?: string | Date;
  trigger: string;
  budget?: {
    limit?: number;
    spent?: number;
  };
  digest?: {
    sourcesChecked?: number;
    sourcesFailed?: number;
    itemsFetched?: number;
    itemsRelevant?: number;
  };
  plan?: {
    pagesPlanned?: number;
    newPagesSuggested?: number;
  };
  execution?: {
    pagesUpdated?: number;
    pagesFailed?: number;
    pagesSkipped?: number;
    results?: Array<{
      pageId: string;
      status: string;
      tier?: string;
      durationMs?: number;
      errorMessage?: string;
    }>;
  };
  newPagesCreated?: string[];
}

// --- Helpers ---

function normalizeTimestamp(d: string | Date): string {
  if (d instanceof Date) return d.toISOString();
  const str = String(d);
  // Already an ISO string
  if (str.includes('T')) return str;
  // Just a date — add midnight
  return str + 'T00:00:00Z';
}

function toTrigger(raw: string): 'scheduled' | 'manual' {
  return raw === 'scheduled' ? 'scheduled' : 'manual';
}

/**
 * Parse a single auto-update run YAML file into the API input format.
 * Returns null for detail files (e.g., *-details.yaml).
 */
export function parseRunYaml(filePath: string): RecordAutoUpdateRunInput | null {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) as YamlAutoUpdateRun;

  if (!parsed || typeof parsed !== 'object' || !parsed.startedAt) {
    return null;
  }

  const results: AutoUpdateRunResultEntry[] = [];
  if (parsed.execution?.results && Array.isArray(parsed.execution.results)) {
    for (const r of parsed.execution.results) {
      if (!r.pageId || !r.status) continue;
      results.push({
        pageId: r.pageId,
        status: r.status as 'success' | 'failed' | 'skipped',
        tier: r.tier ?? null,
        durationMs: r.durationMs ?? null,
        errorMessage: r.errorMessage ?? null,
      });
    }
  }

  return {
    date: parsed.date
      ? (parsed.date instanceof Date ? parsed.date.toISOString().split('T')[0] : String(parsed.date))
      : normalizeTimestamp(parsed.startedAt).split('T')[0],
    startedAt: normalizeTimestamp(parsed.startedAt),
    completedAt: parsed.completedAt ? normalizeTimestamp(parsed.completedAt) : null,
    trigger: toTrigger(String(parsed.trigger || 'manual')),
    budgetLimit: parsed.budget?.limit ?? null,
    budgetSpent: parsed.budget?.spent ?? null,
    sourcesChecked: parsed.digest?.sourcesChecked ?? null,
    sourcesFailed: parsed.digest?.sourcesFailed ?? null,
    itemsFetched: parsed.digest?.itemsFetched ?? null,
    itemsRelevant: parsed.digest?.itemsRelevant ?? null,
    pagesPlanned: parsed.plan?.pagesPlanned ?? null,
    pagesUpdated: parsed.execution?.pagesUpdated ?? null,
    pagesFailed: parsed.execution?.pagesFailed ?? null,
    pagesSkipped: parsed.execution?.pagesSkipped ?? null,
    newPagesCreated: parsed.newPagesCreated ?? [],
    results,
  };
}

/**
 * Read all data/auto-update/runs/*.yaml files and return parsed run entries.
 * Skips detail files (*-details.yaml) which contain supplementary data.
 * Exported for testing.
 */
export function loadRunYamls(
  dir: string = RUNS_DIR,
): { runs: RecordAutoUpdateRunInput[]; fileCount: number; errorFiles: number } {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !f.includes('-details'));
  const runs: RecordAutoUpdateRunInput[] = [];
  let errorFiles = 0;

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const run = parseRunYaml(filePath);
      if (run) {
        runs.push(run);
      } else {
        console.warn(`  WARN: ${file} — could not parse, skipping`);
        errorFiles++;
      }
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  return { runs, fileCount: files.length, errorFiles };
}

/**
 * Sync auto-update runs to the wiki-server one at a time.
 * Exported for testing.
 */
export async function syncAutoUpdateRuns(
  serverUrl: string,
  runs: RecordAutoUpdateRunInput[],
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ inserted: number; errors: number }> {
  let totalInserted = 0;
  let totalErrors = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];

    try {
      const res = await fetchWithRetry(
        `${serverUrl}/api/auto-update-runs`,
        {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(run),
        },
        { _sleep: options._sleep },
      );

      if (!res.ok) {
        const body = await res.text();
        console.error(
          `  Run ${i + 1}/${runs.length} (${run.date}): HTTP ${res.status} — ${body}`,
        );
        totalErrors++;
        consecutiveFailures++;
      } else {
        const result = (await res.json()) as { id: number; resultsInserted: number };
        totalInserted++;
        consecutiveFailures = 0;

        console.log(
          `  Run ${i + 1}/${runs.length} (${run.date}): inserted (id: ${result.id}, ${result.resultsInserted} results)`,
        );
      }
    } catch (err) {
      console.error(
        `  Run ${i + 1}/${runs.length} (${run.date}): Failed after retries — ${err}`,
      );
      totalErrors++;
      consecutiveFailures++;
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const remaining = runs.length - (i + 1);
      if (remaining > 0) {
        console.error(
          `\n  Aborting: ${MAX_CONSECUTIVE_FAILURES} consecutive failures. ` +
            `Skipping ${remaining} remaining runs.`,
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

  // Load runs
  console.log(`Reading auto-update runs from: ${RUNS_DIR}`);
  const { runs, fileCount, errorFiles } = loadRunYamls();

  console.log(`  Found ${runs.length} runs across ${fileCount} files`);
  if (errorFiles > 0) {
    console.warn(`  ${errorFiles} file(s) had errors`);
  }

  const totalResults = runs.reduce((sum, r) => sum + (r.results?.length ?? 0), 0);
  console.log(
    `Syncing ${runs.length} auto-update runs to ${serverUrl}`,
  );
  console.log(`  ${totalResults} total per-page results`);

  if (dryRun) {
    console.log('\n[dry-run] Would sync these auto-update runs:');
    for (const run of runs) {
      console.log(
        `  ${run.date} — ${run.trigger} — ` +
          `${run.pagesUpdated ?? 0} updated, ${run.pagesFailed ?? 0} failed`,
      );
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
  const result = await syncAutoUpdateRuns(serverUrl, runs);

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
