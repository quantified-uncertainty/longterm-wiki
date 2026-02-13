#!/usr/bin/env node

/**
 * Data Validation Script
 *
 * Validates the integrity of YAML data files:
 * - Checks that relatedEntries reference existing entity IDs
 * - Checks that entity IDs map to actual MDX files
 * - Validates expert/organization references
 * - Reports orphaned entities
 *
 * Usage: node scripts/validate-data.ts
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'url';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors } from '../lib/output.ts';
import { CONTENT_DIR, DATA_DIR } from '../lib/content-types.ts';
import { parseFrontmatter, shouldSkipValidation } from '../lib/mdx-utils.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';
import type { Colors } from '../lib/output.ts';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface EntityData {
  id: string;
  type?: string;
  title?: string;
  relatedEntries?: Array<{ id: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ExpertData {
  id: string;
  affiliation?: string;
  [key: string]: unknown;
}

interface OrganizationData {
  id: string;
  [key: string]: unknown;
}

interface PathMapping {
  [type: string]: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadYaml(filename: string): unknown[] {
  const filepath = join(DATA_DIR, filename);
  if (!existsSync(filepath)) {
    return [];
  }
  const content = readFileSync(filepath, 'utf-8');
  return parseYaml(content) || [];
}

/**
 * Load and merge all YAML files from a directory
 */
function loadYamlDir(dirname: string): unknown[] {
  const dirpath = join(DATA_DIR, dirname);
  if (!existsSync(dirpath)) {
    return [];
  }

  const files = readdirSync(dirpath).filter((f: string) => f.endsWith('.yaml'));
  const merged: unknown[] = [];

  for (const file of files) {
    const filepath = join(dirpath, file);
    const content = readFileSync(filepath, 'utf-8');
    const data = parseYaml(content) || [];
    merged.push(...(data as unknown[]));
  }

  return merged;
}

// Extract entity ID from file path
function getEntityIdFromPath(filePath: string): string {
  return basename(filePath, '.mdx');
}

// Map entity type to expected directory paths
function getExpectedPaths(type: string): string[] {
  const pathMapping: PathMapping = {
    'risk': ['knowledge-base/risks'],
    'capability': ['knowledge-base/capabilities'],
    'safety-agenda': ['knowledge-base/responses/technical'],
    'policy': ['knowledge-base/responses/governance'],
    'lab': ['knowledge-base/organizations'],
    'lab-frontier': ['knowledge-base/organizations/labs'],
    'lab-research': ['knowledge-base/organizations/safety-orgs'],
    'lab-startup': ['knowledge-base/organizations'],
    'lab-academic': ['knowledge-base/organizations'],
    'researcher': ['knowledge-base/people'],
    'crux': ['knowledge-base/cruxes'],
    'scenario': ['analysis/scenarios', 'knowledge-base/future-projections'],
    'resource': ['resources'],
    'funder': ['knowledge-base/funders'],
    'intervention': ['knowledge-base/responses'],
    'case-study': ['knowledge-base/case-studies'],
    'debate': ['knowledge-base/debates'],
    'intelligence-paradigm': ['knowledge-base/intelligence-paradigms'],
    'metric': ['knowledge-base/metrics'],
    'historical': ['knowledge-base/history'],
    'concept': ['knowledge-base/worldviews', 'knowledge-base/forecasting'],
    'event': ['knowledge-base/incidents'],
  };

  return pathMapping[type] || ['knowledge-base'];
}

// ---------------------------------------------------------------------------
// runCheck (for orchestrator)
// ---------------------------------------------------------------------------

