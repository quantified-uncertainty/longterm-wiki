#!/usr/bin/env node
/**
 * Auto-fix script - runs all available --fix operations in parallel
 * Usage: node crux/auto-fix.ts [--dry-run]
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getColors } from './lib/output.ts';
import { PROJECT_ROOT } from './lib/content-types.ts';

const args: string[] = process.argv.slice(2);
const DRY_RUN: boolean = args.includes('--dry-run');

const colors = getColors();

console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
console.log(`${colors.bold}${colors.blue}  Auto-Fix Script${colors.reset}`);
console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
console.log();

if (DRY_RUN) {
  console.log(`${colors.yellow}DRY RUN MODE - no changes will be made${colors.reset}\n`);
}

interface Fixer {
  name: string;
  description: string;
  command: string;
}

interface FixerResult {
  name: string;
  success: boolean;
  output?: string;
  error?: string;
  dryRun?: boolean;
  skipped?: boolean;
}

// Define fixable validators with their commands
const fixers: Fixer[] = [
  {
    name: 'EntityLink Conversion',
    description: 'Convert markdown links to EntityLink components',
    command: 'node --import tsx/esm crux/validate/validate-entity-links.ts --fix',
  },
  {
    name: 'Escaping (dollars, comparisons, tildes)',
    description: 'Escape special characters for LaTeX/JSX',
    command: 'node --import tsx/esm crux/validate/validate-unified.ts --rules=dollar-signs,comparison-operators,tilde-dollar --fix',
  },
  {
    name: 'Markdown Formatting',
    description: 'Fix markdown lists and bold labels',
    command: 'node --import tsx/esm crux/validate/validate-unified.ts --rules=markdown-lists,consecutive-bold-labels --fix',
  },
];

function runFixer(fixer: Fixer): FixerResult {
  if (DRY_RUN) {
    console.log(`${colors.dim}[DRY RUN] Would run: ${fixer.command}${colors.reset}`);
    return { name: fixer.name, success: true, dryRun: true };
  }

  const startTime = Date.now();
  try {
    const output = execSync(fixer.command, {
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`${colors.green}✓${colors.reset} ${fixer.name} ${colors.dim}(${duration}s)${colors.reset}`);
    return { name: fixer.name, success: true, output };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.log(`${colors.yellow}⚠${colors.reset} ${fixer.name}: ${error.message.split('\n')[0]}`);
    return { name: fixer.name, success: false, error: error.message };
  }
}

function main(): void {
  console.log(`Running ${fixers.length} auto-fixers...\n`);

  const results: FixerResult[] = [];
  for (const fixer of fixers) {
    results.push(runFixer(fixer));
  }

  console.log();
  console.log(`${colors.bold}Summary:${colors.reset}`);

  const successful = results.filter(r => r.success && !r.skipped && !r.dryRun).length;
  const skipped = results.filter(r => r.skipped).length;
  const failed = results.filter(r => !r.success).length;

  if (DRY_RUN) {
    console.log(`  ${colors.dim}Dry run - no changes made${colors.reset}`);
  } else {
    console.log(`  ${colors.green}Fixed: ${successful}${colors.reset}`);
    if (skipped > 0) console.log(`  ${colors.dim}Skipped: ${skipped}${colors.reset}`);
    if (failed > 0) console.log(`  ${colors.yellow}Failed: ${failed}${colors.reset}`);
  }

  // Exit with error if any failed
  process.exit(failed > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
