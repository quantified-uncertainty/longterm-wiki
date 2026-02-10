#!/usr/bin/env node

/**
 * Quick Re-grade Script
 *
 * Convenience wrapper for grade-content.mjs that makes it easy to re-grade
 * specific pages identified by validate:quality.
 *
 * Usage:
 *   node crux/authoring/regrade.mjs <page-id>              # Re-grade single page
 *   node crux/authoring/regrade.mjs page1 page2 page3      # Re-grade multiple pages
 *   node crux/authoring/regrade.mjs --overrated            # Re-grade all overrated pages
 *   node crux/authoring/regrade.mjs --dry-run <page-id>    # Preview without applying
 *
 * Requires ANTHROPIC_API_KEY in .env or environment.
 */

import dotenv from 'dotenv';
dotenv.config();

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadPages } from '../lib/content-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const OVERRATED_MODE = args.includes('--overrated');

// Filter out flags to get page IDs
const pageIds = args.filter(a => !a.startsWith('--'));

// Check for API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY not found.');
  console.error('Add it to .env or set in environment.\n');
  process.exit(1);
}

/**
 * Find overrated pages from pages.json
 */
function findOverratedPages() {
  const pages = loadPages();
  if (pages.length === 0) {
    console.error('Error: pages.json not found or empty. Run `pnpm build` first.');
    process.exit(1);
  }

  return pages
    .filter(p => p.quality && p.suggestedQuality)
    .filter(p => p.quality - p.suggestedQuality >= 20)
    .map(p => p.id);
}

/**
 * Run grade-content.mjs for a page
 */
function gradePage(pageId) {
  return new Promise((resolve) => {
    const gradeScript = join(__dirname, 'grade-content.mjs');
    const gradeArgs = ['--page', pageId];
    if (!DRY_RUN) gradeArgs.push('--apply');

    console.log(`\n📝 ${DRY_RUN ? 'Previewing' : 'Re-grading'}: ${pageId}`);

    const child = spawn('node', [gradeScript, ...gradeArgs], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });

    child.on('close', (code) => {
      resolve({ pageId, success: code === 0 });
    });

    child.on('error', (err) => {
      console.error(`  Error: ${err.message}`);
      resolve({ pageId, success: false });
    });
  });
}

async function main() {
  let pagesToGrade = pageIds;

  // If --overrated, find all overrated pages
  if (OVERRATED_MODE) {
    pagesToGrade = findOverratedPages();
    if (pagesToGrade.length === 0) {
      console.log('✓ No overrated pages found.');
      return;
    }
    console.log(`Found ${pagesToGrade.length} overrated page(s):`);
    pagesToGrade.forEach(id => console.log(`  - ${id}`));
  }

  if (pagesToGrade.length === 0) {
    console.log(`
Re-grade Page Quality

Usage:
  node crux/authoring/regrade.mjs <page-id>         Re-grade a single page
  node crux/authoring/regrade.mjs id1 id2 id3       Re-grade multiple pages
  node crux/authoring/regrade.mjs --overrated       Re-grade all overrated pages
  node crux/authoring/regrade.mjs --dry-run <id>    Preview without applying

First, find pages that need re-grading:
  node crux/crux.mjs validate quality
`);
    return;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Re-grading ${pagesToGrade.length} page(s)${DRY_RUN ? ' (dry run)' : ''}`);
  console.log(`${'='.repeat(50)}`);

  const results = [];
  for (const pageId of pagesToGrade) {
    const result = await gradePage(pageId);
    results.push(result);
  }

  // Summary
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Complete: ${succeeded} succeeded, ${failed} failed`);

  if (!DRY_RUN && succeeded > 0) {
    console.log(`\nRun \`pnpm build\` to update pages.json with new ratings.`);
  }
}

main().catch(console.error);
