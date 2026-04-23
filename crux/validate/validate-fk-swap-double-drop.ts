#!/usr/bin/env node

/**
 * Validate that every Drizzle migration which performs the QUA-549 Phase B
 * resources-FK swap drops BOTH the Drizzle-generated constraint name
 * (`<table>_<col>_resources_id_fk`) AND the postgres-default constraint name
 * (`<table>_<col>_fkey`).
 *
 * ## Why this exists
 *
 * Migration 0186 (the QUA-549 pilot) only dropped the Drizzle name. Prod had
 * the postgres-default `_fkey` name surviving from an older code path; the
 * Step 2 UPDATE tripped that surviving FK and the deploy halted. Every
 * subsequent Phase B migration (0187–0197) drops both names, but the
 * difference between "safe" and "breaks prod" was the PR author's memory of
 * the pilot post-mortem. This validator promotes that memory to a gate check.
 *
 * ## What it flags
 *
 * For each `apps/wiki-server/drizzle/*.sql`:
 *   1. Detect any FK-swap operation against `resources(stable_id)` for a
 *      `(table, column)` pair. Two signals trigger:
 *        a) `UPDATE <table> <alias> SET <col> = r.stable_id FROM resources r
 *           WHERE <alias>.<col> = r.id` — the canonical hex16 → sid_ rewrite.
 *        b) `ALTER TABLE <table> ... ADD CONSTRAINT ... FOREIGN KEY (<col>)
 *           REFERENCES resources(stable_id)` — the new FK target.
 *   2. For every `(table, col)` discovered, require either:
 *        a) BOTH `DROP CONSTRAINT IF EXISTS "<table>_<col>_resources_id_fk"`
 *           (Drizzle convention) AND `DROP CONSTRAINT IF EXISTS
 *           "<table>_<col>_fkey"` (postgres default) — the explicit two-name
 *           pattern used by 0188–0197; OR
 *        b) A dynamic-drop DO block that looks up the FK by `(table, column,
 *           ccu.table='resources', ccu.column='id')` in `information_schema`
 *           and `EXECUTE format`s an `ALTER TABLE "<table>" DROP CONSTRAINT
 *           %I` — the pattern used by 0187. This is strictly safer than the
 *           two-name pattern (handles any constraint name) so it's accepted.
 *   3. Migrations with no FK-swap signals are skipped entirely.
 *
 * ## What it does NOT check
 *
 * - DELETE policy correctness (CASCADE vs SET NULL) — separate concern.
 * - The reverse direction (sid_ → hex16) — Phase B is one-way.
 * - That the new FK is actually added — some swaps (citation_quotes/0194) are
 *   soft refs that intentionally leave the FK off.
 * - Migrations that touch resources in other ways without doing the swap.
 *
 * Usage: `npx tsx crux/validate/validate-fk-swap-double-drop.ts`
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const DEFAULT_DRIZZLE_DIR = join(PROJECT_ROOT, 'apps/wiki-server/drizzle');

type Signal = 'update' | 'add-constraint';

/** A `(table, column)` pair that needs both drops. */
interface SwapTarget {
  table: string;
  column: string;
  /** Which signal(s) flagged this target — useful for the human-readable error. */
  signals: Set<Signal>;
}

interface MigrationViolation {
  file: string;
  table: string;
  column: string;
  signals: Signal[];
  /** Which of the two required drops are missing for this target. */
  missingDrops: string[];
}

/** Drizzle-generated constraint name for an FK from `<table>.<col>` → `resources.id`. */
function drizzleFkName(table: string, column: string): string {
  return `${table}_${column}_resources_id_fk`;
}

/** Postgres-default constraint name for an FK from `<table>.<col>` → `resources.id`. */
function postgresFkName(table: string, column: string): string {
  return `${table}_${column}_fkey`;
}

interface CheckOptions {
  drizzleDir?: string;
}

interface CheckResult {
  passed: boolean;
  errors: number;
  violations: MigrationViolation[];
  scanned: number;
  /** Files where at least one swap target was detected. */
  filesWithSwaps: number;
}

// ---------------------------------------------------------------------------
// Comment stripping — important so a "do NOT drop X" sentence in a comment
// doesn't accidentally count as a real DROP statement.
// ---------------------------------------------------------------------------

function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------------
// Detection regexes
// ---------------------------------------------------------------------------

// UPDATE rewrite signal. Both alias-form and aliasless forms are matched:
//   `UPDATE "table" alias SET col = r.stable_id ...`     (Drizzle convention)
//   `UPDATE "table" SET col = r.stable_id ...`            (aliasless, allowed by PG)
// The alias capture group is optional via `(?!SET\b)` so `UPDATE x SET` does
// not capture `SET` as the alias.
//
// The resources alias `r` is hardcoded — every Phase B migration in this repo
// uses that name. If a future migration uses a different alias (e.g. `res`),
// this regex won't match. That's acceptable; the validator is meant to
// enforce a convention, not to parse arbitrary SQL.
//
// We anchor to `r.stable_id` to avoid generic UPDATEs and verify the FROM
// resources / WHERE col = r.id structure separately in `isCanonicalRewrite`.
const UPDATE_RE =
  /UPDATE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+(?!SET\b)([A-Za-z_][A-Za-z0-9_]*))?\s+SET\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=\s*r\.stable_id\b([^;]*);/gi;

