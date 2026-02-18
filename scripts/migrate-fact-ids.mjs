#!/usr/bin/env node
/**
 * Migration script: Convert human-readable fact IDs to hash-based IDs.
 *
 * What this does:
 * 1. Reads all fact YAML files in data/facts/
 * 2. Generates 8-char random hex IDs for each fact
 * 3. Builds old→new ID mapping
 * 4. Rewrites YAML files with new IDs (preserving all data, adding explicit measure)
 * 5. Updates all MDX files: <F> references, <Calc> expressions
 * 6. Writes the mapping to scripts/fact-id-mapping.json for reference
 *
 * Usage:
 *   node scripts/migrate-fact-ids.mjs          # Dry run (show what would change)
 *   node scripts/migrate-fact-ids.mjs --apply  # Apply changes
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { randomBytes } from 'crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const FACTS_DIR = join(ROOT, 'data/facts');
const CONTENT_DIR = join(ROOT, 'content/docs');
const FACT_MEASURES_PATH = join(ROOT, 'data/fact-measures.yaml');

const dryRun = !process.argv.includes('--apply');

if (dryRun) {
  console.log('🔍 DRY RUN — pass --apply to write changes\n');
}

// ─── Step 1: Load fact measures for auto-inference logic ─────────────────────

const knownMeasureIds = [];
if (existsSync(FACT_MEASURES_PATH)) {
  const measuresContent = readFileSync(FACT_MEASURES_PATH, 'utf-8');
  const measuresParsed = parseYaml(measuresContent);
  if (measuresParsed?.measures) {
    knownMeasureIds.push(...Object.keys(measuresParsed.measures));
  }
}

/**
 * Infer measure from old fact ID (replicates build-data.mjs logic)
 */
function inferMeasure(factId) {
  // 1. Exact match
  if (knownMeasureIds.includes(factId)) return factId;
  // 2. Longest prefix match
  let bestMatch = null;
  let bestLen = 0;
  for (const measureId of knownMeasureIds) {
    if (factId.startsWith(measureId + '-') && measureId.length > bestLen) {
      bestMatch = measureId;
      bestLen = measureId.length;
    }
  }
  return bestMatch;
}

// ─── Step 2: Generate IDs and build mapping ──────────────────────────────────

function generateFactId() {
  return randomBytes(4).toString('hex'); // 8 hex chars
}

// Ensure no collisions
const usedIds = new Set();
function uniqueFactId() {
  let id;
  do {
    id = generateFactId();
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

// mapping: { "entity.oldFactId" → { newId, entity, oldId } }
const mapping = {};
// Per-entity mapping for YAML rewriting: { entity → { oldId → newId } }
const entityMappings = {};

const factFiles = readdirSync(FACTS_DIR).filter(f => f.endsWith('.yaml'));

for (const file of factFiles) {
  const filepath = join(FACTS_DIR, file);
  const content = readFileSync(filepath, 'utf-8');
  const parsed = parseYaml(content);

  if (!parsed?.entity || !parsed?.facts) continue;

  const entity = parsed.entity;
  entityMappings[entity] = {};

  for (const oldId of Object.keys(parsed.facts)) {
    const newId = uniqueFactId();
    const compositeOld = `${entity}.${oldId}`;
    const compositeNew = `${entity}.${newId}`;
    mapping[compositeOld] = { newId, entity, oldId, compositeNew };
    entityMappings[entity][oldId] = newId;
  }
}

console.log(`📋 Mapped ${Object.keys(mapping).length} facts across ${factFiles.length} files\n`);

// Show mapping
for (const [oldKey, info] of Object.entries(mapping)) {
  console.log(`  ${oldKey} → ${info.compositeNew}`);
}
console.log('');

// ─── Step 3: Rewrite YAML files ─────────────────────────────────────────────

for (const file of factFiles) {
  const filepath = join(FACTS_DIR, file);
  const content = readFileSync(filepath, 'utf-8');
  const parsed = parseYaml(content);

  if (!parsed?.entity || !parsed?.facts) continue;

  const entity = parsed.entity;
  const newFacts = {};

  for (const [oldId, factData] of Object.entries(parsed.facts)) {
    const newId = entityMappings[entity][oldId];

    // Determine if we need to add explicit measure
    const existingMeasure = factData.measure;
    const hasMeasureField = 'measure' in factData;
    const inferredMeasure = inferMeasure(oldId);

    const newFactData = { ...factData };

    // If measure was auto-inferred from the old ID but not explicit, add it
    if (!hasMeasureField && !factData.noCompute && inferredMeasure) {
      newFactData.measure = inferredMeasure;
    }

    newFacts[newId] = newFactData;
  }

  const newParsed = { entity, facts: newFacts };

  // Use YAML stringify with comments showing old IDs for reference
  let yamlOutput = `entity: ${entity}\nfacts:\n`;

  for (const [newId, factData] of Object.entries(newFacts)) {
    // Find original old ID for this fact
    const oldId = Object.entries(entityMappings[entity])
      .find(([, nid]) => nid === newId)?.[0];

    // Build YAML for this fact manually to preserve comment with old ID
    const factObj = {};
    factObj[newId] = factData;
    const factYaml = stringifyYaml(factObj, { indent: 2, lineWidth: 0 });

    // Add comment showing the old human-readable ID
    yamlOutput += `  # ${oldId}\n`;
    yamlOutput += factYaml.split('\n').map(line => line ? `  ${line}` : '').filter(Boolean).join('\n') + '\n\n';
  }

  if (!dryRun) {
    writeFileSync(filepath, yamlOutput);
    console.log(`✅ Rewrote ${file}`);
  } else {
    console.log(`Would rewrite ${file}`);
  }
}

// ─── Step 4: Update MDX files ────────────────────────────────────────────────

function findMdxFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMdxFiles(fullPath));
    } else if (entry.name.endsWith('.mdx')) {
      files.push(fullPath);
    }
  }
  return files;
}

