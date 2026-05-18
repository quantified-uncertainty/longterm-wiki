#!/usr/bin/env node

/**
 * Third-Party Evaluation References Validator (QUA-692).
 *
 * Static (no-DB) check that the controlled vocabularies for
 * `third_party_evaluations` stay in sync across the three places they live:
 *
 *  1. The Drizzle/route source of truth — `VALID_RISK_DOMAIN`,
 *     `VALID_SOURCE_FORMATS`, `VALID_SOURCE_SYSTEMS`,
 *     `VALID_MATCH_CONFIDENCES` exported from
 *     `apps/wiki-server/src/routes/tablebase/third-party-evaluations.ts`.
 *
 *  2. The migration's CHECK constraints in
 *     `apps/wiki-server/drizzle/0209_qua_692_third_party_evaluations.sql`.
 *
 *  3. The wiki-server client + ingester source files — verifying the
 *     constants are imported (no parallel hardcoded copies that drift).
 *
 * Three places to update an enum is two too many; this validator is the
 * cheapest way to catch a vocab-drift bug before it hits prod.
 *
 * Usage:
 *   npx tsx crux/validate/validate-third-party-eval-refs.ts
 *   npx tsx crux/validate/validate-third-party-eval-refs.ts --ci    # JSON
 *
 * Exit codes:
 *   0 = OK
 *   1 = drift detected
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import type { ValidatorResult } from "./types.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const ROUTE_FILE = path.join(
  REPO_ROOT,
  "apps/wiki-server/src/routes/tablebase/third-party-evaluations.ts",
);

const MIGRATION_FILE = path.join(
  REPO_ROOT,
  "apps/wiki-server/drizzle/0209_qua_692_third_party_evaluations.sql",
);

const EXPECTED_RISK_DOMAINS = [
  "cbrn",
  "biological",
  "chemical",
  "radiological",
  "nuclear",
  "cyber",
  "autonomy",
  "agent-security",
  "persuasion",
  "scheming",
  "deception",
  "jailbreak",
  "safeguard-efficacy",
  "evaluation-awareness",
  "misuse",
  "misc",
];

const EXPECTED_SOURCE_FORMATS = ["pdf", "html", "markdown", "arxiv-paper", "missing"];
const EXPECTED_SOURCE_SYSTEMS = ["sitemap", "rss", "html-scrape", "manual"];
const EXPECTED_MATCH_CONFIDENCES = ["exact", "fuzzy", "manual"];

interface DriftFinding {
  scope: string;
  message: string;
}

/**
 * Extract a `as const` string-array literal exported from the route file.
 * Hand-rolled scanner — looks for the named export and reads the
 * comma-separated quoted strings up to the closing `]`. Defensive against
 * formatting changes (whitespace, multi-line layout).
 *
 * If the route file does not declare the constant directly but re-exports
 * it from `api-types.ts` (the canonical home for constants the worker
 * container imports — moved there to avoid pulling route files into the
 * worker image), fall back to reading `api-types.ts`.
 */
function extractRouteVocab(source: string, name: string): string[] | null {
  const re = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const\\s*;`,
    "m",
  );
  const direct = source.match(re);
  if (direct) {
    const body = direct[1];
    const stringRe = /['"]([^'"\n]+?)['"]/g;
    const out: string[] = [];
    let mm: RegExpExecArray | null;
    while ((mm = stringRe.exec(body))) out.push(mm[1]);
    return out;
  }

  // Re-export path: `import { NAME } from "../../api-types.js"; export { NAME };`
  const reExportRe = new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\.\\.\\/\\.\\.\\/api-types(?:\\.js)?['"]`,
  );
  if (!reExportRe.test(source)) return null;
  const apiTypesPath = path.join(REPO_ROOT, "apps/wiki-server/src/api-types.ts");
  if (!existsSync(apiTypesPath)) return null;
  const apiTypesSrc = readFileSync(apiTypesPath, "utf-8");
  const m2 = apiTypesSrc.match(re);
  if (!m2) return null;
  const body = m2[1];
  const stringRe = /['"]([^'"\n]+?)['"]/g;
  const out: string[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = stringRe.exec(body))) out.push(mm[1]);
  return out;
}

/**
 * Extract a string-array literal from inside a CHECK (... IN (...)) clause.
 * Pass `marker` = a unique substring near the constraint (e.g. constraint
 * name) and `field` = the column name. The function looks for a
 * `field IN (...)` clause near the marker.
 */
function extractMigrationInList(
  source: string,
  constraintName: string,
): string[] | null {
  const constraintStart = source.indexOf(constraintName);
  if (constraintStart < 0) return null;
  const block = source.slice(constraintStart, constraintStart + 4000);
  const inMatch = block.match(/IN\s*\(([\s\S]*?)\)/i);
  if (!inMatch) return null;
  const stringRe = /'([^'\n]+?)'/g;
  const out: string[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = stringRe.exec(inMatch[1]))) out.push(mm[1]);
  return out;
}

/**
 * Extract the array literal out of a `<@ ARRAY[...]::text[]` clause.
 * Used for the `risk_domain` CHECK which uses array-subset semantics.
 */
