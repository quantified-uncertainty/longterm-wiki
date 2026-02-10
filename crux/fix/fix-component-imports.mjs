#!/usr/bin/env node

/**
 * Component Import Auto-Fixer
 *
 * Scans MDX files for JSX component usage and ensures they're properly imported.
 * Catches missing imports before CI fails with "Expected component to be defined".
 *
 * Usage:
 *   node crux/crux.mjs fix imports              # Preview changes (dry run)
 *   node crux/crux.mjs fix imports --apply      # Apply changes
 *   node crux/crux.mjs fix imports --verbose    # Show detailed info
 *   node crux/crux.mjs fix imports --file path  # Fix single file
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { findMdxFiles } from '../lib/file-utils.mjs';
import { getColors } from '../lib/output.mjs';
import { PROJECT_ROOT, CONTENT_DIR_ABS as CONTENT_DIR } from '../lib/content-types.js';

const args = process.argv.slice(2);
const APPLY_MODE = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const HELP = args.includes('--help');
const SINGLE_FILE = args.find(a => a.startsWith('--file='))?.split('=')[1];

const colors = getColors();

// Components from @components/wiki that are commonly used
const WIKI_COMPONENTS = [
  'EntityLink',
  'DataInfoBox',
  'InfoBox',
  'Backlinks',
  'Mermaid',
  'R',
  'DataExternalLinks',
  'EstimateBox',
  'QuoteBox',
  'Timeline',
  'ComparisonTable',
];

// Pattern to find JSX component usage: <ComponentName or <ComponentName>
const COMPONENT_USAGE_PATTERN = /<([A-Z][a-zA-Z0-9]*)/g;

// Pattern to find imports from @components/wiki
const WIKI_IMPORT_PATTERN = /import\s*\{([^}]+)\}\s*from\s*['"]@components\/wiki['"]/;

// Pattern to find any import that includes a component name
const anyImportPattern = (component) => new RegExp(`import.*\\b${component}\\b.*from`);

function showHelp() {
  console.log(`
${colors.bold}Component Import Auto-Fixer${colors.reset}

Ensures all JSX components used in MDX files are properly imported.

${colors.bold}Usage:${colors.reset}
  crux fix imports              Preview changes (dry run)
  crux fix imports --apply      Apply changes to files
  crux fix imports --verbose    Show detailed match info
  crux fix imports --file=path  Fix single file only

${colors.bold}Detected components:${colors.reset}
  ${WIKI_COMPONENTS.join(', ')}

${colors.bold}What it does:${colors.reset}
  - Scans MDX body for <ComponentName usage
  - Checks if component is imported from @components/wiki
  - Either adds to existing import or creates new one
  - Skips components in code blocks
`);
}

/**
 * Check if position is inside a code block
 */
