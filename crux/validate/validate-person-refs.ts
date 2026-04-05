#!/usr/bin/env node

/**
 * Person Reference Validation — checks that FactBase facts referencing people
 * use proper `!ref` entity references and that those references resolve to
 * entities with displayable names.
 *
 * Person-referencing properties (founded-by, key-person, employed-by, etc.)
 * should always use `!ref sid_XYZ` values, not raw text strings like
 * "John Smith". Text-based person values:
 *   - Don't link to entity pages
 *   - Break name resolution when the UI tries to display them
 *   - Bypass entity registry validation (validate-kb-entity-slugs.ts)
 *
 * This validator catches:
 *   1. !ref targets that don't resolve to entity registry entries (ERROR)
 *   2. !ref targets that resolve but have no displayable name (ERROR)
 *   3. Text-based person values in person-referencing properties (WARNING)
 *
 * Uses regex-based YAML scanning (like validate-kb-entity-slugs.ts) to avoid
 * issues with custom !ref and !date YAML tag parsing.
 *
 * Reads local files only (YAML + entity registry). No wiki-server dependency.
 *
 * Usage:
 *   npx tsx crux/validate/validate-person-refs.ts
 *   npx tsx crux/validate/validate-person-refs.ts --verbose
 *   npx tsx crux/validate/validate-person-refs.ts --ci
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";
import { isSid } from "../../packages/id-utils/src/index.ts";
import { loadEntityRegistry } from "./validate-kb-entity-slugs.ts";

// ---------------------------------------------------------------------------
// Config: which FactBase properties reference people
// ---------------------------------------------------------------------------

/**
 * FactBase property IDs that reference person entities via `!ref`.
 * When these properties use text values instead of refs, it's a data quality issue.
 */
