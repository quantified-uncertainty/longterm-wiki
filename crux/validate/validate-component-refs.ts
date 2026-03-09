#!/usr/bin/env node
/**
 * Component Reference Validator
 *
 * Validates that components in MDX files reference entities/data that actually exists:
 * - EntityLink id="..." references valid entities
 * - DataInfoBox entityId="..." references valid entities
 * - DataExternalLinks pageId="..." has matching external links data
 *
 * Also checks for unused imports.
 *
 * Usage:
 *   npx tsx crux/validate/validate-component-refs.ts
 *   npx tsx crux/validate/validate-component-refs.ts --ci
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Use shared libraries
import { findMdxFiles } from '../lib/file-utils.ts';
import { createLogger, formatPath } from '../lib/output.ts';
import { CONTENT_DIR, DATA_DIR, PROJECT_ROOT, loadDatabase as loadDatabaseJson } from '../lib/content-types.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';
import { ENTITY_LINK_RE } from '../lib/patterns.ts';
import { stripFencedCodeBlocks } from '../lib/mdx-utils.ts';

const log = createLogger();
const c = log.colors;

/**
 * An import statement parsed from MDX content.
 */
interface ParsedImport {
  components: string[];
  source: string;
  fullMatch: string;
  index: number;
}

/**
 * An unused import found in a file.
 */
interface UnusedImport {
  component: string;
  source: string;
}

/**
 * A component reference found in MDX content.
 */
interface ComponentRef {
  component: string;
  prop: string;
  value: string;
  line: number;
}

/**
 * A missing reference issue.
 */
interface MissingRef {
  file: string;
  line: number;
  component: string;
  prop: string;
  value: string;
  dataSource: string;
}

/**
 * A component that references data that doesn't exist.
 */
interface NoDataComponent {
  file: string;
  line: number;
  component: string;
  value: string;
  dataSource: string;
}

/**
 * An unused import issue entry.
 */
interface UnusedImportIssue {
  file: string;
  component: string;
  source: string;
}

/**
 * Aggregated issues found during validation.
 */
interface ValidationIssues {
  missingRefs: MissingRef[];
  unusedImports: UnusedImportIssue[];
  noDataForComponent: NoDataComponent[];
  brokenKbfRefs: BrokenKbfRef[];
}

/**
 * A KBF/KBFactValue reference found in MDX content.
 */
interface KbfRef {
  component: string;
  entity: string;
  property: string;
  line: number;
}

/**
 * A broken KBF reference (entity or property not found in KB).
 */
interface BrokenKbfRef {
  file: string;
  line: number;
  component: string;
  entity: string;
  property: string;
  reason: 'unknown-entity' | 'unknown-property';
}

// ── KB data loaders ────────────────────────────────────────────────────

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data');

/**
 * Load valid KB property IDs by parsing properties.yaml keys.
 * Lightweight: no full graph load needed.
 */
function loadKbPropertyIds(): Set<string> {
  try {
    const raw = readFileSync(join(KB_DATA_DIR, 'properties.yaml'), 'utf-8');
    const ids = new Set<string>();
    // Property keys appear as "  <key>:" at exactly 2-space indentation under "properties:".
    // Nested field keys (name, description, appliesTo, display, etc.) are at 4+ spaces and won't match.
    for (const match of raw.matchAll(/^  ([a-z][a-z-]*):/gm)) {
      ids.add(match[1]);
    }
    return ids;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[validate-component-refs] Could not load KB properties.yaml: ${msg} — KBF property validation will be skipped`);
    return new Set();
  }
}

/**
 * Load valid KB entity slugs from the filesystem.
 * An entity has KB data if `packages/kb/data/things/<slug>.yaml` exists.
 */
function loadKbEntitySlugs(): Set<string> {
  try {
    const thingsDir = join(KB_DATA_DIR, 'things');
    const slugs = new Set<string>();
    for (const file of readdirSync(thingsDir)) {
      if (file.endsWith('.yaml')) {
        slugs.add(file.slice(0, -5));
      }
    }
    return slugs;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[validate-component-refs] Could not read KB things/ directory: ${msg} — KBF entity validation will be skipped`);
    return new Set();
  }
}

/**
 * Parse all <KBF> and <KBFactValue> usages from MDX content.
 * Returns objects with entity + property attr values.
 */
function findKbfRefs(content: string): KbfRef[] {
  const refs: KbfRef[] = [];
  // Match opening tag with any attribute order; stop at `>` or `/>`
  const tagRegex = /<(KBF|KBFactValue)\s+([^>]+?)(?:\/?>|\s+[^>]*>)/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(content)) !== null) {
    const attrs = tagMatch[2];
    const entityMatch = attrs.match(/entity=["']([^"']+)["']/);
    const propertyMatch = attrs.match(/property=["']([^"']+)["']/);
    if (entityMatch && propertyMatch) {
      refs.push({
        component: tagMatch[1],
        entity: entityMatch[1],
        property: propertyMatch[1],
        line: content.slice(0, tagMatch.index).split('\n').length,
      });
    }
  }
  return refs;
}

