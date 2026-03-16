#!/usr/bin/env node

/**
 * Cross-Entity Consistency Validator
 *
 * Checks for data mismatches between related entities, catching cases where
 * one side of a relationship is recorded but the other isn't:
 *
 *   1. Person <-> Organization: If a person's affiliationId points to Org X,
 *      does Org X's relatedEntries include that person?
 *   2. AI Model <-> Organization: If a model's developer is Org X, does
 *      Org X's relatedEntries include that model?
 *   3. relatedEntries bidirectionality: If Entity A lists Entity B as related,
 *      does B also reference A?
 *   4. Person <-> relatedEntries coherence: If Person A lists Org B in
 *      relatedEntries, does the affiliation field agree?
 *   5. Project <-> Organization: If a project's organization field points to
 *      Org X, does Org X reference that project?
 *
 * Usage:
 *   npx tsx crux/validate/cross-entity-consistency.ts              # human-readable
 *   npx tsx crux/validate/cross-entity-consistency.ts --ci          # JSON output
 *   npx tsx crux/validate/cross-entity-consistency.ts --verbose     # show all issues
 *   npx tsx crux/validate/cross-entity-consistency.ts --type=person # check one type
 *
 * Exit codes:
 *   0 = No issues (or only info-level items)
 *   1 = Warnings or errors found
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { PROJECT_ROOT, ensureDataLayer } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = "error" | "warning" | "info";

interface Mismatch {
  /** Category of the check */
  checkType:
    | "person-org"
    | "model-org"
    | "bidirectional-related"
    | "person-affiliation-coherence"
    | "project-org";
  severity: Severity;
  /** The entity where the reference originates */
  sourceId: string;
  sourceTitle: string;
  sourceType: string;
  /** The entity that should reciprocate */
  targetId: string;
  targetTitle: string;
  targetType: string;
  /** Human-readable description */
  description: string;
  /** Actionable fix suggestion */
  suggestion: string;
}

interface TypedEntity {
  id: string;
  title: string;
  entityType: string;
  affiliation?: string;
  affiliationId?: string;
  developer?: string;
  organization?: string;
  relatedEntries?: Array<{ id: string; type?: string; relationship?: string }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entityLabel(e: TypedEntity): string {
  return `${e.title} (${e.id})`;
}

// ---------------------------------------------------------------------------
// Check functions
// ---------------------------------------------------------------------------

/**
 * Check 1: Person -> Organization
 * If a person's affiliationId points to an org, the org should reference
 * the person in its relatedEntries.
 */
function checkPersonOrg(
  people: TypedEntity[],
  entityById: Map<string, TypedEntity>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];

  for (const person of people) {
    const orgId = person.affiliationId;
    if (!orgId) continue;

    const org = entityById.get(orgId);
    if (!org) continue; // orphaned ref — handled by entity-refs validator

    const orgRefsPerson = (org.relatedEntries || []).some(
      (r) => r.id === person.id,
    );

    if (!orgRefsPerson) {
      mismatches.push({
        checkType: "person-org",
        severity: "warning",
        sourceId: person.id,
        sourceTitle: person.title,
        sourceType: "person",
        targetId: org.id,
        targetTitle: org.title,
        targetType: "organization",
        description: `${entityLabel(person)} lists affiliation "${org.title}", but ${entityLabel(org)} does not reference this person in relatedEntries`,
        suggestion: `Add { id: "${person.id}", type: "person" } to ${org.id}'s relatedEntries`,
      });
    }
  }

  return mismatches;
}

/**
 * Check 2: AI Model -> Organization
 * If a model's developer field points to an org, the org should reference
 * the model in its relatedEntries.
 */
function checkModelOrg(
  models: TypedEntity[],
  entityById: Map<string, TypedEntity>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];

  for (const model of models) {
    const devId = model.developer;
    if (!devId) continue;

    const org = entityById.get(devId);
    if (!org) continue; // orphaned ref

    const orgRefsModel = (org.relatedEntries || []).some(
      (r) => r.id === model.id,
    );

    if (!orgRefsModel) {
      mismatches.push({
        checkType: "model-org",
        severity: "info",
        sourceId: model.id,
        sourceTitle: model.title,
        sourceType: "ai-model",
        targetId: org.id,
        targetTitle: org.title,
        targetType: "organization",
        description: `${entityLabel(model)} lists developer "${org.title}", but ${entityLabel(org)} does not reference this model in relatedEntries`,
        suggestion: `Add { id: "${model.id}", type: "ai-model" } to ${org.id}'s relatedEntries`,
      });
    }
  }

  return mismatches;
}

