/**
 * Wiki Server Sessions Sync (bulk)
 *
 * Reads all .claude/sessions/*.yaml files and bulk-upserts them to the
 * wiki-server's /api/sessions/batch endpoint.
 *
 * Reuses the shared batch sync infrastructure from sync-common.ts.
 *
 * Usage:
 *   pnpm crux wiki-server sync-sessions
 *   pnpm crux wiki-server sync-sessions --dry-run
 *   pnpm crux wiki-server sync-sessions --batch-size=50
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getServerUrl, getApiKey } from '../lib/wiki-server/client.ts';
import type { SessionApiEntry } from '../lib/wiki-server/sessions.ts';
import { waitForHealthy, batchSync } from './sync-common.ts';
import { parseSessionYaml } from './sync-session.ts';

const PROJECT_ROOT = join(import.meta.dirname!, '../..');
const SESSIONS_DIR = join(PROJECT_ROOT, '.claude/sessions');

// --- Configuration ---
const DEFAULT_BATCH_SIZE = 50;

/**
 * Read all .claude/sessions/*.yaml files and return parsed session entries.
 * Exported for testing.
 */
export function loadSessionYamls(
  dir: string = SESSIONS_DIR,
): { sessions: SessionApiEntry[]; fileCount: number; errorFiles: number } {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const sessions: SessionApiEntry[] = [];
  let errorFiles = 0;

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const entry = parseSessionYaml(filePath);
      if (entry) {
        sessions.push(entry);
      } else {
        console.warn(`  WARN: ${file} — could not parse, skipping`);
        errorFiles++;
      }
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  return { sessions, fileCount: files.length, errorFiles };
}

/**
 * Sync session entries to the wiki-server in batches.
 * Exported for testing.
 */
export async function syncSessions(
  serverUrl: string,
  items: SessionApiEntry[],
  batchSize: number,
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ inserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/sessions/batch`,
    items,
    batchSize,
    {
      bodyKey: 'items',
      responseCountKey: 'upserted',
      itemLabel: 'sessions',
      _sleep: options._sleep,
    },
  );

  return { inserted: result.count, errors: result.errors };
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

  // Load sessions
  console.log(`Reading sessions from: ${SESSIONS_DIR}`);
  const { sessions, fileCount, errorFiles } = loadSessionYamls();

  console.log(`  Found ${sessions.length} sessions across ${fileCount} files`);
  if (errorFiles > 0) {
    console.warn(`  ${errorFiles} file(s) had errors`);
  }

  const totalPages = sessions.reduce((sum, s) => sum + (s.pages?.length ?? 0), 0);
  console.log(
    `Syncing ${sessions.length} sessions to ${serverUrl} (batch size: ${batchSize})`,
  );
  console.log(`  ${totalPages} total page associations`);

  if (dryRun) {
    console.log('\n[dry-run] Would sync these sessions:');
    for (const session of sessions.slice(0, 10)) {
      console.log(`  ${session.date} — ${session.title} (${session.pages?.length ?? 0} pages)`);
    }
    if (sessions.length > 10) {
      console.log(`  ... and ${sessions.length - 10} more`);
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
  const result = await syncSessions(serverUrl, sessions, batchSize);

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