// Load data sources
function loadEntities(): Set<string> {
  try {
    const database = loadDatabaseJson();
    const ids = new Set<string>();

    // Slug-based IDs from typedEntities (primary) or legacy entities array
    const typed = (database as Record<string, unknown>).typedEntities as Array<{ id: string }> | undefined;
    const legacy = (database as Record<string, unknown>).entities as Array<{ id: string }> | undefined;
    for (const e of typed ?? legacy ?? []) {
      ids.add(e.id);
    }

    // Numeric IDs (E###) from idRegistry — EntityLinks may reference either form
    const reg = (database as Record<string, unknown>).idRegistry as
      { byNumericId?: Record<string, string> } | undefined;
    for (const eid of Object.keys(reg?.byNumericId ?? {})) {
      ids.add(eid);
    }

    // Page IDs — EntityLinks may also reference pages that lack a YAML entity definition
    // (internal docs, overview pages, style guides, etc.)
    const pages = (database as Record<string, unknown>).pages as Array<{ id: string }> | undefined;
    for (const p of pages ?? []) {
      ids.add(p.id);
    }

    return ids;
  } catch {
    log.warn('Warning: Could not load entities database. Data layer may need manual rebuild.');
    return new Set();
  }
}

function loadExternalLinks(): Set<string> {
  try {
    const content: string = readFileSync(`${DATA_DIR}/external-links.yaml`, 'utf-8');
    const pageIds = new Set<string>();
    const matches = content.matchAll(/^- pageId: (.+)$/gm);
    for (const match of matches) {
      pageIds.add(match[1].trim());
    }
    return pageIds;
  } catch {
    return new Set();
  }
}

// Parse imports from MDX file
function parseImports(content: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const components: string[] = match[1].split(',').map((c: string) => c.trim()).filter(Boolean);
    imports.push({
      components,
      source: match[2],
      fullMatch: match[0],
      index: match.index,
    });
  }

  return imports;
}

// Check which imported components are actually used
function findUnusedImports(content: string, imports: ParsedImport[]): UnusedImport[] {
  const unused: UnusedImport[] = [];

  for (const imp of imports) {
    for (const component of imp.components) {
      const afterImport: string = content.slice(imp.index + imp.fullMatch.length);
      const usagePattern = new RegExp(`<${component}[\\s/>]|${component}\\(`);

      if (!usagePattern.test(afterImport)) {
        unused.push({ component, source: imp.source });
      }
    }
  }

  return unused;
}

// Find component usages and validate references
function findComponentRefs(content: string): ComponentRef[] {
  const refs: ComponentRef[] = [];

  // EntityLink id="..."
  for (const match of content.matchAll(ENTITY_LINK_RE)) {
    refs.push({
      component: 'EntityLink',
      prop: 'id',
      value: match[1],
      line: content.slice(0, match.index).split('\n').length,
    });
  }

  // DataInfoBox entityId="..."
  let match: RegExpExecArray | null;
  const infoBoxRegex = /<DataInfoBox\s+entityId=["']([^"']+)["']/g;
  while ((match = infoBoxRegex.exec(content)) !== null) {
    refs.push({
      component: 'DataInfoBox',
      prop: 'entityId',
      value: match[1],
      line: content.slice(0, match.index).split('\n').length,
    });
  }

  // DataExternalLinks pageId="..."
  const externalLinksRegex = /<DataExternalLinks\s+pageId=["']([^"']+)["']/g;
  while ((match = externalLinksRegex.exec(content)) !== null) {
    refs.push({
      component: 'DataExternalLinks',
      prop: 'pageId',
      value: match[1],
      line: content.slice(0, match.index).split('\n').length,
    });
  }

  return refs;
}

/**
 * Run the component reference check and return a ValidatorResult.
 */
