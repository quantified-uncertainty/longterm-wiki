#!/usr/bin/env node

/**
 * Zod ↔ CHECK Constraint Parity Validator
 *
 * Catches the enum-gap class of deploy bugs: when a route handler's Zod input
 * schema accepts a value that the database's CHECK constraint refuses. A
 * request passes Zod validation, the server writes to the DB, the INSERT
 * fails with a constraint violation, and either the whole sync rolls back or
 * the request 500s.
 *
 * Incident history behind this validator:
 *   - PR #4178: groundskeeper_runs.event CHECK omitted circuit_breaker_reset,
 *     half_open_attempt, half_open_success — blocked prod deploy at ArgoCD
 *     PreSync for ~12h. See .claude/rules/database-migrations.md.
 *   - PR #4202: service_health_incidents.severity CHECK shipped with an
 *     incomplete allowlist — same root cause, same failure shape.
 *   - #4246: research_areas.status Zod schema diverged from the CHECK enum
 *     — caught by tests, not the gate.
 *
 * How it works:
 *   1. Parse apps/wiki-server/drizzle/*.sql for CHECK constraints of the form
 *      `col IN ('a', 'b', ...)` or `col IS NULL OR col IN (...)`. Build an
 *      inventory keyed by (table, column).
 *   2. Parse apps/wiki-server/src/{api-types.ts,routes/** /*.ts} and crux/
 *      for `z.enum([...])` definitions and `const NAME = [...] as const`.
 *   3. Match CHECK constraints to Zod enums heuristically by name:
 *      table + column (camelCase) or column alone. Manual overrides in
 *      MANUAL_MAPPINGS handle cases where the heuristic misses.
 *   4. For each match, diff the sets. Flag:
 *        - "ZOD_EXTRA": Zod accepts value X, CHECK rejects it. BAD — this is
 *          the deploy-failure case.
 *        - "CHECK_EXTRA": CHECK accepts X, no Zod enum has it. Info — less
 *          critical; the DB is more permissive than the API gate.
 *
 * Usage:
 *   node --import tsx/esm crux/validate/validate-zod-check-parity.ts
 *   node --import tsx/esm crux/validate/validate-zod-check-parity.ts --verbose
 *   node --import tsx/esm crux/validate/validate-zod-check-parity.ts --ci
 *
 * Exit codes:
 *   0 = No ZOD_EXTRA findings (advisory is always exit 0)
 *   1 = ZOD_EXTRA findings present (when wired as blocking — currently advisory)
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

// ---------------------------------------------------------------------------
// CHECK constraint extraction
// ---------------------------------------------------------------------------

export interface CheckConstraint {
  /** Migration file the constraint was found in */
  sourceFile: string;
  /** Table name (unquoted) */
  table: string;
  /** Column name (unquoted) */
  column: string;
  /** Allowed string values from the IN list */
  allowed: Set<string>;
  /** Whether the CHECK allows NULL */
  nullable: boolean;
}

/**
 * Extract all `col IN ('a','b')` and `col IS NULL OR col IN (...)` CHECK
 * constraints from a single SQL file.
 *
 * Handles two styles:
 *   1. Inline column: `verdict TEXT NOT NULL CHECK (verdict IN ('a', 'b'))`
 *   2. ALTER TABLE: `ALTER TABLE foo ADD CONSTRAINT ... CHECK (col IN (...))`
 *
 * The regex is intentionally narrow — it only matches `IN ('...')` lists with
 * string literals. BETWEEN, comparison operators, and non-string lists are
 * out of scope (they're not the enum-gap class).
 */
/**
 * Strip SQL comments. `--` line comments only — migrations in this repo don't
 * use `/* * /` block comments. Preserves line count by emptying matched regions.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * Regex matching a `col IN ('a','b')` or `col IS NULL OR col IN (...)` body
 * inside a `CHECK (...)`. Captures:
 *   1: column name
 *   2: the string-list body (values separated by commas)
 * Non-IN checks (BETWEEN, comparison, multi-column) are deliberately out of
 * scope — they aren't the enum-gap class.
 */
const CHECK_IN_RE =
  /CHECK\s*\(\s*(\w+)\s+(?:IS\s+NULL\s+OR\s+\1\s+)?IN\s*\(([^)]+)\)\s*\)/gi;

/** Back-reference check to distinguish the nullable and plain variants. */
const NULLABLE_CHECK_RE = /\bIS\s+NULL\s+OR\b/i;

const ALTER_TABLE_LOOKBACK = 1500;
const CREATE_TABLE_LOOKBACK = 5000;