const PERSON_PROPERTIES = new Set([
  "founded-by",
  "key-person",
  "employed-by",
  "board-member",
  "advisory-board-member",
  "co-founder",
  "ceo",
  "cto",
  "chief-scientist",
  "director",
  "lead-researcher",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonRefIssue {
  sourceFile: string;
  factId: string;
  propertyId: string;
  value: string;
  kind: "text-person-ref" | "unresolved-ref" | "no-displayable-name";
  reason: string;
}

export interface ValidationResult {
  passed: boolean;
  errors: PersonRefIssue[];
  warnings: PersonRefIssue[];
  stats: {
    totalFactbaseFiles: number;
    totalPersonFacts: number;
    totalRefValues: number;
    totalTextValues: number;
  };
}

// ---------------------------------------------------------------------------
// Entity name lookup
// ---------------------------------------------------------------------------

interface EntityNameLookup {
  hasEntity: (stableId: string) => boolean;
  getName: (stableId: string) => string | null;
}

function buildNameLookup(entitiesDir: string): EntityNameLookup {
  const registry = loadEntityRegistry(entitiesDir);
  const nameMap = new Map<string, string>();

  let files: string[];
  try {
    files = readdirSync(entitiesDir).filter(
      (f) => extname(f) === ".yaml" || extname(f) === ".yml",
    );
  } catch {
    return { hasEntity: () => false, getName: () => null };
  }

  // Use a simple regex-based approach to avoid YAML tag issues.
  // Entity YAML files are arrays of objects at 2-space indent. Match
  // stableId/title at exactly that indent to avoid nested false positives.
  for (const file of files) {
    const content = readFileSync(join(entitiesDir, file), "utf-8");

    // Parse blocks: each entity starts with "- id:" at column 0
    const blocks = content.split(/^- /m).slice(1);
    for (const block of blocks) {
      // Match at 2-space indent (top-level entity fields, not nested)
      const sidMatch = block.match(/^ {0,2}stableId:\s*(\S+)/m);
      const titleMatch = block.match(/^ {0,2}title:\s*(.+)/m);
      if (sidMatch && titleMatch) {
        const sid = sidMatch[1].replace(/^["']|["']$/g, "");
        const title = titleMatch[1].trim().replace(/^["']|["']$/g, "");
        nameMap.set(sid, title);
      }
    }
  }

  return {
    hasEntity: (sid) => registry.stableIds.has(sid),
    getName: (sid) => nameMap.get(sid) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Regex-based YAML scanning
// ---------------------------------------------------------------------------

interface FactBlock {
  factId: string;
  propertyId: string;
  /** Whether the value uses !ref syntax */
  hasRef: boolean;
  /** The ref stableIds (from !ref) */
  refIds: string[];
  /** The raw text value (when not using !ref) */
  textValue: string | null;
}

/**
 * Extract person-referencing facts from a FactBase YAML file using regex.
 * Handles both `!ref sid_XYZ` and plain text values.
 */
function extractPersonFacts(content: string): FactBlock[] {
  const facts: FactBlock[] = [];

  // Split into fact blocks (each starts with "  - id:" or similar)
  const factBlockRegex = /^\s+-\s+id:\s*(\S+)/gm;
  const matches: Array<{ id: string; start: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = factBlockRegex.exec(content)) !== null) {
    matches.push({ id: match[1], start: match.index });
  }

  for (let i = 0; i < matches.length; i++) {
    const blockStart = matches[i].start;
    const blockEnd = i + 1 < matches.length ? matches[i + 1].start : content.length;
    const block = content.slice(blockStart, blockEnd);
    const factId = matches[i].id;

    // Extract property
    const propMatch = block.match(/property:\s*(\S+)/);
    if (!propMatch) continue;
    const propertyId = propMatch[1];

    if (!PERSON_PROPERTIES.has(propertyId)) continue;

    // Check for !ref values
    const refMatches = [...block.matchAll(/!ref\s+(sid_[A-Za-z0-9]{10})/g)];

    if (refMatches.length > 0) {
      facts.push({
        factId,
        propertyId,
        hasRef: true,
        refIds: refMatches.map((m) => m[1]),
        textValue: null,
      });
    } else {
      // Extract text value (the line(s) after "value:")
      const valueMatch = block.match(/value:\s*(?:"([^"]+)"|'([^']+)'|([^\n]+))/);
      if (valueMatch) {
        const textValue = (valueMatch[1] || valueMatch[2] || valueMatch[3] || "").trim();
        // Skip !ref and !date tagged values that regex didn't catch
        if (textValue.startsWith("!ref") || textValue.startsWith("!date")) continue;
        // Skip URL values and very long text (not person names)
        if (textValue.startsWith("http") || textValue.length > 200) continue;
        // Skip empty values
        if (!textValue) continue;

        facts.push({
          factId,
          propertyId,
          hasRef: false,
          refIds: [],
          textValue,
        });
      }
    }
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

export function validatePersonRefs(
  thingsDir: string,
  entitiesDir: string,
): ValidationResult {
  const nameLookup = buildNameLookup(entitiesDir);
  const errors: PersonRefIssue[] = [];
  const warnings: PersonRefIssue[] = [];
  let totalFactbaseFiles = 0;
  let totalPersonFacts = 0;
  let totalRefValues = 0;
  let totalTextValues = 0;

  let entries: string[];
  try {
    entries = readdirSync(thingsDir);
  } catch {
    return {
      passed: true,
      errors: [],
      warnings: [],
      stats: { totalFactbaseFiles: 0, totalPersonFacts: 0, totalRefValues: 0, totalTextValues: 0 },
    };
  }

  const yamlFiles = entries.filter(
    (e) => extname(e) === ".yaml" || extname(e) === ".yml",
  );

  for (const filename of yamlFiles) {
    const filePath = join(thingsDir, filename);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const personFacts = extractPersonFacts(content);
    if (personFacts.length === 0) continue;
    totalFactbaseFiles++;

    for (const fact of personFacts) {
      totalPersonFacts++;

      if (fact.hasRef) {
        // Check each ref target
        for (const refId of fact.refIds) {
          totalRefValues++;

          if (!nameLookup.hasEntity(refId)) {
            errors.push({
              sourceFile: filename,
              factId: fact.factId,
              propertyId: fact.propertyId,
              value: refId,
              kind: "unresolved-ref",
              reason: `Person ref "${refId}" not found in entity registry`,
            });
            continue;
          }

          const name = nameLookup.getName(refId);
          if (!name || isSid(name) || name.toLowerCase() === "unknown") {
            errors.push({
              sourceFile: filename,
              factId: fact.factId,
              propertyId: fact.propertyId,
              value: refId,
              kind: "no-displayable-name",
              reason: `Person ref "${refId}" resolves but has no displayable name (got: ${JSON.stringify(name)})`,
            });
          }
        }
      } else if (fact.textValue !== null) {
        totalTextValues++;
        warnings.push({
          sourceFile: filename,
          factId: fact.factId,
          propertyId: fact.propertyId,
          value: fact.textValue,
          kind: "text-person-ref",
          reason: `Person property "${fact.propertyId}" uses text value instead of !ref entity reference`,
        });
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    stats: { totalFactbaseFiles, totalPersonFacts, totalRefValues, totalTextValues },
  };
}

// ---------------------------------------------------------------------------
// Main (CLI)
// ---------------------------------------------------------------------------

function main(): void {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");
  const c = getColors(ci);

  const thingsDir = join(PROJECT_ROOT, "packages", "factbase", "data", "things");
  const entitiesDir = join(PROJECT_ROOT, "data", "entities");

  const result = validatePersonRefs(thingsDir, entitiesDir);

  if (ci) {
    console.log(
      JSON.stringify({
        passed: result.passed,
        errorCount: result.errors.length,
        warningCount: result.warnings.length,
        ...result.stats,
        errors: result.errors,
        warnings: verbose ? result.warnings : result.warnings.slice(0, 10),
      }),
    );
  } else {
    console.log(
      `\n${c.bold}${c.blue}Person Reference Validation${c.reset}\n`,
    );
    console.log(`FactBase files scanned: ${result.stats.totalFactbaseFiles}`);
    console.log(`Person-property facts: ${result.stats.totalPersonFacts}`);
    console.log(`  !ref values: ${result.stats.totalRefValues}`);
    console.log(`  Text values: ${result.stats.totalTextValues}`);

    if (result.errors.length > 0) {
      console.log(
        `\n${c.red}Unresolved person references (ERROR):${c.reset}`,
      );
      const toShow = verbose ? result.errors : result.errors.slice(0, 15);
      for (const err of toShow) {
        console.log(
          `  ${c.red}x${c.reset} ${err.sourceFile} / ${err.propertyId} = "${err.value}"`,
        );
        console.log(`    ${c.dim}${err.reason}${c.reset}`);
      }
      if (!verbose && result.errors.length > 15) {
        console.log(
          `  ${c.dim}... and ${result.errors.length - 15} more (use --verbose)${c.reset}`,
        );
      }
    }

    if (result.warnings.length > 0) {
      console.log(
        `\n${c.yellow}Text-based person values (should use !ref):${c.reset}`,
      );
      const toShow = verbose ? result.warnings : result.warnings.slice(0, 10);
      for (const warn of toShow) {
        console.log(
          `  ${c.yellow}~${c.reset} ${warn.sourceFile} / ${warn.propertyId} = "${warn.value}"`,
        );
      }
      if (!verbose && result.warnings.length > 10) {
        console.log(
          `  ${c.dim}... and ${result.warnings.length - 10} more (use --verbose)${c.reset}`,
        );
      }
    }

    console.log("");
    if (result.passed && result.warnings.length === 0) {
      console.log(
        `${c.green}All person references resolve to entities with displayable names.${c.reset}`,
      );
    } else if (result.passed) {
      console.log(
        `${c.green}All !ref person references resolve correctly.${c.reset} ` +
          `${c.yellow}${result.warnings.length} text-based person value(s) should be converted to !ref.${c.reset}`,
      );
    } else {
      console.log(
        `${c.red}${result.errors.length} person reference error(s) found.${c.reset}`,
      );
    }
  }

  if (!result.passed) {
    process.exit(1);
  }
}

if (process.argv[1]?.includes("validate-person-refs")) {
  try {
    main();
  } catch (err) {
    console.error("Person reference validation crashed:", err);
    process.exit(1);
  }
}
