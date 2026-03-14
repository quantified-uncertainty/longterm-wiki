#!/usr/bin/env node

/**
 * QA Sweep — Deterministic checks for adversarial quality assurance
 *
 * Runs automated checks that don't require LLM judgment:
 * - Recent changes summary (what to prioritize)
 * - Duplicate numericIds
 * - Broken entity references
 * - NEEDS CITATION markers in content
 * - Test status
 * - Gate validation status
 *
 * The `/qa-sweep` Claude Code skill calls this for the deterministic layer,
 * then adds LLM-driven agents on top (production site audit, code review).
 *
 * Usage:
 *   crux qa-sweep              Full sweep report (default)
 *   crux qa-sweep recent       Show recent changes only
 *   crux qa-sweep checks       Run automated checks only
 *   crux qa-sweep --json       JSON output for scripting
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const SUB_COMMAND = args.find((a) => !a.startsWith('--')) ?? 'full';

const c = getColors();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function run(cmd: string, opts?: { cwd?: string; timeout?: number }): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd ?? PROJECT_ROOT,
      timeout: opts?.timeout ?? 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  details?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent changes
// ─────────────────────────────────────────────────────────────────────────────

interface RecentChange {
  type: 'pr' | 'commit';
  id: string;
  title: string;
  date: string;
  files?: number;
}

function getRecentChanges(): RecentChange[] {
  const changes: RecentChange[] = [];

  // Recent merged PRs (last 3 days)
  const prOutput = run(
    `gh pr list --state merged --limit 15 --json number,title,mergedAt ` +
    `--jq '.[] | "\\(.number)\\t\\(.mergedAt[:10])\\t\\(.title)"'`
  );
  if (prOutput) {
    for (const line of prOutput.split('\n')) {
      const [num, date, ...titleParts] = line.split('\t');
      if (num && date) {
        changes.push({ type: 'pr', id: `#${num}`, title: titleParts.join('\t'), date });
      }
    }
  }

  return changes;
}

function getChangedFiles(): string[] {
  const output = run(
    `git log --since="3 days ago" --name-only --pretty=format: -- '*.ts' '*.tsx' '*.yaml' '*.mdx' | sort -u`
  );
  return output ? output.split('\n').filter(Boolean) : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Automated checks
// ─────────────────────────────────────────────────────────────────────────────

function checkDuplicateNumericIds(): CheckResult {
  const entitiesDir = join(PROJECT_ROOT, 'data/entities');
  const contentDir = join(PROJECT_ROOT, 'content/docs');

  // Track IDs separately — an ID appearing once in YAML and once in MDX is normal
  // (the MDX page frontmatter mirrors the YAML entity). Only flag true duplicates
  // within the same source type.
  const yamlIds = new Map<string, number>();
  const mdxIds = new Map<string, number>();

  // Scan entity YAML
  try {
    const yamlOutput = run(`grep -rh 'numericId:' ${entitiesDir}`);
    for (const line of yamlOutput.split('\n')) {
      const match = line.match(/numericId:\s*"?(E\d+)"?/);
      if (match) {
        yamlIds.set(match[1], (yamlIds.get(match[1]) ?? 0) + 1);
      }
    }
  } catch { /* empty */ }

  // Scan MDX frontmatter
  try {
    const mdxOutput = run(`grep -rh 'numericId:' ${contentDir} --include='*.mdx' --include='*.md'`);
    for (const line of mdxOutput.split('\n')) {
      const match = line.match(/numericId:\s*"?(E\d+)"?/);
      if (match) {
        mdxIds.set(match[1], (mdxIds.get(match[1]) ?? 0) + 1);
      }
    }
  } catch { /* empty */ }

  const duplicates: string[] = [];
  for (const [id, count] of yamlIds) {
    if (count > 1) duplicates.push(`${id}: ${count}x in entity YAML`);
  }
  for (const [id, count] of mdxIds) {
    if (count > 1) duplicates.push(`${id}: ${count}x in MDX frontmatter`);
  }

  const totalIds = new Set([...yamlIds.keys(), ...mdxIds.keys()]).size;

  if (duplicates.length === 0) {
    return { name: 'Duplicate numericIds', status: 'pass', message: `${totalIds} unique IDs, no duplicates within sources` };
  }

  return {
    name: 'Duplicate numericIds',
    status: 'fail',
    message: `${duplicates.length} duplicate numericIds found`,
    details: duplicates,
  };
}

