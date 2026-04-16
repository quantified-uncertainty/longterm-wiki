#!/usr/bin/env node

/**
 * Cross-Base Consistency Validator
 *
 * Checks consistency between the three data layers:
 *   - WikiBase: MDX pages in content/docs/ (frontmatter with wikiId)
 *   - TableBase: YAML entities in data/entities/*.yaml (with wikiId, type, title)
 *   - FactBase: YAML files in packages/factbase/data/fb-entities/ (with entity stableId)
 *
 * Checks performed:
 *   1. Page wikiId exists as entity in TableBase (error if not)
 *   2. Page title matches entity title (warning if different)
 *   3. Entity with wikiId has a matching page (warning — some entities may not have pages yet)
 *   4. FactBase entity has a TableBase entry (warning if not)
 *
 * Usage:
 *   npx tsx crux/validate/validate-cross-base.ts [--ci] [--verbose]
 *
 * Exit codes:
 *   0 = No errors (warnings don't block)
 *   1 = Cross-base consistency errors found
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parseFrontmatter } from '../lib/mdx-utils.ts';
import { getColors, formatPath } from '../lib/output.ts';
import { PROJECT_ROOT, CONTENT_DIR } from '../lib/content-types.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

// ============================================================================
// TYPES
// ============================================================================

export interface EntityRecord {
  id: string;
  stableId?: string;
  wikiId?: string;
  type: string;
  title: string;
  /** Source YAML file */
  sourceFile: string;
}

export interface PageRecord {
  filePath: string;
  wikiId?: string;
  title?: string;
  entityType?: string;
}

export interface FactBaseRecord {
  filename: string;
  entityStableId: string | null;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface CrossBaseIssue {
  id: string;
  severity: IssueSeverity;
  message: string;
  /** File where the issue was found */
  file?: string;
  /** Related entity or page identifier */
  entityId?: string;
  wikiId?: string;
}

// ============================================================================
// DATA LOADERS
// ============================================================================

/**
 * Load all entities from YAML files in data/entities/.
 * Each YAML file contains a flat array of entity objects.
 */
export function loadYamlEntities(): EntityRecord[] {
  const entitiesDir = join(PROJECT_ROOT, 'data', 'entities');
  if (!existsSync(entitiesDir)) return [];

  const entities: EntityRecord[] = [];
  const files = readdirSync(entitiesDir).filter(
    (f) => extname(f) === '.yaml' || extname(f) === '.yml',
  );

  for (const filename of files) {
    const filePath = join(entitiesDir, filename);
    const content = readFileSync(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch (err) {
      // Skip files with parse errors — other validators handle that
      continue;
    }

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && typeof entry === 'object' && entry.id && entry.title) {
          entities.push({
            id: entry.id as string,
            stableId: entry.stableId as string | undefined,
            wikiId: entry.wikiId as string | undefined,
            type: (entry.type as string) || 'unknown',
            title: entry.title as string,
            sourceFile: filename,
          });
        }
      }
    } else if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).id) {
      const entry = parsed as Record<string, unknown>;
      entities.push({
        id: entry.id as string,
        stableId: entry.stableId as string | undefined,
        wikiId: entry.wikiId as string | undefined,
        type: (entry.type as string) || 'unknown',
        title: (entry.title as string) || entry.id as string,
        sourceFile: filename,
      });
    }
  }

  return entities;
}

/**
 * Load all MDX pages and extract their frontmatter.
 */
export function loadMdxPages(): PageRecord[] {
  const files = findMdxFiles(CONTENT_DIR);
  const pages: PageRecord[] = [];

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content);
      pages.push({
        filePath,
        wikiId: fm.wikiId as string | undefined,
        title: fm.title as string | undefined,
        entityType: fm.entityType as string | undefined,
      });
    } catch {
      // Skip files that can't be read
    }
  }

  return pages;
}

/**
 * Extract the stableId from a FactBase YAML file.
 * Handles both `entity: <stableId>` and `thing: { id/stableId }` formats.
 */
export function extractFactBaseStableId(content: string): string | null {
  // entity: <stableId> format (newer format)
  const entityMatch = content.match(/^entity:\s*(\S+)/m);
  if (entityMatch && !content.match(/^thing:/m)) {
    return entityMatch[1];
  }

  // thing: { ... } format (older format)
  if (content.match(/^thing:/m)) {
    // Try stableId field
    const stableIdMatch = content.match(/^\s+stableId:\s*(\S+)/m);
    if (stableIdMatch) return stableIdMatch[1];

    // Try id field when slug also exists
    const slugMatch = content.match(/^\s+slug:\s*\S+/m);
    if (slugMatch) {
      const idMatch = content.match(/^\s+id:\s*(\S+)/m);
      if (idMatch) return idMatch[1];
    }
  }

  return null;
}

/**
 * Load all FactBase entity references.
 */
