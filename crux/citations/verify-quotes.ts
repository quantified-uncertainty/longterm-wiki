/**
 * Quote Re-Verification Script
 *
 * Re-fetches source content and verifies that stored quotes still exist.
 * Flags quotes that have disappeared due to content drift.
 *
 * Usage:
 *   pnpm crux citations verify-quotes <page-id>
 *   pnpm crux citations verify-quotes --all --limit=20
 */

import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import {
  citationQuotes,
  citationContent,
} from '../lib/knowledge-db.ts';
import { fetchCitationUrl } from '../lib/citation-archive.ts';
import { verifyQuoteInSource } from '../lib/quote-verifier.ts';

interface VerifyResult {
  pageId: string;
  total: number;
  stillValid: number;
  drifted: number;
  noSource: number;
}

async function verifyQuotesForPage(
  pageId: string,
  opts: { verbose?: boolean; refetch?: boolean } = {},
): Promise<VerifyResult> {
  const verbose = opts.verbose ?? false;
  const refetch = opts.refetch ?? false;

  const quotes = citationQuotes.getByPage(pageId);
  const withQuotes = quotes.filter(
    (q) => q.source_quote && q.source_quote.length > 0,
  );

  const result: VerifyResult = {
    pageId,
    total: withQuotes.length,
    stillValid: 0,
    drifted: 0,
    noSource: 0,
  };

  for (const q of withQuotes) {
    if (verbose) {
      process.stdout.write(`  [^${q.footnote}] `);
    }

    let sourceText: string | null = null;

    if (q.url) {
      if (refetch) {
        // Re-fetch the source
        const fetchResult = await fetchCitationUrl(q.url);
        if (fetchResult.fullText) {
          sourceText = fetchResult.fullText;
          // Update cache
          citationContent.upsert({
            url: q.url,
            pageId,
            footnote: q.footnote,
            fetchedAt: new Date().toISOString(),
            httpStatus: fetchResult.httpStatus,
            contentType: fetchResult.contentType,
            pageTitle: fetchResult.pageTitle,
            fullHtml: fetchResult.fullHtml,
            fullText: fetchResult.fullText,
            contentLength: fetchResult.contentLength,
          });
        }
      } else {
        // Use cached content
        const cached = citationContent.getByUrl(q.url);
        sourceText = cached?.full_text ?? null;
      }
    }

    if (!sourceText) {
      result.noSource++;
      if (verbose) {
        console.log('no source text available');
      }
      continue;
    }

    // Verify the stored quote against the source
    const verification = verifyQuoteInSource(q.source_quote!, sourceText);

    if (verification.verified) {
      result.stillValid++;
      // Update verification status
      citationQuotes.markVerified(
        pageId,
        q.footnote,
        verification.method,
        verification.score,
      );
      if (verbose) {
        console.log(
          `\u2713 still valid (${verification.method}, ${(verification.score * 100).toFixed(0)}%)`,
        );
      }
    } else {
      result.drifted++;
      // Mark as unverified
      citationQuotes.markUnverified(
        pageId,
        q.footnote,
        'reverify-failed',
        verification.score,
      );
      if (verbose) {
        console.log(
          `\u2717 DRIFTED (score: ${(verification.score * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const ci = args.ci === true;
  const json = args.json === true;
  const all = args.all === true;
  const limit = parseInt((args.limit as string) || '0', 10);
  const refetch = args.refetch === true;
  const colors = getColors(ci || json);
  const c = colors;

  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!all && !pageId) {
    console.error(
      `${c.red}Error: provide a page ID or use --all${c.reset}`,
    );
    console.error(
      `  Usage: pnpm crux citations verify-quotes <page-id>`,
    );
    console.error(
      `         pnpm crux citations verify-quotes --all --limit=20`,
    );
    process.exit(1);
  }

  if (all) {
    const pages = citationQuotes.getPagesWithQuotes();

    let pagesToProcess = pages;
    if (limit > 0) {
      pagesToProcess = pages.slice(0, limit);
    }

    console.log(
      `\n${c.bold}${c.blue}Quote Re-Verification — Batch Mode${c.reset}\n`,
    );
    console.log(`  ${pages.length} pages with quotes, processing ${pagesToProcess.length}\n`);

    const allResults: VerifyResult[] = [];

    for (let i = 0; i < pagesToProcess.length; i++) {
      const page = pagesToProcess[i];
      console.log(
        `${c.dim}[${i + 1}/${pagesToProcess.length}]${c.reset} ${c.bold}${page.page_id}${c.reset} (${page.quote_count} quotes)`,
      );

      const result = await verifyQuotesForPage(page.page_id, {
        verbose: true,
        refetch,
      });
      allResults.push(result);
      console.log('');
    }

    const totalQuotes = allResults.reduce((s, r) => s + r.total, 0);
    const totalValid = allResults.reduce((s, r) => s + r.stillValid, 0);
    const totalDrifted = allResults.reduce((s, r) => s + r.drifted, 0);
    const totalNoSource = allResults.reduce((s, r) => s + r.noSource, 0);

    if (json || ci) {
      console.log(
        JSON.stringify(
          {
            pagesProcessed: allResults.length,
            totalQuotes,
            stillValid: totalValid,
            drifted: totalDrifted,
            noSource: totalNoSource,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`${c.bold}${c.blue}Summary${c.reset}`);
      console.log(`  Pages processed:   ${allResults.length}`);
      console.log(`  Total quotes:      ${totalQuotes}`);
      console.log(
        `  ${c.green}Still valid:${c.reset}       ${totalValid}`,
      );
      console.log(
        `  ${c.red}Drifted:${c.reset}           ${totalDrifted}`,
      );
      console.log(
        `  ${c.dim}No source:${c.reset}         ${totalNoSource}`,
      );

      if (totalDrifted > 0) {
        console.log(
          `\n${c.yellow}${totalDrifted} quotes may have drifted — source content changed.${c.reset}`,
        );
        console.log(
          `  Re-extract with: pnpm crux citations extract-quotes --all --recheck`,
        );
      }
    }

    process.exit(totalDrifted > 0 ? 1 : 0);
  }

  // Single page
  const quotes = citationQuotes.getByPage(pageId);
  const withQuotes = quotes.filter(
    (q) => q.source_quote && q.source_quote.length > 0,
  );

  if (withQuotes.length === 0) {
    console.log(
      `${c.dim}No quotes found for ${pageId}. Run extract-quotes first.${c.reset}`,
    );
    process.exit(0);
  }

  console.log(
    `\n${c.bold}${c.blue}Quote Re-Verification: ${pageId}${c.reset}`,
  );
  console.log(`  ${withQuotes.length} quotes to verify\n`);

  const result = await verifyQuotesForPage(pageId, {
    verbose: true,
    refetch,
  });

  if (json || ci) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log(`\n${c.bold}Results:${c.reset}`);
  console.log(`  ${c.green}Still valid:${c.reset}  ${result.stillValid}`);
  console.log(`  ${c.red}Drifted:${c.reset}      ${result.drifted}`);
  console.log(`  ${c.dim}No source:${c.reset}    ${result.noSource}`);

  console.log('');
  process.exit(result.drifted > 0 ? 1 : 0);
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
