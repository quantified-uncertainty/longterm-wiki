#!/usr/bin/env node

/**
 * Entity-schema drift validator (QUA-943 — Plan v2 step 0c).
 *
 * Bans new `const VALID_*` declarations and inline `z.enum([...])` literals in
 * apps/wiki-server/src/routes/tablebase/ — both are markers of an entity wire
 * schema being hand-written in a sync route instead of imported from the
 * canonical schema package (target: packages/entity-schemas, per QUA-943).
 *
 * The current baseline of files containing drift markers is recorded in
 * .entity-schema-drift-allowlist.txt. As routes migrate to canonical schemas
 * (Plan v2 PRs 5a/5b), entries are removed from the allowlist. This file
 * reaches zero entries when QUA-943 closes.
 *
 * Suppression for legitimate inline enums (e.g., query-string enums that are
 * not entity wire shapes): add `// schema-drift-ok` on the same line as the
 * marker.
 *
 * Usage:
 *   npx tsx crux/validate/validate-entity-schema-drift.ts            # check
 *   npx tsx crux/validate/validate-entity-schema-drift.ts --update   # rewrite allowlist
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const TABLEBASE_ROUTES_DIR = join(PROJECT_ROOT, 'apps/wiki-server/src/routes/tablebase');
const ALLOWLIST_PATH = join(PROJECT_ROOT, 'crux/validate/.entity-schema-drift-allowlist.txt');
const SUPPRESS_COMMENT = 'schema-drift-ok';

const VALID_CONST_RE = /\bconst\s+VALID_[A-Z_]+\s*=/;
const INLINE_ENUM_RE = /z\.enum\(\[/;

export interface Violation {
  file: string;
  line: number;
  text: string;
  kind: 'VALID_CONST' | 'INLINE_ENUM';
}

function isSuppressed(line: string): boolean {
  const commentIdx = findLineCommentStart(line);
  if (commentIdx === -1) return false;
  return line.slice(commentIdx).includes(SUPPRESS_COMMENT);
}

function findLineCommentStart(line: string): number {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < line.length; i++) {
    if (i > 0 && line[i - 1] === '\\') continue;
    const ch = line[i];
    if (ch === "'" && !inDouble && !inTemplate) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle && !inTemplate) { inDouble = !inDouble; continue; }
    if (ch === '`' && !inSingle && !inDouble) { inTemplate = !inTemplate; continue; }
    if (!inSingle && !inDouble && !inTemplate && ch === '/' && line[i + 1] === '/') {
      return i;
    }
  }
  return -1;
}

export function checkLine(line: string): Violation['kind'] | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return null;
  }
  if (isSuppressed(line)) return null;
  if (VALID_CONST_RE.test(line)) return 'VALID_CONST';
  if (INLINE_ENUM_RE.test(line)) return 'INLINE_ENUM';
  return null;
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
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(fullPath);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

function checkFile(filePath: string, baseDir: string): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(baseDir, filePath);
  for (let i = 0; i < lines.length; i++) {
    const kind = checkLine(lines[i]);
    if (kind) {
      violations.push({
        file: relPath,
        line: i + 1,
        text: lines[i].trimStart(),
        kind,
      });
    }
  }
  return violations;
}

export function readAllowlist(path: string = ALLOWLIST_PATH): Set<string> {
  const allowed = new Set<string>();
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return allowed;
  }
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    allowed.add(line);
  }
  return allowed;
}

interface CheckResult {
  passed: boolean;
  errors: number;
  newViolations: Violation[];
  staleEntries: string[];
  allowlistedFileCount: number;
  fileCountWithDrift: number;
}

export function runCheck(
  opts: { rootDir?: string; allowlistPath?: string; baseDir?: string; updateBaseline?: boolean } = {},
): CheckResult {
  const c = getColors();
  const rootDir = opts.rootDir ?? TABLEBASE_ROUTES_DIR;
  const allowlistPath = opts.allowlistPath ?? ALLOWLIST_PATH;
  const baseDir = opts.baseDir ?? PROJECT_ROOT;

  console.log(`${c.blue}Checking entity-schema drift in ${relative(baseDir, rootDir)}/...${c.reset}\n`);

  let allFiles: string[];
  try {
    allFiles = collectTsFiles(rootDir);
  } catch {
    console.log(`${c.dim}Skipping: ${rootDir} not found${c.reset}`);
    return {
      passed: true, errors: 0, newViolations: [], staleEntries: [],
      allowlistedFileCount: 0, fileCountWithDrift: 0,
    };
  }

  const filesWithDrift = new Map<string, Violation[]>();
  for (const file of allFiles) {
    const v = checkFile(file, baseDir);
    if (v.length > 0) filesWithDrift.set(v[0].file, v);
  }

  if (opts.updateBaseline) {
    const sorted = [...filesWithDrift.keys()].sort();
    const header = readFileSync(allowlistPath, 'utf-8').split('\n')
      .filter(l => l.startsWith('#') || l.trim() === '')
      .join('\n')
      .replace(/\n+$/, '\n');
    const body = sorted.join('\n') + '\n';
    writeFileSync(allowlistPath, header + body);
    console.log(`${c.green}Wrote ${sorted.length} entries to ${relative(baseDir, allowlistPath)}${c.reset}`);
    return {
      passed: true, errors: 0, newViolations: [], staleEntries: [],
      allowlistedFileCount: sorted.length, fileCountWithDrift: sorted.length,
    };
  }

  const allowed = readAllowlist(allowlistPath);
  const newViolations: Violation[] = [];
  for (const [file, vs] of filesWithDrift) {
    if (!allowed.has(file)) newViolations.push(...vs);
  }

  const staleEntries: string[] = [];
  for (const entry of allowed) {
    if (!filesWithDrift.has(entry)) staleEntries.push(entry);
  }

  const errors = newViolations.length + staleEntries.length;
  if (errors === 0) {
    console.log(`${c.green}No entity-schema drift outside allowlist (${filesWithDrift.size} files allowlisted, ${allFiles.length} files scanned)${c.reset}`);
    if (filesWithDrift.size > 0) {
      console.log(`${c.dim}QUA-943 closure metric: ${filesWithDrift.size} files still need migration to canonical schemas${c.reset}`);
    }
  } else {
    if (newViolations.length > 0) {
      console.log(`${c.red}Found ${newViolations.length} drift marker(s) in ${new Set(newViolations.map(v => v.file)).size} non-allowlisted file(s):${c.reset}\n`);
      for (const v of newViolations) {
        console.log(`  ${c.red}${v.file}:${v.line}${c.reset} [${v.kind}]`);
        console.log(`    ${c.dim}${v.text}${c.reset}`);
      }
      console.log(`\n${c.dim}Fix: import the canonical schema from packages/entity-schemas (QUA-943) instead of hand-writing.${c.reset}`);
      console.log(`${c.dim}Suppress a single legitimate use (e.g., query-string enum): add \`// ${SUPPRESS_COMMENT}\` on the same line.${c.reset}`);
      console.log(`${c.dim}If migration to canonical schemas is not yet possible, add the file to ${relative(PROJECT_ROOT, allowlistPath)}.${c.reset}\n`);
    }
    if (staleEntries.length > 0) {
      console.log(`${c.yellow}${staleEntries.length} stale allowlist entr${staleEntries.length === 1 ? 'y' : 'ies'} (file no longer contains drift markers — please remove):${c.reset}`);
      for (const entry of staleEntries) console.log(`  ${c.yellow}${entry}${c.reset}`);
      console.log(`\n${c.dim}Update with: npx tsx crux/validate/validate-entity-schema-drift.ts --update${c.reset}\n`);
    }
  }

  return {
    passed: errors === 0,
    errors,
    newViolations,
    staleEntries,
    allowlistedFileCount: allowed.size,
    fileCountWithDrift: filesWithDrift.size,
  };
}

const __isMain = process.argv[1]?.includes('validate-entity-schema-drift');
if (__isMain) {
  const updateBaseline = process.argv.includes('--update');
  const result = runCheck({ updateBaseline });
  process.exit(result.passed ? 0 : 1);
}
