#!/usr/bin/env node

/**
 * Validate that `claude` CLI spawns go through the canonical wrapper.
 *
 * Direct `spawn('claude', ...)` calls miss the ANTHROPIC_API_KEY strip that
 * forces OAuth billing (Claude Max/Pro subscription). Callers that inherit a
 * stale slot `.env` API key fail silently with 401s or "Credit balance is
 * too low". Use `spawnClaude` / `spawnClaudeSync` from
 * `crux/lib/spawn-claude.ts` instead.
 *
 * Scoped to:
 *   - crux/**\/*.ts (excluding the wrapper itself and test files)
 *
 * See QUA-599 for context.
 *
 * Usage: npx tsx crux/validate/validate-no-raw-claude-spawn.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const SCAN_DIRS = ['crux'];

/** The file that holds the canonical wrapper — the one place raw spawns are allowed. */
const WRAPPER_FILE = 'crux/lib/spawn-claude.ts';

/**
 * Single combined regex for all known spawn patterns. The `kind` group
 * captures which function was called so we can report it.
 *
 * `\s*` (not just spaces) matches prettier-formatted multi-line calls.
 *
 * Known gaps (NOT caught): aliased imports (`const sp = spawn; sp(...)`),
 * variable-named commands (`const bin = 'claude'; spawn(bin, ...)`). Code
 * review covers these.
 */
const SPAWN_RE = new RegExp(
  [
    // spawn('claude'...) / spawnSync('claude'...) — closing quote required
    `\\b(?<kind>spawn|spawnSync|execFile|execFileSync)\\s*\\(\\s*['"\`]claude['"\`]`,
    // exec-style: shell string that starts with "claude " (space-terminated)
    `\\b(?<kind2>exec|execSync|execa|execaSync|execaCommand)\\s*\\(\\s*['"\`]claude[ '"\`]`,
  ].join('|'),
  'g',
);

interface Violation {
  file: string;
  line: number;
  text: string;
  kind: string;
}

function collectTsFiles(dir: string): string[] {
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
        if (entry === 'node_modules' || entry === '.git') continue;
        walk(fullPath);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.test-d.ts')) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

/** Strip line/block comments so commented-out spawns don't trip the scan. */
function stripComments(content: string): string {
  // Remove block comments first (may span lines), then line comments.
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:/])\/\/[^\n]*/g, (_m, prefix: string) => prefix);
}

export function checkFileContent(content: string, relPath: string): Violation[] {
  if (relPath === WRAPPER_FILE) return [];
  // Fast-path: most files don't mention `claude` at all.
  if (!content.includes('claude')) return [];

  const stripped = stripComments(content);
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const seenLines = new Set<number>();

  SPAWN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAWN_RE.exec(stripped)) !== null) {
    const lineIdx = stripped.slice(0, m.index).split('\n').length - 1;
    if (seenLines.has(lineIdx)) continue;
    seenLines.add(lineIdx);
    violations.push({
      file: relPath,
      line: lineIdx + 1,
      text: (lines[lineIdx] ?? '').trimStart(),
      kind: m.groups?.kind ?? m.groups?.kind2 ?? 'spawn',
    });
  }

  return violations;
}

function checkFile(filePath: string): Violation[] {
  const relPath = relative(PROJECT_ROOT, filePath);
  const content = readFileSync(filePath, 'utf-8');
  return checkFileContent(content, relPath);
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for raw claude CLI spawns (QUA-599)...${c.reset}\n`);

  const allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    const absDir = join(PROJECT_ROOT, dir);
    const files = collectTsFiles(absDir);
    allFiles.push(...files);
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
    console.log(`${c.green}No raw claude spawns found (${allFiles.length} files checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} raw claude spawn(s):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset} (${v.kind})`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
    }
    console.log(
      `\n  ${c.dim}Fix: use spawnClaude() / spawnClaudeSync() from crux/lib/spawn-claude.ts.${c.reset}`,
    );
    console.log(
      `  ${c.dim}Raw spawns skip the ANTHROPIC_API_KEY strip that forces OAuth. See QUA-599.${c.reset}`,
    );
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-no-raw-claude-spawn')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
