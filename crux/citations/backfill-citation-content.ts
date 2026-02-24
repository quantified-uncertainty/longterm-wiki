/**
 * Backfill Citation Content to PostgreSQL
 *
 * Reads all citation_content rows from the local SQLite knowledge.db and
 * upserts them into the wiki-server PostgreSQL database via the API.
 *
 * Usage:
 *   pnpm crux citations backfill-content           # Run backfill
 *   pnpm crux citations backfill-content --dry-run # Preview without writing
 *
 * Prerequisites:
 *   - LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY must be set
 *   - SQLite knowledge.db must exist with citation_content rows
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { citationContent, PROJECT_ROOT } from '../lib/knowledge-db.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  upsertCitationContent,
  getCitationContentStats,
  type UpsertCitationContentInput,
} from '../lib/wiki-server/citations.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';

const BATCH_SIZE = 20;
const FULL_TEXT_MAX = 5 * 1024 * 1024;  // 5 MB
const PREVIEW_MAX = 50 * 1024;           // 50 KB

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const colors = getColors(false);
  const c = colors;

  console.log(`\n${c.bold}${c.blue}Backfill Citation Content → PostgreSQL${c.reset}\n`);

  if (dryRun) {
    console.log(`  ${c.yellow}DRY RUN — no data will be written${c.reset}\n`);
  }

  // Check SQLite DB exists
  const dbPath = join(PROJECT_ROOT, '.cache', 'knowledge.db');
  if (!existsSync(dbPath)) {
    console.log(`${c.red}No SQLite knowledge.db found at ${dbPath}${c.reset}`);
    console.log('Run citation verification first to populate the local DB.');
    process.exit(1);
  }

  // Check server availability
  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.log(`${c.red}Wiki server not available.${c.reset}`);
    console.log('Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.');
    process.exit(1);
  }

  // Read all citation content from SQLite
  const allRows = citationContent.getAll();
  const withFullText = allRows.filter(r => r.full_text && r.full_text.length > 0);
  const withoutFullText = allRows.filter(r => !r.full_text || r.full_text.length === 0);

  console.log(`  SQLite total rows:      ${allRows.length}`);
  console.log(`  With full text:         ${c.green}${withFullText.length}${c.reset}`);
  console.log(`  Without full text:      ${c.yellow}${withoutFullText.length}${c.reset} (metadata only, will skip)`);

  if (withFullText.length === 0) {
    console.log(`\n${c.yellow}No full-text content to backfill.${c.reset}`);
    process.exit(0);
  }

  // Show PG stats before
  const statsBefore = await getCitationContentStats();
  if (statsBefore.ok) {
    console.log(`\n  PG before: ${statsBefore.data.total} total, ${statsBefore.data.withFullText} with full text`);
  }

  if (dryRun) {
    const totalBytes = withFullText.reduce((sum, r) => sum + (r.content_length ?? 0), 0);
    console.log(`\n  Would backfill: ${withFullText.length} rows (~${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`\n${c.green}Dry run complete. Use without --dry-run to backfill.${c.reset}\n`);
    return;
  }

  // Upsert in batches
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < withFullText.length; i += BATCH_SIZE) {
    const batch = withFullText.slice(i, i + BATCH_SIZE);

    for (const row of batch) {
      if (!row.full_text) { skipped++; continue; }

      const fullText = row.full_text.length > FULL_TEXT_MAX
        ? row.full_text.slice(0, FULL_TEXT_MAX)
        : row.full_text;
      const fullTextPreview = fullText.slice(0, PREVIEW_MAX);

      const item: UpsertCitationContentInput = {
        url: row.url,
        fetchedAt: row.fetched_at ?? new Date().toISOString(),
        httpStatus: row.http_status ?? null,
        contentType: row.content_type ?? null,
        pageTitle: row.page_title ?? null,
        fullText,
        fullTextPreview,
        contentLength: row.content_length ?? null,
        contentHash: row.content_hash ?? null,
      };

      const result = await upsertCitationContent(item);
      if (result.ok) {
        succeeded++;
      } else {
        failed++;
        // Clear progress line, log the failing URL, then let progress resume
        process.stdout.write('\r\n');
        const errMsg = 'error' in result ? String(result.error).slice(0, 100) : 'unknown error';
        console.warn(`  [warn] Failed to upsert ${row.url.slice(0, 80)}: ${errMsg}`);
      }
    }

    // Progress
    const processed = Math.min(i + BATCH_SIZE, withFullText.length);
    const pct = Math.round((processed / withFullText.length) * 100);
    process.stdout.write(`\r  Progress: ${pct}% (${succeeded} ok, ${failed} failed, ${skipped} skipped)`);
  }
  console.log('');

  // Show PG stats after
  const statsAfter = await getCitationContentStats();
  if (statsAfter.ok) {
    console.log(`\n  PG after:  ${statsAfter.data.total} total, ${statsAfter.data.withFullText} with full text`);
  }

  console.log(`\n${c.bold}Backfill complete:${c.reset}`);
  console.log(`  Succeeded: ${c.green}${succeeded}${c.reset}`);
  if (failed > 0) {
    console.log(`  Failed:    ${c.red}${failed}${c.reset}`);
  }
  if (skipped > 0) {
    console.log(`  Skipped:   ${c.yellow}${skipped}${c.reset} (no full text)`);
  }
  console.log('');
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}