export function extractChecksFromSql(sql: string, sourceFile: string): CheckConstraint[] {
  const stripped = stripSqlComments(sql);
  const results: CheckConstraint[] = [];

  for (const m of stripped.matchAll(CHECK_IN_RE)) {
    const column = m[1];
    const listBody = m[2];
    const offset = m.index ?? 0;

    const values = new Set<string>();
    for (const lm of listBody.matchAll(/'([^']*)'/g)) values.add(lm[1]);
    if (values.size === 0) continue;

    const table = inferTableForCheck(stripped, offset);
    if (!table) continue;

    results.push({
      sourceFile,
      table,
      column,
      allowed: values,
      nullable: NULLABLE_CHECK_RE.test(m[0]),
    });
  }

  return results;
}

/**
 * Scan backward from a CHECK offset to find the nearest containing or
 * preceding ALTER TABLE / CREATE TABLE statement.
 */
function inferTableForCheck(sql: string, checkOffset: number): string | null {
  const alterWindow = sql.slice(
    Math.max(0, checkOffset - ALTER_TABLE_LOOKBACK),
    checkOffset
  );
  const alterMatches = [...alterWindow.matchAll(/ALTER\s+TABLE\s+"?(\w+)"?/gi)];
  if (alterMatches.length > 0) {
    return alterMatches[alterMatches.length - 1][1];
  }

  const createWindow = sql.slice(
    Math.max(0, checkOffset - CREATE_TABLE_LOOKBACK),
    checkOffset
  );
  const createMatches = [
    ...createWindow.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi),
  ];
  if (createMatches.length > 0) {
    return createMatches[createMatches.length - 1][1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Zod enum extraction
// ---------------------------------------------------------------------------

export interface ZodEnum {
  /** File the enum was declared in */
  sourceFile: string;
  /** Variable/const name, if any (e.g., "JobStatusSchema") or null for inline */
  name: string | null;
  /** The string values in the enum */
  values: Set<string>;
  /** Line number (for diagnostics) */
  line: number;
}

/**
 * Single regex that matches both `[export] const Name = z.enum([...])` and
 * `[export] const NAME = [...] as const` forms. Capture groups:
 *   1: const name in the z.enum form (or undefined for inline z.enum)
 *   2: list body in the z.enum form
 *   3: const name in the `as const` form
 *   4: list body in the `as const` form
 */
const ZOD_ENUM_RE =
  /(?:(?:export\s+)?const\s+(\w+)\s*=\s*)?z\.enum\(\[([^\]]*)\]\)|(?:export\s+)?const\s+(\w+)\s*(?::\s*readonly\s+string\s*\[\s*\])?\s*=\s*\[([^\]]*)\]\s*as\s+const/g;

export function extractZodEnumsFromTs(source: string, sourceFile: string): ZodEnum[] {
  const results: ZodEnum[] = [];
  for (const m of source.matchAll(ZOD_ENUM_RE)) {
    const isZEnum = m[2] !== undefined;
    const name = isZEnum ? (m[1] ?? null) : m[3];
    const listBody = isZEnum ? m[2] : m[4];
    const values = parseStringLiteralList(listBody);
    if (values.size === 0) continue;
    const line = source.slice(0, m.index ?? 0).split("\n").length;
    results.push({ sourceFile, name, values, line });
  }
  return results;
}