function checkBrokenEntityRefs(): CheckResult {
  // Known deleted/merged entities — add to this list as entities get deduplicated
  const DELETED_ENTITIES = ['E8', 'E252'];
  const issues: string[] = [];

  for (const entityId of DELETED_ENTITIES) {
    const refs = run(`grep -rn 'id="${entityId}"' content/docs/ apps/web/src/ 2>/dev/null || true`);
    if (refs) {
      for (const line of refs.split('\n').filter(Boolean)) {
        issues.push(`Reference to deleted ${entityId}: ${line.split(':').slice(0, 2).join(':')}`);
      }
    }
  }

  if (issues.length === 0) {
    return { name: 'Broken entity refs', status: 'pass', message: `No references to ${DELETED_ENTITIES.join(', ')}` };
  }

  return {
    name: 'Broken entity refs',
    status: 'fail',
    message: `${issues.length} references to deleted entities`,
    details: issues,
  };
}

function checkNeedsCitation(): CheckResult {
  const output = run(`grep -rn 'NEEDS CITATION' content/docs/ --include='*.mdx' 2>/dev/null || true`);
  const lines = output ? output.split('\n').filter(Boolean) : [];

  if (lines.length === 0) {
    return { name: 'NEEDS CITATION markers', status: 'pass', message: 'No markers found' };
  }

  // Group by file
  const fileMap = new Map<string, number>();
  for (const line of lines) {
    const file = line.split(':')[0].replace(PROJECT_ROOT + '/', '');
    fileMap.set(file, (fileMap.get(file) ?? 0) + 1);
  }

  return {
    name: 'NEEDS CITATION markers',
    status: 'warn',
    message: `${lines.length} markers in ${fileMap.size} files`,
    details: [...fileMap.entries()].map(([file, count]) => `${file}: ${count}`),
  };
}

function checkTodos(): CheckResult {
  const output = run(`grep -rn 'TODO' content/docs/ --include='*.mdx' 2>/dev/null || true`);
  const lines = output ? output.split('\n').filter(Boolean) : [];

  if (lines.length <= 5) {
    return { name: 'TODO markers', status: 'pass', message: `${lines.length} TODOs (acceptable)` };
  }

  return {
    name: 'TODO markers',
    status: 'warn',
    message: `${lines.length} TODOs in content`,
    details: lines.slice(0, 10).map((l) => l.split(':').slice(0, 2).join(':')),
  };
}

function checkTestStatus(): CheckResult {
  // Use a generous timeout — test suite can take 60-90 seconds
  const output = run('pnpm test 2>&1 | tail -15', { timeout: 180_000 });

  if (!output) {
    return { name: 'Test suite', status: 'skip', message: 'Test run timed out or produced no output' };
  }

  if (output.includes('failed')) {
    const failMatch = output.match(/(\d+)\s+failed/);
    const passMatch = output.match(/(\d+)\s+passed/);
    const failCount = failMatch ? failMatch[1] : '?';
    const passCount = passMatch ? passMatch[1] : '?';
    return {
      name: 'Test suite',
      status: 'fail',
      message: `${failCount} test file(s) failed, ${passCount} passed`,
      details: output.split('\n').filter((l) => l.includes('FAIL') || l.includes('failed')).slice(0, 5),
    };
  }

  if (output.includes('passed')) {
    const passMatch = output.match(/(\d+)\s+passed/);
    return { name: 'Test suite', status: 'pass', message: `${passMatch ? passMatch[1] : 'All'} test files passed` };
  }

  return { name: 'Test suite', status: 'skip', message: 'Could not determine test status' };
}

function checkGateContent(): CheckResult {
  const output = run('pnpm crux validate gate --scope=content --fix 2>&1 | tail -20', { timeout: 60_000 });

  if (output.includes('All') && output.includes('passed')) {
    return { name: 'Content gate', status: 'pass', message: 'All content checks pass' };
  }

  if (output.includes('FAIL') || output.includes('failed')) {
    return { name: 'Content gate', status: 'fail', message: 'Gate check failed', details: [output] };
  }

  return { name: 'Content gate', status: 'pass', message: 'Gate check completed' };
}