/**
 * Check 3: Bidirectional relatedEntries
 * If Entity A lists Entity B in relatedEntries, B should also list A.
 *
 * Severity rules:
 *   - "warning" only for same-type entities that both have relatedEntries
 *     populated (e.g., org <-> org, person <-> person) — these are peers
 *     that should acknowledge each other.
 *   - "info" for cross-type references (e.g., model -> org) and structural
 *     relationships (composed-of, part-of, created-by) — these are often
 *     intentionally one-directional.
 *   - Skipped entirely when the target entity has no relatedEntries at all
 *     (it simply doesn't use the field).
 */
function checkBidirectionalRelated(
  entities: TypedEntity[],
  entityById: Map<string, TypedEntity>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];

  // Build set of entities that have any relatedEntries
  const hasRelated = new Set<string>();
  for (const e of entities) {
    if (e.relatedEntries && e.relatedEntries.length > 0) {
      hasRelated.add(e.id);
    }
  }

  // Structural relationships that are inherently one-directional
  const STRUCTURAL_RELS = new Set([
    "composed-of",
    "part-of",
    "created-by",
    "leads-to",
    "research",
    "addresses",
    "analyzes",
    "mechanism",
    "consequence",
    "outcome",
    "prerequisite",
    "manifestation",
    "contributes-to",
    "component",
    "scenario",
    "cause",
    "shaped-by",
    "affects",
    "mitigation",
    "example",
    "vulnerable-technique",
  ]);

  for (const a of entities) {
    for (const rel of a.relatedEntries || []) {
      const b = entityById.get(rel.id);
      if (!b) continue; // orphaned — handled elsewhere

      // Skip if B has no relatedEntries at all
      if (!hasRelated.has(b.id)) continue;

      // Skip self-references
      if (a.id === b.id) continue;

      const bRefsA = (b.relatedEntries || []).some((r) => r.id === a.id);

      if (!bRefsA) {
        const relationship = rel.relationship || "";
        const isStructural = STRUCTURAL_RELS.has(relationship);
        const isSameType = a.entityType === b.entityType;

        // Only warn for same-type, non-structural, explicit "related" or
        // unlabeled references between entities that both use relatedEntries.
        const severity: Severity =
          !isStructural && isSameType ? "warning" : "info";

        mismatches.push({
          checkType: "bidirectional-related",
          severity,
          sourceId: a.id,
          sourceTitle: a.title,
          sourceType: a.entityType,
          targetId: b.id,
          targetTitle: b.title,
          targetType: b.entityType,
          description: `${entityLabel(a)} references ${entityLabel(b)} [${relationship || "related"}], but ${b.id} does not reference ${a.id} back`,
          suggestion: `Add { id: "${a.id}", type: "${a.entityType}" } to ${b.id}'s relatedEntries`,
        });
      }
    }
  }

  return mismatches;
}

/**
 * Check 4: Person affiliation coherence
 * If a person has relatedEntries pointing to an organization, their
 * affiliationId should match (or vice versa).
 */
function checkPersonAffiliationCoherence(
  people: TypedEntity[],
  entityById: Map<string, TypedEntity>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];

  for (const person of people) {
    const affiliationId = person.affiliationId;
    if (!affiliationId) continue;

    // Find org-type relatedEntries that don't match the affiliation
    const orgRels = (person.relatedEntries || []).filter(
      (r) => r.type === "organization" && r.id !== affiliationId,
    );

    // Check if the affiliationId org is NOT in relatedEntries
    // (inconsistency: affiliation says X but relatedEntries doesn't mention X)
    const affiliationInRelated = (person.relatedEntries || []).some(
      (r) => r.id === affiliationId,
    );

    if (
      !affiliationInRelated &&
      person.relatedEntries &&
      person.relatedEntries.length > 0
    ) {
      const org = entityById.get(affiliationId);
      if (org) {
        mismatches.push({
          checkType: "person-affiliation-coherence",
          severity: "info",
          sourceId: person.id,
          sourceTitle: person.title,
          sourceType: "person",
          targetId: org.id,
          targetTitle: org.title,
          targetType: "organization",
          description: `${entityLabel(person)} has affiliationId="${affiliationId}" but does not include this org in relatedEntries`,
          suggestion: `Add { id: "${affiliationId}", type: "organization" } to ${person.id}'s relatedEntries`,
        });
      }
    }
  }

  return mismatches;
}

/**
 * Check 5: Project -> Organization
 * If a project's organization field points to an org, the org should
 * reference that project in its relatedEntries.
 */
