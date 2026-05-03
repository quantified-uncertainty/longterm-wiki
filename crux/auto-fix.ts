#!/usr/bin/env node
/**
 * Auto-fix script - runs all available --fix operations in parallel
 * Usage: node crux/auto-fix.ts [--dry-run]
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getColors } from './lib/output.ts';
import { PROJECT_ROOT } from './lib/content-types.ts';
import { resolveCruxScriptArgs } from './lib/cli.ts';

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
  /** Crux-relative source path of the script to spawn (e.g. `validate/validate-unified.ts`). */
  scriptRel: string;
  /** Args to forward to the script. Each is its own argv entry — never a shell-joined string. */
  args: string[];
}

interface FixerResult {
  name: string;
  success: boolean;
  output?: string;
  error?: string;
  dryRun?: boolean;
  skipped?: boolean;
}

// Define fixable validators. Each entry produces a `node ... args` spawn
// (no shell), so paths with spaces/quotes can't be misinterpreted and
// no metacharacters need escaping.
const fixers: Fixer[] = [
  {
    name: 'Escaping (dollars, comparisons, tildes)',
    description: 'Escape special characters for LaTeX/JSX',
    scriptRel: 'validate/validate-unified.ts',
    args: ['--rules=dollar-signs,comparison-operators,tilde-dollar', '--fix'],
  },
  {
    name: 'Markdown Formatting',
    description: 'Fix markdown lists and bold labels',
    scriptRel: 'validate/validate-unified.ts',
    args: ['--rules=markdown-lists,consecutive-bold-labels', '--fix'],
  },
  {
    name: 'Frontmatter Field Order',
    description: 'Reorder frontmatter fields to canonical order (identity first, volatile last)',
    scriptRel: 'fix/fix-frontmatter-order.ts',
    args: ['--apply'],
  },
];

function describeFixer(fixer: Fixer): string {
  const { args } = resolveCruxScriptArgs(fixer.scriptRel);
  return ['node', ...args, ...fixer.args].join(' ');
}

function runFixer(fixer: Fixer): FixerResult {
  if (DRY_RUN) {
    console.log(`${colors.dim}[DRY RUN] Would run: ${describeFixer(fixer)}${colors.reset}`);
    return { name: fixer.name, success: true, dryRun: true };
  }

  const startTime = Date.now();
  const { args: scriptInvocation } = resolveCruxScriptArgs(fixer.scriptRel);
  const result = spawnSync('node', [...scriptInvocation, ...fixer.args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  if (result.error) {
    console.log(`${colors.yellow}⚠${colors.reset} ${fixer.name}: ${result.error.message.split('\n')[0]}`);
    return { name: fixer.name, success: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const stderr = result.stderr || '';
    const firstLine = (result.stdout || stderr).split('\n')[0] || `exit ${result.status}`;
    console.log(`${colors.yellow}⚠${colors.reset} ${fixer.name}: ${firstLine}`);
    return { name: fixer.name, success: false, error: stderr || `exit ${result.status}` };
  }

  console.log(`${colors.green}✓${colors.reset} ${fixer.name} ${colors.dim}(${duration}s)${colors.reset}`);
  return { name: fixer.name, success: true, output: result.stdout };
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
