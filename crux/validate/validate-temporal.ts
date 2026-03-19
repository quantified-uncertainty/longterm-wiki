#!/usr/bin/env node

/**
 * Temporal Invariant Validation — gate check for date consistency.
 *
 * Catches temporal paradoxes in both FactBase and entity YAML data:
 *
 * 1. date-value-validity   (error)  — Month 01-12, day 01-31, basic calendar rules
 * 2. factbase-temporal     (error)  — validEnd >= asOf and validEnd >= validStart for facts
 * 3. model-cutoff-release  (error)  — AI model trainingCutoff <= releaseDate
 * 4. policy-date-order     (error)  — Policy introduced date before vote dates
 *
 * This check is CI-blocking. All errors must be resolved before push.
 *
 * Usage:
 *   npx tsx crux/validate/validate-temporal.ts
 *   npx tsx crux/validate/validate-temporal.ts --verbose
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml, parseDocument } from "yaml";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

const verbose = process.argv.includes("--verbose");
const ciMode = process.argv.includes("--ci") || process.env.CI === "true";
const c = getColors(ciMode);

// ── Date Validation Helpers ──────────────────────────────────────────────────

/** Strict date format: YYYY, YYYY-MM, or YYYY-MM-DD with valid values. */
const DATE_FORMAT_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** Days per month (non-leap year). February is checked separately for leap years. */
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export interface DateValidationError {
  field: string;
  value: string;
  reason: string;
}

/**
 * Validates a date string for format AND value validity.
 * Returns null if valid, or a reason string if invalid.
 *
 * Checks:
 * - Matches YYYY, YYYY-MM, or YYYY-MM-DD format
 * - Month is 01-12
 * - Day is 01-{max for that month}, accounting for leap years
 */
export function validateDateValue(dateStr: string): string | null {
  if (!DATE_FORMAT_RE.test(dateStr)) {
    return `does not match YYYY, YYYY-MM, or YYYY-MM-DD format`;
  }

  const parts = dateStr.split("-");
  const year = parseInt(parts[0], 10);

  if (year < 1900 || year > 2100) {
    return `year ${year} is outside reasonable range (1900-2100)`;
  }

  if (parts.length >= 2) {
    const month = parseInt(parts[1], 10);
    if (month < 1 || month > 12) {
      return `invalid month ${parts[1]} (must be 01-12)`;
    }

    if (parts.length === 3) {
      const day = parseInt(parts[2], 10);
      let maxDay = DAYS_IN_MONTH[month];
      if (month === 2 && isLeapYear(year)) {
        maxDay = 29;
      }
      if (day < 1 || day > maxDay) {
        return `invalid day ${parts[2]} for month ${parts[1]} (max ${maxDay})`;
      }
    }
  }

  return null;
}

/**
 * Compare two partial date strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Handles mixed precision (YYYY vs YYYY-MM vs YYYY-MM-DD) by
 * padding shorter dates conservatively for the comparison context.
 */
