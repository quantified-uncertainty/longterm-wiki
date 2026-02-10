#!/usr/bin/env node
/**
 * Auto-fix script - runs all available --fix operations in parallel
 * Usage: node tooling/auto-fix.mjs [--dry-run]
 */

import { execSync } from 'child_process';
import { getColors } from './lib/output.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const colors = getColors();

console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
console.log(`${colors.bold}${colors.blue}  Auto-Fix Script${colors.reset}`);
console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
console.log();

if (DRY_RUN) {
  console.log(`${colors.yellow}DRY RUN MODE - no changes will be made${colors.reset}\n`);
}

// Define fixable validators with their commands
const fixers = [
  {
    name: 'EntityLink Conversion',
    description: 'Convert markdown links to EntityLink components',
    command: 'node tooling/validate/validate-entity-links.mjs --fix',
  },
  {
    name: 'Escaping (dollars, comparisons, tildes)',
    description: 'Escape special characters for LaTeX/JSX',
    command: 'node tooling/validate/validate-unified.mjs --rules=dollar-signs,comparison-operators,tilde-dollar --fix',
  },
  {
    name: 'Markdown Formatting',
    description: 'Fix markdown lists and bold labels',
    command: 'node tooling/validate/validate-unified.mjs --rules=markdown-lists,consecutive-bold-labels --fix',
  },
];

async function runFixer(fixer) {
  const startTime = Date.now();

  return new Promise((resolve) => {
    if (DRY_RUN) {
      console.log(`${colors.dim}[DRY RUN] Would run: ${fixer.command}${colors.reset}`);
      resolve({ name: fixer.name, success: true, dryRun: true });
      return;
    }

    try {
      const output = execSync(fixer.command, {
        encoding: 'utf8',
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`${colors.green}✓${colors.reset} ${fixer.name} ${colors.dim}(${duration}s)${colors.reset}`);
      resolve({ name: fixer.name, success: true, output });
    } catch (error) {
      console.log(`${colors.yellow}⚠${colors.reset} ${fixer.name}: ${error.message.split('\n')[0]}`);
      resolve({ name: fixer.name, success: false, error: error.message });
    }
  });
}

async function main() {
  console.log(`Running ${fixers.length} auto-fixers...\n`);

  // Run fixers sequentially (execSync blocks the event loop)
  const results = [];
  for (const fixer of fixers) {
    results.push(await runFixer(fixer));
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

main();
