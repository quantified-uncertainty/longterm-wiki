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
 *   node scripts/validate/validate-component-refs.mjs
 *   node scripts/validate/validate-component-refs.mjs --ci
 */

import { readFileSync } from 'fs';

// Use shared libraries
import { findMdxFiles } from '../lib/file-utils.mjs';
import { createLogger, formatPath } from '../lib/output.mjs';
import { CONTENT_DIR, DATA_DIR, loadDatabase as loadDatabaseJson } from '../lib/content-types.js';

const log = createLogger();
const c = log.colors;

// Load data sources
function loadEntities() {
  try {
    const database = loadDatabaseJson();
    return new Set(Object.keys(database.entities || {}));
  } catch {
    log.warn('Warning: Could not load entities database. Run pnpm build first.');
    return new Set();
  }
}

function loadExternalLinks() {
  try {
    const content = readFileSync(`${DATA_DIR}/external-links.yaml`, 'utf-8');
    const pageIds = new Set();
    const matches = content.matchAll(/^- pageId: (.+)$/gm);
    for (const match of matches) {
      pageIds.add(match[1].trim());
    }
    return pageIds;
  } catch {
    return new Set();
  }
}

function loadSafetyApproaches() {
  try {
    const content = readFileSync(`${DATA_DIR}/safety-approaches-data.ts`, 'utf-8');
    const ids = new Set();
    const matches = content.matchAll(/id: ['"]([^'"]+)['"]/g);
    for (const match of matches) {
      ids.add(match[1]);
    }
    return ids;
  } catch {
    return new Set();
  }
}

// Parse imports from MDX file
function parseImports(content) {
  const imports = [];
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const components = match[1].split(',').map(c => c.trim()).filter(Boolean);
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
function findUnusedImports(content, imports) {
  const unused = [];

  for (const imp of imports) {
    for (const component of imp.components) {
      const afterImport = content.slice(imp.index + imp.fullMatch.length);
      const usagePattern = new RegExp(`<${component}[\\s/>]|${component}\\(`);

      if (!usagePattern.test(afterImport)) {
        unused.push({ component, source: imp.source });
      }
    }
  }

  return unused;
}

// Find component usages and validate references
function findComponentRefs(content) {
  const refs = [];

  // EntityLink id="..."
  const entityLinkRegex = /<EntityLink\s+id=["']([^"']+)["']/g;
  let match;
  while ((match = entityLinkRegex.exec(content)) !== null) {
    refs.push({
      component: 'EntityLink',
      prop: 'id',
      value: match[1],
      line: content.slice(0, match.index).split('\n').length,
    });
  }

  // DataInfoBox entityId="..."
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

// Main validation
async function main() {
  log.heading('Component Reference Validator');
  console.log();

  // Load all data sources
  log.dim('Loading data sources...');
  const entities = loadEntities();
  const externalLinks = loadExternalLinks();
  const safetyApproaches = loadSafetyApproaches();

  log.dim(`  Entities: ${entities.size}`);
  log.dim(`  External Links: ${externalLinks.size}`);
  log.dim(`  Safety Approaches: ${safetyApproaches.size}`);
  console.log();

  const files = findMdxFiles(CONTENT_DIR);
  log.dim(`Checking ${files.length} MDX files...`);
  console.log();

  const issues = {
    missingRefs: [],
    unusedImports: [],
    noDataForComponent: [],
  };

  for (const file of files) {
    const relPath = formatPath(file);
    const content = readFileSync(file, 'utf-8');

    // Check imports
    const imports = parseImports(content);
    const unused = findUnusedImports(content, imports);

    for (const u of unused) {
      issues.unusedImports.push({ file: relPath, component: u.component, source: u.source });
    }

    // Check component references
    const refs = findComponentRefs(content);

    for (const ref of refs) {
      let isValid = true;
      let dataSource = 'unknown';

      switch (ref.component) {
        case 'EntityLink':
          isValid = entities.has(ref.value) ||
                    safetyApproaches.has(ref.value) ||
                    ref.value.startsWith('__index__/');
          dataSource = 'entities/safety-approaches';
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

  if (issues.unusedImports.length > 0) {
    console.log(`${c.yellow}${c.bold}Unused Imports (${issues.unusedImports.length})${c.reset}`);
    log.dim('These components are imported but never used');
    console.log();

    const byFile = {};
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

main().catch(err => {
  console.error('Validator error:', err);
  process.exit(1);
});
