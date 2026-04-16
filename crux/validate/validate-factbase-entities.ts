#!/usr/bin/env node

/**
 * FactBase Entity Validation — verify every FactBase YAML file's entity
 * has a corresponding TableBase entry.
 *
 * For each YAML file in packages/factbase/data/fb-entities/:
 *   - If file has `thing:` block: extract stableId
 *   - If file has `entity:` key: use the stableId directly
 *   - Check that stableId exists in data/entities/*.yaml
 *   - Report mismatches
 *
 * Usage:
 *   npx tsx crux/validate/validate-factbase-entities.ts
 *   npx tsx crux/validate/validate-factbase-entities.ts --verbose
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const KB_THINGS_DIR = join(PROJECT_ROOT, 'packages', 'factbase', 'data', 'things');
const ENTITIES_DIR = join(PROJECT_ROOT, 'data', 'entities');
const verbose = process.argv.includes('--verbose');

interface EntityEntry {
  stableId?: string;
  [key: string]: unknown;
}

/**
 * Load all stableIds from TableBase entities (data/entities/*.yaml).
 *
 * Entity YAML files contain either:
 * - A flat YAML array of entity objects (e.g., organizations.yaml, people.yaml)
 * - A single entity object
 */
function loadTableBaseStableIds(): Set<string> {
  const ids = new Set<string>();
  const entries = readdirSync(ENTITIES_DIR);
  const yamlFiles = entries.filter(
    (e) => extname(e) === '.yaml' || extname(e) === '.yml',
  );

  for (const filename of yamlFiles) {
    const filePath = join(ENTITIES_DIR, filename);
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(content) as EntityEntry[] | EntityEntry | null;

    if (!parsed) continue;

    // Entity files are typically flat YAML arrays of entity objects
    if (Array.isArray(parsed)) {
      for (const entity of parsed) {
        if (entity.stableId && typeof entity.stableId === 'string') {
          ids.add(entity.stableId);
        }
      }
    } else if (typeof parsed === 'object' && parsed.stableId && typeof parsed.stableId === 'string') {
      // Single entity object
      ids.add(parsed.stableId);
    }
  }

  return ids;
}

/**
 * Extract the stableId from a FactBase YAML file.
 * Returns the stableId or null if it can't be determined.
 */
function extractStableIdFromFile(content: string): { stableId: string | null; format: 'thing' | 'entity' | 'unknown' } {
  // Check for entity: format first
  const entityMatch = content.match(/^entity:\s*(\S+)/m);
  if (entityMatch && !content.match(/^thing:/m)) {
    return { stableId: entityMatch[1], format: 'entity' };
  }

  // Check for thing: format
  if (content.match(/^thing:/m)) {
    // Try stableId field (old format)
    const stableIdMatch = content.match(/^\s+stableId:\s*(\S+)/m);
    if (stableIdMatch) {
      return { stableId: stableIdMatch[1], format: 'thing' };
    }

    // New thing format: id is the stableId when slug field exists
    const slugMatch = content.match(/^\s+slug:\s*\S+/m);
    if (slugMatch) {
      const idMatch = content.match(/^\s+id:\s*(\S+)/m);
      if (idMatch) {
        return { stableId: idMatch[1], format: 'thing' };
      }
    }

    // Old format but no stableId (shouldn't happen in practice)
    return { stableId: null, format: 'thing' };
  }

  return { stableId: null, format: 'unknown' };
}

async function main(): Promise<void> {
  console.log('Loading TableBase entity stableIds...');
  const tableBaseIds = loadTableBaseStableIds();
  console.log(`Found ${tableBaseIds.size} TableBase entities\n`);

  const entries = readdirSync(KB_THINGS_DIR);
  const yamlFiles = entries.filter(
    (e) => extname(e) === '.yaml' || extname(e) === '.yml',
  );

  let matched = 0;
  let unmatched = 0;
  let noStableId = 0;
  const mismatches: { filename: string; stableId: string | null; format: string }[] = [];

  for (const filename of yamlFiles.sort()) {
    const filePath = join(KB_THINGS_DIR, filename);
    const content = readFileSync(filePath, 'utf-8');
    const { stableId, format } = extractStableIdFromFile(content);

    if (!stableId) {
      noStableId++;
      if (verbose) {
        console.log(`  \x1b[33mNO ID\x1b[0m ${filename} (format: ${format})`);
      }
      mismatches.push({ filename, stableId: null, format });
      continue;
    }

    if (tableBaseIds.has(stableId)) {
      matched++;
      if (verbose) {
        console.log(`  \x1b[32m  OK \x1b[0m ${filename} -> ${stableId}`);
      }
    } else {
      unmatched++;
      mismatches.push({ filename, stableId, format });
      console.log(`  \x1b[31mMISS\x1b[0m ${filename} -> ${stableId} (not in TableBase)`);
    }
  }

  console.log(`\n\x1b[1mFactBase Entity Validation Results\x1b[0m`);
  console.log(`Total FactBase files: ${yamlFiles.length}`);
  console.log(`  Matched in TableBase: ${matched}`);
  console.log(`  Missing from TableBase: ${unmatched}`);
  if (noStableId > 0) {
    console.log(`  No stableId found: ${noStableId}`);
  }

  if (mismatches.length > 0) {
    console.log(`\n\x1b[33mMismatched entities (${mismatches.length}):\x1b[0m`);
    for (const m of mismatches.slice(0, 20)) {
      console.log(`  ${m.filename}: stableId=${m.stableId ?? '(none)'} format=${m.format}`);
    }
    if (mismatches.length > 20) {
      console.log(`  ... and ${mismatches.length - 20} more`);
    }
  }

  if (unmatched > 0 || noStableId > 0) {
    console.log(
      `\n\x1b[31mError: ${unmatched + noStableId} FactBase entities have coverage gaps ` +
      `(${unmatched} missing from TableBase, ${noStableId} without stableId).\x1b[0m`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FactBase entity validation crashed:', err);
  process.exit(1);
});
