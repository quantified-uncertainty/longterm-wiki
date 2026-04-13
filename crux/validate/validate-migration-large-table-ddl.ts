#!/usr/bin/env node

/**
 * Validate Drizzle migrations do not add constraints to large tables
 * without `NOT VALID`.
 *
 * ## Background — QUA-294
 *
 * Migration 0173 added a CHECK constraint to `hallucination_risk_snapshots`
 * (905 MB / 3.3M rows) with plain `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`.
 * This requires ACCESS EXCLUSIVE while Postgres scans every row to validate
 * the existing data. The concurrent `REFRESH MATERIALIZED VIEW
 * hallucination_risk_latest` held AccessShareLock throughout, so the migration
 * client hit `lock_timeout` (60s) on every retry and rolled back the PreSync
 * job. Prod was stuck on a ~12-hour-old image until the fix was applied
 * manually with `NOT VALID` + separate `VALIDATE CONSTRAINT`.
 *
 * The correct pattern is documented in
 * `.claude/rules/database-migrations.md` § "ADD CONSTRAINT ... NOT VALID +
 * separate VALIDATE CONSTRAINT". This validator enforces it mechanically:
 *
 *   ALTER TABLE hot_table
 *     ADD CONSTRAINT chk_x CHECK (col IN (...)) NOT VALID;   -- fast (ms)
 *   ALTER TABLE hot_table VALIDATE CONSTRAINT chk_x;          -- non-blocking
 *
 * The `NOT VALID` phase only needs ACCESS EXCLUSIVE for metadata registration,
 * not a full table scan. `VALIDATE CONSTRAINT` takes SHARE UPDATE EXCLUSIVE,
 * which does not conflict with concurrent readers (including matview refresh).
 *
 * ## What this validator does
 *
 * Scans `apps/wiki-server/drizzle/*.sql` for `ADD CONSTRAINT` statements that
 * target any table on the LARGE_TABLES hot list. For each match, the
 * statement must either:
 *   - contain `NOT VALID` in the same statement, OR
 *   - live in a no-op migration file (`SELECT 1;` with the real DDL
 *     deferred to a manual script).
 *
 * Otherwise the validator fails the gate with the file path, line number,
 * and the offending statement.
 *
 * ## Hot table list
 *
 * Currently just `hallucination_risk_snapshots` — the only table we have
 * direct evidence of blowing past `lock_timeout` in production. Add more
 * tables to the list when we see evidence they've crossed ~100 MB.
 *
 * Start minimal. A too-broad list would false-positive on small tables and
 * train agents to ignore the validator.
 *
 * ## Parser limits (documented, not bugs)
 *
 * - Case-insensitive match on `ADD CONSTRAINT` and `NOT VALID`.
 * - Multi-line statements: the parser regexes over the full stripped file
 *   text (not line-by-line) so `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`
 *   split across several lines is captured as one statement.
 * - Handles both named (`ADD CONSTRAINT foo CHECK`) and anonymous
 *   (`ADD CHECK`) forms. Also catches ADD FOREIGN KEY / UNIQUE / PRIMARY
 *   KEY / EXCLUDE (they have the same full-table-scan issue).
 * - `ADD COLUMN ... CHECK (inline)` (where the CHECK is part of a column
 *   definition) is NOT matched — it's a different code path and usually
 *   only fires when the column has no existing rows (the ADD COLUMN itself
 *   would already be blocking).
 * - Line comments and block comments are stripped before matching so
 *   commented-out examples don't trip the check.
 *
 * Usage: npx tsx crux/validate/validate-migration-large-table-ddl.ts
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getColors } from '../lib/output.ts';

// Tables where an ACCESS EXCLUSIVE lock held long enough for a full table
// scan has caused (or could reasonably cause) deploy-blocking contention.
// Add tables here when they grow past ~100 MB.
const LARGE_TABLES = new Set<string>([
  'hallucination_risk_snapshots',
]);

// Migrations that predate this validator and touched a LARGE_TABLES table
// without NOT VALID. These were fixed manually in production (the constraint
// was re-applied with NOT VALID + VALIDATE CONSTRAINT). We grandfather them
// so the validator doesn't retro-flag already-resolved history.
const GRANDFATHERED_FILES = new Set<string>([
  '0173_add_check_constraints_phase2.sql',
]);

export interface Violation {
  file: string;
  line: number;
  table: string;
  statement: string;
}

export interface CheckResult {
  passed: boolean;
  errors: number;
  violations: Violation[];
  filesScanned: number;
}

/**
 * Strip SQL comments. Keeps newlines so line numbers remain stable.
 * Replaces block comment content with spaces (preserving newlines),
 * then drops line comments entirely.
 */