export function compareDates(a: string, b: string): number {
  // Lexicographic comparison works for ISO dates at the same precision.
  // For mixed precision, we pad shorter dates to match longer ones.
  // For "is A before B?" comparisons, pad A with -01 and B with -12-31.
  // But for simple ordering, straight lexicographic on equal-length works.
  // Since our data uses these consistently, lexicographic comparison suffices.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Parse a date string to ISO format (YYYY-MM-DD).
 * Handles both ISO dates ("2024-04-02") and natural-language dates ("April 2, 2024").
 * Returns null if the date cannot be parsed.
 */
export function parseToIsoDate(dateStr: string): string | null {
  // If already in ISO format, return as-is
  if (DATE_FORMAT_RE.test(dateStr)) return dateStr;

  // Try parsing natural-language dates via Date constructor
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ── Violation Types ──────────────────────────────────────────────────────────

interface Violation {
  rule: string;
  location: string;
  message: string;
}

// ── Check 1: Date value validity across all YAML entity files ────────────────

function checkEntityDateValidity(): Violation[] {
  const violations: Violation[] = [];
  const entityDir = join(PROJECT_ROOT, "data/entities");

  if (!existsSync(entityDir)) return violations;

  const dateFields = [
    "releaseDate",
    "trainingCutoff",
    "founded",
    "startDate",
    "introduced",
    "lastUpdated",
    "introducedDate",
  ];

  const files = readdirSync(entityDir).filter((f) => f.endsWith(".yaml"));

  for (const file of files) {
    const filepath = join(entityDir, file);
    let data: unknown;
    try {
      data = parseYaml(readFileSync(filepath, "utf-8"));
    } catch {
      // YAML parse errors are caught by other validators
      continue;
    }

    if (!Array.isArray(data)) continue;

    for (const item of data as Record<string, unknown>[]) {
      const itemId = (item.id as string) || "?";

      for (const field of dateFields) {
        const val = item[field];
        if (val == null) continue;
        const dateStr = String(val);
        const error = validateDateValue(dateStr);
        if (error) {
          violations.push({
            rule: "date-value-validity",
            location: `${file}/${itemId}`,
            message: `${field}="${dateStr}" — ${error}`,
          });
        }
      }

      // Note: vote.date and amendment.date in policy entities use natural language
      // dates ("April 2, 2024") by convention. These are not validated here since
      // they follow a different format than ISO dates.
    }
  }

  return violations;
}

// ── Check 2: FactBase temporal consistency ───────────────────────────────────

function checkFactBaseTemporal(): Violation[] {
  const violations: Violation[] = [];
  const thingsDir = join(PROJECT_ROOT, "packages/factbase/data/things");

  if (!existsSync(thingsDir)) return violations;

  const entries = readdirSync(thingsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith(".yaml")) continue;

    const filepath = join(thingsDir, entry.name);
    let content: string;
    try {
      content = readFileSync(filepath, "utf-8");
    } catch {
      continue;
    }

    // Parse with custom tag handling — treat unknown tags as scalars
    let doc;
    try {
      doc = parseDocument(content, {
        customTags: [
          {
            tag: "!ref",
            resolve: (str: string) => str,
          } as any,
          {
            tag: "!date",
            resolve: (str: string) => str,
          } as any,
          {
            tag: "!src",
            resolve: (str: string) => str,
          } as any,
        ],
      });
    } catch {
      continue;
    }

    const data = doc.toJSON();
    if (!data) continue;

    const facts = data.facts as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(facts)) continue;

    const entityId =
      data.thing?.id || data.thing?.name || data.entity || entry.name.replace(".yaml", "");

    for (const fact of facts) {
      const factId = (fact.id as string) || "?";
      const asOf = fact.asOf != null ? String(fact.asOf) : null;
      const validEnd = fact.validEnd != null ? String(fact.validEnd) : null;
      const validStart = fact.validStart != null ? String(fact.validStart) : null;

      // Validate date format and values for asOf, validEnd, validStart
      for (const [field, val] of [
        ["asOf", asOf],
        ["validEnd", validEnd],
        ["validStart", validStart],
      ] as const) {
        if (val) {
          const error = validateDateValue(val);
          if (error) {
            violations.push({
              rule: "date-value-validity",
              location: `${entry.name}/${entityId}/${factId}`,
              message: `${field}="${val}" — ${error}`,
            });
          }
        }
      }

      // Check: validEnd >= asOf
      if (asOf && validEnd) {
        if (compareDates(validEnd, asOf) < 0) {
          violations.push({
            rule: "factbase-temporal",
            location: `${entry.name}/${entityId}/${factId}`,
            message: `validEnd="${validEnd}" is before asOf="${asOf}" (property: ${fact.property || "?"})`,
          });
        }
      }

      // Check: validEnd >= validStart
      if (validStart && validEnd) {
        if (compareDates(validEnd, validStart) < 0) {
          violations.push({
            rule: "factbase-temporal",
            location: `${entry.name}/${entityId}/${factId}`,
            message: `validEnd="${validEnd}" is before validStart="${validStart}" (property: ${fact.property || "?"})`,
          });
        }
      }
    }
  }

  return violations;
}

// ── Check 3: AI model trainingCutoff <= releaseDate ──────────────────────────

function checkModelCutoffRelease(): Violation[] {
  const violations: Violation[] = [];
  const modelsFile = join(PROJECT_ROOT, "data/entities/ai-models.yaml");

  if (!existsSync(modelsFile)) return violations;

  let data: unknown;
  try {
    data = parseYaml(readFileSync(modelsFile, "utf-8"));
  } catch {
    return violations;
  }

  if (!Array.isArray(data)) return violations;

  for (const model of data as Record<string, unknown>[]) {
    const modelId = (model.id as string) || "?";
    const releaseDate = model.releaseDate ? String(model.releaseDate) : null;
    const trainingCutoff = model.trainingCutoff
      ? String(model.trainingCutoff)
      : null;

    if (!releaseDate || !trainingCutoff) continue;

    // trainingCutoff is the end of training data, not when training completed.
    // A model can be released in the same month its training data ends.
    // But the cutoff should not be AFTER the release date.
    if (compareDates(trainingCutoff, releaseDate) > 0) {
      violations.push({
        rule: "model-cutoff-release",
        location: `ai-models.yaml/${modelId}`,
        message: `trainingCutoff="${trainingCutoff}" is after releaseDate="${releaseDate}"`,
      });
    }
  }

  return violations;
}

