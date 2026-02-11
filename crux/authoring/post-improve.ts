#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Post-Improvement Processing Library
 *
 * Runs after batch improvements to:
 * 1. Fix dollar sign escaping issues
 * 2. Fix comparison operator issues
 * 3. Re-grade improved pages
 *
 * Usage:
 *   node crux/authoring/post-improve.ts              # Run all fixes
 *   node crux/authoring/post-improve.ts --fix-only   # Only fix, don't re-grade
 *   node crux/authoring/post-improve.ts --grade-only # Only re-grade
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname: string = path.dirname(fileURLToPath(import.meta.url));
const ROOT: string = path.join(__dirname, '../..');

const args: string[] = process.argv.slice(2);
const fixOnly: boolean = args.includes('--fix-only');
const gradeOnly: boolean = args.includes('--grade-only');
const limit: number = args.includes('--limit')
  ? parseInt(args[args.indexOf('--limit') + 1])
  : 50;

interface RunResult {
  success: boolean;
  output?: string;
  error?: string;
}

function run(cmd: string, description: string): RunResult {
  console.log(`\n\u{1F4E6} ${description}...`);
  try {
    const output: string = execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Extract summary line
    const lines: string[] = output.trim().split('\n');
    const summary: string | undefined = lines.find(l => l.includes('Fixed') || l.includes('No ')) || lines[lines.length - 1];
    console.log(`   \u2705 ${(summary || '').replace(/\x1b\[[0-9;]*m/g, '').trim()}`);
    return { success: true, output };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.log(`   \u26A0\uFE0F  ${error.message.split('\n')[0]}`);
    return { success: false, error: error.message };
  }
}

async function runGrading(limit: number): Promise<RunResult> {
  console.log(`\n\u{1F4CA} Re-grading up to ${limit} pages...`);

  return new Promise((resolve) => {
    const proc: ChildProcess = spawn('node', [
      '--import', 'tsx/esm', '--no-warnings',
      'crux/authoring/grade-content.ts',
      '--category', 'knowledge-base',
      '--limit', String(limit),
      '--apply'
    ], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout: string = '';
    let stderr: string = '';

    proc.stdout!.on('data', (data: Buffer) => { stdout += data; });
    proc.stderr!.on('data', (data: Buffer) => { stderr += data; });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        // Extract summary stats
        const processed: string = stdout.match(/Processed: (\d+)/)?.[1] || '?';
        const avgQual: string = stdout.match(/Avg: ([\d.]+)/)?.[1] || '?';
        console.log(`   \u2705 Graded ${processed} pages (avg quality: ${avgQual})`);
        resolve({ success: true });
      } else {
        console.log(`   \u26A0\uFE0F  Grading failed: ${stderr.slice(0, 100)}`);
        resolve({ success: false, error: stderr });
      }
    });

    proc.on('error', (err: Error) => {
      console.log(`   \u26A0\uFE0F  Grading failed to start: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}

interface Results {
  dollarFix: RunResult | null;
  comparisonFix: RunResult | null;
  grading: RunResult | null;
}

async function main(): Promise<void> {
  console.log('\u2550'.repeat(43));
  console.log('  Post-Improvement Processing');
  console.log('\u2550'.repeat(43));

  const results: Results = {
    dollarFix: null,
    comparisonFix: null,
    grading: null
  };

  if (!gradeOnly) {
    // Fix dollar signs
    results.dollarFix = run(
      'node --import tsx/esm --no-warnings crux/crux.mjs validate unified --rules=dollar-signs --fix',
      'Fixing dollar sign escaping'
    );

    // Fix comparison operators
    results.comparisonFix = run(
      'node --import tsx/esm --no-warnings crux/crux.mjs validate unified --rules=comparison-operators --fix',
      'Fixing comparison operators'
    );
  }

  if (!fixOnly) {
    // Re-grade pages
    results.grading = await runGrading(limit);
  }

  // Summary
  console.log('\n' + '\u2550'.repeat(43));
  console.log('  Summary');
  console.log('\u2550'.repeat(43));

  if (results.dollarFix) {
    console.log(`  Dollar signs: ${results.dollarFix.success ? '\u2705 Fixed' : '\u26A0\uFE0F  Check manually'}`);
  }
  if (results.comparisonFix) {
    console.log(`  Comparisons:  ${results.comparisonFix.success ? '\u2705 Fixed' : '\u26A0\uFE0F  Check manually'}`);
  }
  if (results.grading) {
    console.log(`  Re-grading:   ${results.grading.success ? '\u2705 Done' : '\u26A0\uFE0F  Check manually'}`);
  }

  console.log('\u2550'.repeat(43) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