function checkProjectOrg(
  projects: TypedEntity[],
  entityById: Map<string, TypedEntity>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];

  for (const project of projects) {
    const orgSlug = project.organization as string | undefined;
    if (!orgSlug) continue;

    const org = entityById.get(orgSlug);
    if (!org) continue; // orphaned ref

    const orgRefsProject = (org.relatedEntries || []).some(
      (r) => r.id === project.id,
    );

    if (!orgRefsProject) {
      mismatches.push({
        checkType: "project-org",
        severity: "info",
        sourceId: project.id,
        sourceTitle: project.title,
        sourceType: "project",
        targetId: org.id,
        targetTitle: org.title,
        targetType: "organization",
        description: `${entityLabel(project)} lists organization "${org.title}", but ${entityLabel(org)} does not reference this project in relatedEntries`,
        suggestion: `Add { id: "${project.id}", type: "project" } to ${org.id}'s relatedEntries`,
      });
    }
  }

  return mismatches;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");
  const c = getColors(ci);

  const typeArg = process.argv.find((a) => a.startsWith("--type="));
  const filterType = typeArg ? typeArg.split("=")[1] : null;

  ensureDataLayer();

  const dbPath = join(PROJECT_ROOT, "apps/web/src/data/database.json");
  if (!existsSync(dbPath)) {
    console.error(
      c.red + "database.json not found. Run: pnpm build-data" + c.reset,
    );
    process.exit(1);
  }

  const db = JSON.parse(readFileSync(dbPath, "utf-8"));
  const typedEntities: TypedEntity[] = db.typedEntities || [];

  if (typedEntities.length === 0) {
    console.error(c.red + "No typedEntities in database.json." + c.reset);
    process.exit(1);
  }

  const entityById = new Map<string, TypedEntity>();
  for (const e of typedEntities) {
    entityById.set(e.id, e);
  }

  const people = typedEntities.filter((e) => e.entityType === "person");
  const models = typedEntities.filter((e) => e.entityType === "ai-model");
  const projects = typedEntities.filter((e) => e.entityType === "project");

  // Run all checks (filter by type if requested)
  const allMismatches: Mismatch[] = [];

  if (!filterType || filterType === "person" || filterType === "person-org") {
    allMismatches.push(...checkPersonOrg(people, entityById));
  }
  if (!filterType || filterType === "ai-model" || filterType === "model-org") {
    allMismatches.push(...checkModelOrg(models, entityById));
  }
  if (
    !filterType ||
    filterType === "bidirectional" ||
    filterType === "related"
  ) {
    allMismatches.push(...checkBidirectionalRelated(typedEntities, entityById));
  }
  if (!filterType || filterType === "person" || filterType === "coherence") {
    allMismatches.push(
      ...checkPersonAffiliationCoherence(people, entityById),
    );
  }
  if (
    !filterType ||
    filterType === "project" ||
    filterType === "project-org"
  ) {
    allMismatches.push(...checkProjectOrg(projects, entityById));
  }

  // Compute stats
  const byCheckType = new Map<string, Mismatch[]>();
  for (const m of allMismatches) {
    if (!byCheckType.has(m.checkType)) byCheckType.set(m.checkType, []);
    byCheckType.get(m.checkType)!.push(m);
  }

  const errorCount = allMismatches.filter((m) => m.severity === "error").length;
  const warningCount = allMismatches.filter(
    (m) => m.severity === "warning",
  ).length;
  const infoCount = allMismatches.filter((m) => m.severity === "info").length;

  // ── CI JSON output ──────────────────────────────────────────────
  if (ci) {
    const summary = {
      passed: warningCount === 0 && errorCount === 0,
      totalEntities: typedEntities.length,
      people: people.length,
      models: models.length,
      projects: projects.length,
      totalMismatches: allMismatches.length,
      errors: errorCount,
      warnings: warningCount,
      infos: infoCount,
      byCheckType: Object.fromEntries(
        [...byCheckType.entries()].map(([type, items]) => [
          type,
          {
            count: items.length,
            errors: items.filter((m) => m.severity === "error").length,
            warnings: items.filter((m) => m.severity === "warning").length,
            infos: items.filter((m) => m.severity === "info").length,
          },
        ]),
      ),
      mismatches: allMismatches,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(errorCount > 0 || warningCount > 0 ? 1 : 0);
    return;
  }

  // ── Human-readable output ───────────────────────────────────────
  console.log(
    "\n" +
      c.bold +
      c.blue +
      "Cross-Entity Consistency Check" +
      c.reset +
      "\n",
  );
  console.log(
    c.dim +
      `Scanning ${typedEntities.length} entities (${people.length} people, ${models.length} models, ${projects.length} projects)` +
      c.reset +
      "\n",
  );

  // Summary table
  const CHECK_LABELS: Record<string, string> = {
    "person-org": "Person -> Org (affiliation not reciprocated)",
    "model-org": "Model -> Org (developer not reciprocated)",
    "bidirectional-related": "Bidirectional relatedEntries",
    "person-affiliation-coherence": "Person affiliation coherence",
    "project-org": "Project -> Org (not reciprocated)",
  };

  console.log(c.bold + "Summary by Check Type" + c.reset + "\n");

  const headerLine =
    "Check".padEnd(50) +
    "Warn".padStart(6) +
    "Info".padStart(6) +
    "Total".padStart(7);
  console.log(headerLine);
  console.log("-".repeat(headerLine.length));

  for (const [checkType, label] of Object.entries(CHECK_LABELS)) {
    const items = byCheckType.get(checkType) || [];
    const w = items.filter((m) => m.severity === "warning").length;
    const i = items.filter((m) => m.severity === "info").length;

    const fmtW =
      w > 0 ? c.yellow + w.toString().padStart(6) + c.reset : c.dim + "0".padStart(6) + c.reset;
    const fmtI =
      i > 0 ? c.blue + i.toString().padStart(6) + c.reset : c.dim + "0".padStart(6) + c.reset;

    console.log(
      label.padEnd(50) + fmtW + fmtI + items.length.toString().padStart(7),
    );
  }

  console.log(
    "-".repeat(headerLine.length),
  );
  console.log(
    "TOTAL".padEnd(50) +
      (warningCount > 0
        ? c.yellow + warningCount.toString().padStart(6) + c.reset
        : c.dim + "0".padStart(6) + c.reset) +
      (infoCount > 0
        ? c.blue + infoCount.toString().padStart(6) + c.reset
        : c.dim + "0".padStart(6) + c.reset) +
      allMismatches.length.toString().padStart(7),
  );

  // Detailed issues grouped by check type
  if (allMismatches.length > 0) {
    for (const [checkType, label] of Object.entries(CHECK_LABELS)) {
      const items = byCheckType.get(checkType) || [];
      if (items.length === 0) continue;

      // Separate by severity
      const warnings = items.filter((m) => m.severity === "warning");
      const infos = items.filter((m) => m.severity === "info");

      console.log(
        "\n" + c.bold + label + c.reset + ` (${items.length} issues)`,
      );

      // Show warnings first
      const warningsToShow = verbose ? warnings : warnings.slice(0, 10);
      for (const m of warningsToShow) {
        console.log(
          `  ${c.yellow}!${c.reset} ${m.description}`,
        );
        console.log(
          `    ${c.dim}Fix: ${m.suggestion}${c.reset}`,
        );
      }
      if (!verbose && warnings.length > 10) {
        console.log(
          `  ${c.dim}... and ${warnings.length - 10} more warnings (use --verbose)${c.reset}`,
        );
      }

      // Show infos (fewer by default)
      const infosToShow = verbose ? infos : infos.slice(0, 5);
      for (const m of infosToShow) {
        console.log(
          `  ${c.blue}i${c.reset} ${c.dim}${m.description}${c.reset}`,
        );
      }
      if (!verbose && infos.length > 5) {
        console.log(
          `  ${c.dim}... and ${infos.length - 5} more info items (use --verbose)${c.reset}`,
        );
      }
    }
  }

  // Final summary line
  console.log("\n" + "-".repeat(50));
  if (allMismatches.length === 0) {
    console.log(
      c.green +
        "No cross-entity consistency issues found." +
        c.reset,
    );
  } else {
    const parts: string[] = [];
    if (warningCount > 0) parts.push(c.yellow + warningCount + " warning(s)" + c.reset);
    if (infoCount > 0) parts.push(c.blue + infoCount + " info(s)" + c.reset);
    console.log(
      `Found ${allMismatches.length} mismatches: ${parts.join(", ")}`,
    );
    if (warningCount > 0) {
      console.log(
        c.dim +
          "Warnings indicate missing reciprocal references that should be added." +
          c.reset,
      );
    }
    if (infoCount > 0) {
      console.log(
        c.dim +
          "Info items are structural (one-way relationships) or low-priority." +
          c.reset,
      );
    }
  }
  console.log("");

  process.exit(errorCount > 0 || warningCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Cross-entity consistency check crashed:", err);
  process.exit(1);
});
