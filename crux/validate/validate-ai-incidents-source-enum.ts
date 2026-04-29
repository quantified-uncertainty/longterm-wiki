#!/usr/bin/env node

/**
 * Validate that the `ai_incidents.source` enum stays in lockstep across
 * three layers:
 *
 *   1. The route's `VALID_SOURCES` literal
 *      (apps/wiki-server/src/routes/tablebase/ai-incidents.ts)
 *   2. The Zod schema's `z.enum(VALID_SOURCES)` reference (same file)
 *   3. The CHECK constraint shipped in the most recent
 *      `*_widen_ai_incidents_source.sql` (or the original 0214 migration
 *      if no widening migration has been added yet)
 *
 * Failure modes this catches:
 *   - Adding a new source to the route's literal without a paired migration
 *     (route would accept rows the DB CHECK rejects → 500 on insert)
 *   - Shipping a migration without updating the route literal (route
 *     refuses payloads the DB would accept)
 *   - Drift between the literal and the Zod enum reference inside the
 *     route file (refactor leaves them out of sync)
 *
 * Static check only — no DB connection. Parses both files as text.
 *
 * Usage: npx tsx crux/validate/validate-ai-incidents-source-enum.ts
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { getColors } from "../lib/output.ts";

const ROUTE_FILE =
  "apps/wiki-server/src/routes/tablebase/ai-incidents.ts";
const MIGRATIONS_DIR = "apps/wiki-server/drizzle";

interface CheckResult {
  passed: boolean;
  errors: number;
  message: string;
}

interface SourceEnums {
  routeLiteral: string[];
  routeUsedInZod: boolean;
  migrationFile: string;
  migrationCheck: string[];
}

function parseRouteLiteral(src: string): {
  values: string[] | null;
  usedInZod: boolean;
} {
  // Match: const VALID_SOURCES = ["mit-aiid", "oecd-aim"] as const;
  const re =
    /VALID_SOURCES\s*=\s*\[([^\]]+)\]\s*as\s+const/;
  const match = src.match(re);
  if (!match) return { values: null, usedInZod: false };
  const inner = match[1];
  const values = Array.from(inner.matchAll(/["']([^"']+)["']/g)).map(
    (m) => m[1],
  );
  // Must reference VALID_SOURCES inside z.enum(...) at least once.
  const usedInZod = /z\.enum\s*\(\s*VALID_SOURCES\s*\)/.test(src);
  return { values, usedInZod };
}

/**
 * Find the most recent migration that contains a CHECK for
 * ai_incidents.source — typically a `*_widen_ai_incidents_source.sql` file,
 * but falls back to the original creating migration. Returns null if none.
 */
function findLatestSourceMigration(): string | null {
  if (!existsSync(MIGRATIONS_DIR)) return null;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .reverse(); // newest first by 4-digit prefix
  for (const name of files) {
    const path = join(MIGRATIONS_DIR, name);
    const src = readFileSync(path, "utf-8");
    if (
      /chk_ai_incidents_source/.test(src) &&
      /ai_incidents/i.test(src) &&
      /CHECK\s*\(\s*"?source"?\s+IN\s*\(/i.test(src)
    ) {
      return path;
    }
  }
  return null;
}

function parseMigrationCheck(path: string): string[] | null {
  const src = readFileSync(path, "utf-8");
  // Match the most recent ADD CONSTRAINT chk_ai_incidents_source ... CHECK
  // ("source" IN ('a','b',...))
  // (case-insensitive, allow whitespace, optional double-quotes around
  // identifiers).
  const re =
    /CHECK\s*\(\s*"?source"?\s+IN\s*\(([^)]+)\)\s*\)/gi;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) last = m;
  if (!last) return null;
  return Array.from(last[1].matchAll(/['"]([^'"]+)['"]/g)).map((mm) => mm[1]);
}

