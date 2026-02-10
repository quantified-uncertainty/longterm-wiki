#!/usr/bin/env node

/**
 * Post-Improvement Processing Library
 *
 * Runs after batch improvements to:
 * 1. Fix dollar sign escaping issues
 * 2. Fix comparison operator issues
 * 3. Re-grade improved pages
 *
 * Usage:
 *   node tooling/authoring/post-improve.mjs              # Run all fixes
 *   node tooling/authoring/post-improve.mjs --fix-only   # Only fix, don't re-grade
 *   node tooling/authoring/post-improve.mjs --grade-only # Only re-grade
 */

import { execSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');

const args = process.argv.slice(2);
const fixOnly = args.includes('--fix-only');
const gradeOnly = args.includes('--grade-only');
const limit = args.includes('--limit')
  ? parseInt(args[args.indexOf('--limit') + 1])
  : 50;

function run(cmd, description) {
  console.log(`\n📦 ${description}...`);
  try {
    const output = execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Extract summary line
    const lines = output.trim().split('\n');
    const summary = lines.find(l => l.includes('Fixed') || l.includes('No ')) || lines[lines.length - 1];
    console.log(`   ✅ ${summary.replace(/\x1b\[[0-9;]*m/g, '').trim()}`);
    return { success: true, output };
  } catch (e) {
    console.log(`   ⚠️  ${e.message.split('\n')[0]}`);
    return { success: false, error: e.message };
  }
}

async function runGrading(limit) {
  console.log(`\n📊 Re-grading up to ${limit} pages...`);

  return new Promise((resolve) => {
    const proc = spawn('node', [
      'tooling/authoring/grade-content.mjs',
      '--category', 'knowledge-base',
      '--limit', String(limit),
      '--apply'
    ], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code === 0) {
        // Extract summary stats
        const processed = stdout.match(/Processed: (\d+)/)?.[1] || '?';
        const avgQual = stdout.match(/Avg: ([\d.]+)/)?.[1] || '?';
        console.log(`   ✅ Graded ${processed} pages (avg quality: ${avgQual})`);
        resolve({ success: true });
      } else {
        console.log(`   ⚠️  Grading failed: ${stderr.slice(0, 100)}`);
        resolve({ success: false, error: stderr });
      }
    });
  });
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Post-Improvement Processing');
  console.log('═══════════════════════════════════════════');

  const results = {
    dollarFix: null,
    comparisonFix: null,
    grading: null
  };

  if (!gradeOnly) {
    // Fix dollar signs
    results.dollarFix = run(
      'node tooling/crux.mjs validate unified --rules=dollar-signs --fix',
      'Fixing dollar sign escaping'
    );

    // Fix comparison operators
    results.comparisonFix = run(
      'node tooling/crux.mjs validate unified --rules=comparison-operators --fix',
      'Fixing comparison operators'
    );
  }

  if (!fixOnly) {
    // Re-grade pages
    results.grading = await runGrading(limit);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════');

  if (results.dollarFix) {
    console.log(`  Dollar signs: ${results.dollarFix.success ? '✅ Fixed' : '⚠️  Check manually'}`);
  }
  if (results.comparisonFix) {
    console.log(`  Comparisons:  ${results.comparisonFix.success ? '✅ Fixed' : '⚠️  Check manually'}`);
  }
  if (results.grading) {
    console.log(`  Re-grading:   ${results.grading.success ? '✅ Done' : '⚠️  Check manually'}`);
  }

  console.log('═══════════════════════════════════════════\n');
}

main().catch(console.error);