function stripComments(sql: string): string {
  const noBlock = sql.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\n]/g, ' ');
  });
  return noBlock.replace(/--[^\n]*/g, '');
}

/**
 * Return true if a stripped SQL file is a no-op (only `SELECT 1;` plus
 * whitespace). No-op files defer the real DDL to a manual script per
 * `database-migrations.md` § "Pattern: no-op Drizzle migration +
 * manual SQL script".
 */
function isNoOp(stripped: string): boolean {
  const normalized = stripped.replace(/\s+/g, ' ').trim();
  return /^SELECT\s+1\s*;?\s*$/i.test(normalized);
}

/**
 * Find `ALTER TABLE ... ADD CONSTRAINT` (or `ADD CHECK`) statements targeting
 * LARGE_TABLES. Statements may span multiple lines, so we regex over the
 * full stripped text rather than line-by-line.
 *
 * Returns {line, statement, table} for each match. `line` is the 1-indexed
 * line number where the matched `ALTER TABLE` begins.
 */
function findLargeTableConstraints(
  stripped: string,
): Array<{ line: number; statement: string; table: string }> {
  const matches: Array<{ line: number; statement: string; table: string }> = [];

  // Match full ALTER TABLE ... ; statements. Captures the table name and
  // the statement body. Uses [\s\S]*? for multiline-lazy matching.
  const STMT_RE =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?([\s\S]*?);/gi;

  // Keywords that indicate a *constraint* being added to an existing
  // table (not a column, not an index). Anonymous `ADD CHECK (...)` and
  // named `ADD CONSTRAINT foo CHECK (...)` are both caught.
  const ADD_CONSTRAINT_RE =
    /\bADD\s+(?:CONSTRAINT\s+\w+\s+)?(?:CHECK|FOREIGN\s+KEY|UNIQUE|PRIMARY\s+KEY|EXCLUDE)\b/i;

  let m: RegExpExecArray | null;
  STMT_RE.lastIndex = 0;
  while ((m = STMT_RE.exec(stripped)) !== null) {
    const table = m[1];
    const body = m[2];
    const fullStatement = m[0];
    if (!LARGE_TABLES.has(table)) continue;
    if (!ADD_CONSTRAINT_RE.test(body)) continue;

    const line = stripped.slice(0, m.index).split('\n').length;

    matches.push({ line, statement: fullStatement, table });
  }

  return matches;
}

export function runCheck(drizzleDir = 'apps/wiki-server/drizzle'): CheckResult {
  const c = getColors();
  console.log(`${c.blue}Checking migrations for NOT VALID on large tables...${c.reset}\n`);

  let sqlFiles: string[];
  try {
    sqlFiles = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    console.log(`${c.dim}Skipping: ${drizzleDir} not found${c.reset}`);
    return { passed: true, errors: 0, violations: [], filesScanned: 0 };
  }

  const violations: Violation[] = [];

  for (const file of sqlFiles) {
    if (GRANDFATHERED_FILES.has(file)) continue;

    const filePath = join(drizzleDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const stripped = stripComments(content);

    // `SELECT 1;` no-op files defer real DDL to a manual script.
    if (isNoOp(stripped)) continue;

    const matches = findLargeTableConstraints(stripped);
    for (const m of matches) {
      // NOT VALID must be in the same statement.
      if (/\bNOT\s+VALID\b/i.test(m.statement)) continue;
      violations.push({
        file,
        line: m.line,
        table: m.table,
        statement: m.statement.trim().split('\n').slice(0, 3).join(' ').slice(0, 200),
      });
    }
  }

  if (violations.length === 0) {
    console.log(
      `${c.green}All migrations against large tables (${sqlFiles.length} files scanned) use NOT VALID or are no-ops${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}Found ${violations.length} ADD CONSTRAINT statement(s) on large tables without NOT VALID:${c.reset}\n`,
    );
    for (const v of violations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset} — ${c.yellow}${v.table}${c.reset}`);
      console.log(`    ${c.dim}${v.statement}${c.reset}`);
    }
    console.log();
    console.log(
      `${c.dim}Use NOT VALID + VALIDATE CONSTRAINT. See .claude/rules/database-migrations.md${c.reset}`,
    );
    console.log(
      `${c.dim}(§ "ADD CONSTRAINT ... NOT VALID + separate VALIDATE CONSTRAINT")${c.reset}`,
    );
  }

  return {
    passed: violations.length === 0,
    errors: violations.length,
    violations,
    filesScanned: sqlFiles.length,
  };
}

if (process.argv[1]?.includes('validate-migration-large-table-ddl')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