const STRING_LITERAL_RE = /["'`]([^"'`]*)["'`]/g;

function parseStringLiteralList(body: string): Set<string> {
  const values = new Set<string>();
  for (const m of body.matchAll(STRING_LITERAL_RE)) {
    if (m[1].length > 0) values.add(m[1]);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Matching CHECK → Zod
// ---------------------------------------------------------------------------

interface ManualTarget {
  /** Zod const/schema name */
  name: string;
  /** File path suffix the enum must live in. Disambiguates duplicate names. */
  file: string;
}

/**
 * Explicit registry mapping `(table, column)` → one or more Zod enum targets.
 *
 * Primary source of truth; the name-matching heuristic below is a fallback
 * that only catches obvious same-file, same-word pairs. Most high-risk enums
 * are cross-file (Zod in api-types.ts, CHECK in a migration SQL file) so they
 * need an explicit entry here.
 *
 * Seeded with the incidents that motivated QUA-364. Add entries as new
 * CHECK-gated columns ship. Keep sorted by table name.
 */
const MANUAL_MAPPINGS: Record<string, readonly ManualTarget[]> = {
  "groundskeeper_runs.event": [
    { name: "VALID_GK_EVENTS", file: "apps/wiki-server/src/api-types.ts" },
  ],
  "research_areas.status": [
    { name: "VALID_STATUSES", file: "apps/wiki-server/src/routes/tablebase/research-areas.ts" },
  ],
};

export interface Finding {
  severity: "ZOD_EXTRA" | "CHECK_EXTRA";
  table: string;
  column: string;
  zodName: string | null;
  zodFile: string;
  checkFile: string;
  values: string[];
  message: string;
}

/**
 * Match a single CHECK constraint against all discovered Zod enums, returning
 * both the candidate matches and parity findings. Callers use `matches.length`
 * for coverage stats without re-running the matcher.
 */
export function diffCheckAgainstZod(
  check: CheckConstraint,
  zodEnums: readonly ZodEnum[],
): { matches: ZodEnum[]; findings: Finding[] } {
  const matches = findZodCandidates(check, zodEnums);
  if (matches.length === 0) return { matches, findings: [] };

  const findings: Finding[] = [];
  for (const zod of matches) {
    for (const v of zod.values) {
      if (!check.allowed.has(v)) {
        findings.push({
          severity: "ZOD_EXTRA",
          table: check.table,
          column: check.column,
          zodName: zod.name,
          zodFile: zod.sourceFile,
          checkFile: check.sourceFile,
          values: [v],
          message: `Zod enum ${zod.name ?? "(inline)"} accepts "${v}" but CHECK constraint on ${check.table}.${check.column} does not`,
        });
      }
    }
    for (const v of check.allowed) {
      if (!zod.values.has(v)) {
        findings.push({
          severity: "CHECK_EXTRA",
          table: check.table,
          column: check.column,
          zodName: zod.name,
          zodFile: zod.sourceFile,
          checkFile: check.sourceFile,
          values: [v],
          message: `CHECK constraint on ${check.table}.${check.column} allows "${v}" but Zod enum ${zod.name ?? "(inline)"} does not`,
        });
      }
    }
  }
  return { matches, findings };
}

/**
 * Find Zod enums that are plausibly the counterpart to a given CHECK
 * constraint. Uses a naming heuristic + manual overrides.
 *
 * The heuristic (strict, biased toward false negatives over false positives):
 *   1. Manual mapping takes precedence.
 *   2. Enum name must contain the column name (case-insensitive, underscores
 *      stripped).
 *   3. Enum name must EITHER contain the table name OR be a "bare" column
 *      name like `VALID_STATUSES` / `statusSchema` — no extra qualifier words
 *      that would indicate a DIFFERENT field (e.g., `VALID_CANDIDATE_STATUSES`
 *      co-located with `VALID_STATUSES` in the same file — we only want the
 *      bare form).
 *   4. Enum file must live in a route path matching the table.
 *
 * A "bare" name is one whose non-boilerplate word set is equal to the column
 * name (singular or plural). This filters out co-located enums for sibling
 * columns like "candidate_status" vs "race_status".
 */
export function findZodCandidates(check: CheckConstraint, all: readonly ZodEnum[]): ZodEnum[] {
  const key = `${check.table}.${check.column}`;
  const manual = MANUAL_MAPPINGS[key];
  if (manual) {
    return all.filter(
      (z) =>
        z.name !== null &&
        manual.some((t) => t.name === z.name && z.sourceFile.endsWith(t.file))
    );
  }

  const colLower = check.column.toLowerCase().replace(/_/g, "");
  const tableLower = check.table.toLowerCase().replace(/_/g, "");

  const candidates: ZodEnum[] = [];
  for (const z of all) {
    if (!z.name) continue;
    const nameLower = z.name.toLowerCase();

    // Must mention the column
    if (!nameLower.includes(colLower)) continue;

    // File must live in a route file matching the table
    const fileNormalized = z.sourceFile.toLowerCase().replace(/[_\-/]/g, "");
    if (!fileNormalized.includes(tableLower)) continue;

    // Accept if the name explicitly includes the table
    if (nameLower.includes(tableLower)) {
      candidates.push(z);
      continue;
    }

    // Accept if the name is "bare": only column + boilerplate words.
    // Boilerplate: VALID, SCHEMA, TYPE, ENUM, S (plural)
    const significantWords = z.name
      .split(/[_\s]|(?<=[a-z])(?=[A-Z])/) // underscore, whitespace, or camelCase boundary
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 0 && !["valid", "schema", "type", "enum"].includes(w));
    const joined = significantWords.join("");
    // Bare = joined is col, col+"s", col+"es", or col without trailing "s".
    // `+es` handles VALID_STATUSES ↔ status, VALID_ADDRESSES ↔ address, etc.
    const col = colLower;
    if (
      joined === col ||
      joined === col + "s" ||
      joined === col + "es" ||
      (col.endsWith("s") && joined === col.slice(0, -1))
    ) {
      candidates.push(z);
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function walkFiles(dir: string, suffix: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
      walkFiles(full, suffix, out);
    } else if (entry.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

export interface RunResult {
  passed: boolean;
  errors: number;
  warnings: number;
  findings: Finding[];
  checksScanned: number;
  zodEnumsScanned: number;
  /** CHECKs that matched at least one Zod enum (and were diffed) */
  checksMatched: number;
  /** Column-level CHECKs that did NOT match any Zod enum — coverage gap */
  unmatchedChecks: Array<{ table: string; column: string }>;
}

export function runCheck(): RunResult {
  const migrationsDir = join(PROJECT_ROOT, "apps/wiki-server/drizzle");
  const routesDir = join(PROJECT_ROOT, "apps/wiki-server/src/routes");
  const apiTypesFile = join(PROJECT_ROOT, "apps/wiki-server/src/api-types.ts");

  const checks: CheckConstraint[] = [];
  for (const file of walkFiles(migrationsDir, ".sql")) {
    checks.push(...extractChecksFromSql(readFileSync(file, "utf8"), file));
  }

  const zodEnums: ZodEnum[] = [];
  const tsFiles = walkFiles(routesDir, ".ts");
  if (existsSync(apiTypesFile)) tsFiles.push(apiTypesFile);
  for (const file of tsFiles) {
    zodEnums.push(...extractZodEnumsFromTs(readFileSync(file, "utf8"), file));
  }

  const findings: Finding[] = [];
  const unmatched: Array<{ table: string; column: string }> = [];
  let matched = 0;
  // Dedupe CHECKs by (table,column) — some columns have multiple constraints
  // (e.g., an inline CHECK on CREATE TABLE and a tightened ALTER TABLE later).
  const seen = new Set<string>();
  for (const check of checks) {
    const key = `${check.table}.${check.column}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { matches, findings: checkFindings } = diffCheckAgainstZod(check, zodEnums);
    findings.push(...checkFindings);
    if (matches.length > 0) {
      matched++;
    } else {
      unmatched.push({ table: check.table, column: check.column });
    }
  }

  const zodExtras = findings.filter((f) => f.severity === "ZOD_EXTRA");
  const checkExtras = findings.filter((f) => f.severity === "CHECK_EXTRA");

  return {
    passed: zodExtras.length === 0,
    errors: zodExtras.length,
    warnings: checkExtras.length,
    findings,
    checksScanned: seen.size,
    zodEnumsScanned: zodEnums.length,
    checksMatched: matched,
    unmatchedChecks: unmatched,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const ci = args.includes("--ci") || args.includes("--json");
  const c = getColors();

  const result = runCheck();

  if (ci) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  console.log(`${c.bold}${c.blue}Zod ↔ CHECK Constraint Parity — Enum-gap detector${c.reset}\n`);
  console.log(`  CHECK constraints scanned:   ${result.checksScanned}`);
  console.log(`  Zod enums scanned:           ${result.zodEnumsScanned}`);
  const covPct = result.checksScanned > 0
    ? Math.round((result.checksMatched / result.checksScanned) * 100)
    : 0;
  console.log(`  CHECKs matched to a Zod enum: ${result.checksMatched} / ${result.checksScanned} (${covPct}%)\n`);

  if (verbose && result.unmatchedChecks.length > 0) {
    console.log(`${c.dim}~ ${result.unmatchedChecks.length} CHECKs have no Zod mapping (coverage gap):${c.reset}`);
    for (const u of result.unmatchedChecks) {
      console.log(`  ${c.dim}${u.table}.${u.column}${c.reset}`);
    }
    console.log("");
  }

  const zodExtras = result.findings.filter((f) => f.severity === "ZOD_EXTRA");
  const checkExtras = result.findings.filter((f) => f.severity === "CHECK_EXTRA");

  if (zodExtras.length > 0) {
    console.log(`${c.red}✗ ${zodExtras.length} ZOD_EXTRA finding(s) — deploy-blocker class:${c.reset}`);
    for (const f of zodExtras) {
      console.log(`  ${c.red}${f.message}${c.reset}`);
      if (verbose) {
        console.log(`    Zod:   ${f.zodFile}`);
        console.log(`    CHECK: ${f.checkFile}`);
      }
    }
    console.log("");
  }

  if (checkExtras.length > 0) {
    console.log(`${c.yellow}~ ${checkExtras.length} CHECK_EXTRA finding(s) — Zod is more restrictive than DB:${c.reset}`);
    if (verbose) {
      for (const f of checkExtras) console.log(`  ${f.message}`);
    }
    console.log("");
  }

  if (result.passed && checkExtras.length === 0) {
    console.log(`${c.green}✓ All matched Zod enums are in parity with their CHECK constraints.${c.reset}`);
  } else if (result.passed) {
    console.log(`${c.green}✓ No ZOD_EXTRA findings (deploy-blocker class clean). See CHECK_EXTRA warnings above.${c.reset}`);
  }

  process.exit(result.passed ? 0 : 1);
}

// Only run main when invoked directly (not on import).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
