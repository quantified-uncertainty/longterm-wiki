#!/usr/bin/env node

/**
 * Cross-Check People Roles
 *
 * Validates that person role titles are consistent across the two authoritative
 * data sources:
 *
 *   1. YAML entities (`data/entities/people.yaml`) — `customFields.Role`
 *   2. FactBase YAML (`packages/factbase/data/things/<slug>.yaml`) — `property: role` facts
 *
 * This catches the class of bugs where e.g. Sutskever shows "Chief Scientist"
 * in one place and "CEO" in another, or Leike has 3 different titles.
 *
 * Usage:
 *   npx tsx crux/validate/cross-check-people.ts              # human-readable
 *   npx tsx crux/validate/cross-check-people.ts --ci          # JSON output
 *   npx tsx crux/validate/cross-check-people.ts --verbose     # show all details
 *
 * Exit codes:
 *   0 = No mismatches (advisory — never blocks CI)
 *   1 = Mismatches found
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersonEntity {
  id: string;
  title: string;
  customFields?: Array<{ label: string; value: string }>;
}

interface FactBaseFact {
  id: string;
  property: string;
  value: string;
  asOf?: string;
  validEnd?: string;
  notes?: string;
}

interface FactBaseThing {
  thing: {
    id: string;
    type: string;
    name: string;
  };
  facts: FactBaseFact[];
}

export interface RoleMismatch {
  personId: string;
  personName: string;
  entityRole: string;
  factbaseRoles: string[];
  currentFactbaseRole: string | null;
  severity: "warning" | "info";
  description: string;
}

// ---------------------------------------------------------------------------
// Normalization helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Normalize a role string for comparison purposes.
 * Strips noise like "& ", extra whitespace, normalizes casing and delimiters.
 */
export function normalizeRole(role: string): string {
  return role
    .toLowerCase()
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s*;\s*/g, ", ")   // normalize semicolons to commas
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/\s*\(.*?\)\s*/g, " ") // strip parenthetical notes like "(until 2024)"
    .trim();
}

/**
 * Split a role string into individual role parts, splitting on comma, semicolon,
 * and " and " boundaries. Each part is normalized.
 */
export function splitRoleParts(role: string): string[] {
  const normalized = normalizeRole(role);
  return normalized
    .split(/,\s*|\s+and\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Extract the "core" tokens from a role for fuzzy matching.
 * Strips common prefixes like "Co-founder" and connecting words,
 * and also strips institutional suffixes for comparison.
 */
export function extractCoreTokens(role: string): Set<string> {
  const parts = splitRoleParts(role);
  const tokens = new Set<string>();
  for (const part of parts) {
    // Add full part
    tokens.add(part);

    // Strip "co-founder" / "founder" prefix
    const withoutFounder = part
      .replace(/^(co-)?founder\s*/i, "")
      .trim();
    if (withoutFounder.length > 0) {
      tokens.add(withoutFounder);
    }

    // Strip "of <Institution>" or ", <Institution>" suffix
    // e.g., "scientific director of mila" -> "scientific director"
    // e.g., "professor, universite de montreal" -> "professor"
    const withoutInstitution = part
      .replace(/\s+of\s+\w[\w\s]*/i, "")
      .replace(/,\s+\w[\w\s]*/i, "")
      .trim();
    if (withoutInstitution.length > 0 && withoutInstitution !== part) {
      tokens.add(withoutInstitution);
    }
  }
  return tokens;
}

/**
 * Extract "significant words" from a role — lowercase words that convey meaning,
 * excluding common noise words.
 */
function significantWords(role: string): Set<string> {
  const NOISE = new Set([
    "a", "an", "the", "of", "at", "in", "for", "and", "or", "to",
    "co", "former", "now", "until", "since",
  ]);
  const normalized = normalizeRole(role);
  const words = normalized.split(/[\s,;]+/).filter((w) => w.length > 1);
  return new Set(words.filter((w) => !NOISE.has(w)));
}

/**
 * Determine if two role strings are semantically similar enough to not warn.
 * Returns true if roles are considered "close enough" (just formatting differences).
 *
 * The matching is intentionally generous — we only want to flag cases where the
 * roles are clearly different titles (e.g., "CEO" vs "Chief Scientist").
 */
export function rolesAreSimilar(roleA: string, roleB: string): boolean {
  const normA = normalizeRole(roleA);
  const normB = normalizeRole(roleB);

  // Exact match after normalization
  if (normA === normB) return true;

  // One is a substring of the other (e.g., "CEO" vs "CEO and Co-founder")
  const shorter = normA.length <= normB.length ? normA : normB;
  const longer = normA.length <= normB.length ? normB : normA;
  if (longer.includes(shorter) && shorter.length >= 2) return true;

  // Split into role parts and check if the key parts match.
  // e.g., "Professor of CS, CHAI Founder" vs "Professor of CS, UC Berkeley; Founder of CHAI"
  // The core tokens ("professor", "founder") should overlap significantly.
  const tokensA = extractCoreTokens(roleA);
  const tokensB = extractCoreTokens(roleB);

  let overlapCount = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlapCount++;
  }
  const totalUnique = new Set([...tokensA, ...tokensB]).size;
  if (totalUnique > 0 && overlapCount / totalUnique >= 0.4) return true;

  // Significant word overlap: if 60%+ of the important words are shared,
  // the roles are likely describing the same position with formatting differences.
  // e.g., "Scientific Director of Mila, Professor" vs "Scientific Director, Mila; Professor, Universite de Montreal"
  const wordsA = significantWords(roleA);
  const wordsB = significantWords(roleB);
  let wordOverlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) wordOverlap++;
  }
  const minWords = Math.min(wordsA.size, wordsB.size);
  if (minWords >= 2 && wordOverlap / minWords >= 0.6) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Load people from data/entities/people.yaml
 */
