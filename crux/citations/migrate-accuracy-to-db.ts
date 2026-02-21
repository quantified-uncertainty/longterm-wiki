/**
 * Migrate Citation Accuracy Data to PostgreSQL
 *
 * Reads accuracy data from the local SQLite knowledge.db and pushes it
 * to the wiki-server PostgreSQL database via the API.
 *
 * Usage:
 *   pnpm crux citations migrate-accuracy       # Run migration
 *   pnpm crux citations migrate-accuracy --dry-run  # Preview without writing
 *
 * Prerequisites:
 *   - LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY must be set
 *   - SQLite knowledge.db must exist with accuracy data
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { citationQuotes, PROJECT_ROOT } from '../lib/knowledge-db.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  markCitationAccuracyBatch,
  createAccuracySnapshot,
  type MarkAccuracyItem,
} from '../lib/wiki-server/citations.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';

const BATCH_SIZE = 50;

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const colors = getColors(false);

  console.log(`\n${colors.bold}${colors.blue}Migrate Citation Accuracy → PostgreSQL${colors.reset}\n`);

  if (dryRun) {
    console.log(`  ${colors.yellow}DRY RUN — no data will be written${colors.reset}\n`);
  }

  // Check SQLite DB exists
  const dbPath = join(PROJECT_ROOT, '.cache', 'knowledge.db');
  if (!existsSync(dbPath)) {
    console.log(`${colors.red}No SQLite knowledge.db found at ${dbPath}${colors.reset}`);
    console.log('Run citation accuracy checks first to populate the local DB.');
    process.exit(1);
  }

  // Check server availability
  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.log(`${colors.red}Wiki server not available.${colors.reset}`);
    console.log('Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.');
    process.exit(1);
  }

  // Read all accuracy data from SQLite
  const allQuotes = citationQuotes.getAll();
  const withAccuracy = allQuotes.filter(q => q.accuracy_verdict !== null);

  console.log(`  SQLite quotes: ${allQuotes.length}`);
  console.log(`  With accuracy data: ${withAccuracy.length}`);

  if (withAccuracy.length === 0) {
    console.log(`\n${colors.yellow}No accuracy data to migrate.${colors.reset}`);
    process.exit(0);
  }

  // Map verdicts to valid API values
  const validVerdicts = new Set(['accurate', 'inaccurate', 'unsupported', 'minor_issues', 'not_verifiable']);

  // Build batch items
  const items: MarkAccuracyItem[] = [];
  let skipped = 0;

  for (const q of withAccuracy) {
    const verdict = q.accuracy_verdict;
    if (!verdict || !validVerdicts.has(verdict)) {
      skipped++;
      continue;
    }

    items.push({
      pageId: q.page_id,
      footnote: q.footnote,
      verdict: verdict as MarkAccuracyItem['verdict'],
      score: q.accuracy_score ?? 0,
      issues: q.accuracy_issues || null,
      supportingQuotes: q.accuracy_supporting_quotes || null,
      verificationDifficulty: (['easy', 'moderate', 'hard'].includes(q.verification_difficulty || '')
        ? q.verification_difficulty as 'easy' | 'moderate' | 'hard'
        : null),
    });
  }

  if (skipped > 0) {
    console.log(`  Skipped (invalid verdict): ${skipped}`);
  }

  console.log(`  Items to migrate: ${items.length}`);

  if (dryRun) {
    // Show breakdown by verdict
    const byVerdict: Record<string, number> = {};
    for (const item of items) {
      byVerdict[item.verdict] = (byVerdict[item.verdict] || 0) + 1;
    }
    console.log('\n  Verdict breakdown:');
    for (const [verdict, count] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${verdict}: ${count}`);
    }

    // Show page count
    const pages = new Set(items.map(i => i.pageId));
    console.log(`\n  Pages: ${pages.size}`);
    console.log(`\n${colors.green}Dry run complete. Use without --dry-run to migrate.${colors.reset}\n`);
    return;
  }

  // Send in batches
  let migrated = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await markCitationAccuracyBatch(batch);

    if (result.ok) {
      migrated += result.data.updated;
    } else {
      failed += batch.length;
      console.log(`  ${colors.red}Batch ${Math.floor(i / BATCH_SIZE) + 1} failed${colors.reset}`);
    }

    // Progress indicator
    const pct = Math.round(((i + batch.length) / items.length) * 100);
    process.stdout.write(`\r  Progress: ${pct}% (${migrated} migrated, ${failed} failed)`);
  }
  console.log('');

  // Create an accuracy snapshot
  console.log(`\n  Creating accuracy snapshot...`);
  const snapshot = await createAccuracySnapshot();
  if (snapshot.ok) {
    console.log(`  ${colors.green}Snapshot created for ${snapshot.data.snapshotCount} pages${colors.reset}`);
  } else {
    console.log(`  ${colors.yellow}Snapshot creation failed${colors.reset}`);
  }

  console.log(`\n${colors.bold}Migration complete:${colors.reset}`);
  console.log(`  Migrated: ${colors.green}${migrated}${colors.reset}`);
  if (failed > 0) {
    console.log(`  Failed: ${colors.red}${failed}${colors.reset}`);
  }
  console.log('');
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
