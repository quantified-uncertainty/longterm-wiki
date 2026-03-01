#!/usr/bin/env node

/**
 * Validate that no git merge conflict markers remain in committed files.
 *
 * Scans all git-tracked files for leftover `<<<<<<<`, `=======`, and
 * `>>>>>>>` markers that can slip through automated merge conflict
 * resolution. Only flags lines where a full conflict marker pattern is
 * present (marker at start of line), not incidental uses of those
 * characters.
 *
 * Excludes:
 *   - The conflict resolver script itself (.github/scripts/resolve-conflicts.mjs)
 *   - Test fixtures and snapshot files
 *   - Binary files (images, fonts, etc.)
 *
 * Usage: npx tsx crux/validate/validate-conflict-markers.ts
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

/** Files that legitimately reference conflict markers (e.g., the resolver script). */
const EXCLUDED_FILES = new Set([
  '.github/scripts/resolve-conflicts.mjs',
]);

/** File extensions to skip (binary or irrelevant). */
const EXCLUDED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot',
  '.pdf', '.zip', '.tar', '.gz',
  '.lock',
]);

/**
 * Conflict marker patterns. Each must appear at the start of a line
 * (after optional whitespace) to count as a real conflict marker.
 *
 * We require at least 7 consecutive characters to match git's default
 * conflict marker format:
 *   <<<<<<< HEAD
 *   =======
 *   >>>>>>> branch-name
 */
const CONFLICT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^<{7}(?:\s|$)/, label: '<<<<<<<' },
  { pattern: /^={7}(?:\s|$)/, label: '=======' },
  { pattern: /^>{7}(?:\s|$)/, label: '>>>>>>>' },
];

export interface ConflictViolation {
  file: string;
  line: number;
  marker: string;
  text: string;
}

function isExcluded(filePath: string): boolean {
  if (EXCLUDED_FILES.has(filePath)) return true;

  // Skip binary extensions
  const extMatch = filePath.match(/\.[^.]+$/);
  if (extMatch && EXCLUDED_EXTENSIONS.has(extMatch[0].toLowerCase())) return true;

  // Skip test fixtures and snapshots
  if (filePath.includes('__fixtures__/') || filePath.includes('__snapshots__/')) return true;
  if (filePath.endsWith('.snap')) return true;

  return false;
}

function checkFile(filePath: string): ConflictViolation[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return []; // File can't be read — skip silently
  }

  // Quick check: skip files that don't contain any marker substring
  if (!content.includes('<<<<<<<') && !content.includes('=======') && !content.includes('>>>>>>>')) {
    return [];
  }

  const lines = content.split('\n');
  const violations: ConflictViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, label } of CONFLICT_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: filePath,
          line: i + 1,
          marker: label,
          text: line.trim(),
        });
        break; // One violation per line is enough
      }
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: ConflictViolation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for leftover merge conflict markers...${c.reset}\n`);

  // Get list of tracked files from git
  let trackedFiles: string[];
  try {
    const output = execSync('git ls-files', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10 MB — repo has ~2000 files
    });
    trackedFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    console.log(`${c.dim}Skipping: could not list git-tracked files${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const filesToCheck = trackedFiles.filter(f => !isExcluded(f));
  const allViolations: ConflictViolation[] = [];

  for (const file of filesToCheck) {
    const violations = checkFile(file);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log(`${c.green}No conflict markers found (${filesToCheck.length} files checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} conflict marker(s):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.marker}: ${v.text}${c.reset}\n`);
    }
    console.log(`${c.dim}Fix: remove leftover merge conflict markers and commit the resolved file.${c.reset}`);
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-conflict-markers')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
