#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Grade Content CLI — 3-Step Pipeline entry point.
 *
 * Orchestrates page collection, filtering, cost estimation, parallel
 * processing, and statistics output. Delegates grading logic to steps.ts.
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
 *   --skip-graded      Skip pages that already have importance set
 *   --output FILE      Write results to JSON file
 *   --apply            Apply grades directly to frontmatter
 *   --skip-warnings    Skip Steps 1-2, just rate (backward compat)
 *   --warnings-only    Run Steps 1-2, skip rating (Step 3)
 */

import { createClient } from '../../lib/anthropic.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { relative, basename, dirname } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { fileURLToPath } from 'url';
import { CONTENT_DIR } from '../../lib/content-types.ts';
import { parseFrontmatter } from '../../lib/mdx-utils.ts';
import { findMdxFiles } from '../../lib/file-utils.ts';
import { parseCliArgs } from '../../lib/cli.ts';
import { appendEditLog, getDefaultRequestedBy } from '../../lib/edit-log.ts';
import type Anthropic from '@anthropic-ai/sdk';

import type {
  Frontmatter, PageInfo, Warning, ChecklistWarning,
  GradeResult, PageResult, ProcessPageResult, Options,
} from './types.ts';
import {
  computeMetrics, computeQuality,
  runAutomatedWarnings, runChecklistReview,
  formatWarningsSummary, gradePage,
} from './steps.ts';

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

// ── Page Collection ──────────────────────────────────────────────────────────

/** Alias for shared parseFrontmatter. */
const extractFrontmatter = parseFrontmatter;

/**
 * Detect page type based on filename and frontmatter.
 * - 'overview': index.mdx files (navigation pages)
 * - 'stub': explicitly marked in frontmatter
 * - 'content': default
 */
function detectPageType(id: string, frontmatter: Frontmatter): string {
  if (id === 'index') return 'overview';
  if (frontmatter.pageType === 'stub') return 'stub';
  return 'content';
}

/** Scan content directory and collect all pages. */
function collectPages(): PageInfo[] {
  const files = findMdxFiles(CONTENT_DIR);
  const pages: PageInfo[] = [];

  for (const fullPath of files) {
    const content = readFileSync(fullPath, 'utf-8');
    const fm = extractFrontmatter(content) as Frontmatter;
    const entry = basename(fullPath);
    const id = basename(entry, entry.endsWith('.mdx') ? '.mdx' : '.md');

    const relPath = relative(CONTENT_DIR, fullPath);
    const pathParts = dirname(relPath).split('/').filter(p => p && p !== '.');
    const category = pathParts[0] || 'other';
    const subcategory = pathParts[1] || null;
    const urlPrefix = '/' + pathParts.join('/');

    const isModel = relPath.includes('/models') || fm.ratings !== undefined;
    const pageType = detectPageType(id, fm);

    pages.push({
      id,
      filePath: fullPath,
      relativePath: relPath,
      urlPath: id === 'index' ? `${urlPrefix}/` : `${urlPrefix}/${id}/`,
      title: fm.title || id.replace(/-/g, ' '),
      category,
      subcategory,
      isModel,
      pageType,
      contentFormat: fm.contentFormat || 'article',
      currentImportance: fm.importance ?? null,
      currentQuality: fm.quality ?? null,
      currentRatings: fm.ratings ?? null,
      content,
      frontmatter: fm,
    });
  }

  return pages;
}

// ── Frontmatter Application ──────────────────────────────────────────────────