// ADD CONSTRAINT to resources(stable_id). The ALTER TABLE may sit on a prior
// line (Drizzle multi-line) or inside a DO block, but the FOREIGN KEY
// (<col>) REFERENCES "resources"("stable_id") clause must appear within the
// same SQL statement as its ALTER TABLE. We bound the gap with `[^;]*?` so
// the regex cannot span across a statement terminator and misattribute the
// FK to a different ALTER TABLE earlier in the file.
const ADD_CONSTRAINT_RE =
  /ALTER\s+TABLE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?[^;]*?ADD\s+CONSTRAINT\s+"?[A-Za-z_][A-Za-z0-9_]*"?[^;]*?FOREIGN\s+KEY\s*\(\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)\s*REFERENCES\s+"?resources"?\s*\(\s*"?stable_id"?\s*\)/gi;

// All `DROP CONSTRAINT IF EXISTS <name>` constraint names in the file.
// We require IF EXISTS because the migrations always use it; a DROP without
// IF EXISTS is risky on its own and would warrant a separate check.
const DROP_RE =
  /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;

// Inside an UPDATE statement, confirm the canonical hex16→sid_ structure:
// `FROM "?resources"? r ... WHERE [<prefix>.]<col> = r.id`.
//
// The prefix may be the alias (`p.resource_id`), the bare table name
// (`publications.resource_id`, common in aliasless UPDATEs), or absent
// (`resource_id = r.id`, also valid in aliasless form). All three are
// accepted because all three are FK-swap shapes worth catching.
function isCanonicalRewrite(
  stmt: string,
  table: string,
  alias: string | undefined,
  column: string
): boolean {
  if (!/FROM\s+"?resources"?\s+r\b/i.test(stmt)) return false;
  // Optional prefix: alias OR table OR nothing.
  const prefixes = alias ? [alias, table] : [table];
  const prefixGroup = `(?:(?:${prefixes.map(escapeRegex).join('|')})\\.\\s*)?`;
  const re = new RegExp(
    `\\b${prefixGroup}"?${escapeRegex(column)}"?\\s*=\\s*r\\.\\s*id\\b`,
    'i'
  );
  return re.test(stmt);
}

export function findSwapTargets(sql: string): SwapTarget[] {
  const stripped = stripComments(sql);
  const targets = new Map<string, SwapTarget>(); // key = `${table}::${column}`

  function record(table: string, column: string, signal: Signal): void {
    const key = `${table}::${column}`;
    let target = targets.get(key);
    if (!target) {
      target = { table, column, signals: new Set() };
      targets.set(key, target);
    }
    target.signals.add(signal);
  }

  // UPDATE rewrites — alias is the optional second capture (undefined for
  // aliasless `UPDATE "x" SET ...`).
  UPDATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UPDATE_RE.exec(stripped)) !== null) {
    const [, table, alias, column, tail] = m;
    if (isCanonicalRewrite(tail, table, alias, column)) {
      record(table, column, 'update');
    }
  }

  // ADD CONSTRAINT to resources(stable_id)
  ADD_CONSTRAINT_RE.lastIndex = 0;
  while ((m = ADD_CONSTRAINT_RE.exec(stripped)) !== null) {
    const [, table, column] = m;
    record(table, column, 'add-constraint');
  }

  return [...targets.values()];
}

export function findDroppedConstraints(sql: string): Set<string> {
  const stripped = stripComments(sql);
  const drops = new Set<string>();
  DROP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DROP_RE.exec(stripped)) !== null) {
    drops.add(m[1]);
  }
  return drops;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect the "dynamic drop" pattern used by migration 0187: a DO block that
 * looks up the FK in information_schema by (table, column, target=resources.id)
 * and `EXECUTE format`s an `ALTER TABLE "<table>" DROP CONSTRAINT %I`.
 *
 * This is strictly safer than the two-name pattern because it drops *any*
 * constraint name matching the (table, column, target) tuple — including
 * names neither convention covers. Accepted as an equivalent guarantee.
 *
 * The check is file-scoped, but the EXECUTE format hardcodes the literal
 * `<table>` so a dynamic-drop block for table A cannot satisfy the check
 * for table B.
 */
export function hasDynamicDrop(sql: string, table: string, column: string): boolean {
  const stripped = stripComments(sql);
  const t = escapeRegex(table);
  const c = escapeRegex(column);

  const required: RegExp[] = [
    new RegExp(`tc\\.table_name\\s*=\\s*'${t}'`, 'i'),
    new RegExp(`kcu\\.column_name\\s*=\\s*'${c}'`, 'i'),
    /ccu\.table_name\s*=\s*'resources'/i,
    /ccu\.column_name\s*=\s*'id'/i,
    new RegExp(
      `EXECUTE\\s+format\\s*\\(\\s*'ALTER\\s+TABLE\\s+"?${t}"?\\s+DROP\\s+CONSTRAINT\\s+%I'`,
      'i'
    ),
  ];

  return required.every((re) => re.test(stripped));
}

