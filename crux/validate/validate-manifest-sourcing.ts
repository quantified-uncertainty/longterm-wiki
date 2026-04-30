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
  /**
   * Current schema (post-2026-04-09). The legacy schema below is rejected
   * for any newly-added manifest because it implies the writer regressed.
   */
  sourcingSummary?: {
    withSourcing?: number;
    withoutSourcing?: number;
  };
  /**
   * Pre-2026-04-09 schema. Still appears on grandfathered manifests in main,
   * but new manifests in the diff using this schema are flagged as a
   * regression — see `evaluateManifest`.
   */
  verificationSummary?: {
    withVerification?: number;
    withoutVerification?: number;
  };
}

interface Violation {
  file: string;
  table: string;
  recordCount: number;
  withSourcing: number;
  withoutSourcing: number;
  /**
   * Why the manifest failed: 'no-sourcing' = recorded but every record is
   * unverified; 'legacy-schema' = uses pre-QUA-730 verificationSummary in
   * a newly-added file (regression).
   */
  reason: 'no-sourcing' | 'legacy-schema';
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
  } else {
    // Shallow clones / detached HEAD without origin/main: the committed-vs-main
    // branch is silently dropped. Staged + unstaged + untracked still fire,
    // which is enough for pre-push gate runs but leaves a coverage gap in CI
    // environments that lose the merge base. Surface that visibly.
    console.warn(
      '[validate-manifest-sourcing] No merge base for HEAD vs origin/main or main — skipping committed-diff scan',
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
  } catch (err: unknown) {
    // Surface malformed manifests instead of silently treating them as
    // legacy-and-skip. A JSON parse failure in PR review is an authoring bug.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[validate-manifest-sourcing] Could not parse ${absPath}: ${msg}`);
    return null;
  }
}

/** Coerce a possibly-non-numeric JSON value to a finite integer (or 0). */
function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
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

  const recordCount = toCount(data.recordCount);
  if (recordCount <= MIN_RECORDS_FOR_GATE) return null;

  const table = data.table ?? basename(relPath, '.json');

  // QUA-730 regression guard: the legacy `verificationSummary` schema (used
  // pre-2026-04-09) is grandfathered on main but must NOT appear in newly
  // added manifests. If a future writer regresses to the old schema, the
  // current validator's "skip when sourcingSummary is empty" logic would
  // pass it silently — exactly the failure mode this gate is meant to catch.
  if (data.verificationSummary && !data.sourcingSummary) {
    const v = data.verificationSummary;
    return {
      file: relPath,
      table,
      recordCount,
      withSourcing: toCount(v.withVerification),
      withoutSourcing: toCount(v.withoutVerification),
      reason: 'legacy-schema',
    };
  }

  const summary = data.sourcingSummary ?? {};
  const withSourcing = toCount(summary.withSourcing);
  const withoutSourcing = toCount(summary.withoutSourcing);

  // Pre-2026-04-09 manifests have neither field populated; skip them. (A new
  // manifest with no sourcingSummary at all is treated the same — there's
  // nothing to gate on. The legacy-schema branch above catches the obvious
  // regression of writing verificationSummary on purpose.)
  if (withSourcing === 0 && withoutSourcing === 0) return null;

  if (withSourcing === 0) {
    return {
      file: relPath,
      table,
      recordCount,
      withSourcing,
      withoutSourcing,
      reason: 'no-sourcing',
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
      `${c.red}Found ${violations.length} manifest(s) failing the sourcing gate:${c.reset}\n`,
    );
    for (const v of violations) {
      const tag = v.reason === 'legacy-schema' ? 'legacy-schema regression' : 'all records unverified';
      console.log(`  ${c.red}${v.file} — ${tag}${c.reset}`);
      console.log(
        `    ${c.dim}table=${v.table} recordCount=${v.recordCount} withSourcing=${v.withSourcing} withoutSourcing=${v.withoutSourcing}${c.reset}`,
      );
    }
    console.log('');
    console.log(
      `${c.dim}'all records unverified' usually means --skip-sourcing was used (e.g. missing ANTHROPIC_BILLING_KEY).${c.reset}`,
    );
    console.log(
      `${c.dim}'legacy-schema regression' means the writer emitted the pre-2026-04-09 verificationSummary field; rewrite to sourcingSummary.${c.reset}`,
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