/** Apply grades to frontmatter YAML in the source file. */
function applyGradesToFile(page: PageInfo, grades: GradeResult, metrics: { wordCount: number; citations: number; tables: number; diagrams: number }, derivedQuality: number): boolean {
  const content = readFileSync(page.filePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

  if (!fmMatch) {
    console.warn(`No frontmatter found in ${page.filePath}`);
    return false;
  }

  const fm = parseYaml(fmMatch[1]) || {} as Record<string, unknown>;

  fm.importance = grades.importance;
  fm.quality = derivedQuality;
  if (grades.llmSummary) {
    fm.llmSummary = grades.llmSummary;
  }
  if (grades.ratings) {
    fm.ratings = grades.ratings;
  }
  // Metrics are computed at build time — not stored in frontmatter.
  delete fm.metrics;

  if (fm.lastEdited instanceof Date) {
    fm.lastEdited = fm.lastEdited.toISOString().split('T')[0];
  }

  let newFm: string = stringifyYaml(fm, {
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  });

  // Ensure lastEdited is always quoted
  newFm = newFm.replace(/^(lastEdited:\s*)(\d{4}-\d{2}-\d{2})$/m, '$1"$2"');

  if (!newFm.endsWith('\n')) {
    newFm += '\n';
  }

  const bodyStart: number = content.indexOf('---', 4) + 3;
  let body: string = content.slice(bodyStart);
  body = '\n' + body.replace(/^\n+/, '');
  const newContent: string = `---\n${newFm}---${body}`;

  // Validation: ensure file structure is correct
  const fmTest = newContent.match(/^---\n[\s\S]*?\n---\n/);
  if (!fmTest) {
    console.error(`ERROR: Invalid frontmatter structure in ${page.filePath}`);
    console.error('Frontmatter must end with ---\\n');
    return false;
  }

  // Validation: ensure no corrupted imports
  const afterFm: string = newContent.slice(fmTest[0].length);
  if (/^[a-z]/.test(afterFm.trim()) && !/^(import|export|const|let|var|function|class|\/\/)/.test(afterFm.trim())) {
    console.error(`ERROR: Suspicious content after frontmatter in ${page.filePath}`);
    console.error(`First chars: "${afterFm.slice(0, 50)}..."`);
    return false;
  }

  writeFileSync(page.filePath, newContent);
  return true;
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
  if (!process.env.ANTHROPIC_API_KEY && !options.dryRun) {
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
    pages = pages.filter(p => p.currentImportance === null);
    console.log(`Filtered to ${pages.length} pages without importance`);
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

  async function processPage(page: PageInfo, index: number): Promise<ProcessPageResult> {
    try {
      let automatedWarnings: Warning[] = [];
      let checklistWarnings: ChecklistWarning[] = [];
      let warningsSummary: string | null = null;

      // Step 1 & 2: Run warnings (unless --skip-warnings)
      if (!options.skipWarnings) {
        automatedWarnings = await runAutomatedWarnings(page);
        console.log(`  [${index + 1}/${pages.length}] ${page.id}: Step 1 — ${automatedWarnings.length} automated warnings`);

        if (!options.dryRun) {
          checklistWarnings = await runChecklistReview(client, page);
          console.log(`  [${index + 1}/${pages.length}] ${page.id}: Step 2 — ${checklistWarnings.length} checklist warnings`);
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
        console.log(`[${index + 1}/${pages.length}] ${page.id}: ${automatedWarnings.length + checklistWarnings.length} total warnings (warnings-only mode)`);
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
          importance: grades.importance,
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
              note: `Quality graded: ${derivedQuality}, importance: ${grades.importance.toFixed(1)}`,
            });
          } else {
            console.error(`  Failed to apply grades to ${page.filePath}`);
          }
        }

        const r = grades.ratings;
        const warnCount: string = options.skipWarnings ? '' : ` [${automatedWarnings.length + checklistWarnings.length}w]`;
        console.log(`[${index + 1}/${pages.length}] ${page.id}: imp=${grades.importance.toFixed(1)}, f=${r.focus} n=${r.novelty} r=${r.rigor} c=${r.completeness} con=${r.concreteness} a=${r.actionability} o=${r.objectivity} → qual=${derivedQuality} (${metrics.wordCount}w, ${metrics.citations}cit)${warnCount}${options.apply ? (applied ? ' ok' : ' FAIL') : ''}`);
        return { success: true, result };
      } else {
        console.log(`[${index + 1}/${pages.length}] ${page.id}: FAILED (no ratings in response)`);
        return { success: false };
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.log(`[${index + 1}/${pages.length}] ${page.id}: ERROR - ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // Process in parallel batches
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);
    const batchPromises = batch.map((page, batchIndex) =>
      processPage(page, i + batchIndex)
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
  const importanceScores: number[] = results.map(r => r.importance).filter((x): x is number => x != null).sort((a, b) => b - a);
  const qualityScores: number[] = results.map(r => r.quality).filter((x): x is number => x != null).sort((a, b) => b - a);

  const impRanges: Record<string, number> = {
    '90-100': importanceScores.filter(x => x >= 90).length,
    '70-89': importanceScores.filter(x => x >= 70 && x < 90).length,
    '50-69': importanceScores.filter(x => x >= 50 && x < 70).length,
    '30-49': importanceScores.filter(x => x >= 30 && x < 50).length,
    '0-29': importanceScores.filter(x => x < 30).length,
  };

  console.log('\nImportance Distribution (0-100):');
  for (const [range, count] of Object.entries(impRanges)) {
    const bar = '\u2588'.repeat(Math.ceil(count / 3));
    console.log(`  ${range}: ${bar} (${count})`);
  }

  if (importanceScores.length > 0) {
    const impAvg: number = importanceScores.reduce((a, b) => a + b, 0) / importanceScores.length;
    const impMedian: number = importanceScores[Math.floor(importanceScores.length / 2)];
    console.log(`\n  Avg: ${impAvg.toFixed(1)}, Median: ${impMedian.toFixed(1)}`);
    console.log(`  Top 5: ${importanceScores.slice(0, 5).map(x => x.toFixed(1)).join(', ')}`);
    console.log(`  Bottom 5: ${importanceScores.slice(-5).map(x => x.toFixed(1)).join(', ')}`);
  }

  const qualRanges: Record<string, number> = {
    '80-100 (Comprehensive)': qualityScores.filter(x => x >= 80).length,
    '60-79 (Good)': qualityScores.filter(x => x >= 60 && x < 80).length,
    '40-59 (Adequate)': qualityScores.filter(x => x >= 40 && x < 60).length,
    '20-39 (Draft)': qualityScores.filter(x => x >= 20 && x < 40).length,
    '0-19 (Stub)': qualityScores.filter(x => x < 20).length,
  };

  console.log('\nQuality Distribution (0-100):');
  for (const [range, count] of Object.entries(qualRanges)) {
    const bar = '\u2588'.repeat(Math.ceil(count / 3));
    console.log(`  ${range}: ${bar} (${count})`);
  }

  if (qualityScores.length > 0) {
    const qualAvg: number = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
    const qualMedian: number = qualityScores[Math.floor(qualityScores.length / 2)];
    console.log(`\n  Avg: ${qualAvg.toFixed(1)}, Median: ${qualMedian.toFixed(1)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
