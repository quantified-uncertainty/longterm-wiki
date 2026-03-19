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
 *   - data/experts.yaml:
 *     - affiliation → org/entity slug
 *   - data/organizations.yaml:
 *     - keyPeople[] → person/expert slugs
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
  [key: string]: unknown;
}

interface ParsedExpert {
  id?: string;
  name?: string;
  affiliation?: string;
  [key: string]: unknown;
}

interface ParsedOrganization {
  id?: string;
  name?: string;
  keyPeople?: string[];
  parentOrg?: string;
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

    if (Array.isArray(parsed)) {
      for (const entity of parsed) {
        if (entity && typeof entity === "object" && typeof entity.id === "string") {
          slugs.add(entity.id);
        }
      }
    } else if (parsed && typeof parsed === "object" && typeof (parsed as ParsedEntity).id === "string") {
      slugs.add((parsed as ParsedEntity).id!);
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

/**
 * Load all organization slugs from data/organizations.yaml.
 */
export function loadOrgSlugs(orgsPath: string): Set<string> {
  const slugs = new Set<string>();
  if (!existsSync(orgsPath)) return slugs;

  const content = readFileSync(orgsPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return slugs;
  }

  if (Array.isArray(parsed)) {
    for (const org of parsed) {
      if (org && typeof org === "object" && typeof org.id === "string") {
        slugs.add(org.id);
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

/**
 * Check data/organizations.yaml for dangling keyPeople and parentOrg references.
 */
function checkOrganizationsFile(
  orgsPath: string,
  allSlugs: Set<string>,
  expertSlugs: Set<string>,
  relPath: string
): { refs: DanglingRef[]; checked: number } {
  const danglingRefs: DanglingRef[] = [];
  let checked = 0;

  if (!existsSync(orgsPath)) return { refs: danglingRefs, checked };

  const content = readFileSync(orgsPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return { refs: danglingRefs, checked };
  }

  if (!Array.isArray(parsed)) return { refs: danglingRefs, checked };

  // Combine entity slugs and expert slugs for keyPeople lookups
  const peopleSlugs = new Set([...allSlugs, ...expertSlugs]);

  for (const org of parsed as ParsedOrganization[]) {
    if (!org || typeof org !== "object") continue;
    const orgId = org.id ?? "(unknown)";
    const orgName = org.name ?? orgId;

    // Check keyPeople
    if (Array.isArray(org.keyPeople)) {
      for (const personSlug of org.keyPeople) {
        if (typeof personSlug !== "string") continue;
        checked++;
        if (!peopleSlugs.has(personSlug)) {
          danglingRefs.push({
            sourceFile: relPath,
            sourceId: orgId,
            sourceTitle: orgName,
            fieldName: "keyPeople[]",
            refValue: personSlug,
            severity: "error",
            expectedType: "person",
          });
        }
      }
    }

    // Check parentOrg
    if (typeof org.parentOrg === "string") {
      checked++;
      if (!allSlugs.has(org.parentOrg) && !new Set(Array.isArray(parsed) ? parsed.map((o: ParsedOrganization) => o.id).filter(Boolean) : []).has(org.parentOrg)) {
        danglingRefs.push({
          sourceFile: relPath,
          sourceId: orgId,
          sourceTitle: orgName,
          fieldName: "parentOrg",
          refValue: org.parentOrg,
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
  const orgsPath = join(projectRoot, "data", "organizations.yaml");

  // Step 1: Build the combined set of all known entity slugs
  const entitySlugs = loadEntitySlugs(entitiesDir);
  const expertSlugs = loadExpertSlugs(expertsPath);
  const orgSlugs = loadOrgSlugs(orgsPath);

  // Merge all slugs into one set for cross-file reference resolution
  const allSlugs = new Set([...entitySlugs, ...expertSlugs, ...orgSlugs]);

  // Step 2: Check each data source for dangling references
  const allDangling: DanglingRef[] = [];
  let totalChecked = 0;
  const allByFile: Record<string, { checked: number; dangling: number }> = {};

  // 2a: Entity YAML files (relatedEntries, developer, organization, summaryPage, parentOrg)
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

  // 2c: Organizations file (keyPeople, parentOrg)
  const orgsResult = checkOrganizationsFile(orgsPath, allSlugs, expertSlugs, "data/organizations.yaml");
  allDangling.push(...orgsResult.refs);
  totalChecked += orgsResult.checked;
  if (orgsResult.checked > 0) {
    allByFile["data/organizations.yaml"] = {
      checked: orgsResult.checked,
      dangling: orgsResult.refs.length,
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
