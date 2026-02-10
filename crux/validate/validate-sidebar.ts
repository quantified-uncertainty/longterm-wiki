#!/usr/bin/env node

/**
 * Sidebar Validation Script
 *
 * Validates that all index.mdx files have consistent sidebar configuration:
 * - sidebar.label should be "Overview"
 * - sidebar.order should be 0
 *
 * Usage: node scripts/validate-sidebar.ts [--ci]
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = Errors found
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from '../lib/mdx-utils.ts';
import { getColors, formatPath } from '../lib/output.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

const CONTENT_DIR: string = 'content/docs/knowledge-base';

interface SidebarIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  description: string;
  fix: string;
}

interface FileWithIssues {
  file: string;
  issues: SidebarIssue[];
}

interface IndexFileCheckResult {
  file: string;
  issues: SidebarIssue[];
}

/**
 * Find all index.mdx files recursively
 */
function findIndexFiles(dir: string, results: string[] = []): string[] {
  if (!existsSync(dir)) return results;

  try {
    const files: string[] = readdirSync(dir);
    for (const file of files) {
      const filePath: string = join(dir, file);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        findIndexFiles(filePath, results);
      } else if (file === 'index.mdx' || file === 'index.md') {
        results.push(filePath);
      }
    }
  } catch (e: unknown) {
    // Directory doesn't exist or permission error
  }
  return results;
}

/**
 * Check a single index file for sidebar configuration
 */
function checkIndexFile(filePath: string): SidebarIssue[] {
  const content: string = readFileSync(filePath, 'utf-8');
  const frontmatter: Record<string, unknown> = parseFrontmatter(content);
  const issues: SidebarIssue[] = [];

  const sidebar = (frontmatter.sidebar || {}) as Record<string, unknown>;
  const label = sidebar.label as string | undefined;
  const order = sidebar.order as number | undefined;

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

export function runCheck(options?: ValidatorOptions): ValidatorResult {
  const CI_MODE: boolean = options?.ci ?? process.argv.includes('--ci');
  const colors = getColors(CI_MODE);

  const files: string[] = findIndexFiles(CONTENT_DIR);
  const allIssues: FileWithIssues[] = [];
  let errorCount: number = 0;

  if (!CI_MODE) {
    console.log(`${colors.blue}Checking ${files.length} index files for sidebar configuration...${colors.reset}\n`);
  }

  for (const file of files) {
    const issues: SidebarIssue[] = checkIndexFile(file);
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
        const relPath: string = file.replace(process.cwd() + '/', '');
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

  return { passed: errorCount === 0, errors: errorCount, warnings: 0 };
}

/**
 * Main function
 */
function main(): void {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