export function loadPeopleEntities(projectRoot: string): PersonEntity[] {
  const peoplePath = join(projectRoot, "data/entities/people.yaml");
  if (!existsSync(peoplePath)) {
    throw new Error(`people.yaml not found at ${peoplePath}`);
  }
  const raw = readFileSync(peoplePath, "utf-8");
  const parsed = parseYaml(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("people.yaml does not contain an array");
  }
  return parsed as PersonEntity[];
}

/**
 * Load a FactBase thing file for a given slug.
 * Returns null if the file doesn't exist.
 */
export function loadFactBaseThing(
  projectRoot: string,
  slug: string,
): FactBaseThing | null {
  const thingPath = join(
    projectRoot,
    "packages/factbase/data/things",
    `${slug}.yaml`,
  );
  if (!existsSync(thingPath)) {
    return null;
  }
  const raw = readFileSync(thingPath, "utf-8");
  const parsed = parseYaml(raw);
  return parsed as FactBaseThing;
}

/**
 * Get the "current" role facts from a FactBase thing (no validEnd set).
 * Also returns all role facts for context.
 */
export function getFactBaseRoles(thing: FactBaseThing): {
  currentRoles: string[];
  allRoles: string[];
} {
  const roleFacts = (thing.facts || []).filter((f) => f.property === "role");
  const allRoles = roleFacts.map((f) => f.value);
  const currentRoles = roleFacts
    .filter((f) => !f.validEnd)
    .map((f) => f.value);
  return { currentRoles, allRoles };
}

/**
 * Get the Role value from a person entity's customFields.
 */
export function getEntityRole(person: PersonEntity): string | null {
  if (!person.customFields) return null;
  const roleField = person.customFields.find((f) => f.label === "Role");
  return roleField?.value ?? null;
}

// ---------------------------------------------------------------------------
// Core check logic
// ---------------------------------------------------------------------------

/**
 * Run the cross-check between YAML entities and FactBase for all people.
 */
