#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Quick Re-grade Script
 *
 * Convenience wrapper for grade-content.ts that makes it easy to re-grade
 * specific pages identified by validate:quality.
 *
 * Usage:
 *   node crux/authoring/regrade.ts <page-id>              # Re-grade single page
 *   node crux/authoring/regrade.ts page1 page2 page3      # Re-grade multiple pages
 *   node crux/authoring/regrade.ts --overrated            # Re-grade all overrated pages
 *   node crux/authoring/regrade.ts --dry-run <page-id>    # Preview without applying
 *
 * Requires ANTHROPIC_API_KEY in .env or environment.
 */

import dotenv from 'dotenv';
dotenv.config();

import { spawn, type ChildProcess } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadPages } from '../lib/content-types.ts';

const __dirname: string = dirname(fileURLToPath(import.meta.url));

const args: string[] = process.argv.slice(2);
const DRY_RUN: boolean = args.includes('--dry-run');
const OVERRATED_MODE: boolean = args.includes('--overrated');

// Filter out flags to get page IDs
const pageIds: string[] = args.filter(a => !a.startsWith('--'));

// Check for API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY not found.');
  console.error('Add it to .env or set in environment.\n');
  process.exit(1);
}

interface GradeResult {
  pageId: string;
  success: boolean;
}

/**
 * Find overrated pages from pages.json
 */
function findOverratedPages(): string[] {
  const pages = loadPages();
  if (pages.length === 0) {
    console.error('Error: pages.json not found or empty. Run `pnpm build` first.');
    process.exit(1);
  }

  return pages
    .filter((p: Record<string, unknown>) => p.quality && p.suggestedQuality)
    .filter((p: Record<string, unknown>) => (p.quality as number) - (p.suggestedQuality as number) >= 20)
    .map((p: Record<string, unknown>) => p.id as string);
}

/**
 * Run grade-content.ts for a page
 */
function gradePage(pageId: string): Promise<GradeResult> {
  return new Promise((resolve) => {
    const gradeScript: string = join(__dirname, 'grade-content.ts');
    const gradeArgs: string[] = ['--page', pageId];
    if (!DRY_RUN) gradeArgs.push('--apply');

    console.log(`\n\u{1F4DD} ${DRY_RUN ? 'Previewing' : 'Re-grading'}: ${pageId}`);

    const child: ChildProcess = spawn('node', [gradeScript, ...gradeArgs], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });

    child.on('close', (code: number | null) => {
      resolve({ pageId, success: code === 0 });
    });

    child.on('error', (err: Error) => {
      console.error(`  Error: ${err.message}`);
      resolve({ pageId, success: false });
    });
  });
}

async function main(): Promise<void> {
  let pagesToGrade: string[] = pageIds;

  // If --overrated, find all overrated pages
  if (OVERRATED_MODE) {
    pagesToGrade = findOverratedPages();
    if (pagesToGrade.length === 0) {
      console.log('\u2713 No overrated pages found.');
      return;
    }
    console.log(`Found ${pagesToGrade.length} overrated page(s):`);
    pagesToGrade.forEach(id => console.log(`  - ${id}`));
  }

  if (pagesToGrade.length === 0) {
    console.log(`
Re-grade Page Quality

Usage:
  node crux/authoring/regrade.ts <page-id>         Re-grade a single page
  node crux/authoring/regrade.ts id1 id2 id3       Re-grade multiple pages
  node crux/authoring/regrade.ts --overrated       Re-grade all overrated pages
  node crux/authoring/regrade.ts --dry-run <id>    Preview without applying

First, find pages that need re-grading:
  node crux/crux.mjs validate quality
`);
    return;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Re-grading ${pagesToGrade.length} page(s)${DRY_RUN ? ' (dry run)' : ''}`);
  console.log(`${'='.repeat(50)}`);

  const results: GradeResult[] = [];
  for (const pageId of pagesToGrade) {
    const result: GradeResult = await gradePage(pageId);
    results.push(result);
  }

  // Summary
  const succeeded: number = results.filter(r => r.success).length;
  const failed: number = results.filter(r => !r.success).length;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Complete: ${succeeded} succeeded, ${failed} failed`);

  if (!DRY_RUN && succeeded > 0) {
    console.log(`\nRun \`pnpm build\` to update pages.json with new ratings.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
