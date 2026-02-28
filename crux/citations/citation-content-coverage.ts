/**
 * Citation Content Coverage Stats
 *
 * Shows how many citation URLs have full text cached in PostgreSQL.
 * Useful for understanding backfill coverage before running verification.
 *
 * Usage:
 *   pnpm crux citations content-coverage        # Show coverage stats
 *   pnpm crux citations content-coverage --json # JSON output
 */

import { fileURLToPath } from 'url';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getCitationContentStats } from '../lib/wiki-server/citations.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const json = args.json === true;
  const c = getColors(json);

  // PostgreSQL stats (authoritative store)
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

  // PostgreSQL section
  console.log(`${c.bold}PostgreSQL (authoritative store):${c.reset}`);
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

  console.log('');
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Coverage check failed:', err);
    process.exit(1);
  });
}
