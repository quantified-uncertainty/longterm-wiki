#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Grade Content CLI — 3-Step Pipeline entry point.
 *
 * Orchestrates page collection, filtering, cost estimation, parallel
 * processing, and statistics output. Delegates grading logic to steps.ts,
 * page collection to pages.ts, frontmatter writes to apply.ts,
 * and statistics to stats.ts.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node crux/authoring/grading/index.ts [options]
 *
 * Options:
 *   --page ID          Grade a single page by ID or partial match
 *   --dry-run          Show what would be processed without calling API
 *   --limit N          Only process N pages (for testing)
 *   --parallel N       Process N pages concurrently (default: 1)
 *   --category X       Only process pages in category
 *   --skip-graded      Skip pages that already have readerImportance set
 *   --output FILE      Write results to JSON file
 *   --apply            Apply grades directly to frontmatter
 *   --skip-warnings    Skip Steps 1-2, just rate (backward compat)
 *   --warnings-only    Run Steps 1-2, skip rating (Step 3)
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '../../lib/anthropic.ts';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../../lib/cli.ts';
import { getApiKey } from '../../lib/api-keys.ts';
import { appendEditLog, getDefaultRequestedBy } from '../../lib/edit-log.ts';

import type {
  PageInfo, Warning, ChecklistWarning,
  GradeResult, PageResult, ProcessPageResult, Options,
} from './types.ts';
import {
  computeMetrics, computeQuality,
  runAutomatedWarnings, runChecklistReview,
  formatWarningsSummary, gradePage,
} from './steps.ts';
import { collectPages } from './pages.ts';
import { applyGradesToFile } from './apply.ts';
import { printStats } from './stats.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const OUTPUT_FILE = '.claude/temp/grades-output.json';

// ── CLI Parsing ──────────────────────────────────────────────────────────────

function parseOptions(argv: string[]): Options {
  const parsed = parseCliArgs(argv);
  return {
    page: (parsed.page as string) || null,
    dryRun: parsed['dry-run'] === true,
    limit: parsed.limit ? parseInt(parsed.limit as string) : null,
    category: (parsed.category as string) || null,
    skipGraded: parsed['skip-graded'] === true,
    output: (parsed.output as string) || OUTPUT_FILE,
    apply: parsed.apply === true,
    parallel: parsed.parallel ? parseInt(parsed.parallel as string) : 1,
    skipWarnings: parsed['skip-warnings'] === true,
    warningsOnly: parsed['warnings-only'] === true,
  };
}

// ── Page Processing ──────────────────────────────────────────────────────────

