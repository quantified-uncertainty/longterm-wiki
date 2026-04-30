#!/usr/bin/env node

/**
 * Validate that newly-added TableBase enrichment manifests in
 * `data/tablebase-manifests/` ship records with sourcing verdicts
 * attached, not all `verdict: "none"` / `withoutSourcing: N`.
 *
 * Background: QUA-730. Across 71 manifests written between Mar–Apr 2026,
 * only 9% of records ended up with sourcing data attached. PR #4612 was the
 * inciting case: 81 personnel records shipped with `verdict: "none"` for
 * every row because the agent ran with `--skip-sourcing` after
 * `ANTHROPIC_BILLING_KEY` was missing. CodeRabbit happened to flag it; the
 * gate did not.
 *
 * Rule: a manifest in the diff fails if both
 *   - `recordCount > MIN_RECORDS_FOR_GATE` (small manifests aren't worth a
 *     gate trip), and
 *   - `sourcingSummary.withSourcing === 0` (every record shipped without
 *     sourcing evidence).
 *
 * Scope: only files added or modified in the current branch's diff vs main.
 * Existing manifests on main are grandfathered — adding a check that
 * scanned all manifests would fail the gate against the baseline.
 *
 * Usage:
 *   npx tsx crux/validate/validate-manifest-sourcing.ts
 */

import { readFileSync, existsSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { join, basename } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const MANIFEST_DIR = 'data/tablebase-manifests';
const MIN_RECORDS_FOR_GATE = 5;

interface ManifestSummary {
  table?: string;
  recordCount?: number;
  sourcingSummary?: {
    withSourcing?: number;
    withoutSourcing?: number;
  };
}

interface Violation {
  file: string;
  table: string;
  recordCount: number;
  withSourcing: number;
  withoutSourcing: number;
}

/**
 * Files added or modified on this branch vs origin/main, plus staged and
 * untracked manifests in the working tree. Pre-push gate runs need to see
 * a manifest that's staged but not yet committed; CI runs need to see what
 * landed on the branch. Returns relative paths (matching git's output).
 */
export function getAddedManifestFiles(): string[] {
  const collected = new Set<string>();

  function tryGit(args: string[]): string {
    try {
      return execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  }

  function addLines(out: string): void {
    if (!out) return;
    for (const line of out.split('\n')) {
      const f = line.trim();
      if (!f) continue;
      if (f.startsWith(`${MANIFEST_DIR}/`) && f.endsWith('.json')) {
        collected.add(f);
      }
    }
  }

  // 1. Committed changes vs origin/main (or fallback to local main).
  let base = '';
  try {
    base = execSync(
      'git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' },
    ).trim();
  } catch {
    base = '';
  }
  if (base) {
    addLines(
      tryGit(['diff', '--name-only', '--diff-filter=AM', base, 'HEAD', '--', `${MANIFEST_DIR}/*.json`]),
    );
  }

  // 2. Staged changes (vs HEAD) — catches manifests that have been git-add'd
  //    but not yet committed.
  addLines(
    tryGit(['diff', '--name-only', '--cached', '--diff-filter=AM', '--', `${MANIFEST_DIR}/*.json`]),
  );

  // 3. Unstaged tracked modifications.
  addLines(
    tryGit(['diff', '--name-only', '--diff-filter=AM', '--', `${MANIFEST_DIR}/*.json`]),
  );

  // 4. Untracked manifests (new files not yet staged).
  addLines(
    tryGit(['ls-files', '--others', '--exclude-standard', '--', `${MANIFEST_DIR}/*.json`]),
  );

  return [...collected].sort();
}

function loadManifest(absPath: string): ManifestSummary | null {
  try {
    const raw = readFileSync(absPath, 'utf-8');
    return JSON.parse(raw) as ManifestSummary;
  } catch {
    return null;
  }
}

/**
 * Pure-function form of the per-manifest check, exported so tests can drive
 * it without setting up a git repo.
 */
export function evaluateManifest(
  relPath: string,
  data: ManifestSummary | null,
): Violation | null {
  if (!data) return null;

  const recordCount = data.recordCount ?? 0;
  if (recordCount <= MIN_RECORDS_FOR_GATE) return null;

  const summary = data.sourcingSummary ?? {};
  const withSourcing = summary.withSourcing ?? 0;
  const withoutSourcing = summary.withoutSourcing ?? 0;

  // Manifests written before the sourcingSummary field existed don't have
  // either count populated; skip them.
  if (withSourcing === 0 && withoutSourcing === 0) return null;

  if (withSourcing === 0) {
    return {
      file: relPath,
      table: data.table ?? basename(relPath, '.json'),
      recordCount,
      withSourcing,
      withoutSourcing,
    };
  }
  return null;
}

function checkManifest(relPath: string): Violation | null {
  const absPath = join(PROJECT_ROOT, relPath);
  if (!existsSync(absPath)) return null; // Modified-then-deleted edge case.
  return evaluateManifest(relPath, loadManifest(absPath));
}

export interface ValidationResult {
  passed: boolean;
  errors: number;
  violations: Violation[];
  filesChecked: number;
}

export function runCheck(): ValidationResult {
  const c = getColors();
  console.log(
    `${c.blue}Checking new tablebase manifests for missing sourcing data (QUA-730)...${c.reset}\n`,
  );

  const files = getAddedManifestFiles();
  if (files.length === 0) {
    console.log(`${c.dim}No new/modified manifests in this diff${c.reset}`);
    return { passed: true, errors: 0, violations: [], filesChecked: 0 };
  }

  const violations: Violation[] = [];
  for (const f of files) {
    const v = checkManifest(f);
    if (v) violations.push(v);
  }

  if (violations.length === 0) {
    console.log(
      `${c.green}All ${files.length} new manifest(s) have at least one sourcing-verified record${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}Found ${violations.length} manifest(s) shipping records WITHOUT any sourcing verification:${c.reset}\n`,
    );
    for (const v of violations) {
      console.log(`  ${c.red}${v.file}${c.reset}`);
      console.log(
        `    ${c.dim}table=${v.table} recordCount=${v.recordCount} withSourcing=0 withoutSourcing=${v.withoutSourcing}${c.reset}`,
      );
    }
    console.log('');
    console.log(
      `${c.dim}This usually means the run used --skip-sourcing (e.g. missing ANTHROPIC_BILLING_KEY).${c.reset}`,
    );
    console.log(
      `${c.dim}Re-run with sourcing enabled, or split the unverified records out of the PR until they can be sourcing-verified.${c.reset}`,
    );
    console.log(
      `${c.dim}Manifests with ≤${MIN_RECORDS_FOR_GATE} records are exempt; this gate fires only on bulk drops.${c.reset}`,
    );
  }

  return {
    passed: violations.length === 0,
    errors: violations.length,
    violations,
    filesChecked: files.length,
  };
}

if (process.argv[1]?.includes('validate-manifest-sourcing')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}

// Re-export the constant for tests.
export { MIN_RECORDS_FOR_GATE };