export function runCheck(): CheckResult {
  const c = getColors();
  console.log(
    `${c.blue}Checking ai_incidents.source enum lockstep across route + migration ...${c.reset}\n`,
  );

  if (!existsSync(ROUTE_FILE)) {
    return {
      passed: true,
      errors: 0,
      message: `(skipped: ${ROUTE_FILE} not found)`,
    };
  }
  const routeSrc = readFileSync(ROUTE_FILE, "utf-8");
  const { values: routeLiteral, usedInZod: routeUsedInZod } =
    parseRouteLiteral(routeSrc);
  if (routeLiteral == null) {
    return {
      passed: false,
      errors: 1,
      message:
        `${c.red}Could not parse VALID_SOURCES literal in ${ROUTE_FILE}.${c.reset}\n` +
        `Expected: const VALID_SOURCES = ["...", ...] as const;`,
    };
  }
  if (!routeUsedInZod) {
    return {
      passed: false,
      errors: 1,
      message:
        `${c.red}VALID_SOURCES literal in ${ROUTE_FILE} is not referenced via z.enum(VALID_SOURCES).${c.reset}\n` +
        `The route's Zod schema must use the literal so payload validation and the CHECK constraint share one source of truth.`,
    };
  }

  const migrationPath = findLatestSourceMigration();
  if (!migrationPath) {
    return {
      passed: false,
      errors: 1,
      message:
        `${c.red}No migration found for chk_ai_incidents_source.${c.reset}\n` +
        `Expected a CHECK constraint in apps/wiki-server/drizzle/*.sql.`,
    };
  }
  const migrationCheck = parseMigrationCheck(migrationPath);
  if (!migrationCheck) {
    return {
      passed: false,
      errors: 1,
      message:
        `${c.red}Found ${migrationPath} but couldn't parse the CHECK constraint values.${c.reset}\n` +
        `Expected: CHECK ("source" IN ('a','b',...))`,
    };
  }

  const enums: SourceEnums = {
    routeLiteral,
    routeUsedInZod,
    migrationFile: migrationPath,
    migrationCheck,
  };

  const routeSet = new Set(enums.routeLiteral);
  const migrationSet = new Set(enums.migrationCheck);
  const onlyRoute = enums.routeLiteral.filter((v) => !migrationSet.has(v));
  const onlyMigration = enums.migrationCheck.filter((v) => !routeSet.has(v));

  if (onlyRoute.length === 0 && onlyMigration.length === 0) {
    console.log(
      `${c.green}OK${c.reset} — VALID_SOURCES = [${enums.routeLiteral
        .map((v) => `"${v}"`)
        .join(", ")}] matches CHECK in ${enums.migrationFile}`,
    );
    return {
      passed: true,
      errors: 0,
      message: "ai_incidents.source enum in lockstep",
    };
  }

  let msg =
    `${c.red}ai_incidents.source enum drift:${c.reset}\n` +
    `  Route file:    ${ROUTE_FILE}\n` +
    `    VALID_SOURCES = [${enums.routeLiteral.map((v) => `"${v}"`).join(", ")}]\n` +
    `  Migration:     ${enums.migrationFile}\n` +
    `    CHECK ... IN (${enums.migrationCheck.map((v) => `'${v}'`).join(", ")})\n`;
  if (onlyRoute.length > 0) {
    msg += `  ${c.red}Only in route literal:${c.reset}     ${onlyRoute.join(", ")}\n`;
    msg += `  ${c.dim}=> Add a migration that widens chk_ai_incidents_source to include these.${c.reset}\n`;
  }
  if (onlyMigration.length > 0) {
    msg += `  ${c.red}Only in migration CHECK:${c.reset}   ${onlyMigration.join(", ")}\n`;
    msg += `  ${c.dim}=> Add these to VALID_SOURCES in the route file.${c.reset}\n`;
  }
  return {
    passed: false,
    errors: onlyRoute.length + onlyMigration.length,
    message: msg.trimEnd(),
  };
}

function main(): void {
  const result = runCheck();
  if (!result.passed) {
    console.error(result.message);
    process.exit(1);
  } else {
    if (result.message) console.log(result.message);
    process.exit(0);
  }
}

const invokedDirectly = (() => {
  try {
    const self = new URL(import.meta.url).pathname;
    return (
      process.argv[1] === self ||
      process.argv[1]?.endsWith("validate-ai-incidents-source-enum.ts")
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