const mdxFiles = findMdxFiles(CONTENT_DIR);
let mdxUpdated = 0;

for (const mdxPath of mdxFiles) {
  let content = readFileSync(mdxPath, 'utf-8');
  let changed = false;

  // Update <F e="entity" f="oldId"> references
  content = content.replace(
    /<F\s+e="([^"]+)"\s+f="([^"]+)"/g,
    (match, entity, factId) => {
      const compositeKey = `${entity}.${factId}`;
      const info = mapping[compositeKey];
      if (info) {
        changed = true;
        return `<F e="${entity}" f="${info.newId}"`;
      }
      return match;
    }
  );

  // Update {entity.factId} references in Calc expressions and computed facts
  // These appear in expr="..." attributes and compute: fields
  content = content.replace(
    /\{([a-z][a-z0-9-]*)\.([ a-z][a-z0-9-]*)\}/g,
    (match, entity, factId) => {
      const compositeKey = `${entity}.${factId}`;
      const info = mapping[compositeKey];
      if (info) {
        changed = true;
        return `{${entity}.${info.newId}}`;
      }
      return match;
    }
  );

  if (changed) {
    mdxUpdated++;
    if (!dryRun) {
      writeFileSync(mdxPath, content);
      console.log(`✅ Updated ${relative(ROOT, mdxPath)}`);
    } else {
      console.log(`Would update ${relative(ROOT, mdxPath)}`);
    }
  }
}

console.log(`\n📝 ${mdxUpdated} MDX files ${dryRun ? 'would be' : 'were'} updated`);

// ─── Step 5: Update computed facts in YAML (compute: expressions) ────────────

for (const file of factFiles) {
  const filepath = join(FACTS_DIR, file);
  let content = readFileSync(filepath, 'utf-8');
  let changed = false;

  // Update {entity.factId} in compute: expressions within YAML
  content = content.replace(
    /\{([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)\}/g,
    (match, entity, factId) => {
      const compositeKey = `${entity}.${factId}`;
      const info = mapping[compositeKey];
      if (info) {
        changed = true;
        return `{${entity}.${info.newId}}`;
      }
      return match;
    }
  );

  if (changed && !dryRun) {
    writeFileSync(filepath, content);
    console.log(`✅ Updated compute expressions in ${file}`);
  }
}

// ─── Step 6: Write mapping file ──────────────────────────────────────────────

const mappingPath = join(ROOT, 'scripts/fact-id-mapping.json');
const mappingForExport = {};
for (const [oldKey, info] of Object.entries(mapping)) {
  mappingForExport[oldKey] = info.compositeNew;
}
if (!dryRun) {
  writeFileSync(mappingPath, JSON.stringify(mappingForExport, null, 2) + '\n');
  console.log(`\n✅ Mapping saved to scripts/fact-id-mapping.json`);
}

console.log(`\n${dryRun ? '🔍 DRY RUN complete. Pass --apply to write changes.' : '✅ Migration complete!'}`);