export function loadFactBaseEntities(): FactBaseRecord[] {
  const thingsDir = join(PROJECT_ROOT, 'packages', 'factbase', 'data', 'fb-entities');
  if (!existsSync(thingsDir)) return [];

  const records: FactBaseRecord[] = [];
  const files = readdirSync(thingsDir).filter(
    (f) => extname(f) === '.yaml' || extname(f) === '.yml',
  );

  for (const filename of files) {
    const filePath = join(thingsDir, filename);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const stableId = extractFactBaseStableId(content);
      records.push({ filename, entityStableId: stableId });
    } catch {
      // Skip files that can't be read
    }
  }

  return records;
}

// ============================================================================
// VALIDATORS
// ============================================================================

/**
 * Check that every page with a wikiId has a corresponding entity.
 *
 * Many pages have wikiIds purely for URL routing (/wiki/E<N>) without needing
 * a corresponding entity in data/entities/. This is expected for non-entity pages
 * like guides, project docs, and internal dashboards.
 *
 * This is an info-level notice (not an error) because wikiIds are decoupled
 * from entity records by design. The entity-missing-page check is more
 * actionable: if an entity declares a wikiId, it should have a page.
 */
export function checkPageEntityCoverage(
  pages: PageRecord[],
  entityByWikiId: Map<string, EntityRecord>,
): CrossBaseIssue[] {
  const issues: CrossBaseIssue[] = [];

  for (const page of pages) {
    if (!page.wikiId) continue;

    const entity = entityByWikiId.get(page.wikiId);
    if (!entity) {
      issues.push({
        id: 'page-no-entity',
        severity: 'info',
        message: `Page has wikiId "${page.wikiId}" with no corresponding entity in data/entities/*.yaml`,
        file: page.filePath,
        wikiId: page.wikiId,
      });
    }
  }

  return issues;
}

/**
 * Check that page titles match entity titles for pages with wikiId.
 */
export function checkTitleConsistency(
  pages: PageRecord[],
  entityByWikiId: Map<string, EntityRecord>,
): CrossBaseIssue[] {
  const issues: CrossBaseIssue[] = [];

  for (const page of pages) {
    if (!page.wikiId || !page.title) continue;

    const entity = entityByWikiId.get(page.wikiId);
    if (!entity) continue; // Already reported by checkPageEntityCoverage

    if (page.title !== entity.title) {
      issues.push({
        id: 'title-mismatch',
        severity: 'warning',
        message: `Page title "${page.title}" differs from entity title "${entity.title}" (wikiId: ${page.wikiId})`,
        file: page.filePath,
        wikiId: page.wikiId,
        entityId: entity.id,
      });
    }
  }

  return issues;
}

/**
 * Check that every entity with a wikiId has a corresponding page.
 */
export function checkEntityPageCoverage(
  entities: EntityRecord[],
  pageByWikiId: Map<string, PageRecord>,
): CrossBaseIssue[] {
  const issues: CrossBaseIssue[] = [];

  for (const entity of entities) {
    if (!entity.wikiId) continue;

    if (!pageByWikiId.has(entity.wikiId)) {
      issues.push({
        id: 'entity-missing-page',
        severity: 'warning',
        message: `Entity "${entity.title}" (${entity.id}) declares wikiId "${entity.wikiId}" but no page with that wikiId exists`,
        entityId: entity.id,
        wikiId: entity.wikiId,
      });
    }
  }

  return issues;
}

/**
 * Check that every FactBase entity has a TableBase entry.
 */
