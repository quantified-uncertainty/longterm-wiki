/**
 * YAML Entity Reference Checker — core validation logic
 *
 * Scans YAML data files for fields that reference entity slugs and validates
 * that each referenced entity actually exists in the entity set.
 *
 * Targets the most impactful reference fields:
 *   - Entity YAML (data/entities/*.yaml):
 *     - relatedEntries[].id → entity slug
 *     - developer → org slug (ai-models)
 *     - organization → org slug (projects)
 *     - summaryPage → page slug (informational, not blocking)
 *     - parentOrg → org slug
 *     - keyPeople[] → person/expert slugs (organization entities)
 *     - stakeholders[].entityId → entity slug (policy responses)
 *     - keyPoliticians[].entityId → entity slug (policy responses)
 *   - data/experts.yaml:
 *     - affiliation → org/entity slug
 *
 * Related bugs this would have caught:
 *   - #2723: affiliation: forethought (no forethought entity)
 *   - #2677: 19 person stableIds with no people.yaml entries
 *   - #2672: 4 policy entity slugs not in any YAML
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DanglingRef {
  /** Source file path (relative to project root) */
  sourceFile: string;
  /** ID of the entity or record containing the dangling reference */
  sourceId: string;
  /** Human-readable title/name of the source */
  sourceTitle: string;
  /** The field name containing the reference */
  fieldName: string;
  /** The referenced slug that doesn't exist */
  refValue: string;
  /** Whether this is a blocking error or an informational warning */
  severity: "error" | "warning";
  /** What type of entity was expected */
  expectedType?: string;
}

export interface ValidationResult {
  /** All dangling references found */
  danglingRefs: DanglingRef[];
  /** Summary stats */
  stats: {
    totalEntities: number;
    totalRefsChecked: number;
    validRefs: number;
    danglingRefs: number;
    byFile: Record<string, { checked: number; dangling: number }>;
  };
}

