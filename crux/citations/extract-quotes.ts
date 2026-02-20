/**
 * Citation Quote Extraction Script
 *
 * For each citation on a wiki page, extracts the specific supporting quote
 * from the cited source, verifies that the quote exists, and stores everything
 * in SQLite (.cache/knowledge.db).
 *
 * Usage:
 *   pnpm crux citations extract-quotes <page-id>
 *   pnpm crux citations extract-quotes --all --limit=20
 *   pnpm crux citations extract-quotes existential-risk --recheck
 *
 * Requires: OPENROUTER_API_KEY (for LLM quote extraction)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import {
  extractCitationsFromContent,
  extractClaimSentence,
  fetchCitationUrl,
} from '../lib/citation-archive.ts';
import {
  citationContent,
  citationQuotes,
} from '../lib/knowledge-db.ts';
import { extractSupportingQuote, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { verifyQuoteInSource } from '../lib/quote-verifier.ts';
import {
  parseBookReference,
  findSourceOnline,
} from '../lib/source-lookup.ts';
import { findPagesWithCitations, logBatchProgress } from './shared.ts';

/** Detect if a footnote is a book/paper reference (no URL). */
function isBookReference(footnoteText: string): boolean {
  return (
    !footnoteText.includes('http://') && !footnoteText.includes('https://')
  );
}

