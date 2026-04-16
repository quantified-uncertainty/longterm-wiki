#!/usr/bin/env node

/**
 * FactBase ↔ TableBase Entity ID Consistency Validator
 *
 * Ensures that FactBase entity files and TableBase entity YAML are in sync:
 * - No duplicate entity IDs within people.yaml / organizations.yaml
 * - FactBase stableIds match their TableBase counterparts
 * - FactBase filenames (slugs) match TableBase entity IDs
 * - Every FactBase entity has a TableBase entry
 *
 * This is a CI-blocking check. Run via:
 *   pnpm crux validate factbase-entity-ids
 *   pnpm crux w validate gate --fix  (included automatically)
 *
 * Usage: npx tsx crux/validate/validate-factbase-entity-ids.ts [--ci] [--fix]
 */

import { readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { renameSync } from 'fs';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { ValidatorResult } from './types.ts';

const FACTBASE_DIR = join(PROJECT_ROOT, 'packages/factbase/data/fb-entities');
const ENTITIES_DIR = join(PROJECT_ROOT, 'data/entities');

const args = process.argv.slice(2);
const CI_MODE = args.includes('--ci');
const FIX_MODE = args.includes('--fix');
const c = getColors(CI_MODE);

// ── Load all TableBase entities ────────────────────────────────────────────

interface TableBaseEntity {
  id: string; // slug
  stableId: string;
  type: string;
  title?: string;
  file: string; // which YAML file it came from
}

function loadTableBaseEntities(): TableBaseEntity[] {
  const entities: TableBaseEntity[] = [];
  const yamlFiles = readdirSync(ENTITIES_DIR).filter((f) => f.endsWith('.yaml'));

  for (const file of yamlFiles) {
    const path = join(ENTITIES_DIR, file);
    const content = readFileSync(path, 'utf-8');
    const parsed = parseYaml(content);
    if (!Array.isArray(parsed)) continue;

    for (const entry of parsed) {
      if (entry?.id && entry?.stableId) {
        entities.push({
          id: entry.id,
          stableId: entry.stableId,
          type: entry.type || 'unknown',
          title: entry.title,
          file,
        });
      }
    }
  }

  return entities;
}

// ── Load all FactBase entities ─────────────────────────────────────────────

interface FactBaseEntity {
  slug: string; // filename without .yaml
  stableId: string;
  type?: string;
  file: string;
}

function loadFactBaseEntities(): FactBaseEntity[] {
  const entities: FactBaseEntity[] = [];
  const yamlFiles = readdirSync(FACTBASE_DIR).filter((f) => f.endsWith('.yaml'));

  for (const file of yamlFiles) {
    const slug = basename(file, '.yaml');
    const path = join(FACTBASE_DIR, file);
    const content = readFileSync(path, 'utf-8');
    const parsed = parseYaml(content);

    let stableId: string | undefined;
    let type: string | undefined;

    // New format: thing: { id, stableId, type }
    if (parsed?.thing?.stableId) {
      stableId = parsed.thing.stableId;
      type = parsed.thing.type;
    }
    // Old format: entity: <stableId>
    else if (typeof parsed?.entity === 'string') {
      stableId = parsed.entity;
    }

    if (stableId) {
      entities.push({ slug, stableId, type, file });
    }
  }

  return entities;
}

// ── Validation ─────────────────────────────────────────────────────────────

export function runCheck(): ValidatorResult {
  const tableBase = loadTableBaseEntities();
  const factBase = loadFactBaseEntities();

  // Build lookup maps
  const tbBySlug = new Map<string, TableBaseEntity[]>();
  const tbByStableId = new Map<string, TableBaseEntity>();

  for (const e of tableBase) {
    const existing = tbBySlug.get(e.id) || [];
    existing.push(e);
    tbBySlug.set(e.id, existing);
    tbByStableId.set(e.stableId, e);
  }

  let errors = 0;
  let warnings = 0;
  const fixes: Array<{ type: string; detail: string }> = [];

  console.log(`${c.bold}FactBase ↔ TableBase Entity Consistency${c.reset}\n`);
  console.log(`  FactBase entities: ${factBase.length}`);
  console.log(`  TableBase entities: ${tableBase.length}\n`);

  // 1. Check for duplicate entity IDs in TableBase
  for (const [slug, entries] of tbBySlug) {
    if (entries.length > 1) {
      errors++;
      const files = entries.map((e) => e.file).join(', ');
      const stableIds = entries.map((e) => e.stableId).join(', ');
      console.log(
        `${c.red}DUPLICATE${c.reset} TableBase ID "${slug}" appears ${entries.length} times (files: ${files}, stableIds: ${stableIds})`,
      );
    }
  }

  // 2. Check each FactBase entity against TableBase
  for (const fb of factBase) {
    // Find matching TableBase entry by stableId
    const tbByStable = tbByStableId.get(fb.stableId);

    if (!tbByStable) {
      errors++;
      console.log(
        `${c.red}MISSING${c.reset} FactBase entity "${fb.slug}" (stableId: ${fb.stableId}) has no TableBase entry`,
      );
      continue;
    }

    // Check stableId consistency (should match since we looked up by stableId)
    // But also check if there's a TableBase entry with matching slug but different stableId
    const tbBySlugMatch = tbBySlug.get(fb.slug);
    if (tbBySlugMatch) {
      for (const tbEntry of tbBySlugMatch) {
        if (tbEntry.stableId !== fb.stableId) {
          errors++;
          console.log(
            `${c.red}STABLEID MISMATCH${c.reset} "${fb.slug}" — FactBase: ${fb.stableId}, TableBase: ${tbEntry.stableId} (${tbEntry.file})`,
          );
        }
      }
    }

    // Check slug consistency — FactBase filename should match TableBase ID
    if (tbByStable.id !== fb.slug) {
      if (FIX_MODE) {
        const oldPath = join(FACTBASE_DIR, `${fb.slug}.yaml`);
        const newPath = join(FACTBASE_DIR, `${tbByStable.id}.yaml`);
        try {
          renameSync(oldPath, newPath);
          fixes.push({
            type: 'slug-rename',
            detail: `${fb.slug}.yaml → ${tbByStable.id}.yaml`,
          });
          console.log(
            `${c.green}FIXED${c.reset} slug mismatch: renamed ${fb.slug}.yaml → ${tbByStable.id}.yaml`,
          );
        } catch {
          errors++;
          console.log(
            `${c.red}SLUG MISMATCH${c.reset} FactBase "${fb.slug}" ↔ TableBase "${tbByStable.id}" (stableId: ${fb.stableId}) — rename failed`,
          );
        }
      } else {
        errors++;
        console.log(
          `${c.red}SLUG MISMATCH${c.reset} FactBase file "${fb.slug}.yaml" ↔ TableBase ID "${tbByStable.id}" (stableId: ${fb.stableId}, run with --fix to rename)`,
        );
      }
    }
  }

  // Summary
  console.log('');
  if (errors === 0 && fixes.length === 0) {
    console.log(`${c.green}All FactBase ↔ TableBase entity IDs are consistent.${c.reset}`);
  } else {
    if (fixes.length > 0) {
      console.log(`${c.green}Fixed ${fixes.length} issue(s).${c.reset}`);
    }
    if (errors > 0) {
      console.log(
        `${c.red}${errors} error(s) found. Fix entity ID inconsistencies before merging.${c.reset}`,
      );
    }
  }

  if (CI_MODE) {
    console.log(
      JSON.stringify({
        validator: 'factbase-entity-ids',
        passed: errors === 0,
        errors,
        warnings,
        fixes: fixes.length,
      }),
    );
  }

  return { passed: errors === 0, errors, warnings };
}

// Only run when invoked directly (not when imported as a module)
if (process.argv[1]?.endsWith('validate-factbase-entity-ids.ts')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
