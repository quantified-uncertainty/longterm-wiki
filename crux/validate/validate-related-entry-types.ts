#!/usr/bin/env node

/**
 * Related Entry Type Mismatch Validator
 *
 * Checks that `relatedEntries[].type` in entity YAML files matches the actual
 * `type` of the referenced entity. This catches bugs like:
 *   - compute-governance referenced as type "policy" but actually type "concept"
 *   - monitoring referenced as type "policy" but actually type "approach"
 *
 * The controlled-vocab validator already checks that the type is a *valid* entity
 * type string. This validator goes further and checks it's the *correct* type
 * for the specific entity being referenced.
 *
 * Usage:
 *   npx tsx crux/validate/validate-related-entry-types.ts
 *   npx tsx crux/validate/validate-related-entry-types.ts --ci
 *   npx tsx crux/validate/validate-related-entry-types.ts --fix  # auto-correct types
 *
 * Exit codes:
 *   0 = No mismatches
 *   1 = Mismatches found
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import type { ValidatorResult } from './types.ts';

// ============================================================================
// TYPES
// ============================================================================

interface EntityRecord {
  id: string;
  type: string;
  title?: string;
  relatedEntries?: Array<{
    id: string;
    type?: string;
    relationship?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface TypeMismatch {
  /** Entity containing the mismatched relatedEntry */
  sourceEntityId: string;
  /** Source YAML file */
  sourceFile: string;
  /** The referenced entity ID */
  referencedEntityId: string;
  /** The type declared in relatedEntries */
  declaredType: string;
  /** The actual type of the referenced entity */
  actualType: string;
}

// ============================================================================
// DATA LOADING
// ============================================================================

const ENTITIES_DIR = join(PROJECT_ROOT, 'data', 'entities');

/**
 * Load all entities from YAML files and build an id→type map.
 */