async function processPage(
  client: Anthropic,
  page: PageInfo,
  index: number,
  total: number,
  options: Options,
): Promise<ProcessPageResult> {
  try {
    let automatedWarnings: Warning[] = [];
    let checklistWarnings: ChecklistWarning[] = [];
    let warningsSummary: string | null = null;

    // Step 1 & 2: Run warnings (unless --skip-warnings)
    if (!options.skipWarnings) {
      automatedWarnings = await runAutomatedWarnings(page);
      console.log(`  [${index + 1}/${total}] ${page.id}: Step 1 — ${automatedWarnings.length} automated warnings`);

      if (!options.dryRun) {
        checklistWarnings = await runChecklistReview(client, page);
        console.log(`  [${index + 1}/${total}] ${page.id}: Step 2 — ${checklistWarnings.length} checklist warnings`);
      }

      warningsSummary = formatWarningsSummary(automatedWarnings, checklistWarnings);
    }

    // If --warnings-only, skip Step 3
    if (options.warningsOnly) {
      const metrics = computeMetrics(page.content);
      const result: PageResult = {
        id: page.id,
        filePath: page.relativePath,
        category: page.category,
        title: page.title,
        metrics,
        warnings: {
          automated: automatedWarnings,
          checklist: checklistWarnings,
          totalCount: automatedWarnings.length + checklistWarnings.length,
        },
      };
      console.log(`[${index + 1}/${total}] ${page.id}: ${automatedWarnings.length + checklistWarnings.length} total warnings (warnings-only mode)`);
      return { success: true, result };
    }

    // Step 3: LLM rating (Sonnet)
    const grades = await gradePage(client, page, warningsSummary);

    if (grades && grades.ratings) {
      const metrics = computeMetrics(page.content);
      const derivedQuality = computeQuality(grades.ratings, metrics, page.frontmatter, page.relativePath);

      const result: PageResult = {
        id: page.id,
        filePath: page.relativePath,
        category: page.category,
        isModel: page.isModel,
        title: page.title,
        readerImportance: grades.readerImportance,
        ratings: grades.ratings,
        metrics,
        quality: derivedQuality,
        llmSummary: grades.llmSummary,
        warnings: options.skipWarnings ? undefined : {
          automated: automatedWarnings,
          checklist: checklistWarnings,
          totalCount: automatedWarnings.length + checklistWarnings.length,
        },
      };

      let applied = false;
      if (options.apply) {
        applied = applyGradesToFile(page, grades, metrics, derivedQuality);
        if (applied) {
          appendEditLog(page.id, {
            tool: 'crux-grade',
            agency: 'automated',
            requestedBy: getDefaultRequestedBy(),
            note: `Quality graded: ${derivedQuality}, readerImportance: ${grades.readerImportance.toFixed(1)}`,
          });
        } else {
          console.error(`  Failed to apply grades to ${page.filePath}`);
        }
      }

      const r = grades.ratings;
      const warnCount: string = options.skipWarnings ? '' : ` [${automatedWarnings.length + checklistWarnings.length}w]`;
      console.log(`[${index + 1}/${total}] ${page.id}: imp=${grades.readerImportance.toFixed(1)}, f=${r.focus} n=${r.novelty} r=${r.rigor} c=${r.completeness} con=${r.concreteness} a=${r.actionability} o=${r.objectivity} → qual=${derivedQuality} (${metrics.wordCount}w, ${metrics.citations}cit)${warnCount}${options.apply ? (applied ? ' ok' : ' FAIL') : ''}`);
      return { success: true, result };
    } else {
      console.log(`[${index + 1}/${total}] ${page.id}: FAILED (no ratings in response)`);
      return { success: false };
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.log(`[${index + 1}/${total}] ${page.id}: ERROR - ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  console.log('Content Grading Script — 3-Step Pipeline');
  console.log('==========================================\n');

  if (options.skipWarnings) {
    console.log('Mode: Skip warnings (Step 3 only — backward compat)');
  } else if (options.warningsOnly) {
    console.log('Mode: Warnings only (Steps 1-2, no rating)');
  } else {
    console.log('Mode: Full 3-step pipeline (warnings → checklist → rating)');
  }

  // Check for API key
  if (!getApiKey('ANTHROPIC_API_KEY') && !options.dryRun) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... node crux/authoring/grading/index.ts');
    process.exit(1);
  }

  // Collect pages
  let pages: PageInfo[] = collectPages();
  console.log(`Found ${pages.length} total pages\n`);

  // Apply filters
  if (options.page) {
    const query = options.page.toLowerCase();
    pages = pages.filter(p =>
      p.id.toLowerCase().includes(query) ||
      p.title.toLowerCase().includes(query) ||
      p.relativePath.toLowerCase().includes(query)
    );
    if (pages.length === 0) {
      console.error(`No pages found matching: ${options.page}`);
      process.exit(1);
    }
    if (pages.length > 1) {
      console.log(`Found ${pages.length} matching pages:`);
      pages.forEach(p => console.log(`  - ${p.id}: ${p.title}`));
      console.log(`\nUse a more specific query or the full ID.`);
      process.exit(1);
    }
    console.log(`Grading single page: ${pages[0].title}`);
  }

  if (options.category) {
    pages = pages.filter(p => p.category === options.category || p.subcategory === options.category);
    console.log(`Filtered to ${pages.length} pages in category: ${options.category}`);
  }

  if (options.skipGraded) {
    pages = pages.filter(p => p.currentReaderImportance === null);
    console.log(`Filtered to ${pages.length} pages without readerImportance`);
  }

  // Skip overview pages, stubs, non-graded formats, and internal files
  const skippedOverview: number = pages.filter(p => p.pageType === 'overview').length;
  const skippedStub: number = pages.filter(p => p.pageType === 'stub').length;
  const nonGradedFormats = ['index', 'dashboard'];
  const skippedFormat: number = pages.filter(p => nonGradedFormats.includes(p.contentFormat)).length;
  pages = pages.filter(p => p.pageType === 'content' && !p.id.startsWith('_') && !nonGradedFormats.includes(p.contentFormat));
  console.log(`Filtered to ${pages.length} content pages (skipped ${skippedOverview} overview, ${skippedStub} stub, ${skippedFormat} non-graded format)`);

  if (options.limit) {
    pages = pages.slice(0, options.limit);
    console.log(`Limited to ${pages.length} pages`);
  }

  // Cost estimate
  const avgTokens = 4000;
  const outputTokens = 200;
  const sonnetInputCost: number = (pages.length * avgTokens / 1_000_000) * 3;
  const sonnetOutputCost: number = (pages.length * outputTokens / 1_000_000) * 15;
  const haikuInputCost: number = (pages.length * 3000 / 1_000_000) * 0.80;
  const haikuOutputCost: number = (pages.length * 500 / 1_000_000) * 4;

  let totalCost: number;
  if (options.warningsOnly) {
    totalCost = haikuInputCost + haikuOutputCost;
    console.log(`\nCost Estimate (warnings-only — Step 2 Haiku):`);
    console.log(`  Haiku: $${totalCost.toFixed(2)}\n`);
  } else if (options.skipWarnings) {
    totalCost = sonnetInputCost + sonnetOutputCost;
    console.log(`\nCost Estimate (skip-warnings — Step 3 Sonnet only):`);
    console.log(`  Sonnet: $${totalCost.toFixed(2)}\n`);
  } else {
    totalCost = sonnetInputCost + sonnetOutputCost + haikuInputCost + haikuOutputCost;
    console.log(`\nCost Estimate (full pipeline — Haiku + Sonnet):`);
    console.log(`  Step 2 (Haiku):  $${(haikuInputCost + haikuOutputCost).toFixed(2)}`);
    console.log(`  Step 3 (Sonnet): $${(sonnetInputCost + sonnetOutputCost).toFixed(2)}`);
    console.log(`  Total:           $${totalCost.toFixed(2)}\n`);
  }

  if (options.dryRun) {
    console.log('Dry run - pages that would be processed:');
    for (const page of pages.slice(0, 20)) {
      console.log(`  - ${page.relativePath} (${page.category}${page.isModel ? ', model' : ''})`);
    }
    if (pages.length > 20) {
      console.log(`  ... and ${pages.length - 20} more`);
    }
    return;
  }

  // Initialize API client
  const client = createClient()!;

  // Process pages
  const results: PageResult[] = [];
  let processed = 0;
  let errors = 0;

  const concurrency: number = options.parallel;
  console.log(`Processing ${pages.length} pages with concurrency ${concurrency}...\n`);

  // Process in parallel batches
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);
    const batchPromises = batch.map((page, batchIndex) =>
      processPage(client, page, i + batchIndex, pages.length, options)
    );

    const batchResults = await Promise.all(batchPromises);

    for (const br of batchResults) {
      if (br.success) {
        results.push(br.result!);
        processed++;
      } else {
        errors++;
      }
    }

    // Rate limiting
    await new Promise<void>(r => setTimeout(r, 200));
  }

  // Write results
  const outputDir = dirname(options.output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(options.output, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${options.output}`);
  console.log(`Processed: ${processed}, Errors: ${errors}`);

  // Summary statistics
  printStats(results);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
