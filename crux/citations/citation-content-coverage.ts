/**
 * Citation Content Coverage Stats
 *
 * Shows how many citation URLs have full text cached in SQLite and PostgreSQL.
 * Useful for understanding backfill coverage before running verification.
 *
 * Usage:
 *   pnpm crux citations content-coverage        # Show coverage stats
 *   pnpm crux citations content-coverage --json # JSON output
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { citationContent, PROJECT_ROOT } from '../lib/knowledge-db.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getCitationContentStats } from '../lib/wiki-server/citations.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const json = args.json === true;
  const c = getColors(json);

  // SQLite stats
  const dbPath = join(PROJECT_ROOT, '.cache', 'knowledge.db');
  const dbExists = existsSync(dbPath);

  let sqliteStats: { totalUrls: number; totalPages: number; totalBytes: number } | null = null;
  let sqliteWithFullText = 0;

  if (dbExists) {
    try {
      sqliteStats = citationContent.stats();
      const allRows = citationContent.getAll();
      sqliteWithFullText = allRows.filter(r => r.full_text && r.full_text.length > 0).length;
    } catch {
      // DB may be locked or unavailable
    }
  }

  // PostgreSQL stats
  const serverAvailable = await isServerAvailable();
  let pgStats: {
    total: number;
    withFullText: number;
    withPreview: number;
    coverage: number;
    okCount: number;
    deadCount: number;
    avgContentLength: number | null;
  } | null = null;

  if (serverAvailable) {
    const result = await getCitationContentStats();
    if (result.ok) {
      pgStats = result.data;
    }
  }

  if (json) {
    console.log(JSON.stringify({
      sqlite: sqliteStats ? {
        totalUrls: sqliteStats.totalUrls,
        totalPages: sqliteStats.totalPages,
        totalBytes: sqliteStats.totalBytes,
        withFullText: sqliteWithFullText,
        coveragePct: sqliteStats.totalUrls > 0
          ? Math.round((sqliteWithFullText / sqliteStats.totalUrls) * 100)
          : 0,
      } : null,
      postgres: pgStats ? {
        total: pgStats.total,
        withFullText: pgStats.withFullText,
        withPreview: pgStats.withPreview,
        coverage: pgStats.coverage,
        okCount: pgStats.okCount,
        deadCount: pgStats.deadCount,
        avgContentLength: pgStats.avgContentLength,
      } : null,
    }, null, 2));
    return;
  }

  console.log(`\n${c.bold}${c.blue}Citation Content Coverage${c.reset}\n`);

  // SQLite section
  console.log(`${c.bold}SQLite (local cache):${c.reset}`);
  if (!dbExists) {
    console.log(`  ${c.yellow}No knowledge.db found at ${dbPath}${c.reset}`);
    console.log(`  Run 'pnpm crux citations verify' to populate the local cache.`);
  } else if (!sqliteStats) {
    console.log(`  ${c.red}Could not read SQLite stats (DB locked?)${c.reset}`);
  } else {
    const pct = sqliteStats.totalUrls > 0
      ? Math.round((sqliteWithFullText / sqliteStats.totalUrls) * 100)
      : 0;
    console.log(`  Total URLs:    ${sqliteStats.totalUrls}`);
    console.log(`  Total pages:   ${sqliteStats.totalPages}`);
    console.log(`  With full text: ${c.green}${sqliteWithFullText}${c.reset} / ${sqliteStats.totalUrls} (${pct}%)`);
    console.log(`  Total size:    ${(sqliteStats.totalBytes / 1024 / 1024).toFixed(1)} MB`);
  }

  // PostgreSQL section
  console.log(`\n${c.bold}PostgreSQL (server cache):${c.reset}`);
  if (!serverAvailable) {
    console.log(`  ${c.yellow}Server not available — set LONGTERMWIKI_SERVER_URL${c.reset}`);
  } else if (!pgStats) {
    console.log(`  ${c.red}Could not fetch PG stats${c.reset}`);
  } else {
    const pct = pgStats.coverage > 1 ? Math.round(pgStats.coverage) : Math.round(pgStats.coverage * 100);
    console.log(`  Total URLs:    ${pgStats.total}`);
    console.log(`  With full text: ${c.green}${pgStats.withFullText}${c.reset} / ${pgStats.total} (${pct}%)`);
    console.log(`  With preview:  ${pgStats.withPreview}`);
    console.log(`  HTTP 200 ok:   ${pgStats.okCount}`);
    console.log(`  HTTP 4xx dead: ${pgStats.deadCount}`);
    if (pgStats.avgContentLength) {
      console.log(`  Avg length:    ${(pgStats.avgContentLength / 1024).toFixed(0)} KB`);
    }
  }

  // Backfill hint
  if (sqliteWithFullText > 0 && pgStats && pgStats.withFullText < sqliteWithFullText) {
    const gap = sqliteWithFullText - pgStats.withFullText;
    console.log(`\n${c.yellow}Hint: ${gap} rows in SQLite not yet in PG.${c.reset}`);
    console.log(`  Run: pnpm crux citations backfill-content`);
  }

  console.log('');
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Coverage check failed:', err);
    process.exit(1);
  });
}