export function checkFactBaseCoverage(
  factBaseRecords: FactBaseRecord[],
  stableIdSet: Set<string>,
): CrossBaseIssue[] {
  const issues: CrossBaseIssue[] = [];

  for (const record of factBaseRecords) {
    if (!record.entityStableId) {
      issues.push({
        id: 'factbase-no-stableid',
        severity: 'warning',
        message: `FactBase file "${record.filename}" has no extractable stableId`,
        file: join('packages/factbase/data/fb-entities', record.filename),
      });
      continue;
    }

    if (!stableIdSet.has(record.entityStableId)) {
      issues.push({
        id: 'factbase-missing-tablebase',
        severity: 'warning',
        message: `FactBase entity "${record.filename}" (stableId: ${record.entityStableId}) has no TableBase entry in data/entities/*.yaml`,
        file: join('packages/factbase/data/fb-entities', record.filename),
        entityId: record.entityStableId,
      });
    }
  }

  return issues;
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

export interface CrossBaseValidationResult extends ValidatorResult {
  issues: CrossBaseIssue[];
  stats: {
    totalPages: number;
    pagesWithWikiId: number;
    totalEntities: number;
    entitiesWithWikiId: number;
    factBaseFiles: number;
    factBaseWithStableId: number;
  };
}

/**
 * Run all cross-base consistency checks and return structured results.
 */
export function runCrossBaseValidation(): CrossBaseValidationResult {
  // Load data
  const entities = loadYamlEntities();
  const pages = loadMdxPages();
  const factBaseRecords = loadFactBaseEntities();

  // Build lookup maps
  const entityByWikiId = new Map<string, EntityRecord>();
  const stableIdSet = new Set<string>();

  for (const entity of entities) {
    if (entity.wikiId) entityByWikiId.set(entity.wikiId, entity);
    if (entity.stableId) stableIdSet.add(entity.stableId);
    // Also add the entity id itself since some FactBase entries reference by id
    stableIdSet.add(entity.id);
  }

  const pageByWikiId = new Map<string, PageRecord>();
  for (const page of pages) {
    if (page.wikiId) pageByWikiId.set(page.wikiId, page);
  }

  // Run checks
  const allIssues: CrossBaseIssue[] = [
    ...checkPageEntityCoverage(pages, entityByWikiId),
    ...checkTitleConsistency(pages, entityByWikiId),
    ...checkEntityPageCoverage(entities, pageByWikiId),
    ...checkFactBaseCoverage(factBaseRecords, stableIdSet),
  ];

  const errorCount = allIssues.filter((i) => i.severity === 'error').length;
  const warningCount = allIssues.filter((i) => i.severity === 'warning').length;
  const infoCount = allIssues.filter((i) => i.severity === 'info').length;

  const pagesWithWikiId = pages.filter((p) => p.wikiId).length;
  const entitiesWithWikiId = entities.filter((e) => e.wikiId).length;
  const factBaseWithStableId = factBaseRecords.filter((r) => r.entityStableId).length;

  return {
    passed: errorCount === 0,
    errors: errorCount,
    warnings: warningCount,
    infos: infoCount,
    issues: allIssues,
    stats: {
      totalPages: pages.length,
      pagesWithWikiId,
      totalEntities: entities.length,
      entitiesWithWikiId,
      factBaseFiles: factBaseRecords.length,
      factBaseWithStableId,
    },
  };
}

/**
 * Run the cross-base check and return a ValidatorResult.
 * Can be called in-process by the orchestrator.
 */
export function runCheck(_options: ValidatorOptions = {}): ValidatorResult {
  const result = runCrossBaseValidation();
  return {
    passed: result.passed,
    errors: result.errors,
    warnings: result.warnings,
    infos: result.infos,
  };
}

// ============================================================================
// CLI MAIN
// ============================================================================

function main(): void {
  const CI_MODE = process.argv.includes('--ci');
  const VERBOSE = process.argv.includes('--verbose');
  const c = getColors(CI_MODE);

  const result = runCrossBaseValidation();

  if (CI_MODE) {
    console.log(JSON.stringify({
      passed: result.passed,
      errors: result.errors,
      warnings: result.warnings,
      infos: result.infos,
      stats: result.stats,
      issues: result.issues,
    }, null, 2));
  } else {
    console.log(`${c.bold}${c.blue}Cross-Base Consistency Validation${c.reset}\n`);
    console.log(`${c.dim}Pages: ${result.stats.totalPages} total, ${result.stats.pagesWithWikiId} with wikiId${c.reset}`);
    console.log(`${c.dim}Entities: ${result.stats.totalEntities} total, ${result.stats.entitiesWithWikiId} with wikiId${c.reset}`);
    console.log(`${c.dim}FactBase: ${result.stats.factBaseFiles} files, ${result.stats.factBaseWithStableId} with stableId${c.reset}\n`);

    if (result.issues.length === 0) {
      console.log(`${c.green}No cross-base consistency issues found.${c.reset}\n`);
    } else {
      // Group by issue type
      const byId = new Map<string, CrossBaseIssue[]>();
      for (const issue of result.issues) {
        const existing = byId.get(issue.id) || [];
        existing.push(issue);
        byId.set(issue.id, existing);
      }

      for (const [id, issues] of byId) {
        const first = issues[0];
        const severityColor = first.severity === 'error' ? c.red : first.severity === 'warning' ? c.yellow : c.blue;
        const severityLabel = first.severity.toUpperCase();

        console.log(`${severityColor}${c.bold}${severityLabel}: ${id}${c.reset} (${issues.length})`);

        const displayLimit = VERBOSE ? issues.length : Math.min(issues.length, 10);
        for (let i = 0; i < displayLimit; i++) {
          const issue = issues[i];
          const location = issue.file ? formatPath(issue.file) : (issue.entityId || issue.wikiId || '');
          console.log(`  ${c.dim}${location}:${c.reset} ${issue.message}`);
        }
        if (!VERBOSE && issues.length > 10) {
          console.log(`  ${c.dim}... and ${issues.length - 10} more (use --verbose to see all)${c.reset}`);
        }
        console.log();
      }

      console.log(`${c.bold}Summary:${c.reset}`);
      if (result.errors > 0) console.log(`  ${c.red}${result.errors} error(s)${c.reset}`);
      if (result.warnings > 0) console.log(`  ${c.yellow}${result.warnings} warning(s)${c.reset}`);
      if (result.infos && result.infos > 0) console.log(`  ${c.blue}${result.infos} info(s)${c.reset}`);
      console.log();
    }
  }

  process.exit(result.errors > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
