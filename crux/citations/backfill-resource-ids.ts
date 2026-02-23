/**
 * Backfill resource_id for existing citation_quotes rows.
 *
 * Iterates all citation_quotes that have a URL but no resource_id,
 * looks up the matching resource via getResourceByUrl(), and updates
 * the record via the existing upsert() path (writes to both SQLite
 * and PostgreSQL).
 *
 * Usage:
 *   pnpm crux citations backfill-resource-ids
 *   pnpm crux citations backfill-resource-ids --dry-run
 */

import { fileURLToPath } from 'url';
import { citationQuotes } from '../lib/knowledge-db.ts';
import { getResourceByUrl } from '../lib/resource-lookup.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const c = getColors(false);

  console.log(
    `\n${c.bold}${c.blue}Backfill resource_id for citation_quotes${c.reset}\n`,
  );

  // Get all quotes that have a URL but no resource_id
  const all = citationQuotes.getAll();
  const candidates = all.filter(
    (q) => q.url && q.url.length > 0 && !q.resource_id,
  );

  console.log(`  Total quotes:      ${all.length}`);
  console.log(`  Already have resource_id: ${all.filter((q) => q.resource_id).length}`);
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
          `  ${c.green}MATCH${c.reset} [${quote.page_id}:^${quote.footnote}] → ${resource.id} (${resource.title || resource.url})`,
        );
      } else {
        // Re-upsert with the resource_id populated
        citationQuotes.upsert({
          pageId: quote.page_id,
          footnote: quote.footnote,
          url: quote.url,
          resourceId: resource.id,
          claimText: quote.claim_text,
          claimContext: quote.claim_context,
          sourceQuote: quote.source_quote,
          sourceLocation: quote.source_location,
          quoteVerified: quote.quote_verified === 1,
          verificationMethod: quote.verification_method,
          verificationScore: quote.verification_score,
          sourceTitle: quote.source_title,
          sourceType: quote.source_type,
          extractionModel: quote.extraction_model,
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