function checkWrongDomainRefs(): CheckResult {
  const issues: string[] = [];

  for (const domain of ['longterm.wiki', 'longtermwiki.org']) {
    const refs = run(`grep -rn '${domain}' apps/web/src/ content/docs/ 2>/dev/null || true`);
    if (refs) {
      for (const line of refs.split('\n').filter(Boolean)) {
        issues.push(`Wrong domain '${domain}': ${line.split(':').slice(0, 2).join(':')}`);
      }
    }
  }

  if (issues.length === 0) {
    return { name: 'Wrong domain refs', status: 'pass', message: 'No references to wrong domains' };
  }

  return {
    name: 'Wrong domain refs',
    status: 'fail',
    message: `${issues.length} references to wrong domains`,
    details: issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report generation
// ─────────────────────────────────────────────────────────────────────────────

interface SweepReport {
  timestamp: string;
  recentChanges: RecentChange[];
  changedFiles: string[];
  checks: CheckResult[];
}

function printReport(report: SweepReport): void {
  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n${c.bold}QA Sweep Report — ${report.timestamp}${c.reset}\n`);

  // Recent changes
  if (report.recentChanges.length > 0) {
    console.log(`${c.bold}Recent Changes (last 3 days)${c.reset}`);
    for (const change of report.recentChanges.slice(0, 10)) {
      console.log(`  ${c.dim}${change.date}${c.reset}  ${change.id}  ${change.title}`);
    }
    if (report.recentChanges.length > 10) {
      console.log(`  ${c.dim}... and ${report.recentChanges.length - 10} more${c.reset}`);
    }
    console.log();
  }

  // Changed files
  if (report.changedFiles.length > 0) {
    console.log(`${c.bold}Changed Files${c.reset}: ${report.changedFiles.length} files modified`);
    const byDir = new Map<string, number>();
    for (const f of report.changedFiles) {
      const dir = f.split('/').slice(0, 3).join('/');
      byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
    }
    for (const [dir, count] of [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${dir}: ${count} files`);
    }
    console.log();
  }

  // Check results
  console.log(`${c.bold}Automated Checks${c.reset}`);
  const statusIcon = { pass: `${c.green}✓${c.reset}`, fail: `${c.red}✗${c.reset}`, warn: `${c.yellow}⚠${c.reset}`, skip: `${c.dim}○${c.reset}` };
  for (const check of report.checks) {
    console.log(`  ${statusIcon[check.status]} ${check.name}: ${check.message}`);
    if (check.details && check.status !== 'pass') {
      for (const detail of check.details.slice(0, 5)) {
        console.log(`    ${c.dim}${detail}${c.reset}`);
      }
      if (check.details.length > 5) {
        console.log(`    ${c.dim}... and ${check.details.length - 5} more${c.reset}`);
      }
    }
  }

  // Summary
  const fails = report.checks.filter((ch) => ch.status === 'fail').length;
  const warns = report.checks.filter((ch) => ch.status === 'warn').length;
  console.log();
  if (fails > 0) {
    console.log(`${c.red}${fails} check(s) failed${c.reset}${warns > 0 ? `, ${warns} warning(s)` : ''}`);
  } else if (warns > 0) {
    console.log(`${c.green}All checks passed${c.reset}, ${c.yellow}${warns} warning(s)${c.reset}`);
  } else {
    console.log(`${c.green}All checks passed${c.reset}`);
  }

  console.log(`\n${c.dim}For LLM-driven analysis, run /qa-sweep in Claude Code${c.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const timestamp = new Date().toISOString().slice(0, 10);

  if (SUB_COMMAND === 'recent') {
    const changes = getRecentChanges();
    const files = getChangedFiles();
    printReport({ timestamp, recentChanges: changes, changedFiles: files, checks: [] });
    return;
  }

  if (SUB_COMMAND === 'checks' || SUB_COMMAND === 'full') {
    const checks: CheckResult[] = [];

    // Fast checks first
    if (!JSON_MODE) console.log(`${c.dim}Running checks...${c.reset}`);
    checks.push(checkDuplicateNumericIds());
    checks.push(checkBrokenEntityRefs());
    checks.push(checkNeedsCitation());
    checks.push(checkTodos());
    checks.push(checkWrongDomainRefs());

    // Slower checks
    if (SUB_COMMAND === 'full') {
      checks.push(checkGateContent());
      checks.push(checkTestStatus());
    }

    const recentChanges = SUB_COMMAND === 'full' ? getRecentChanges() : [];
    const changedFiles = SUB_COMMAND === 'full' ? getChangedFiles() : [];

    printReport({ timestamp, recentChanges, changedFiles, checks });

    // Exit with failure code if any checks failed
    const hasFail = checks.some((ch) => ch.status === 'fail');
    if (hasFail) process.exit(1);
  }
}

main().catch((err) => {
  console.error('QA Sweep failed:', err);
  process.exit(1);
});