function loadEntities(): {
  entities: Array<EntityRecord & { _sourceFile: string }>;
  typeMap: Map<string, string>;
} {
  const entities: Array<EntityRecord & { _sourceFile: string }> = [];
  const typeMap = new Map<string, string>();

  const files = readdirSync(ENTITIES_DIR).filter(
    (f) => extname(f) === '.yaml' || extname(f) === '.yml',
  );

  for (const filename of files) {
    const filePath = join(ENTITIES_DIR, filename);
    const content = readFileSync(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch {
      continue; // Schema validation catches parse errors
    }

    if (Array.isArray(parsed)) {
      for (const entity of parsed) {
        if (entity && typeof entity === 'object' && entity.id && entity.type) {
          entities.push({ ...entity, _sourceFile: filename });
          typeMap.set(entity.id, entity.type);
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      const e = parsed as EntityRecord;
      if (e.id && e.type) {
        entities.push({ ...e, _sourceFile: filename as string });
        typeMap.set(e.id, e.type);
      }
    }
  }

  return { entities, typeMap };
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Check all relatedEntries type fields against actual entity types.
 */
export function findTypeMismatches(
  entities: Array<EntityRecord & { _sourceFile: string }>,
  typeMap: Map<string, string>,
): TypeMismatch[] {
  const mismatches: TypeMismatch[] = [];

  for (const entity of entities) {
    if (!Array.isArray(entity.relatedEntries)) continue;

    for (const entry of entity.relatedEntries) {
      if (!entry.id || !entry.type) continue;

      const actualType = typeMap.get(entry.id);
      if (!actualType) continue; // Dangling ref — yaml-entity-ref-check handles this

      if (entry.type !== actualType) {
        mismatches.push({
          sourceEntityId: entity.id,
          sourceFile: entity._sourceFile,
          referencedEntityId: entry.id,
          declaredType: entry.type,
          actualType,
        });
      }
    }
  }

  return mismatches;
}

// ============================================================================
// AUTO-FIX
// ============================================================================

/**
 * Fix type mismatches by rewriting the YAML files.
 * Returns the number of fixes applied.
 */
function autoFixMismatches(
  mismatches: TypeMismatch[],
): number {
  // Group mismatches by source file
  const byFile = new Map<string, TypeMismatch[]>();
  for (const m of mismatches) {
    const existing = byFile.get(m.sourceFile) || [];
    existing.push(m);
    byFile.set(m.sourceFile, existing);
  }

  let fixCount = 0;

  for (const [filename, fileMismatches] of byFile) {
    const filePath = join(ENTITIES_DIR, filename);
    const content = readFileSync(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch {
      continue;
    }

    // Normalize to array for uniform handling (single-object YAML files are rare but possible)
    const entityList = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    if (entityList.length === 0) continue;

    // Build a lookup of which entries to fix
    const fixMap = new Map<string, Map<string, string>>(); // sourceEntityId → (refId → actualType)
    for (const m of fileMismatches) {
      const entityFixes = fixMap.get(m.sourceEntityId) || new Map();
      entityFixes.set(m.referencedEntityId, m.actualType);
      fixMap.set(m.sourceEntityId, entityFixes);
    }

    let modified = false;
    for (const entity of entityList) {
      if (!entity?.id || !Array.isArray(entity.relatedEntries)) continue;

      const entityFixes = fixMap.get(entity.id);
      if (!entityFixes) continue;

      for (const entry of entity.relatedEntries) {
        const correctType = entityFixes.get(entry.id);
        if (correctType && entry.type !== correctType) {
          entry.type = correctType;
          fixCount++;
          modified = true;
        }
      }
    }

    if (modified) {
      // Note: stringifyYaml rewrites the file — comments and formatting may change.
      // This is consistent with other --fix operations in the codebase.
      const output = Array.isArray(parsed)
        ? stringifyYaml(entityList, { lineWidth: 120 })
        : stringifyYaml(entityList[0], { lineWidth: 120 });
      writeFileSync(filePath, output);
    }
  }

  return fixCount;
}

// ============================================================================
// MAIN
// ============================================================================

export function runRelatedEntryTypeCheck(options?: {
  fix?: boolean;
}): ValidatorResult & { mismatches: TypeMismatch[] } {
  const { entities, typeMap } = loadEntities();
  const mismatches = findTypeMismatches(entities, typeMap);

  if (options?.fix && mismatches.length > 0) {
    autoFixMismatches(mismatches);
  }

  return {
    passed: mismatches.length === 0,
    errors: mismatches.length,
    warnings: 0,
    mismatches,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const CI_MODE = args.includes('--ci');
  const FIX_MODE = args.includes('--fix');
  const c = getColors(CI_MODE);

  const { entities, typeMap } = loadEntities();
  const mismatches = findTypeMismatches(entities, typeMap);

  if (FIX_MODE && mismatches.length > 0) {
    const fixCount = autoFixMismatches(mismatches);
    if (!CI_MODE) {
      console.log(`${c.green}Fixed ${fixCount} type mismatch(es) in entity YAML files.${c.reset}\n`);
    }
    // Re-check after fix
    const { entities: entities2, typeMap: typeMap2 } = loadEntities();
    const remaining = findTypeMismatches(entities2, typeMap2);
    if (remaining.length === 0) {
      if (!CI_MODE) {
        console.log(`${c.green}All relatedEntries type fields now match actual entity types.${c.reset}`);
      }
      process.exit(0);
    }
    // Fall through to report remaining
  }

  if (CI_MODE) {
    console.log(JSON.stringify({
      passed: mismatches.length === 0,
      errors: mismatches.length,
      warnings: 0,
      mismatches: mismatches.map((m) => ({
        source: m.sourceEntityId,
        ref: m.referencedEntityId,
        declared: m.declaredType,
        actual: m.actualType,
        file: m.sourceFile,
      })),
    }, null, 2));
  } else {
    console.log(`${c.bold}Related Entry Type Validation${c.reset}`);
    console.log(`${c.dim}  Checked ${entities.length} entities, ${typeMap.size} types in registry${c.reset}\n`);

    if (mismatches.length === 0) {
      console.log(`${c.green}  All relatedEntries type fields match actual entity types.${c.reset}\n`);
    } else {
      console.log(`${c.red}  ${mismatches.length} type mismatch(es) found:${c.reset}\n`);

      for (const m of mismatches) {
        console.log(
          `  ${c.red}MISMATCH${c.reset} ${m.sourceEntityId} → ${m.referencedEntityId}`,
        );
        console.log(
          `    declared: ${c.yellow}${m.declaredType}${c.reset}  actual: ${c.green}${m.actualType}${c.reset}`,
        );
        console.log(`    ${c.dim}file: data/entities/${m.sourceFile}${c.reset}`);
        console.log();
      }

      console.log(`${c.dim}  Run with --fix to auto-correct these type fields.${c.reset}\n`);
    }
  }

  process.exit(mismatches.length > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
