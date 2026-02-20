/**
 * Citation Audit — Full Pipeline for a Single Page
 *
 * Runs extract-quotes → check-accuracy → fix-inaccuracies in one command.
 * Useful for auditing a specific page end-to-end without running separate
 * commands and managing intermediate state.
 *
 * Usage:
 *   pnpm crux citations audit <page-id>          # Find issues (no changes)
 *   pnpm crux citations audit <page-id> --apply   # Find and fix issues
 *   pnpm crux citations audit <page-id> --recheck # Re-run from scratch
 *
 * Requires: OPENROUTER_API_KEY
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { extractCitationsFromContent } from '../lib/citation-archive.ts';
import { DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { extractQuotesForPage } from './extract-quotes.ts';
import { checkAccuracyForPage } from './check-accuracy.ts';
import { exportDashboardData } from './export-dashboard.ts';
import {
  loadFlaggedCitations,
  enrichFromSqlite,
  generateFixesForPage,
  applyFixes,
  escalateWithClaude,
  applySectionRewrites,
  cleanupOrphanedFootnotes,
  findReplacementSources,
  applySourceReplacements,
  secondOpinionCheck,
} from './fix-inaccuracies.ts';
import type { ApplyResult } from './fix-inaccuracies.ts';
import { appendEditLog } from '../lib/edit-log.ts';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const json = args.json === true;
  const apply = args.apply === true;
  const recheck = args.recheck === true;
  const escalate = args.escalate !== false; // enabled by default, --no-escalate disables
  const model = typeof args.model === 'string' ? args.model : undefined;
  const c = getColors(json);

  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux citations audit <page-id>`);
    console.error(`         pnpm crux citations audit <page-id> --apply`);
    process.exit(1);
  }

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

  console.log(`\n${c.bold}${c.blue}Citation Audit: ${pageId}${c.reset}`);
  console.log(`  ${citations.length} citations found\n`);

  // ── Step 1: Extract quotes ────────────────────────────────────────────
  console.log(`${c.bold}Step 1: Extract Quotes${c.reset}\n`);

  const extractResult = await extractQuotesForPage(pageId, body, {
    verbose: true,
    recheck,
  });

  console.log(`\n  ${c.green}Extracted:${c.reset} ${extractResult.extracted}  ${c.green}Verified:${c.reset} ${extractResult.verified}  ${c.dim}Skipped:${c.reset} ${extractResult.skipped}`);
  if (extractResult.errors > 0) {
    console.log(`  ${c.red}Errors:${c.reset} ${extractResult.errors}`);
  }

  // ── Step 2: Check accuracy ────────────────────────────────────────────
  console.log(`\n${c.bold}Step 2: Check Accuracy${c.reset}\n`);

  const accuracyResult = await checkAccuracyForPage(pageId, {
    verbose: true,
    recheck,
  });

  console.log(`\n  ${c.green}Accurate:${c.reset} ${accuracyResult.accurate}  ${c.yellow}Minor:${c.reset} ${accuracyResult.minorIssues}  ${c.red}Inaccurate:${c.reset} ${accuracyResult.inaccurate}  ${c.red}Unsupported:${c.reset} ${accuracyResult.unsupported}`);

  // Export dashboard data after accuracy check
  exportDashboardData();

  // ── Step 2b: Second opinion (Haiku) ──────────────────────────────────
  // Re-check flagged citations with a different model to reduce false positives
  const flaggedIssues = accuracyResult.issues.filter(
    (i) => i.verdict === 'inaccurate' || i.verdict === 'unsupported',
  );

  if (flaggedIssues.length > 0) {
    console.log(`\n${c.bold}Step 2b: Second Opinion (Haiku)${c.reset}\n`);
    console.log(`  ${flaggedIssues.length} flagged citation(s) — getting second opinion...\n`);

    const soResult = await secondOpinionCheck(pageId, flaggedIssues, { verbose: true });

    if (soResult.demoted > 0) {
      // Adjust in-memory counts
      for (const d of soResult.details) {
        if (d.originalVerdict === 'inaccurate') accuracyResult.inaccurate--;
        if (d.originalVerdict === 'unsupported') accuracyResult.unsupported--;
        if (d.newVerdict === 'accurate') accuracyResult.accurate++;
        else accuracyResult.minorIssues++;
      }
      exportDashboardData(); // Re-export with corrected verdicts
      console.log(`\n  ${c.green}${soResult.demoted} false positive(s) demoted${c.reset}`);
    } else {
      console.log(`\n  ${c.dim}All flags confirmed — no false positives found.${c.reset}`);
    }
  }

  const problemCount = accuracyResult.inaccurate + accuracyResult.unsupported;

  if (problemCount === 0) {
    console.log(`\n${c.green}${c.bold}All citations accurate — no fixes needed.${c.reset}\n`);
    process.exit(0);
  }

  // ── Step 3: Generate fixes ────────────────────────────────────────────
  console.log(`\n${c.bold}Step 3: Generate Fixes${c.reset} ${apply ? `${c.red}(APPLY MODE)${c.reset}` : `${c.dim}(dry run)${c.reset}`}\n`);

  const flagged = loadFlaggedCitations({ pageId });
  if (flagged.length === 0) {
    console.log(`  ${c.yellow}No flagged citations found in dashboard data.${c.reset}`);
    console.log(`  ${c.dim}This can happen if export-dashboard didn't capture them.${c.reset}\n`);
    process.exit(0);
  }

  const enriched = enrichFromSqlite(flagged);
  const withSource = enriched.filter(
    (e) => e.supportingQuotes || e.sourceQuote || e.sourceFullText,
  ).length;
  console.log(`  ${flagged.length} flagged citations (${withSource} with source evidence)`);
  console.log(`  Model: ${model || DEFAULT_CITATION_MODEL}\n`);

  const pageContent = readFileSync(filePath, 'utf-8');
  const proposals = await generateFixesForPage(pageId, enriched, pageContent, { model });

  let fixesApplied = false;

  if (proposals.length === 0 && escalate) {
    // ── Step 3b: Escalate to Claude ─────────────────────────────────────
    console.log(`  ${c.dim}No string-replacement fixes proposed — escalating to Claude...${c.reset}\n`);
    console.log(`${c.bold}Step 3b: Escalate to Claude${c.reset} (section-level rewrite)\n`);

    const sectionRewrites = await escalateWithClaude(
      pageId, body, flagged, enriched,
      { verbose: true },
    );

    if (sectionRewrites.length === 0) {
      console.log(`  ${c.dim}Escalation produced no rewrites — issues may need manual review.${c.reset}\n`);
      if (!apply) {
        process.exit(0);
      }
    } else if (!apply) {
      for (const rw of sectionRewrites) {
        console.log(`  ${c.yellow}Section: ${rw.heading.replace(/^#+\s*/, '')}${c.reset}`);
        console.log(`    ${c.dim}${rw.originalSection.length} chars → ${rw.rewrittenSection.length} chars${c.reset}`);
      }
      console.log(`\n${c.dim}Run with --apply to write changes and re-verify.${c.reset}\n`);
      process.exit(0);
    } else {
      const rwResult = applySectionRewrites(pageContent, sectionRewrites);
      if (rwResult.applied > 0) {
        // Clean up orphaned footnote definitions left by removed inline refs
        const orphanResult = cleanupOrphanedFootnotes(rwResult.content);
        writeFileSync(filePath, orphanResult.content, 'utf-8');
        appendEditLog(pageId, {
          tool: 'crux-audit-escalated',
          agency: 'automated',
          note: `Escalated to Claude: rewrote ${rwResult.applied} section(s) to fix citation inaccuracies`,
        });
        console.log(`  ${c.green}${rwResult.applied} section(s) rewritten${c.reset}`);
        if (rwResult.skipped > 0) {
          console.log(`  ${c.yellow}${rwResult.skipped} section(s) skipped (text not found)${c.reset}`);
        }
        if (orphanResult.removed.length > 0) {
          console.log(`  ${c.dim}Cleaned up ${orphanResult.removed.length} orphaned footnote definition(s): ${orphanResult.removed.map(n => `[^${n}]`).join(', ')}${c.reset}`);
        }
        fixesApplied = true;
      } else {
        console.log(`  ${c.yellow}No section rewrites could be applied${c.reset}\n`);
      }
    }
  } else if (proposals.length === 0) {
    console.log(`  ${c.dim}No fixes proposed — issues may be with sources, not wiki text.${c.reset}\n`);
    process.exit(0);
  } else {
    // Display proposals
    for (const p of proposals) {
      console.log(`  ${c.yellow}[^${p.footnote}]${c.reset} ${p.fixType}: ${p.explanation}`);
      const origOneLine = p.original.replace(/\n/g, ' ');
      const replOneLine = p.replacement.replace(/\n/g, ' ');
      console.log(`    ${c.red}- ${origOneLine.length > 120 ? origOneLine.slice(0, 120) + '...' : origOneLine}${c.reset}`);
      console.log(`    ${c.green}+ ${replOneLine.length > 120 ? replOneLine.slice(0, 120) + '...' : replOneLine}${c.reset}`);
    }

    if (!apply) {
      console.log(`\n${c.dim}Run with --apply to write changes and re-verify.${c.reset}\n`);
      process.exit(0);
    }

    // Apply fixes
    console.log('');
    const applyResult = applyFixes(pageContent, proposals);
    const modifiedContent = applyResult.content;

    if (applyResult.applied > 0 && modifiedContent) {
      writeFileSync(filePath, modifiedContent, 'utf-8');
      appendEditLog(pageId, {
        tool: 'crux-audit',
        agency: 'automated',
        note: `Fixed ${applyResult.applied} flagged citation inaccuracies via audit`,
      });
      console.log(`  ${c.green}${applyResult.applied} fixes applied${c.reset}`);
      if (applyResult.skipped > 0) {
        console.log(`  ${c.yellow}${applyResult.skipped} skipped (text not found)${c.reset}`);
      }
      fixesApplied = true;
    } else {
      console.log(`  ${c.yellow}No fixes could be applied (text not found in page)${c.reset}\n`);
      process.exit(0);
    }
  }

  // ── Step 3c: Source replacement for unsupported citations ──────────────
  // After text rewrites, try to find better sources for still-unsupported claims
  let step3cRanRecheck = false;
  if (apply && process.env.EXA_API_KEY) {
    // Re-load flagged citations to reflect any changes from Steps 3/3b
    const currentContent = readFileSync(filePath, 'utf-8');
    const currentBody = stripFrontmatter(currentContent);

    // Quick re-check to find remaining unsupported citations
    await extractQuotesForPage(pageId, currentBody, { verbose: false, recheck: true });
    await checkAccuracyForPage(pageId, { verbose: false, recheck: true });
    exportDashboardData();
    step3cRanRecheck = true;

    const remainingFlagged = loadFlaggedCitations({ pageId });
    const remainingUnsupported = remainingFlagged.filter(
      (f) => f.verdict === 'unsupported' && (f.score ?? 1) <= 0.2,
    );

    if (remainingUnsupported.length > 0) {
      console.log(`\n${c.bold}Step 3c: Source Replacement Search${c.reset}\n`);
      console.log(`  ${remainingUnsupported.length} unsupported citation(s) — searching for better sources...\n`);

      const remainingEnriched = enrichFromSqlite(remainingUnsupported);
      const replacements = await findReplacementSources(remainingEnriched, { verbose: true });

      if (replacements.length > 0) {
        console.log('');
        for (const rep of replacements) {
          console.log(`  ${c.yellow}[^${rep.footnote}]${c.reset} ${rep.confidence}: ${rep.reason.slice(0, 80)}`);
          console.log(`    ${c.red}- ${rep.oldUrl}${c.reset}`);
          console.log(`    ${c.green}+ ${rep.newUrl}${c.reset}`);
        }

        const repResult = applySourceReplacements(currentContent, replacements);
        if (repResult.applied > 0) {
          writeFileSync(filePath, repResult.content, 'utf-8');
          appendEditLog(pageId, {
            tool: 'crux-audit-source-replace',
            agency: 'automated',
            note: `Replaced ${repResult.applied} unsupported source URL(s) with better matches`,
          });
          console.log(`\n  ${c.green}${repResult.applied} source(s) replaced${c.reset}`);
          fixesApplied = true;
          step3cRanRecheck = false; // Source URLs changed — need fresh re-verify
        }
      } else {
        console.log(`  ${c.dim}No replacement sources found.${c.reset}`);
      }
    }
  }

  if (!fixesApplied) {
    process.exit(0);
  }

  // ── Step 4: Re-extract + Re-verify ─────────────────────────────────────
  // After fixing the page, claim_text in SQLite is stale (from Step 1).
  // Re-extract quotes to update claim_text before re-verifying accuracy.
  // Skip re-extract if Step 3c already did it and no further changes were made.
  console.log(`\n${c.bold}Step 4: Re-extract & Re-verify${c.reset}\n`);

  if (!step3cRanRecheck) {
    const updatedRaw = readFileSync(filePath, 'utf-8');
    const updatedBody = stripFrontmatter(updatedRaw);
    console.log(`  Re-extracting claims from updated page...`);
    await extractQuotesForPage(pageId, updatedBody, { verbose: false, recheck: true });
  } else {
    console.log(`  ${c.dim}(Using claims from Step 3c re-check)${c.reset}`);
  }
  console.log(`  Re-checking accuracy...\n`);

  const reVerify = await checkAccuracyForPage(pageId, {
    verbose: true,
    recheck: true,
  });

  exportDashboardData();

  const beforeProblems = accuracyResult.inaccurate + accuracyResult.unsupported;
  let afterProblems = reVerify.inaccurate + reVerify.unsupported;
  let improved = beforeProblems - afterProblems;

  // ── Step 5: Second fix pass (if making progress) ──────────────────────
  if (apply && afterProblems > 0 && improved > 0) {
    console.log(`\n${c.bold}Step 5: Second Fix Pass${c.reset}\n`);
    console.log(`  ${afterProblems} citation(s) still flagged — attempting second pass...\n`);

    const pass2Flagged = loadFlaggedCitations({ pageId });
    if (pass2Flagged.length > 0) {
      const pass2Enriched = enrichFromSqlite(pass2Flagged);
      const pass2Content = readFileSync(filePath, 'utf-8');
      const pass2Proposals = await generateFixesForPage(pageId, pass2Enriched, pass2Content, { model });

      if (pass2Proposals.length > 0) {
        for (const p of pass2Proposals) {
          console.log(`  ${c.yellow}[^${p.footnote}]${c.reset} ${p.fixType}: ${p.explanation}`);
        }

        const pass2Apply = applyFixes(pass2Content, pass2Proposals);
        if (pass2Apply.applied > 0 && pass2Apply.content) {
          writeFileSync(filePath, pass2Apply.content, 'utf-8');
          appendEditLog(pageId, {
            tool: 'crux-audit-pass2',
            agency: 'automated',
            note: `Second pass: fixed ${pass2Apply.applied} remaining citation inaccuracies`,
          });

          // Final re-verify
          const finalRaw = readFileSync(filePath, 'utf-8');
          const finalBody = stripFrontmatter(finalRaw);
          await extractQuotesForPage(pageId, finalBody, { verbose: false, recheck: true });
          const finalVerify = await checkAccuracyForPage(pageId, { verbose: false, recheck: true });
          exportDashboardData();

          const finalProblems = finalVerify.inaccurate + finalVerify.unsupported;
          const pass2Improved = afterProblems - finalProblems;

          console.log(`\n  ${c.green}${pass2Apply.applied} additional fix(es) applied${c.reset}`);
          if (pass2Improved > 0) {
            console.log(`  ${c.green}${pass2Improved} more citation(s) improved${c.reset} (${afterProblems} -> ${finalProblems} flagged)`);
          }

          afterProblems = finalProblems;
          improved = beforeProblems - finalProblems;
        } else {
          console.log(`  ${c.dim}No additional fixes could be applied.${c.reset}`);
        }
      } else {
        console.log(`  ${c.dim}No additional fixes proposed.${c.reset}`);
      }
    }
  }

  console.log(`\n${c.bold}Audit Complete${c.reset}`);
  console.log(`  Before: ${c.red}${beforeProblems} flagged${c.reset} (${accuracyResult.inaccurate} inaccurate, ${accuracyResult.unsupported} unsupported)`);
  console.log(`  After:  ${afterProblems > 0 ? c.yellow : c.green}${afterProblems} flagged${c.reset} (${reVerify.inaccurate} inaccurate, ${reVerify.unsupported} unsupported)`);
  if (improved > 0) {
    console.log(`  ${c.green}${improved} citations improved${c.reset}`);
  } else if (improved === 0) {
    console.log(`  ${c.yellow}No improvement — fixes may need manual review${c.reset}`);
  } else {
    console.log(`  ${c.red}Regression: ${-improved} more flagged after fixes${c.reset}`);
  }
  console.log('');

  process.exit(0);
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