export function crossCheckPeopleRoles(
  projectRoot: string,
): RoleMismatch[] {
  const people = loadPeopleEntities(projectRoot);
  const mismatches: RoleMismatch[] = [];

  for (const person of people) {
    const entityRole = getEntityRole(person);
    if (!entityRole) continue;

    const factbaseThing = loadFactBaseThing(projectRoot, person.id);
    if (!factbaseThing) continue; // No FactBase file — nothing to compare

    const { currentRoles, allRoles } = getFactBaseRoles(factbaseThing);

    if (currentRoles.length === 0) continue; // No current role in FactBase — nothing to compare

    // Check if any current FactBase role is similar to the entity role
    const hasSimilar = currentRoles.some((fbRole) =>
      rolesAreSimilar(entityRole, fbRole),
    );

    if (!hasSimilar) {
      // Determine severity: if there is a historical FactBase role that matches,
      // it's likely a staleness issue (info). Otherwise it's a real mismatch (warning).
      const historicalMatch = allRoles.some((fbRole) =>
        rolesAreSimilar(entityRole, fbRole),
      );

      const severity: "warning" | "info" = historicalMatch ? "info" : "warning";

      const currentFbDisplay = currentRoles.join(" / ");
      mismatches.push({
        personId: person.id,
        personName: person.title,
        entityRole,
        factbaseRoles: allRoles,
        currentFactbaseRole: currentFbDisplay,
        severity,
        description: historicalMatch
          ? `${person.title}: entity role "${entityRole}" matches a historical FactBase role but not the current one "${currentFbDisplay}" — likely stale`
          : `${person.title}: entity role "${entityRole}" differs from FactBase current role "${currentFbDisplay}"`,
      });
    }
  }

  return mismatches;
}

// ---------------------------------------------------------------------------
// Main CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");
  const c = getColors(ci);

  const mismatches = crossCheckPeopleRoles(PROJECT_ROOT);

  const warnings = mismatches.filter((m) => m.severity === "warning");
  const infos = mismatches.filter((m) => m.severity === "info");

  // ── CI JSON output ──────────────────────────────────────────────
  if (ci) {
    const summary = {
      passed: warnings.length === 0,
      totalMismatches: mismatches.length,
      warnings: warnings.length,
      infos: infos.length,
      mismatches,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(warnings.length > 0 ? 1 : 0);
    return;
  }

  // ── Human-readable output ───────────────────────────────────────
  console.log(
    "\n" +
      c.bold +
      c.blue +
      "People Role Cross-Check" +
      c.reset +
      "\n",
  );
  console.log(
    c.dim +
      "Comparing roles between data/entities/people.yaml and packages/factbase/data/things/*.yaml" +
      c.reset +
      "\n",
  );

  if (mismatches.length === 0) {
    console.log(
      c.green + "No role mismatches found between YAML entities and FactBase." + c.reset,
    );
    console.log("");
    process.exit(0);
    return;
  }

  // Show warnings first
  if (warnings.length > 0) {
    console.log(
      c.bold + c.yellow + `Warnings (${warnings.length})` + c.reset + "\n",
    );
    const toShow = verbose ? warnings : warnings.slice(0, 15);
    for (const m of toShow) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.bold}${m.personName}${c.reset} (${m.personId})`,
      );
      console.log(
        `    Entity role:   "${m.entityRole}"`,
      );
      console.log(
        `    FactBase role: "${m.currentFactbaseRole}"`,
      );
      console.log(
        `    ${c.dim}All FactBase roles: ${m.factbaseRoles.map((r) => `"${r}"`).join(", ")}${c.reset}`,
      );
      console.log("");
    }
    if (!verbose && warnings.length > 15) {
      console.log(
        `  ${c.dim}... and ${warnings.length - 15} more (use --verbose)${c.reset}\n`,
      );
    }
  }

  // Show infos
  if (infos.length > 0) {
    console.log(
      c.bold + c.blue + `Info — likely stale (${infos.length})` + c.reset + "\n",
    );
    const toShow = verbose ? infos : infos.slice(0, 10);
    for (const m of toShow) {
      console.log(
        `  ${c.blue}i${c.reset} ${c.dim}${m.personName}: entity="${m.entityRole}" factbase="${m.currentFactbaseRole}"${c.reset}`,
      );
    }
    if (!verbose && infos.length > 10) {
      console.log(
        `\n  ${c.dim}... and ${infos.length - 10} more (use --verbose)${c.reset}`,
      );
    }
    console.log("");
  }

  // Summary
  console.log("-".repeat(50));
  const parts: string[] = [];
  if (warnings.length > 0)
    parts.push(c.yellow + warnings.length + " warning(s)" + c.reset);
  if (infos.length > 0)
    parts.push(c.blue + infos.length + " info(s)" + c.reset);
  console.log(`Found ${mismatches.length} role mismatches: ${parts.join(", ")}`);
  console.log(
    c.dim +
      "This check is advisory — it does not block the gate." +
      c.reset,
  );
  console.log("");

  process.exit(warnings.length > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("People role cross-check crashed:", err);
    process.exit(1);
  });
}