export function runCheck(options: ValidatorOptions = {}): ValidatorResult {
  const ciMode = options.ci ?? false;
  const colors: Colors = getColors(ciMode);

  let errors = 0;
  let warnings = 0;

  if (!ciMode) {
    console.log(`${colors.blue}🔍 Validating data integrity...${colors.reset}\n`);
  }

  // Load all data
  const entitiesFromFile = loadYaml('entities.yaml') as EntityData[];
  const entitiesFromDir = loadYamlDir('entities') as EntityData[];
  const entities: EntityData[] = [...entitiesFromFile, ...entitiesFromDir];
  const experts = loadYaml('experts.yaml') as ExpertData[];
  const organizations = loadYaml('organizations.yaml') as OrganizationData[];
  const literature = loadYaml('literature.yaml');

  // Build ID sets for quick lookups
  const entityIds = new Set<string>(entities.map((e: EntityData) => e.id));
  const expertIds = new Set<string>(experts.map((e: ExpertData) => e.id));
  const orgIds = new Set<string>(organizations.map((o: OrganizationData) => o.id));

  // Also index numeric IDs (E43 → slug) from id-registry.json
  try {
    const registryPath = join(DATA_DIR, 'id-registry.json');
    if (existsSync(registryPath)) {
      const registry = JSON.parse(readFileSync(registryPath, 'utf-8')) as {
        entities?: Record<string, string>;
      };
      if (registry.entities) {
        for (const numericId of Object.keys(registry.entities)) {
          entityIds.add(numericId);
        }
      }
    }
  } catch {
    // id-registry.json is optional
  }

  // Find all MDX files
  const mdxFiles = findMdxFiles(CONTENT_DIR);
  const mdxIds = new Set<string>(mdxFiles.map((f: string) => getEntityIdFromPath(f)));

  if (!ciMode) {
    console.log(`📊 Data summary:`);
    console.log(`   Entities: ${entities.length}`);
    console.log(`   Experts: ${experts.length}`);
    console.log(`   Organizations: ${organizations.length}`);
    console.log(`   MDX files: ${mdxFiles.length}\n`);
  }

  // ==========================================================================
  // 1. Validate related entries reference existing entities
  // ==========================================================================
  if (!ciMode) console.log(`${colors.blue}Checking related entries...${colors.reset}`);

  for (const entity of entities) {
    if (!entity.relatedEntries) continue;

    for (const related of entity.relatedEntries) {
      const relatedId = related.id;

      // Check if it exists in entities, experts, or organizations
      const exists = entityIds.has(relatedId) ||
                    expertIds.has(relatedId) ||
                    orgIds.has(relatedId);

      if (!exists) {
        console.log(`${colors.yellow}⚠️  ${entity.id}: relatedEntry "${relatedId}" not found in any data file${colors.reset}`);
        warnings++;
      }
    }
  }

  // ==========================================================================
  // 2. Validate entities have corresponding MDX files
  // ==========================================================================
  if (!ciMode) console.log(`\n${colors.blue}Checking entity-to-file mapping...${colors.reset}`);

  const entitiesWithoutFiles: EntityData[] = [];
  for (const entity of entities) {
    if (!mdxIds.has(entity.id)) {
      entitiesWithoutFiles.push(entity);
    }
  }

  if (entitiesWithoutFiles.length > 0) {
    console.log(`${colors.yellow}⚠️  ${entitiesWithoutFiles.length} entities without MDX files:${colors.reset}`);
    for (const e of entitiesWithoutFiles.slice(0, 10)) {
      console.log(`   - ${e.id} (${e.type})`);
    }
    if (entitiesWithoutFiles.length > 10) {
      console.log(`   ... and ${entitiesWithoutFiles.length - 10} more`);
    }
    warnings += entitiesWithoutFiles.length;
  }

  // ==========================================================================
  // 3. Check for duplicate IDs
  // ==========================================================================
  if (!ciMode) console.log(`\n${colors.blue}Checking for duplicate IDs...${colors.reset}`);

  const seenIds = new Map<string, boolean>();
  for (const entity of entities) {
    if (seenIds.has(entity.id)) {
      console.log(`${colors.red}❌ Duplicate entity ID: ${entity.id}${colors.reset}`);
      errors++;
    }
    seenIds.set(entity.id, true);
  }

  // ==========================================================================
  // 4. Validate required fields
  // ==========================================================================
  if (!ciMode) console.log(`\n${colors.blue}Checking required fields...${colors.reset}`);

  for (const entity of entities) {
    if (!entity.id) {
      console.log(`${colors.red}❌ Entity missing ID: ${JSON.stringify(entity).slice(0, 50)}${colors.reset}`);
      errors++;
    }
    if (!entity.type) {
      console.log(`${colors.red}❌ Entity "${entity.id}" missing type${colors.reset}`);
      errors++;
    }
    if (!entity.title) {
      console.log(`${colors.yellow}⚠️  Entity "${entity.id}" missing title${colors.reset}`);
      warnings++;
    }
  }

  // ==========================================================================
  // 5. Check expert affiliations reference valid organizations
  // ==========================================================================
  if (!ciMode) console.log(`\n${colors.blue}Checking expert affiliations...${colors.reset}`);

  for (const expert of experts) {
    if (expert.affiliation && !orgIds.has(expert.affiliation)) {
      console.log(`${colors.yellow}⚠️  Expert "${expert.id}": affiliation "${expert.affiliation}" not found in organizations${colors.reset}`);
      warnings++;
    }
  }

  // ==========================================================================
  // 6. Check MDX files that use DataInfoBox have corresponding entities
  // ==========================================================================
  if (!ciMode) console.log(`\n${colors.blue}Checking DataInfoBox references...${colors.reset}`);

  let missingEntityRefs = 0;
  for (const file of mdxFiles) {
    const content = readFileSync(file, 'utf-8');
    const frontmatter = parseFrontmatter(content);

    // Skip pages marked as documentation (contain examples that would trigger false positives)
    if (shouldSkipValidation(frontmatter)) {
      continue;
    }

    const match = content.match(/<DataInfoBox\s+entityId="([^"]+)"/);
    if (match) {
      const entityId = match[1];
      if (!entityIds.has(entityId) && !expertIds.has(entityId) && !orgIds.has(entityId)) {
        console.log(`${colors.red}❌ ${file}: DataInfoBox references unknown entityId "${entityId}"${colors.reset}`);
        errors++;
        missingEntityRefs++;
      }
    }
  }

  // ==========================================================================
  // Summary
  // ==========================================================================
  if (!ciMode) {
    console.log(`\n${'─'.repeat(60)}`);

    if (errors === 0 && warnings === 0) {
      console.log(`${colors.green}✅ All validations passed!${colors.reset}`);
    } else {
      if (errors > 0) {
        console.log(`${colors.red}❌ ${errors} error(s)${colors.reset}`);
      }
      if (warnings > 0) {
        console.log(`${colors.yellow}⚠️  ${warnings} warning(s)${colors.reset}`);
      }
    }
  }

  return {
    passed: errors === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Standalone main
// ---------------------------------------------------------------------------

function main(): void {
  const result = runCheck({ ci: process.argv.includes('--ci') });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