export async function runCheck(options: ValidatorOptions = {}): Promise<ValidatorResult> {
  const entities: Set<string> = loadEntities();
  const externalLinks: Set<string> = loadExternalLinks();
  const kbEntitySlugs: Set<string> = loadKbEntitySlugs();
  const kbPropertyIds: Set<string> = loadKbPropertyIds();

  const files: string[] = findMdxFiles(CONTENT_DIR);

  const issues: ValidationIssues = {
    missingRefs: [],
    unusedImports: [],
    noDataForComponent: [],
    brokenKbfRefs: [],
  };

  for (const file of files) {
    const relPath: string = formatPath(file);
    const rawContent: string = readFileSync(file, 'utf-8');
    // Strip fenced code blocks to avoid false positives from example code
    const content: string = stripFencedCodeBlocks(rawContent);

    const imports: ParsedImport[] = parseImports(content);
    const unused: UnusedImport[] = findUnusedImports(content, imports);

    for (const u of unused) {
      issues.unusedImports.push({ file: relPath, component: u.component, source: u.source });
    }

    const refs: ComponentRef[] = findComponentRefs(content);

    for (const ref of refs) {
      let isValid = true;
      let dataSource = 'unknown';

      switch (ref.component) {
        case 'EntityLink':
          isValid = entities.has(ref.value) ||
                    ref.value.startsWith('__index__/');
          dataSource = 'entities/pages';
          break;

        case 'DataInfoBox':
          isValid = entities.has(ref.value);
          dataSource = 'entities';
          break;

        case 'DataExternalLinks':
          isValid = externalLinks.has(ref.value);
          dataSource = 'external-links.yaml';
          if (!isValid) {
            issues.noDataForComponent.push({
              file: relPath,
              line: ref.line,
              component: ref.component,
              value: ref.value,
              dataSource,
            });
          }
          continue;
      }

      if (!isValid) {
        issues.missingRefs.push({
          file: relPath,
          line: ref.line,
          component: ref.component,
          prop: ref.prop,
          value: ref.value,
          dataSource,
        });
      }
    }

    // Validate KBF / KBFactValue references
    if (kbEntitySlugs.size > 0 || kbPropertyIds.size > 0) {
      for (const ref of findKbfRefs(content)) {
        if (kbEntitySlugs.size > 0 && !kbEntitySlugs.has(ref.entity)) {
          issues.brokenKbfRefs.push({
            file: relPath,
            line: ref.line,
            component: ref.component,
            entity: ref.entity,
            property: ref.property,
            reason: 'unknown-entity',
          });
        } else if (kbPropertyIds.size > 0 && !kbPropertyIds.has(ref.property)) {
          issues.brokenKbfRefs.push({
            file: relPath,
            line: ref.line,
            component: ref.component,
            entity: ref.entity,
            property: ref.property,
            reason: 'unknown-property',
          });
        }
      }
    }
  }

  return {
    passed: issues.missingRefs.length === 0,
    errors: issues.missingRefs.length,
    warnings: issues.noDataForComponent.length + issues.unusedImports.length + issues.brokenKbfRefs.length,
  };
}

