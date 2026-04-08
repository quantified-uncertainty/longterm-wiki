#!/usr/bin/env node
/**
 * Gate rule: check source-check coverage of TableBase submissions.
 *
 * Reads JSON manifests from data/tablebase-manifests/ and reports:
 * - Per-manifest: table, record count, source-check coverage
 * - Total coverage percentage across all manifests
 * - Warnings for unchecked or contradicted records
 *
 * Enforcement levels (Discussion #3875):
 *   - advisory:  warn only, exit 0 (default when --enforcement=advisory)
 *   - soft:      exit 1 to block, unless --force is passed (default when --enforcement=soft)
 *   - hard:      exit 1 unconditionally for tables listed in HARD_ENFORCED_TABLES
 *
 * The gate step in validate-gate.ts controls whether this is advisory or blocking.
 * This script's exit code is the only signal — the gate respects it accordingly.
 *
 * Exit codes:
 *   0 = All records have source-checks (or no manifests, or --force overrides soft block)
 *   1 = Unchecked or contradicted records found (blocks unless overridden)
 */

import { readdirSync, readFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const MANIFEST_DIR = join(PROJECT_ROOT, 'data', 'tablebase-manifests');

/** Tables where hard enforcement is active — --force cannot override these */
const HARD_ENFORCED_TABLES: string[] = [
  // Populated as tables reach >70% coverage (Phase 5, Discussion #3875).
  // Example: 'personnel' once personnel source-check coverage >70%.
];

const cliArgs = process.argv.slice(2);
const forceOverride = cliArgs.includes('--force');
const enforcementArg = cliArgs.find(a => a.startsWith('--enforcement='))?.split('=')[1];
const enforcement: 'advisory' | 'soft' | 'hard' = (
  enforcementArg === 'advisory' || enforcementArg === 'soft' || enforcementArg === 'hard'
    ? enforcementArg : 'soft'
);

interface SourceCheckSummary {
  withSourceCheck: number;
  withoutSourceCheck: number;
  verdicts: {
    verified: number;
    contradicted: number;
    unverifiable: number;
    other: number;
  };
}

interface Manifest {
  table: string;
  recordCount: number;
  submittedAt: string;
  sourceCheckSummary: SourceCheckSummary;
  records: Array<Record<string, unknown>>;
}

function main() {
  if (!existsSync(MANIFEST_DIR)) {
    console.log('No tablebase-manifests/ directory — nothing to check.');
    process.exit(0);
  }

  const files = readdirSync(MANIFEST_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No manifest files found — nothing to check.');
    process.exit(0);
  }

  let totalRecords = 0;
  let totalVerified = 0;
  let totalUnverified = 0;
  const warnings: string[] = [];
  const fatalErrors: string[] = [];
  const hardBlockedTables = new Set<string>();

  for (const file of files) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(join(MANIFEST_DIR, file), 'utf-8')) as Manifest;
    } catch (e: unknown) {
      fatalErrors.push(`${file}: failed to parse — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const { table, recordCount, sourceCheckSummary } = manifest;

    if (!sourceCheckSummary || typeof recordCount !== 'number') {
      fatalErrors.push(`${file}: missing sourceCheckSummary or recordCount`);
      continue;
    }

    totalRecords += recordCount;
    totalVerified += sourceCheckSummary.withSourceCheck;
    totalUnverified += sourceCheckSummary.withoutSourceCheck;

    if (sourceCheckSummary.withoutSourceCheck > 0) {
      warnings.push(
        `${file}: ${sourceCheckSummary.withoutSourceCheck}/${recordCount} ${table} records submitted WITHOUT source-check`
      );
      if (HARD_ENFORCED_TABLES.includes(table)) {
        hardBlockedTables.add(table);
      }
    }

    if (sourceCheckSummary.verdicts.contradicted > 0) {
      warnings.push(
        `${file}: ${sourceCheckSummary.verdicts.contradicted} ${table} records have CONTRADICTED verdicts`
      );
    }
  }

  // Summary
  const coverage = totalRecords > 0 ? Math.round((totalVerified / totalRecords) * 100) : 100;
  console.log(`Source-check coverage: ${totalVerified}/${totalRecords} records (${coverage}%)`);

  // Fatal errors (malformed manifests) — cannot be overridden with --force
  if (fatalErrors.length > 0) {
    console.log('');
    for (const err of fatalErrors) {
      console.log(`  ERROR: ${err}`);
    }
    console.log('');
    console.log('BLOCKED: Manifest files are unreadable or malformed. Fix them before proceeding.');
    process.exit(1);
  }

  if (warnings.length === 0) {
    console.log('All TableBase submissions have source-checks.');
    process.exit(0);
  }

  // Print warnings
  console.log('');
  for (const w of warnings) {
    console.log(`  WARNING: ${w}`);
  }

  // Hard enforcement — cannot be overridden
  if (hardBlockedTables.size > 0) {
    console.log('');
    console.log(`BLOCKED: Tables with hard enforcement have unchecked records: ${[...hardBlockedTables].join(', ')}`);
    console.log('Run `pnpm crux tb verify <table>` to source-check records before submitting.');
    process.exit(1);
  }

  // Soft enforcement — can be overridden with --force.
  // Note: contradicted verdicts also land here and can be --force'd.
  // This is intentional for soft enforcement — contradictions should be fixed
  // but shouldn't block agents who are actively triaging them.
  if (enforcement === 'soft' || enforcement === 'hard') {
    if (forceOverride) {
      console.log('');
      console.log('--force: source-check warnings overridden.');
      logForceUsage(warnings);
      process.exit(0);
    }
    console.log('');
    console.log('Run `pnpm crux tb verify <table>` after submission, or pass --force to the gate to override.');
    process.exit(1);
  }

  // Advisory mode — warn but don't block
  process.exit(0);
}

/** Log --force usage for monitoring (Phase 4 guardrail) */
function logForceUsage(warnings: string[]): void {
  try {
    // Use git rev-parse to resolve the real git dir — handles worktrees where .git is a file
    let logFile: string;
    try {
      logFile = execSync('git rev-parse --git-path source-check-force-log', {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
      }).trim();
    } catch {
      // Fallback if git is unavailable
      logFile = join(PROJECT_ROOT, '.git', 'source-check-force-log');
    }
    const entry = `${new Date().toISOString()} | ${warnings.length} warnings | ${warnings.join('; ')}\n`;
    appendFileSync(logFile, entry);
  } catch (e: unknown) {
    // Non-fatal: logging failure shouldn't block the gate
    console.warn(`[source-check-coverage] Could not write force-log: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main();