/** Get full-text content for a URL, from cache or by fetching. */
async function getSourceText(
  url: string,
  pageId: string,
  footnote: number,
): Promise<string | null> {
  // Check SQLite cache first
  const cached = citationContent.getByUrl(url);
  if (cached?.full_text) {
    return cached.full_text;
  }

  // Fetch the URL
  const result = await fetchCitationUrl(url);
  if (result.fullText) {
    // Store in SQLite for future use
    citationContent.upsert({
      url,
      pageId,
      footnote,
      fetchedAt: new Date().toISOString(),
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      pageTitle: result.pageTitle,
      fullHtml: result.fullHtml,
      fullText: result.fullText,
      contentLength: result.contentLength,
    });
    return result.fullText;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Single page extraction
// ---------------------------------------------------------------------------

export interface ExtractResult {
  pageId: string;
  total: number;
  extracted: number;
  verified: number;
  skipped: number;
  errors: number;
}

export async function extractQuotesForPage(
  pageId: string,
  body: string,
  opts: { verbose?: boolean; recheck?: boolean; delayMs?: number } = {},
): Promise<ExtractResult> {
  const verbose = opts.verbose ?? false;
  const recheck = opts.recheck ?? false;
  const delayMs = opts.delayMs ?? 500;

  const extracted = extractCitationsFromContent(body);
  const lines = body.split('\n');

  const result: ExtractResult = {
    pageId,
    total: extracted.length,
    extracted: 0,
    verified: 0,
    skipped: 0,
    errors: 0,
  };

  for (let i = 0; i < extracted.length; i++) {
    const cit = extracted[i];

    // Check if already processed
    if (!recheck) {
      const existing = citationQuotes.get(pageId, cit.footnote);
      if (existing?.source_quote) {
        result.skipped++;
        if (verbose) {
          console.log(
            `  [^${cit.footnote}] (already extracted, skipping)`,
          );
        }
        continue;
      }
    }

    // Extract the specific claim sentence
    const claimSentence = extractClaimSentence(body, cit.footnote);
    const claimText = claimSentence || cit.claimContext;

    if (verbose) {
      process.stdout.write(
        `  [^${cit.footnote}] ${cit.url ? cit.url.slice(0, 60) + '...' : cit.linkText.slice(0, 40) + '...'}`,
      );
    }

    // Detect footnote definition to check for book references
    const defLine = lines.find((l) =>
      l.trim().startsWith(`[^${cit.footnote}]:`),
    );
    const defText = defLine
      ? defLine.replace(/^\[\^\d+\]:\s*/, '').trim()
      : '';

    let sourceQuote = '';
    let sourceLocation = '';
    let verificationMethod: string | null = null;
    let verificationScore: number | null = null;
    let sourceTitle = cit.linkText || null;
    let sourceType: string = 'url';
    let extractionModel: string | null = null;

    try {
      if (cit.url) {
        // URL-based citation — fetch and extract quote
        const sourceText = await getSourceText(
          cit.url,
          pageId,
          cit.footnote,
        );

        if (sourceText && sourceText.length > 100) {
          // Use LLM to extract the supporting quote
          const llmResult = await extractSupportingQuote(
            claimText,
            sourceText,
          );
          sourceQuote = llmResult.quote;
          sourceLocation = llmResult.location;
          extractionModel = DEFAULT_CITATION_MODEL;

          // Verify the quote exists in the source
          if (sourceQuote) {
            const verification = verifyQuoteInSource(
              sourceQuote,
              sourceText,
            );
            verificationMethod = verification.method;
            verificationScore = verification.score;
          }
        } else if (sourceText) {
          // Source text too short for LLM extraction — use as-is
          sourceQuote = sourceText.slice(0, 500);
          sourceLocation = 'full document (short)';
        }

        // Get page title from cache
        const cached = citationContent.getByUrl(cit.url);
        if (cached?.page_title) {
          sourceTitle = cached.page_title;
        }
      } else if (isBookReference(defText)) {
        // Book/paper reference — try to find online
        sourceType = 'book';
        const ref = parseBookReference(defText);
        if (ref) {
          const found = await findSourceOnline(ref);
          if (found) {
            sourceTitle = found.title;
            sourceType = found.source === 'arxiv' ? 'paper' : 'book';
            if (found.abstract) {
              sourceQuote = found.abstract;
              sourceLocation = 'abstract';
            }
            if (verbose) {
              process.stdout.write(` [found: ${found.source}]`);
            }
          }
        }
      }

      // Store in SQLite
      citationQuotes.upsert({
        pageId,
        footnote: cit.footnote,
        url: cit.url || null,
        claimText,
        claimContext: cit.claimContext,
        sourceQuote: sourceQuote || null,
        sourceLocation: sourceLocation || null,
        quoteVerified:
          verificationMethod !== null && verificationScore !== null && verificationScore >= 0.4,
        verificationMethod,
        verificationScore,
        sourceTitle,
        sourceType,
        extractionModel,
      });

      if (sourceQuote) {
        result.extracted++;
        if (
          verificationMethod &&
          verificationScore !== null &&
          verificationScore >= 0.4
        ) {
          result.verified++;
        }
      }

      if (verbose) {
        const icon = sourceQuote
          ? verificationScore !== null && verificationScore >= 0.4
            ? ' \u2713 verified'
            : ' ~ extracted'
          : ' - no quote';
        console.log(icon);
      }
    } catch (err: unknown) {
      result.errors++;
      if (verbose) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(` ERROR: ${msg.slice(0, 80)}`);
      }

      // Still store the claim even if extraction failed
      citationQuotes.upsert({
        pageId,
        footnote: cit.footnote,
        url: cit.url || null,
        claimText,
        claimContext: cit.claimContext,
        sourceTitle,
        sourceType,
      });
    }

    // Rate limit delay
    if (i < extracted.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
  const recheck = args.recheck === true;
  const colors = getColors(ci || json);
  const c = colors;

  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!all && !pageId) {
    console.error(
      `${c.red}Error: provide a page ID or use --all${c.reset}`,
    );
    console.error(
      `  Usage: pnpm crux citations extract-quotes <page-id>`,
    );
    console.error(
      `         pnpm crux citations extract-quotes --all --limit=20`,
    );
    process.exit(1);
  }

  if (all) {
    // Batch mode
    let pages = findPagesWithCitations();
    console.log(
      `\n${c.bold}${c.blue}Quote Extraction — Batch Mode${c.reset}\n`,
    );
    console.log(`  Found ${pages.length} pages with citations\n`);

    // Skip already-processed pages unless --recheck
    if (!recheck) {
      pages = pages.filter((p) => {
        const existing = citationQuotes.getByPage(p.pageId);
        return existing.length === 0;
      });
      console.log(
        `  ${pages.length} pages need processing (use --recheck to re-extract all)\n`,
      );
    }

    if (limit > 0) {
      pages = pages.slice(0, limit);
      console.log(`  Processing first ${pages.length} pages\n`);
    }

    const concurrency = Math.max(1, parseInt((args.concurrency as string) || '1', 10));
    if (concurrency > 1) {
      console.log(`  Concurrency: ${concurrency}\n`);
    }

    const totalCitationCount = pages.reduce((s, p) => s + p.citationCount, 0);

    // Dry-run: show what would be processed and exit
    if (args['dry-run']) {
      console.log(`${c.bold}Dry run — would process:${c.reset}`);
      for (const page of pages) {
        console.log(`  ${page.pageId} (${page.citationCount} citations)`);
      }
      console.log(`\n  Total: ${pages.length} pages, ${totalCitationCount} citations`);
      console.log(`  Estimated LLM calls: ~${totalCitationCount} (one per citation with a URL)`);
      process.exit(0);
    }

    const allResults: ExtractResult[] = [];
    const runStart = Date.now();

    for (let i = 0; i < pages.length; i += concurrency) {
      const batch = pages.slice(i, i + concurrency);
      const batchStart = Date.now();
      const batchResults = await Promise.all(
        batch.map(async (page, batchIdx) => {
          const globalIdx = i + batchIdx;
          console.log(
            `${c.dim}[${globalIdx + 1}/${pages.length}]${c.reset} ${c.bold}${page.pageId}${c.reset} (${page.citationCount} citations)`,
          );

          try {
            const raw = readFileSync(page.path, 'utf-8');
            const body = stripFrontmatter(raw);
            const result = await extractQuotesForPage(page.pageId, body, {
              verbose: concurrency === 1,
              recheck,
            });
            if (concurrency > 1) {
              console.log(
                `  ${c.green}${page.pageId}:${c.reset} ${result.extracted} extracted, ${result.verified} verified, ${result.skipped} skipped, ${result.errors} errors`,
              );
            }
            return result;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  ${c.red}${page.pageId}: Error — ${msg}${c.reset}`);
            return null;
          }
        }),
      );
      for (const r of batchResults) {
        if (r) allResults.push(r);
      }

      logBatchProgress(c, {
        batchIndex: i, concurrency, totalPages: pages.length,
        runStartMs: runStart, batchStartMs: batchStart,
      });
    }

    // Summary
    const totalCitations = allResults.reduce((s, r) => s + r.total, 0);
    const totalExtracted = allResults.reduce((s, r) => s + r.extracted, 0);
    const totalVerified = allResults.reduce((s, r) => s + r.verified, 0);
    const totalSkipped = allResults.reduce((s, r) => s + r.skipped, 0);
    const totalErrors = allResults.reduce((s, r) => s + r.errors, 0);

    if (json || ci) {
      console.log(
        JSON.stringify(
          {
            pagesProcessed: allResults.length,
            totalCitations,
            extracted: totalExtracted,
            verified: totalVerified,
            skipped: totalSkipped,
            errors: totalErrors,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`${c.bold}${c.blue}Summary${c.reset}`);
      console.log(`  Pages processed:   ${allResults.length}`);
      console.log(`  Total citations:   ${totalCitations}`);
      console.log(
        `  ${c.green}Quotes extracted:${c.reset}  ${totalExtracted}`,
      );
      console.log(`  ${c.green}Quotes verified:${c.reset}   ${totalVerified}`);
      console.log(`  ${c.dim}Skipped (cached):${c.reset}  ${totalSkipped}`);
      if (totalErrors > 0) {
        console.log(`  ${c.red}Errors:${c.reset}            ${totalErrors}`);
      }
    }

    process.exit(0);
  }

  // Single page mode
  const filePath = findPageFile(pageId);
  if (!filePath) {
    console.error(`${c.red}Error: page "${pageId}" not found${c.reset}`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const body = stripFrontmatter(raw);
  const citations = extractCitationsFromContent(body);

  if (citations.length === 0) {
    console.log(`${c.dim}No citations found in ${pageId}${c.reset}`);
    process.exit(0);
  }

  console.log(
    `\n${c.bold}${c.blue}Quote Extraction: ${pageId}${c.reset}`,
  );
  console.log(`  ${citations.length} citations to process\n`);

  const result = await extractQuotesForPage(pageId, body, {
    verbose: true,
    recheck,
  });

  if (json || ci) {
    const quotes = citationQuotes.getByPage(pageId);
    console.log(JSON.stringify({ ...result, quotes }, null, 2));
    process.exit(0);
  }

  // Display stored quotes
  console.log(`\n${c.bold}Results:${c.reset}`);
  console.log(`  ${c.green}Extracted:${c.reset}  ${result.extracted}`);
  console.log(`  ${c.green}Verified:${c.reset}   ${result.verified}`);
  console.log(`  ${c.dim}Skipped:${c.reset}    ${result.skipped}`);
  if (result.errors > 0) {
    console.log(`  ${c.red}Errors:${c.reset}     ${result.errors}`);
  }

  // Show extracted quotes
  const stored = citationQuotes.getByPage(pageId);
  const withQuotes = stored.filter(
    (q) => q.source_quote && q.source_quote.length > 0,
  );
  if (withQuotes.length > 0) {
    console.log(`\n${c.bold}Extracted Quotes:${c.reset}`);
    for (const q of withQuotes) {
      const verifiedIcon =
        q.quote_verified
          ? `${c.green}\u2713${c.reset}`
          : `${c.yellow}~${c.reset}`;
      const scoreStr =
        q.verification_score !== null
          ? ` (${(q.verification_score * 100).toFixed(0)}%)`
          : '';

      console.log(
        `\n  [^${q.footnote}] ${verifiedIcon}${scoreStr} ${c.dim}${q.verification_method || ''}${c.reset}`,
      );
      console.log(`  ${c.dim}Claim:${c.reset} ${q.claim_text.slice(0, 120)}`);
      console.log(
        `  ${c.dim}Quote:${c.reset} "${q.source_quote!.slice(0, 200)}${q.source_quote!.length > 200 ? '...' : ''}"`,
      );
      if (q.source_location) {
        console.log(`  ${c.dim}Location:${c.reset} ${q.source_location}`);
      }
    }
  }

  console.log(
    `\n${c.dim}Quotes stored in .cache/knowledge.db${c.reset}\n`,
  );

  process.exit(0);
}

// Only run when executed directly (not when imported)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
