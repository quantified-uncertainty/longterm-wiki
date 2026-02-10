#!/usr/bin/env node

/**
 * Sidebar Validation Script
 *
 * Validates that all index.mdx files have consistent sidebar configuration:
 * - sidebar.label should be "Overview"
 * - sidebar.order should be 0
 *
 * Usage: node scripts/validate-sidebar.mjs [--ci]
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = Errors found
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../lib/mdx-utils.ts';
import { getColors, formatPath } from '../lib/output.ts';

const CONTENT_DIR = 'content/docs/knowledge-base';
const CI_MODE = process.argv.includes('--ci');
const colors = getColors(CI_MODE);

/**
 * Find all index.mdx files recursively
 */
function findIndexFiles(dir, results = []) {
  if (!existsSync(dir)) return results;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        findIndexFiles(filePath, results);
      } else if (file === 'index.mdx' || file === 'index.md') {
        results.push(filePath);
      }
    }
  } catch (e) {
    // Directory doesn't exist or permission error
  }
  return results;
}

/**
 * Check a single index file for sidebar configuration
 */
function checkIndexFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const issues = [];

  const sidebar = frontmatter.sidebar || {};
  const label = sidebar.label;
  const order = sidebar.order;

  // Check label
  if (label !== 'Overview') {
    issues.push({
      id: 'sidebar-label',
      severity: 'error',
      description: label === undefined
        ? 'Missing sidebar.label (should be "Overview")'
        : `sidebar.label is "${label}" (should be "Overview")`,
      fix: 'Add to frontmatter: sidebar: { label: Overview, order: 0 }',
    });
  }

  // Check order
  if (order !== 0) {
    issues.push({
      id: 'sidebar-order',
      severity: 'error',
      description: order === undefined
        ? 'Missing sidebar.order (should be 0)'
        : `sidebar.order is ${order} (should be 0)`,
      fix: 'Add to frontmatter: sidebar: { label: Overview, order: 0 }',
    });
  }

  return issues;
}

/**
 * Main function
 */
function main() {
  const files = findIndexFiles(CONTENT_DIR);
  const allIssues = [];
  let errorCount = 0;

  if (!CI_MODE) {
    console.log(`${colors.blue}Checking ${files.length} index files for sidebar configuration...${colors.reset}\n`);
  }

  for (const file of files) {
    const issues = checkIndexFile(file);
    if (issues.length > 0) {
      allIssues.push({ file, issues });
      errorCount += issues.length;
    }
  }

  if (CI_MODE) {
    console.log(JSON.stringify({
      files: files.length,
      errors: errorCount,
      issues: allIssues,
    }, null, 2));
  } else {
    if (allIssues.length === 0) {
      console.log(`${colors.green}✓ All ${files.length} index files have correct sidebar configuration${colors.reset}\n`);
      console.log(`${colors.dim}  All use: sidebar: { label: Overview, order: 0 }${colors.reset}\n`);
    } else {
      console.log(`${colors.red}Found ${errorCount} sidebar configuration issue(s):${colors.reset}\n`);

      for (const { file, issues } of allIssues) {
        const relPath = file.replace(process.cwd() + '/', '');
        console.log(`${colors.bold}${relPath}${colors.reset}`);

        for (const issue of issues) {
          console.log(`  ${colors.red}✗ ${issue.description}${colors.reset}`);
          console.log(`    ${colors.dim}Fix: ${issue.fix}${colors.reset}`);
        }
        console.log();
      }

      console.log(`${colors.bold}Summary:${colors.reset}`);
      console.log(`  Index files checked: ${files.length}`);
      console.log(`  ${colors.red}${errorCount} error(s)${colors.reset}`);
      console.log();
      console.log(`${colors.dim}Expected frontmatter for all index.mdx files:${colors.reset}`);
      console.log(`${colors.dim}  sidebar:${colors.reset}`);
      console.log(`${colors.dim}    label: Overview${colors.reset}`);
      console.log(`${colors.dim}    order: 0${colors.reset}`);
      console.log();
    }
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

main();
