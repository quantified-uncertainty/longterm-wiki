#!/usr/bin/env node

/**
 * Validate that source code never references `ANTHROPIC_API_KEY` as an env var.
 *
 * Rationale (QUA-612): The Claude CLI auto-reads `ANTHROPIC_API_KEY` from the
 * process env. If any slot's env has this var set, the CLI picks it up and
 * bypasses the user's OAuth subscription — breaking `./ws dispatch` and
 * similar flows with "Credit balance too low" when the slot key is stale.
 *
 * Structural fix: this codebase reads the billing key as `ANTHROPIC_BILLING_KEY`
 * instead. The name `ANTHROPIC_API_KEY` MUST NOT appear in any slot's env,
 * which means no source code should read, set, or delete it.
 *
 * Scope:
 *   - Scans .ts / .mjs / .js / .sh under crux/, apps/, scripts/, .github/scripts/,
 *     .claude/hooks/
 *   - Skips test files (__tests__/, *.test.ts), node_modules/, dist/
 *   - Skips .md / .mdx / .yml docs (prose may reference the old name)
 *
 * Allowlist:
 *   - Lines containing `// anthropic-billing-key-remap-ok` (inline marker for
 *     explicit re-map sites — headless services that intentionally want
 *     API billing must acknowledge the re-map inline)
 *   - This validator itself (skipped by absolute path)
 *
 * Usage: npx tsx crux/validate/validate-no-anthropic-api-key-read.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

/** Directories to scan (relative to PROJECT_ROOT) */
const SCAN_DIRS = [
  'crux',
  'apps',
  'scripts',
  '.github/scripts',
  '.claude/hooks',
];

/** File extensions to scan */
const SCAN_EXTENSIONS = ['.ts', '.mjs', '.js', '.sh'];

/** Dirs to always skip during traversal */
const ALWAYS_SKIP = new Set([
  'node_modules',
  'dist',
  '__tests__',
  '.next',
  'coverage',
]);

/** Dotfile-named dirs that are allowed to be walked */
const DOTFILE_ALLOW = new Set(['.github', '.claude']);

/** Inline allowlist marker — use this on any line that intentionally re-maps */
const REMAP_MARKER = 'anthropic-billing-key-remap-ok';

/** Banned token — the env var name that should never be read/written/deleted */
const BANNED_PATTERN = /ANTHROPIC_API_KEY/;

/** Absolute path of this validator — skipped from scanning */
const VALIDATOR_ABS_PATH = resolve(
  PROJECT_ROOT,
  'crux/validate/validate-no-anthropic-api-key-read.ts',
);

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** Whether a directory name should be skipped during traversal. */
export function shouldSkipDir(name: string): boolean {
  if (ALWAYS_SKIP.has(name)) return true;
  if (name.startsWith('.') && !DOTFILE_ALLOW.has(name)) return true;
  return false;
}

/**
 * Per-line decision: is this line a violation?
 *
 * A line is a violation when it contains the banned env-var name AND is not
 * allowlisted. Allowlist cases:
 *   - Line contains the explicit re-map marker comment.
 *   - Line is a line-comment (starts with //, *, /*, #).
 *
 * Known gap: block comments that span multiple lines may false-positive on
 * their middle lines (which don't start with `*`). Wrap the full block with
 * a leading-`*` on every line (JSDoc-style) or use // line comments instead.
 */
export function isLineViolation(line: string): boolean {
  if (!BANNED_PATTERN.test(line)) return false;
  if (line.includes(REMAP_MARKER)) return false;

  const trimmed = line.trimStart();
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  ) {
    return false;
  }

  return true;
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (shouldSkipDir(entry)) continue;
        walk(fullPath);
      } else {
        if (entry.endsWith('.test.ts') || entry.endsWith('.test.mjs')) continue;
        const hasExt = SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext));
        if (!hasExt) continue;
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function checkFile(filePath: string): Violation[] {
  // Skip the validator itself — by absolute path, not basename
  if (resolve(filePath) === VALIDATOR_ABS_PATH) return [];

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(PROJECT_ROOT, filePath);

  for (let i = 0; i < lines.length; i++) {
    if (!isLineViolation(lines[i])) continue;
    violations.push({
      file: relPath,
      line: i + 1,
      text: lines[i].trimStart().slice(0, 160),
    });
  }

  return violations;
}

export function runCheck(): {
  passed: boolean;
  errors: number;
  violations: Violation[];
} {
  const c = getColors();
  console.log(
    `${c.blue}Checking for ANTHROPIC_API_KEY reads in source code...${c.reset}\n`,
  );

  const allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    const absDir = join(PROJECT_ROOT, dir);
    allFiles.push(...collectFiles(absDir));
  }

  if (allFiles.length === 0) {
    console.log(`${c.dim}No files found to check${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: Violation[] = [];
  for (const file of allFiles) {
    allViolations.push(...checkFile(file));
  }

  if (allViolations.length === 0) {
    console.log(
      `${c.green}No ANTHROPIC_API_KEY references found (${allFiles.length} files checked)${c.reset}`,
    );
    console.log(
      `${c.dim}Use ANTHROPIC_BILLING_KEY for SDK calls. Re-map sites that must set ANTHROPIC_API_KEY for a subprocess must carry the inline marker \`// ${REMAP_MARKER}\`.${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}Found ${allViolations.length} ANTHROPIC_API_KEY reference(s):${c.reset}\n`,
    );
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
    }
    console.log(
      `\n${c.dim}Fix: rename to ANTHROPIC_BILLING_KEY, or annotate an intentional re-map with \`// ${REMAP_MARKER}\` (see QUA-612 for the rationale).${c.reset}`,
    );
  }

  return {
    passed: allViolations.length === 0,
    errors: allViolations.length,
    violations: allViolations,
  };
}

if (process.argv[1]?.includes('validate-no-anthropic-api-key-read')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