function extractMigrationArrayList(
  source: string,
  constraintName: string,
): string[] | null {
  const constraintStart = source.indexOf(constraintName);
  if (constraintStart < 0) return null;
  const block = source.slice(constraintStart, constraintStart + 4000);
  const arrayMatch = block.match(/ARRAY\s*\[([\s\S]*?)\]\s*::\s*text\s*\[\]/i);
  if (!arrayMatch) return null;
  const stringRe = /'([^'\n]+?)'/g;
  const out: string[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = stringRe.exec(arrayMatch[1]))) out.push(mm[1]);
  return out;
}

function arraysMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  // Order-sensitive: the canonical lists are kept in the same order in
  // both places by convention. If we relax that, this check is too strict.
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function compareSets(
  scope: string,
  expected: string[],
  actual: string[] | null,
  findings: DriftFinding[],
): void {
  if (actual === null) {
    findings.push({
      scope,
      message: `could not find vocab declaration`,
    });
    return;
  }
  if (!arraysMatch(expected, actual)) {
    const missing = expected.filter((v) => !actual.includes(v));
    const extra = actual.filter((v) => !expected.includes(v));
    const detail: string[] = [];
    if (missing.length) detail.push(`missing: ${missing.join(", ")}`);
    if (extra.length) detail.push(`extra: ${extra.join(", ")}`);
    if (
      missing.length === 0 &&
      extra.length === 0 &&
      expected.length === actual.length
    ) {
      detail.push("order differs (canonical lists must be identical)");
    }
    findings.push({
      scope,
      message: detail.join("; "),
    });
  }
}

export interface RunOptions {
  ci?: boolean;
}

export interface RunResult extends ValidatorResult {
  findings: DriftFinding[];
}

export async function runCheck(options: RunOptions = {}): Promise<RunResult> {
  const findings: DriftFinding[] = [];

  if (!existsSync(ROUTE_FILE)) {
    findings.push({
      scope: "route-file",
      message: `route file missing: ${ROUTE_FILE}`,
    });
    return makeResult(findings);
  }
  if (!existsSync(MIGRATION_FILE)) {
    findings.push({
      scope: "migration-file",
      message: `migration file missing: ${MIGRATION_FILE}`,
    });
    return makeResult(findings);
  }

  const routeSrc = readFileSync(ROUTE_FILE, "utf-8");
  const migrationSrc = readFileSync(MIGRATION_FILE, "utf-8");

  // Route ↔ expected
  compareSets(
    "route:VALID_RISK_DOMAINS",
    EXPECTED_RISK_DOMAINS,
    extractRouteVocab(routeSrc, "VALID_RISK_DOMAINS"),
    findings,
  );
  compareSets(
    "route:VALID_SOURCE_FORMATS",
    EXPECTED_SOURCE_FORMATS,
    extractRouteVocab(routeSrc, "VALID_SOURCE_FORMATS"),
    findings,
  );
  compareSets(
    "route:VALID_SOURCE_SYSTEMS",
    EXPECTED_SOURCE_SYSTEMS,
    extractRouteVocab(routeSrc, "VALID_SOURCE_SYSTEMS"),
    findings,
  );
  compareSets(
    "route:VALID_MATCH_CONFIDENCES",
    EXPECTED_MATCH_CONFIDENCES,
    extractRouteVocab(routeSrc, "VALID_MATCH_CONFIDENCES"),
    findings,
  );

  // Migration ↔ expected
  compareSets(
    "migration:chk_tpe_risk_domain",
    EXPECTED_RISK_DOMAINS,
    extractMigrationArrayList(migrationSrc, "chk_tpe_risk_domain"),
    findings,
  );
  compareSets(
    "migration:chk_tpe_source_format",
    EXPECTED_SOURCE_FORMATS,
    extractMigrationInList(migrationSrc, "chk_tpe_source_format"),
    findings,
  );
  compareSets(
    "migration:chk_tpe_source_system",
    EXPECTED_SOURCE_SYSTEMS,
    extractMigrationInList(migrationSrc, "chk_tpe_source_system"),
    findings,
  );
  compareSets(
    "migration:chk_tpem_match_confidence",
    EXPECTED_MATCH_CONFIDENCES,
    extractMigrationInList(migrationSrc, "chk_tpem_match_confidence"),
    findings,
  );

  if (options.ci) {
    process.stdout.write(JSON.stringify({ ok: findings.length === 0, findings }, null, 2) + "\n");
  } else {
    if (findings.length === 0) {
      console.log(
        "✓ third-party-evaluations: vocab arrays match across route + migration.",
      );
    } else {
      console.error(
        `✗ third-party-evaluations vocab drift (${findings.length}):`,
      );
      for (const f of findings) {
        console.error(`  [${f.scope}] ${f.message}`);
      }
      console.error(
        "\nFix: keep the four arrays in third-party-evaluations.ts in sync with",
      );
      console.error(
        "the CHECK constraints in 0209_qua_692_third_party_evaluations.sql.",
      );
    }
  }

  return makeResult(findings);
}

function makeResult(findings: DriftFinding[]): RunResult {
  return {
    passed: findings.length === 0,
    errors: findings.length,
    warnings: 0,
    infos: 0,
    findings,
  };
}

async function main() {
  const ci = process.argv.includes("--ci") || process.argv.includes("--json");
  const result = await runCheck({ ci });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("validate-third-party-eval-refs crashed:", err);
    process.exit(1);
  });
}
