/**
 * Citation Accuracy Check Script
 *
 * Second pass: for each citation with an extracted quote, uses an LLM to check
 * whether the wiki's claim accurately represents what the source says.
 * Flags misrepresented numbers, wrong attributions, overclaims, etc.
 *
 * Usage:
 *   pnpm crux citations check-accuracy <page-id>
 *   pnpm crux citations check-accuracy --all --limit=20
 *
 * Requires: OPENROUTER_API_KEY
 */

import { fileURLToPath } from 'url';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { citationQuotes, citationContent } from '../lib/knowledge-db.ts';
import { checkClaimAccuracy } from '../lib/quote-extractor.ts';
import type { AccuracyVerdict } from '../lib/quote-extractor.ts';
import { exportDashboardData } from './export-dashboard.ts';
import { logBatchProgress } from './shared.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { createAccuracySnapshot } from '../lib/wiki-server/citations.ts';

export interface AccuracyResult {
  pageId: string;
  total: number;
  accurate: number;
  minorIssues: number;
  inaccurate: number;
  unsupported: number;
  notVerifiable: number;
  errors: number;
  issues: Array<{
    footnote: number;
    verdict: string;
    score: number;
    claim: string;
    issues: string[];
  }>;
}

export async function checkAccuracyForPage(
  pageId: string,
  opts: { verbose?: boolean; recheck?: boolean; delayMs?: number } = {},
): Promise<AccuracyResult> {
  const verbose = opts.verbose ?? false;
  const recheck = opts.recheck ?? false;
  const delayMs = opts.delayMs ?? 500;

  const quotes = citationQuotes.getByPage(pageId);
  const withQuotes = quotes.filter(
    (q) => q.source_quote && q.source_quote.length > 0
      // Skip quotes with very low verification scores — likely bad extractions
      && (q.verification_score === null || q.verification_score >= 0.4),
  );

  const result: AccuracyResult = {
    pageId,
    total: withQuotes.length,
    accurate: 0,
    minorIssues: 0,
    inaccurate: 0,
    unsupported: 0,
    notVerifiable: 0,
    errors: 0,
    issues: [],
  };

  for (let i = 0; i < withQuotes.length; i++) {
    const q = withQuotes[i];

    // Skip already checked unless --recheck
    if (!recheck && q.accuracy_verdict) {
      if (verbose) {
        console.log(`  [^${q.footnote}] (already checked: ${q.accuracy_verdict})`);
      }
      // Still count in results
      switch (q.accuracy_verdict as AccuracyVerdict) {
        case 'accurate': result.accurate++; break;
        case 'minor_issues': result.minorIssues++; break;
        case 'inaccurate': result.inaccurate++; break;
        case 'unsupported': result.unsupported++; break;
        default: result.notVerifiable++; break;
      }
      if (q.accuracy_verdict !== 'accurate' && q.accuracy_issues) {
        result.issues.push({
          footnote: q.footnote,
          verdict: q.accuracy_verdict,
          score: q.accuracy_score ?? 0,
          claim: q.claim_text.slice(0, 120),
          issues: q.accuracy_issues.split('\n').filter(Boolean),
        });
      }
      continue;
    }

    if (verbose) {
      process.stdout.write(`  [^${q.footnote}] `);
    }

    try {
      // Use full cached source text when available (much better accuracy),
      // fall back to the narrow extracted quote
      let sourceText = q.source_quote!;
      if (q.url) {
        const cached = citationContent.getByUrl(q.url);
        if (cached?.full_text && cached.full_text.length > sourceText.length) {
          sourceText = cached.full_text;
        }
      }

      const check = await checkClaimAccuracy(
        q.claim_text,
        sourceText,
        { sourceTitle: q.source_title ?? undefined },
      );

      // Store result in local SQLite (also dual-writes to wiki-server via fire-and-forget)
      citationQuotes.markAccuracy(
        pageId,
        q.footnote,
        check.verdict,
        check.score,
        check.issues.length > 0 ? check.issues.join('\n') : null,
        check.supportingQuotes.length > 0 ? check.supportingQuotes.join('\n---\n') : null,
        check.verificationDifficulty || null,
      );

      switch (check.verdict) {
        case 'accurate': result.accurate++; break;
        case 'minor_issues': result.minorIssues++; break;
        case 'inaccurate': result.inaccurate++; break;
        case 'unsupported': result.unsupported++; break;
        default: result.notVerifiable++; break;
      }

      if (check.verdict !== 'accurate') {
        result.issues.push({
          footnote: q.footnote,
          verdict: check.verdict,
          score: check.score,
          claim: q.claim_text.slice(0, 120),
          issues: check.issues,
        });
      }

      if (verbose) {
        const icon = check.verdict === 'accurate' ? '\u2713'
          : check.verdict === 'minor_issues' ? '~'
          : '\u2717';
        console.log(`${icon} ${check.verdict} (${(check.score * 100).toFixed(0)}%)`);
        if (check.issues.length > 0) {
          for (const issue of check.issues) {
            console.log(`    → ${issue}`);
          }
        }
      }
    } catch (err: unknown) {
      result.errors++;
      if (verbose) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`ERROR: ${msg.slice(0, 80)}`);
      }
    }

    // Rate limit
    if (i < withQuotes.length - 1 && delayMs > 0) {
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
      `  Usage: pnpm crux citations check-accuracy <page-id>`,
    );
    console.error(
      `         pnpm crux citations check-accuracy --all --limit=20`,
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
      `\n${c.bold}${c.blue}Accuracy Check — Batch Mode${c.reset}\n`,
    );
    console.log(`  ${pages.length} pages with quotes, processing ${pagesToProcess.length}\n`);

    const concurrency = Math.max(1, parseInt((args.concurrency as string) || '1', 10));
    if (concurrency > 1) {
      console.log(`  Concurrency: ${concurrency}\n`);
    }

    const totalQuoteCount = pagesToProcess.reduce((s, p) => s + p.quote_count, 0);

    // Dry-run: show what would be processed and exit
    if (args['dry-run']) {
      console.log(`${c.bold}Dry run — would process:${c.reset}`);
      for (const page of pagesToProcess) {
        console.log(`  ${page.page_id} (${page.quote_count} quotes)`);
      }
      console.log(`\n  Total: ${pagesToProcess.length} pages, ${totalQuoteCount} quotes`);
      console.log(`  Estimated LLM calls: ~${totalQuoteCount} (one per quote)`);
      process.exit(0);
    }

    const allResults: AccuracyResult[] = [];
    const runStart = Date.now();

    for (let i = 0; i < pagesToProcess.length; i += concurrency) {
      const batch = pagesToProcess.slice(i, i + concurrency);
      const batchStart = Date.now();
      const batchResults = await Promise.all(
        batch.map(async (page, batchIdx) => {
          const globalIdx = i + batchIdx;
          console.log(
            `${c.dim}[${globalIdx + 1}/${pagesToProcess.length}]${c.reset} ${c.bold}${page.page_id}${c.reset} (${page.quote_count} quotes)`,
          );

          try {
            const result = await checkAccuracyForPage(page.page_id, {
              verbose: concurrency === 1,
              recheck,
            });
            if (concurrency > 1) {
              console.log(
                `  ${c.green}${page.page_id}:${c.reset} ${result.accurate} accurate, ${result.minorIssues} minor, ${result.inaccurate} inaccurate, ${result.errors} errors`,
              );
            }
            return result;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  ${c.red}${page.page_id}: Error — ${msg}${c.reset}`);
            return null;
          }
        }),
      );
      for (const r of batchResults) {
        if (r) allResults.push(r);
      }

      logBatchProgress(c, {
        batchIndex: i, concurrency, totalPages: pagesToProcess.length,
        runStartMs: runStart, batchStartMs: batchStart,
      });
    }

    const totals = {
      total: allResults.reduce((s, r) => s + r.total, 0),
      accurate: allResults.reduce((s, r) => s + r.accurate, 0),
      minorIssues: allResults.reduce((s, r) => s + r.minorIssues, 0),
      inaccurate: allResults.reduce((s, r) => s + r.inaccurate, 0),
      unsupported: allResults.reduce((s, r) => s + r.unsupported, 0),
      notVerifiable: allResults.reduce((s, r) => s + r.notVerifiable, 0),
      errors: allResults.reduce((s, r) => s + r.errors, 0),
    };
    const allIssues = allResults.flatMap((r) => r.issues.map((iss) => ({ ...iss, pageId: r.pageId })));

    if (json || ci) {
      console.log(JSON.stringify({ pagesProcessed: allResults.length, ...totals, issues: allIssues }, null, 2));
    } else {
      printSummary(c, totals, allIssues.map((iss) => ({ ...iss, pageId: iss.pageId })));
    }

    // Auto-export dashboard data after accuracy checks
    const exportResult = exportDashboardData();
    if (!exportResult && !json && !ci) {
      console.log(`${c.yellow}Warning: could not export dashboard data${c.reset}`);
    }

    // Create accuracy snapshot in the DB for trend tracking
    const serverUp = await isServerAvailable();
    if (serverUp) {
      const snapshot = await createAccuracySnapshot();
      if (snapshot.ok && !json && !ci) {
        console.log(`${c.dim}Accuracy snapshot created for ${snapshot.data.snapshotCount} pages${c.reset}`);
      }
    }

    process.exit(totals.inaccurate > 0 ? 1 : 0);
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
    `\n${c.bold}${c.blue}Accuracy Check: ${pageId}${c.reset}`,
  );
  console.log(`  ${withQuotes.length} quotes to check\n`);

  const result = await checkAccuracyForPage(pageId, {
    verbose: true,
    recheck,
  });

  // Auto-export dashboard data after accuracy checks
  const exportPath = exportDashboardData();
  if (!exportPath && !json && !ci) {
    console.log(`${c.yellow}Warning: could not export dashboard data${c.reset}`);
  }

  // Create accuracy snapshot in the DB for trend tracking
  const serverUp = await isServerAvailable();
  if (serverUp) {
    const snapshot = await createAccuracySnapshot();
    if (snapshot && !json && !ci) {
      console.log(`${c.dim}Accuracy snapshot created for ${snapshot.snapshotCount} pages${c.reset}`);
    }
  }

  if (json || ci) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  printSummary(c, result, result.issues.map((iss) => ({ ...iss, pageId })));
  process.exit(result.inaccurate > 0 ? 1 : 0);
}

function printSummary(
  c: ReturnType<typeof getColors>,
  totals: { total: number; accurate: number; minorIssues: number; inaccurate: number; unsupported: number; notVerifiable: number; errors: number },
  issues: Array<{ pageId: string; footnote: number; verdict: string; score: number; claim: string; issues: string[] }>,
) {
  console.log(`\n${c.bold}${c.blue}Summary${c.reset}`);
  console.log(`  Total checked:       ${totals.total}`);
  console.log(`  ${c.green}Accurate:${c.reset}            ${totals.accurate}`);
  if (totals.minorIssues > 0) {
    console.log(`  ${c.yellow}Minor issues:${c.reset}        ${totals.minorIssues}`);
  }
  if (totals.inaccurate > 0) {
    console.log(`  ${c.red}Inaccurate:${c.reset}          ${totals.inaccurate}`);
  }
  if (totals.unsupported > 0) {
    console.log(`  ${c.red}Unsupported:${c.reset}         ${totals.unsupported}`);
  }
  if (totals.notVerifiable > 0) {
    console.log(`  ${c.dim}Not verifiable:${c.reset}      ${totals.notVerifiable}`);
  }
  if (totals.errors > 0) {
    console.log(`  ${c.red}Errors:${c.reset}              ${totals.errors}`);
  }

  const flagged = issues.filter((i) => i.verdict === 'inaccurate' || i.verdict === 'unsupported');
  if (flagged.length > 0) {
    console.log(`\n${c.red}${c.bold}Flagged Citations:${c.reset}`);
    for (const iss of flagged) {
      console.log(`\n  ${c.red}[^${iss.footnote}]${c.reset} ${iss.pageId} — ${c.bold}${iss.verdict}${c.reset} (${(iss.score * 100).toFixed(0)}%)`);
      console.log(`  ${c.dim}Claim:${c.reset} ${iss.claim}`);
      for (const detail of iss.issues) {
        console.log(`  ${c.red}→${c.reset} ${detail}`);
      }
    }
  }

  const warnings = issues.filter((i) => i.verdict === 'minor_issues');
  if (warnings.length > 0) {
    console.log(`\n${c.yellow}${c.bold}Minor Issues:${c.reset}`);
    for (const iss of warnings) {
      console.log(`\n  ${c.yellow}[^${iss.footnote}]${c.reset} ${iss.pageId} — (${(iss.score * 100).toFixed(0)}%)`);
      console.log(`  ${c.dim}Claim:${c.reset} ${iss.claim}`);
      for (const detail of iss.issues) {
        console.log(`  ${c.yellow}→${c.reset} ${detail}`);
      }
    }
  }

  console.log('');
}

// Only run when executed directly (not when imported)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
