/**
 * Migration script: Add entityType to frontmatter of existing MDX pages
 *
 * For each MDX file in entity-required categories:
 *   1. Read frontmatter
 *   2. If entityType already present → skip
 *   3. Look up category → entityType via CATEGORY_ENTITY_TYPES mapping
 *   4. Add `entityType: <type>` to frontmatter (after title/description block)
 *
 * Usage: node crux/scripts/migrate-entity-types.mjs [--dry-run]
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, basename } from 'path';

const CONTENT_DIR = join(import.meta.dirname, '../../content/docs/knowledge-base');

// Matches crux/lib/category-entity-types.ts — entity-required categories only
const CATEGORY_ENTITY_TYPES = {
  people: 'person',
  organizations: 'organization',
  risks: 'risk',
  responses: 'approach',
  models: 'model',
  worldviews: 'concept',
  'intelligence-paradigms': 'intelligence-paradigm',
};

const dryRun = process.argv.includes('--dry-run');

let migrated = 0;
let skipped = 0;
let errors = 0;

function processDir(dir, entityType) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Recurse into subdirectories (same entityType)
      processDir(fullPath, entityType);
      continue;
    }

    if (!entry.endsWith('.mdx') && !entry.endsWith('.md')) continue;
    if (entry === 'index.mdx' || entry === 'index.md') continue;

    const content = readFileSync(fullPath, 'utf-8');

    // Check if file has frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      console.log(`  SKIP (no frontmatter): ${fullPath}`);
      skipped++;
      continue;
    }

    const frontmatterText = fmMatch[1];

    // Check if entityType already present
    if (/^entityType:/m.test(frontmatterText)) {
      skipped++;
      continue;
    }

    // Insert entityType after the frontmatter opening, in a logical position.
    // Place it after 'title' line (or after 'description' if multiline).
    // Strategy: insert `entityType: <type>` as the last line before the closing ---
    // This keeps it visible but non-disruptive to existing field ordering.

    // Find a good insertion point: after quality or after description/sidebar block
    // Simplest safe approach: add it right before the closing ---
    const newContent = content.replace(
      /^(---\n[\s\S]*?)\n---/,
      `$1\nentityType: ${entityType}\n---`
    );

    if (newContent === content) {
      console.log(`  ERROR (replacement failed): ${fullPath}`);
      errors++;
      continue;
    }

    if (dryRun) {
      console.log(`  WOULD MIGRATE: ${basename(fullPath)} → entityType: ${entityType}`);
    } else {
      writeFileSync(fullPath, newContent, 'utf-8');
    }
    migrated++;
  }
}

console.log(`Migration: Adding entityType to frontmatter${dryRun ? ' (DRY RUN)' : ''}\n`);

for (const [category, entityType] of Object.entries(CATEGORY_ENTITY_TYPES)) {
  const categoryDir = join(CONTENT_DIR, category);
  console.log(`Processing ${category}/ → entityType: ${entityType}`);
  try {
    processDir(categoryDir, entityType);
  } catch (e) {
    console.error(`  ERROR processing ${category}: ${e.message}`);
    errors++;
  }
}

console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}, Errors: ${errors}`);