function checkFile(
  file: string,
  sql: string,
  targets: SwapTarget[]
): MigrationViolation[] {
  if (targets.length === 0) return [];

  const drops = findDroppedConstraints(sql);
  const violations: MigrationViolation[] = [];

  for (const target of targets) {
    // Equivalent guarantee: a dynamic-drop DO block covers any constraint name.
    if (hasDynamicDrop(sql, target.table, target.column)) continue;

    const drizzleName = drizzleFkName(target.table, target.column);
    const postgresName = postgresFkName(target.table, target.column);

    const missing: string[] = [];
    if (!drops.has(drizzleName)) missing.push(drizzleName);
    if (!drops.has(postgresName)) missing.push(postgresName);

    if (missing.length > 0) {
      violations.push({
        file,
        table: target.table,
        column: target.column,
        signals: [...target.signals],
        missingDrops: missing,
      });
    }
  }

  return violations;
}

export function runCheck(options: CheckOptions = {}): CheckResult {
  const c = getColors();
  const drizzleDir = options.drizzleDir ?? DEFAULT_DRIZZLE_DIR;

  console.log(
    `${c.blue}Checking FK-swap double-drop pattern in ${drizzleDir}...${c.reset}\n`
  );

  let sqlFiles: string[];
  try {
    sqlFiles = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    // Intentionally pass-through. The dir-missing case fires when the
    // validator runs outside the repo (tests, isolated tooling). Failing
    // here would block legitimate non-repo usage; the gate runs from the
    // repo root and doesn't hit this path. Same convention as
    // validate-workspace-dep-coverage.ts.
    console.log(`${c.dim}Skipping: ${drizzleDir} not found${c.reset}`);
    return { passed: true, errors: 0, violations: [], scanned: 0, filesWithSwaps: 0 };
  }

  const violations: MigrationViolation[] = [];
  let filesWithSwaps = 0;

  for (const file of sqlFiles) {
    let sql: string;
    try {
      sql = readFileSync(join(drizzleDir, file), 'utf-8');
    } catch {
      // File disappeared between readdir and readFile (race, or symlink
      // resolution failure). Skip — there's no useful action to take here
      // and no real risk because if we can't read it, nothing else can
      // apply it as a migration either.
      continue;
    }
    const targets = findSwapTargets(sql);
    if (targets.length === 0) continue;
    filesWithSwaps += 1;
    violations.push(...checkFile(file, sql, targets));
  }

  if (violations.length === 0) {
    console.log(
      `${c.green}All ${filesWithSwaps} FK-swap migration${filesWithSwaps === 1 ? '' : 's'} drop both _fk and _fkey names${c.reset}`
    );
    console.log(
      `${c.dim}(${sqlFiles.length} migration files scanned, ${filesWithSwaps} flagged as FK-swap)${c.reset}`
    );
    return {
      passed: true,
      errors: 0,
      violations: [],
      scanned: sqlFiles.length,
      filesWithSwaps,
    };
  }

  console.log(
    `${c.red}Found ${violations.length} FK-swap migration${violations.length === 1 ? '' : 's'} missing required DROP CONSTRAINT IF EXISTS:${c.reset}\n`
  );
  for (const v of violations) {
    const sigList = v.signals.join(' + ');
    console.log(
      `  ${c.red}${v.file}${c.reset} — ${c.dim}${v.table}.${v.column} (${sigList})${c.reset}`
    );
    for (const drop of v.missingDrops) {
      console.log(`    ${c.red}missing:${c.reset} DROP CONSTRAINT IF EXISTS "${drop}"`);
    }
  }
  console.log();
  console.log(
    `${c.dim}Both names must be dropped because prod databases may carry the postgres-default${c.reset}`
  );
  console.log(
    `${c.dim}\`<table>_<col>_fkey\` constraint (from older code paths) alongside, or instead of,${c.reset}`
  );
  console.log(
    `${c.dim}the Drizzle-generated \`<table>_<col>_resources_id_fk\` name. Migration 0186 (QUA-549${c.reset}`
  );
  console.log(
    `${c.dim}pilot) halted production for this exact reason.${c.reset}\n`
  );
  console.log(`${c.dim}Two equivalent fixes:${c.reset}`);
  console.log(
    `${c.dim}  1. Add both \`ALTER TABLE ... DROP CONSTRAINT IF EXISTS ...\` lines (pattern in 0188).${c.reset}`
  );
  console.log(
    `${c.dim}  2. Use the dynamic information_schema lookup + EXECUTE format() pattern (0187).${c.reset}`
  );

  return {
    passed: false,
    errors: violations.length,
    violations,
    scanned: sqlFiles.length,
    filesWithSwaps,
  };
}

const invokedDirectly =
  import.meta.url.startsWith('file://') &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