interface ParsedEntity {
  id?: string;
  title?: string;
  type?: string;
  developer?: string;
  organization?: string;
  summaryPage?: string;
  parentOrg?: string;
  relatedEntries?: Array<{ id?: string; type?: string }>;
  stakeholders?: Array<{ entityId?: string; name?: string; [key: string]: unknown }>;
  keyPoliticians?: Array<{ entityId?: string; name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ParsedExpert {
  id?: string;
  name?: string;
  affiliation?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Entity index building
// ---------------------------------------------------------------------------

/**
 * Load all entity slugs (the `id` field) from entity YAML files.
 * Returns a set of all known entity slugs.
 */
export function loadEntitySlugs(entitiesDir: string): Set<string> {
  const slugs = new Set<string>();

  if (!existsSync(entitiesDir)) return slugs;

  const entries = readdirSync(entitiesDir);
  const yamlFiles = entries.filter(
    (e) => extname(e) === ".yaml" || extname(e) === ".yml"
  );

  for (const filename of yamlFiles) {
    const filePath = join(entitiesDir, filename);
    const content = readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch {
      // Skip unparseable files — schema validation will catch this
      continue;
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const entity of items) {
      if (entity && typeof entity === "object") {
        if (typeof entity.id === "string") slugs.add(entity.id);
        if (typeof entity.stableId === "string") slugs.add(entity.stableId);
      }
    }
  }

  return slugs;
}

/**
 * Load all expert slugs from data/experts.yaml.
 */
export function loadExpertSlugs(expertsPath: string): Set<string> {
  const slugs = new Set<string>();
  if (!existsSync(expertsPath)) return slugs;

  const content = readFileSync(expertsPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    // Skip unparseable file — schema validation will catch YAML syntax errors
    return slugs;
  }

  if (Array.isArray(parsed)) {
    for (const expert of parsed) {
      if (expert && typeof expert === "object" && typeof expert.id === "string") {
        slugs.add(expert.id);
      }
    }
  }

  return slugs;
}

// ---------------------------------------------------------------------------
// Reference checking
// ---------------------------------------------------------------------------

/**
 * Check entity YAML files for dangling relatedEntries, developer, organization,
 * summaryPage, and parentOrg references.
 */
function checkEntityFiles(
  entitiesDir: string,
  allSlugs: Set<string>,
  relativeBase: string
): { refs: DanglingRef[]; checked: number; byFile: Record<string, { checked: number; dangling: number }> } {
  const danglingRefs: DanglingRef[] = [];
  let totalChecked = 0;
  const byFile: Record<string, { checked: number; dangling: number }> = {};

  if (!existsSync(entitiesDir)) return { refs: danglingRefs, checked: totalChecked, byFile };

  const entries = readdirSync(entitiesDir);
  const yamlFiles = entries.filter(
    (e) => extname(e) === ".yaml" || extname(e) === ".yml"
  );

  for (const filename of yamlFiles) {
    const filePath = join(entitiesDir, filename);
    const relPath = join(relativeBase, filename);
    const fileStats = { checked: 0, dangling: 0 };

    const content = readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch {
      // Skip unparseable files — schema validation will catch YAML syntax errors
      continue;
    }

    const entityList: ParsedEntity[] = Array.isArray(parsed) ? parsed : parsed ? [parsed as ParsedEntity] : [];

    for (const entity of entityList) {
      if (!entity || typeof entity !== "object") continue;
      const entityId = entity.id ?? "(unknown)";
      const entityTitle = entity.title ?? entityId;

      // Check relatedEntries[].id
      if (Array.isArray(entity.relatedEntries)) {
        for (const entry of entity.relatedEntries) {
          if (entry && typeof entry === "object" && typeof entry.id === "string") {
            fileStats.checked++;
            totalChecked++;
            if (!allSlugs.has(entry.id)) {
              fileStats.dangling++;
              danglingRefs.push({
                sourceFile: relPath,
                sourceId: entityId,
                sourceTitle: entityTitle,
                fieldName: "relatedEntries[].id",
                refValue: entry.id,
                severity: "error",
                expectedType: typeof entry.type === "string" ? entry.type : undefined,
              });
            }
          }
        }
      }

      // Check developer (ai-models reference org slug)
      if (typeof entity.developer === "string") {
        fileStats.checked++;
        totalChecked++;
        if (!allSlugs.has(entity.developer)) {
          fileStats.dangling++;
          danglingRefs.push({
            sourceFile: relPath,
            sourceId: entityId,
            sourceTitle: entityTitle,
            fieldName: "developer",
            refValue: entity.developer,
            severity: "error",
            expectedType: "organization",
          });
        }
      }

      // Check organization (projects reference org slug)
      if (typeof entity.organization === "string") {
        fileStats.checked++;
        totalChecked++;
        if (!allSlugs.has(entity.organization)) {
          fileStats.dangling++;
          danglingRefs.push({
            sourceFile: relPath,
            sourceId: entityId,
            sourceTitle: entityTitle,
            fieldName: "organization",
            refValue: entity.organization,
            severity: "error",
            expectedType: "organization",
          });
        }
      }

      // Check parentOrg
      if (typeof entity.parentOrg === "string") {
        fileStats.checked++;
        totalChecked++;
        if (!allSlugs.has(entity.parentOrg)) {
          fileStats.dangling++;
          danglingRefs.push({
            sourceFile: relPath,
            sourceId: entityId,
            sourceTitle: entityTitle,
            fieldName: "parentOrg",
            refValue: entity.parentOrg,
            severity: "error",
            expectedType: "organization",
          });
        }
      }

      // Check keyPeople[] (org entities) — references person/expert slugs.
      const keyPeople = (entity as { keyPeople?: unknown }).keyPeople;
      if (Array.isArray(keyPeople)) {
        for (const personSlug of keyPeople) {
          if (typeof personSlug !== "string") continue;
          fileStats.checked++;
          totalChecked++;
          if (!allSlugs.has(personSlug)) {
            fileStats.dangling++;
            danglingRefs.push({
              sourceFile: relPath,
              sourceId: entityId,
              sourceTitle: entityTitle,
              fieldName: "keyPeople[]",
              refValue: personSlug,
              severity: "error",
              expectedType: "person",
            });
          }
        }
      }

      // Check summaryPage — warning only (references page slugs, not entity slugs)
      // We still check against entity slugs since many summaryPages match entity IDs
      // but some legitimately reference MDX file slugs, so it's informational only.
      if (typeof entity.summaryPage === "string") {
        fileStats.checked++;
        totalChecked++;
        if (!allSlugs.has(entity.summaryPage)) {
          fileStats.dangling++;
          danglingRefs.push({
            sourceFile: relPath,
            sourceId: entityId,
            sourceTitle: entityTitle,
            fieldName: "summaryPage",
            refValue: entity.summaryPage,
            severity: "warning",
          });
        }
      }

      // Check stakeholders[].entityId (policy response entities)
      if (Array.isArray(entity.stakeholders)) {
        for (const stakeholder of entity.stakeholders) {
          if (stakeholder && typeof stakeholder === "object" && typeof stakeholder.entityId === "string") {
            fileStats.checked++;
            totalChecked++;
            if (!allSlugs.has(stakeholder.entityId)) {
              fileStats.dangling++;
              danglingRefs.push({
                sourceFile: relPath,
                sourceId: entityId,
                sourceTitle: entityTitle,
                fieldName: "stakeholders[].entityId",
                refValue: stakeholder.entityId,
                severity: "error",
                expectedType: "entity",
              });
            }
          }
        }
      }

      // Check keyPoliticians[].entityId (policy response entities)
      if (Array.isArray(entity.keyPoliticians)) {
        for (const politician of entity.keyPoliticians) {
          if (politician && typeof politician === "object" && typeof politician.entityId === "string") {
            fileStats.checked++;
            totalChecked++;
            if (!allSlugs.has(politician.entityId)) {
              fileStats.dangling++;
              danglingRefs.push({
                sourceFile: relPath,
                sourceId: entityId,
                sourceTitle: entityTitle,
                fieldName: "keyPoliticians[].entityId",
                refValue: politician.entityId,
                severity: "error",
                expectedType: "person",
              });
            }
          }
        }
      }
    }

    byFile[relPath] = fileStats;
  }

  return { refs: danglingRefs, checked: totalChecked, byFile };
}

/**
 * Check data/experts.yaml for dangling affiliation references.
 */
function checkExpertsFile(
  expertsPath: string,
  allSlugs: Set<string>,
  relPath: string
): { refs: DanglingRef[]; checked: number } {
  const danglingRefs: DanglingRef[] = [];
  let checked = 0;

  if (!existsSync(expertsPath)) return { refs: danglingRefs, checked };

  const content = readFileSync(expertsPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    // Skip unparseable file — schema validation will catch YAML syntax errors
    return { refs: danglingRefs, checked };
  }

  if (!Array.isArray(parsed)) return { refs: danglingRefs, checked };

  for (const expert of parsed as ParsedExpert[]) {
    if (!expert || typeof expert !== "object") continue;
    const expertId = expert.id ?? "(unknown)";
    const expertName = expert.name ?? expertId;

    if (typeof expert.affiliation === "string") {
      // Skip generic affiliations that aren't entity references
      if (expert.affiliation === "independent") continue;

      checked++;
      if (!allSlugs.has(expert.affiliation)) {
        danglingRefs.push({
          sourceFile: relPath,
          sourceId: expertId,
          sourceTitle: expertName,
          fieldName: "affiliation",
          refValue: expert.affiliation,
          severity: "error",
          expectedType: "organization",
        });
      }
    }
  }

  return { refs: danglingRefs, checked };
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Run the full YAML entity reference validation.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns ValidationResult with all dangling references and stats
 */
export function validateYamlEntityRefs(projectRoot: string): ValidationResult {
  const entitiesDir = join(projectRoot, "data", "entities");
  const expertsPath = join(projectRoot, "data", "experts.yaml");

  // Step 1: Build the combined set of all known entity slugs
  const entitySlugs = loadEntitySlugs(entitiesDir);
  const expertSlugs = loadExpertSlugs(expertsPath);

  // Merge all slugs into one set for cross-file reference resolution
  const allSlugs = new Set([...entitySlugs, ...expertSlugs]);

  // Step 2: Check each data source for dangling references
  const allDangling: DanglingRef[] = [];
  let totalChecked = 0;
  const allByFile: Record<string, { checked: number; dangling: number }> = {};

  // 2a: Entity YAML files (relatedEntries, developer, organization, summaryPage,
  //     parentOrg, keyPeople[])
  const entityResult = checkEntityFiles(entitiesDir, allSlugs, "data/entities");
  allDangling.push(...entityResult.refs);
  totalChecked += entityResult.checked;
  Object.assign(allByFile, entityResult.byFile);

  // 2b: Experts file (affiliation)
  const expertsResult = checkExpertsFile(expertsPath, allSlugs, "data/experts.yaml");
  allDangling.push(...expertsResult.refs);
  totalChecked += expertsResult.checked;
  if (expertsResult.checked > 0) {
    allByFile["data/experts.yaml"] = {
      checked: expertsResult.checked,
      dangling: expertsResult.refs.length,
    };
  }

  const validRefs = totalChecked - allDangling.length;

  return {
    danglingRefs: allDangling,
    stats: {
      totalEntities: allSlugs.size,
      totalRefsChecked: totalChecked,
      validRefs,
      danglingRefs: allDangling.length,
      byFile: allByFile,
    },
  };
}