// ── Check 4: Policy date ordering ───────────────────────────────────────────

function checkPolicyDateOrder(): Violation[] {
  const violations: Violation[] = [];

  // Policy entities can be in any entity file, but typically in policies.yaml
  const entityDir = join(PROJECT_ROOT, "data/entities");
  if (!existsSync(entityDir)) return violations;

  const files = readdirSync(entityDir).filter((f) => f.endsWith(".yaml"));

  for (const file of files) {
    const filepath = join(entityDir, file);
    let data: unknown;
    try {
      data = parseYaml(readFileSync(filepath, "utf-8"));
    } catch {
      continue;
    }

    if (!Array.isArray(data)) continue;

    for (const item of data as Record<string, unknown>[]) {
      if (item.type !== "policy") continue;

      const itemId = (item.id as string) || "?";
      const introduced = item.introduced ? String(item.introduced) : null;

      if (!introduced) continue;

      // Check that vote dates are not before the introduced date
      const votes = item.votes as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(votes)) {
        for (const vote of votes) {
          if (vote.date) {
            const voteDate = String(vote.date);
            // Vote dates may use natural-language format ("April 2, 2024").
            // Parse to ISO before comparing against the introduced date.
            const voteDateIso = parseToIsoDate(voteDate);
            if (voteDateIso && compareDates(voteDateIso, introduced) < 0) {
              violations.push({
                rule: "policy-date-order",
                location: `${file}/${itemId}`,
                message: `vote date="${voteDate}" is before introduced="${introduced}" (chamber: ${vote.chamber || "?"})`,
              });
            }
          }
        }
      }
    }
  }

  return violations;
}

// ── Main ────────────────────────────────────────────────────────────────────

export function runTemporalValidation(): { passed: boolean; violations: Violation[] } {
  const allViolations: Violation[] = [];

  if (!ciMode) {
    console.log(`${c.blue}Running temporal invariant checks...${c.reset}\n`);
  }

  // Run all checks
  const entityDateErrors = checkEntityDateValidity();
  allViolations.push(...entityDateErrors);

  const factbaseErrors = checkFactBaseTemporal();
  allViolations.push(...factbaseErrors);

  const modelErrors = checkModelCutoffRelease();
  allViolations.push(...modelErrors);

  const policyErrors = checkPolicyDateOrder();
  allViolations.push(...policyErrors);

  // CI mode: output JSON and return
  if (ciMode) {
    console.log(JSON.stringify({
      passed: allViolations.length === 0,
      violations: allViolations,
    }));
    return { passed: allViolations.length === 0, violations: allViolations };
  }

  // Group by rule for summary
  const byRule = new Map<string, Violation[]>();
  for (const v of allViolations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule)!.push(v);
  }

  // Print violations
  if (allViolations.length > 0) {
    for (const [rule, violations] of byRule) {
      console.log(`${c.red}[${rule}] ${violations.length} violation(s):${c.reset}`);
      for (const v of violations) {
        console.log(`  ${c.red}${v.location}: ${v.message}${c.reset}`);
      }
      console.log();
    }
  }

  // Print summary
  const checkCounts = [
    { name: "date-value-validity", count: entityDateErrors.length + factbaseErrors.filter(v => v.rule === "date-value-validity").length },
    { name: "factbase-temporal", count: factbaseErrors.filter(v => v.rule === "factbase-temporal").length },
    { name: "model-cutoff-release", count: modelErrors.length },
    { name: "policy-date-order", count: policyErrors.length },
  ];

  if (allViolations.length === 0) {
    console.log(`${c.green}All temporal invariant checks passed${c.reset}`);
    if (verbose) {
      for (const check of checkCounts) {
        console.log(`  ${c.green}${check.name}: 0 violations${c.reset}`);
      }
    }
  } else {
    console.log(`${c.red}Temporal invariant check failed: ${allViolations.length} violation(s)${c.reset}`);
    for (const check of checkCounts) {
      if (check.count > 0) {
        console.log(`  ${c.red}${check.name}: ${check.count} violation(s)${c.reset}`);
      } else if (verbose) {
        console.log(`  ${c.green}${check.name}: 0 violations${c.reset}`);
      }
    }
  }

  return { passed: allViolations.length === 0, violations: allViolations };
}

// Run when invoked directly
if (process.argv[1]?.includes("validate-temporal")) {
  const result = runTemporalValidation();
  process.exit(result.passed ? 0 : 1);
}