function isInCodeBlock(content, position) {
  const before = content.slice(0, position);
  const codeBlocksBefore = (before.match(/```/g) || []).length;
  if (codeBlocksBefore % 2 === 1) return true;

  // In inline code
  const lastBacktick = before.lastIndexOf('`');
  const lastDoubleBacktick = before.lastIndexOf('``');
  if (lastBacktick > lastDoubleBacktick) {
    const afterBacktick = before.slice(lastBacktick + 1);
    if (!afterBacktick.includes('`')) return true;
  }

  return false;
}

/**
 * Find used wiki components in content
 */
function findUsedComponents(content) {
  const used = new Set();
  let match;
  const regex = new RegExp(COMPONENT_USAGE_PATTERN.source, 'g');

  while ((match = regex.exec(content)) !== null) {
    if (!isInCodeBlock(content, match.index)) {
      const componentName = match[1];
      if (WIKI_COMPONENTS.includes(componentName)) {
        used.add(componentName);
      }
    }
  }

  return used;
}

/**
 * Find imported components from @components/wiki
 */
function findImportedComponents(content) {
  const imported = new Set();

  // Check @components/wiki import
  const wikiImportMatch = content.match(WIKI_IMPORT_PATTERN);
  if (wikiImportMatch) {
    const importList = wikiImportMatch[1];
    const components = importList.split(',').map(c => c.trim()).filter(Boolean);
    components.forEach(c => imported.add(c));
  }

  // Check individual imports for each wiki component
  for (const component of WIKI_COMPONENTS) {
    if (anyImportPattern(component).test(content)) {
      imported.add(component);
    }
  }

  return imported;
}

/**
 * Process a single file
 */
function processFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');

  // Find frontmatter end
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  const bodyStart = fmMatch ? fmMatch[0].length : 0;
  const body = content.slice(bodyStart);

  const usedComponents = findUsedComponents(body);
  const importedComponents = findImportedComponents(content);

  // Find missing imports
  const missing = [...usedComponents].filter(c => !importedComponents.has(c));

  if (missing.length === 0) {
    return { changes: [], content };
  }

  // Generate fix
  let fixedContent = content;
  const wikiImportMatch = content.match(WIKI_IMPORT_PATTERN);

  if (wikiImportMatch) {
    // Add to existing import
    const existingImports = wikiImportMatch[1].trim();
    const newImports = `${existingImports}, ${missing.join(', ')}`;
    const quoteChar = wikiImportMatch[0].includes("'") ? "'" : '"';
    fixedContent = content.replace(
      WIKI_IMPORT_PATTERN,
      `import {${newImports}} from ${quoteChar}@components/wiki${quoteChar}`
    );
  } else {
    // Add new import after frontmatter
    const importStatement = `import { ${missing.join(', ')} } from '@components/wiki';`;
    const lines = content.split('\n');

    // Find end of frontmatter
    let fmCount = 0;
    let insertIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '---') {
        fmCount++;
        if (fmCount === 2) {
          insertIdx = i + 1;
          break;
        }
      }
    }

    lines.splice(insertIdx, 0, importStatement);
    fixedContent = lines.join('\n');
  }

  return {
    changes: missing.map(c => ({
      component: c,
      action: wikiImportMatch ? 'added-to-existing' : 'created-new-import',
    })),
    content: fixedContent,
    originalContent: content,
    hasExistingImport: !!wikiImportMatch,
  };
}

async function main() {
  if (HELP) {
    showHelp();
    process.exit(0);
  }

  console.log(`${colors.bold}${colors.blue}Component Import Auto-Fixer${colors.reset}`);
  console.log(`${colors.dim}Mode: ${APPLY_MODE ? 'APPLY CHANGES' : 'Preview (dry run)'}${colors.reset}\n`);

  let files;
  if (SINGLE_FILE) {
    const fullPath = SINGLE_FILE.startsWith('/') ? SINGLE_FILE : join(PROJECT_ROOT, SINGLE_FILE);
    if (!existsSync(fullPath)) {
      console.error(`File not found: ${SINGLE_FILE}`);
      process.exit(1);
    }
    files = [fullPath];
  } else {
    files = findMdxFiles(CONTENT_DIR);
  }

  let totalChanges = 0;
  let filesChanged = 0;

  for (const file of files) {
    const relPath = relative(PROJECT_ROOT, file);
    const result = processFile(file);

    if (result.changes.length === 0) continue;

    filesChanged++;
    totalChanges += result.changes.length;

    console.log(`${colors.cyan}${relPath}${colors.reset}`);
    for (const change of result.changes) {
      if (change.action === 'added-to-existing') {
        console.log(`  ${colors.green}+${colors.reset} Added ${colors.bold}${change.component}${colors.reset} to existing import`);
      } else {
        console.log(`  ${colors.green}+${colors.reset} Created import for ${colors.bold}${change.component}${colors.reset}`);
      }
    }

    if (APPLY_MODE) {
      writeFileSync(file, result.content);
      console.log(`  ${colors.green}✓${colors.reset} Saved`);
    }
  }

  console.log();
  console.log(`${colors.bold}Summary:${colors.reset}`);
  console.log(`  ${totalChanges} missing import(s) in ${filesChanged} file(s)`);

  if (!APPLY_MODE && totalChanges > 0) {
    console.log();
    console.log(`${colors.yellow}Run with --apply to fix these files${colors.reset}`);
  }

  if (APPLY_MODE && totalChanges > 0) {
    console.log();
    console.log(`${colors.green}✓ Fixed ${totalChanges} imports in ${filesChanged} files${colors.reset}`);
    console.log(`${colors.dim}Run 'node crux/crux.mjs validate compile --quick' to verify${colors.reset}`);
  }

  // Exit with error if there are unfixed issues (for CI)
  if (!APPLY_MODE && totalChanges > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