// Main validation
async function main(): Promise<void> {
  log.heading('Component Reference Validator');
  console.log();

  // Load all data sources
  log.dim('Loading data sources...');
  const entities: Set<string> = loadEntities();
  const externalLinks: Set<string> = loadExternalLinks();
  const kbEntitySlugs: Set<string> = loadKbEntitySlugs();
  const kbPropertyIds: Set<string> = loadKbPropertyIds();

  log.dim(`  Entities + Pages: ${entities.size}`);
  log.dim(`  External Links: ${externalLinks.size}`);
  log.dim(`  KB Entities: ${kbEntitySlugs.size}`);
  log.dim(`  KB Properties: ${kbPropertyIds.size}`);
  console.log();

  const files: string[] = findMdxFiles(CONTENT_DIR);
  log.dim(`Checking ${files.length} MDX files...`);
  console.log();

  const issues: ValidationIssues = {
    missingRefs: [],
    unusedImports: [],
    noDataForComponent: [],
    brokenKbfRefs: [],
  };

  for (const file of files) {
    const relPath: string = formatPath(file);
    const rawContent: string = readFileSync(file, 'utf-8');
    // Strip fenced code blocks to avoid false positives from example code
    const content: string = stripFencedCodeBlocks(rawContent);

    // Check imports
    const imports: ParsedImport[] = parseImports(content);
    const unused: UnusedImport[] = findUnusedImports(content, imports);

    for (const u of unused) {
      issues.unusedImports.push({ file: relPath, component: u.component, source: u.source });
    }

    // Check component references
    const refs: ComponentRef[] = findComponentRefs(content);

    for (const ref of refs) {
      let isValid = true;
      let dataSource = 'unknown';

      switch (ref.component) {
        case 'EntityLink':
          isValid = entities.has(ref.value) ||
                    ref.value.startsWith('__index__/');
          dataSource = 'entities/pages';
          break;

        case 'DataInfoBox':
          isValid = entities.has(ref.value);
          dataSource = 'entities';
          break;

        case 'DataExternalLinks':
          isValid = externalLinks.has(ref.value);
          dataSource = 'external-links.yaml';
          if (!isValid) {
            issues.noDataForComponent.push({
              file: relPath,
              line: ref.line,
              component: ref.component,
              value: ref.value,
              dataSource,
            });
          }
          continue;
      }

      if (!isValid) {
        issues.missingRefs.push({
          file: relPath,
          line: ref.line,
          component: ref.component,
          prop: ref.prop,
          value: ref.value,
          dataSource,
        });
      }
    }

    // Validate KBF / KBFactValue references
    if (kbEntitySlugs.size > 0 || kbPropertyIds.size > 0) {
      for (const ref of findKbfRefs(content)) {
        if (kbEntitySlugs.size > 0 && !kbEntitySlugs.has(ref.entity)) {
          issues.brokenKbfRefs.push({
            file: relPath,
            line: ref.line,
            component: ref.component,
            entity: ref.entity,
            property: ref.property,
            reason: 'unknown-entity',
          });
        } else if (kbPropertyIds.size > 0 && !kbPropertyIds.has(ref.property)) {
          issues.brokenKbfRefs.push({
            file: relPath,
            line: ref.line,
            component: ref.component,
            entity: ref.entity,
            property: ref.property,
            reason: 'unknown-property',
          });
        }
      }
    }
  }

  // Report results
  let hasErrors = false;

  if (issues.missingRefs.length > 0) {
    hasErrors = true;
    console.log(`${c.red}${c.bold}Missing References (${issues.missingRefs.length})${c.reset}`);
    log.dim('These components reference data that doesn\'t exist');
    console.log();

    for (const ref of issues.missingRefs) {
      console.log(`  ${c.red}${ref.file}:${ref.line}${c.reset}`);
      console.log(`    <${ref.component} ${ref.prop}="${c.yellow}${ref.value}${c.reset}" />`);
      log.dim(`    Not found in: ${ref.dataSource}`);
      console.log();
    }
  }

  if (issues.noDataForComponent.length > 0) {
    console.log(`${c.yellow}${c.bold}Components With No Data (${issues.noDataForComponent.length})${c.reset}`);
    log.dim('These components will render nothing (consider removing)');
    console.log();

    for (const ref of issues.noDataForComponent) {
      console.log(`  ${c.yellow}${ref.file}:${ref.line}${c.reset}`);
      console.log(`    <${ref.component} pageId="${ref.value}" />`);
      log.dim(`    No entry in: ${ref.dataSource}`);
      console.log();
    }
  }

  if (issues.brokenKbfRefs.length > 0) {
    console.log(`${c.yellow}${c.bold}Broken KBF References (${issues.brokenKbfRefs.length})${c.reset}`);
    log.dim('<KBF> or <KBFactValue> referencing unknown entity or property — will show red badge at runtime');
    console.log();

    for (const ref of issues.brokenKbfRefs) {
      console.log(`  ${c.yellow}${ref.file}:${ref.line}${c.reset}`);
      const desc = ref.reason === 'unknown-entity'
        ? `entity "${ref.entity}" not found in packages/kb/data/things/`
        : `property "${ref.property}" not found in packages/kb/data/properties.yaml`;
      console.log(`    <${ref.component} entity="${ref.entity}" property="${ref.property}" />`);
      log.dim(`    ${desc}`);
      console.log();
    }
  }

  if (issues.unusedImports.length > 0) {
    console.log(`${c.yellow}${c.bold}Unused Imports (${issues.unusedImports.length})${c.reset}`);
    log.dim('These components are imported but never used');
    console.log();

    const byFile: Record<string, string[]> = {};
    for (const u of issues.unusedImports) {
      if (!byFile[u.file]) byFile[u.file] = [];
      byFile[u.file].push(u.component);
    }

    for (const [file, components] of Object.entries(byFile)) {
      console.log(`  ${c.yellow}${file}${c.reset}`);
      log.dim(`    Unused: ${components.join(', ')}`);
      console.log();
    }
  }

  // Summary
  console.log(`${c.bold}Summary${c.reset}`);
  console.log(`  Files checked: ${files.length}`);
  console.log(`  ${c.red}Missing references: ${issues.missingRefs.length}${c.reset}`);
  console.log(`  ${c.yellow}No-data components: ${issues.noDataForComponent.length}${c.reset}`);
  console.log(`  ${c.yellow}Broken KBF refs: ${issues.brokenKbfRefs.length}${c.reset}`);
  console.log(`  ${c.yellow}Unused imports: ${issues.unusedImports.length}${c.reset}`);

  if (hasErrors) {
    console.log(`\n${c.red}${c.bold}Validation failed with errors${c.reset}`);
    process.exit(1);
  } else if (issues.noDataForComponent.length > 0 || issues.unusedImports.length > 0) {
    console.log(`\n${c.yellow}${c.bold}Validation passed with warnings${c.reset}`);
    process.exit(0);
  } else {
    console.log(`\n${c.green}${c.bold}All component references valid${c.reset}`);
    process.exit(0);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('Validator error:', err);
    process.exit(1);
  });
}
