/**
 * Backfill resource_id for existing citation_quotes rows.
 *
 * Iterates all citation_quotes that have a URL but no resource_id,
 * looks up the matching resource via getResourceByUrl(), and updates
 * the record via the wiki-server API.
 *
 * Usage:
 *   pnpm crux citations backfill-resource-ids
 *   pnpm crux citations backfill-resource-ids --dry-run
 */

import { fileURLToPath } from 'url';
import { getAllQuotes, upsertCitationQuote } from '../lib/wiki-server/citations.ts';
import { getResourceByUrl } from '../lib/search/resource-lookup.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const c = getColors(false);

  console.log(
    `\n${c.bold}${c.blue}Backfill resource_id for citation_quotes${c.reset}\n`,
  );

  // Get all quotes (max 5000 per request)
  const allResult = await getAllQuotes(5000, 0);
  if (!allResult.ok) {
    console.error(`${c.red}Error fetching quotes: ${allResult.error}${c.reset}`);
    process.exit(1);
  }
  const all = allResult.data.quotes;
  if (allResult.data.total > all.length) {
    console.warn(`${c.yellow}Warning: ${allResult.data.total} quotes exist but only ${all.length} fetched. Run again with pagination for full coverage.${c.reset}`);
  }
  const candidates = all.filter(
    (q) => q.url && q.url.length > 0 && !q.resourceId,
  );

  console.log(`  Total quotes:      ${all.length}`);
  console.log(`  Already have resource_id: ${all.filter((q) => q.resourceId).length}`);
  console.log(`  Candidates (URL, no resource_id): ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log(`${c.dim}Nothing to backfill.${c.reset}\n`);
    process.exit(0);
  }

  let matched = 0;
  let unmatched = 0;

  for (const quote of candidates) {
    const resource = getResourceByUrl(quote.url!);
    if (resource) {
      matched++;
      if (dryRun) {
        console.log(
          `  ${c.green}MATCH${c.reset} [${quote.pageId}:^${quote.footnote}] → ${resource.id} (${resource.title || resource.url})`,
        );
      } else {
        if (!quote.pageId) {
          console.warn(`  Skipping quote ^${quote.footnote}: no page slug (orphaned citation)`);
          continue;
        }
        // Re-upsert with the resource_id populated
        await upsertCitationQuote({
          pageId: quote.pageId,
          footnote: quote.footnote,
          url: quote.url,
          resourceId: resource.id,
          claimText: quote.claimText,
          claimContext: quote.claimContext ?? null,
          sourceQuote: quote.sourceQuote ?? null,
          sourceLocation: quote.sourceLocation ?? null,
          quoteVerified: quote.quoteVerified ?? false,
          verificationMethod: quote.verificationMethod ?? null,
          verificationScore: quote.verificationScore ?? null,
          sourceTitle: quote.sourceTitle ?? null,
          sourceType: quote.sourceType ?? null,
          extractionModel: quote.extractionModel ?? null,
        });
      }
    } else {
      unmatched++;
    }
  }

  console.log(`\n${c.bold}Results:${c.reset}`);
  console.log(`  ${c.green}Matched:${c.reset}   ${matched}`);
  console.log(`  ${c.dim}Unmatched:${c.reset} ${unmatched}`);
  if (dryRun) {
    console.log(`\n  ${c.yellow}Dry run — no changes written.${c.reset}`);
  } else {
    console.log(`\n  ${c.green}Updated ${matched} records.${c.reset}`);
  }
  console.log();

  process.exit(0);
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
