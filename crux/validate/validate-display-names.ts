#!/usr/bin/env node

/**
 * Display Names Validator — Detect raw machine IDs in display fields
 *
 * Scans entity YAML files for:
 *   - StableIds appearing as entity `title` fields (10-char alphanumeric with mixed case)
 *   - Hash-like strings (generateId output) in title fields
 *   - Pure numeric IDs used as titles
 *   - The literal string "Unknown" as a title
 *
 * These indicate data pipeline bugs where machine-readable identifiers
 * leak into user-facing display fields.
 *
 * Usage: npx tsx crux/validate/validate-display-names.ts
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { isLegacyStableId } from '../../packages/id-utils/src/index.ts';

const ENTITIES_DIR = join(PROJECT_ROOT, 'data/entities');

export interface DisplayNameViolation {
  file: string;
  entityId: string;
  field: string;
  value: string;
  reason: string;
}

/**
 * Check if a string looks like a stableId (machine-generated 10-char ID).
 * Uses isLegacyStableId from id-utils for the base 10-char pattern check,
 * then adds heuristics requiring mixed case + digits to avoid false positives
 * on short real names like "Washington" or "Regulation".
 */
export function looksLikeStableId(value: string): boolean {
  if (!isLegacyStableId(value)) return false;
  // Must contain at least one uppercase AND one lowercase letter
  // to distinguish from real words like "Washington" or "Pythonista"
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  // A stableId typically has digits mixed in; pure alphabetic 10-char strings
  // are more likely to be real words (e.g., "Regulation")
  return hasUpper && hasLower && hasDigit;
}

/**
 * Check if a string looks like a hash-based ID from generateId().
 * These are typically longer alphanumeric strings that are clearly not names.
 *
 * Conservative: only flags strings that are purely alphanumeric (no hyphens,
 * no underscores) to avoid false positives on real product names like
 * "GPT-4o-mini" or "Llama-3.1-405B". Hash IDs from generateId() are
 * pure alphanumeric.
 */
export function looksLikeHashId(value: string): boolean {
  // Only flag pure alphanumeric strings (no hyphens, no underscores)
  // to avoid false positives on hyphenated product/model names
  if (value.length < 11 || value.length > 30) return false;
  if (/\s/.test(value)) return false; // Real names have spaces
  if (!/^[A-Za-z0-9]+$/.test(value)) return false; // Pure alphanumeric only
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  // Must have all three character classes — unlikely for a real name
  return hasUpper && hasLower && hasDigit;
}

/**
 * Check if a string is purely numeric (a raw database ID).
 */
export function isPureNumericId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

/**
 * Check if a title is the literal "Unknown" (case-insensitive).
 */
export function isUnknownPlaceholder(value: string): boolean {
  return value.trim().toLowerCase() === 'unknown';
}

interface YamlEntity {
  id?: string;
  stableId?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

function checkEntity(entity: YamlEntity, file: string): DisplayNameViolation[] {
  const violations: DisplayNameViolation[] = [];
  const entityId = entity.id || entity.stableId || '(no id)';

  // Check title field
  if (typeof entity.title === 'string') {
    const title = entity.title.trim();

    if (looksLikeStableId(title)) {
      violations.push({
        file,
        entityId,
        field: 'title',
        value: title,
        reason: 'Title looks like a raw stableId (10-char machine-generated ID)',
      });
    } else if (looksLikeHashId(title)) {
      violations.push({
        file,
        entityId,
        field: 'title',
        value: title,
        reason: 'Title looks like a hash-based machine ID',
      });
    } else if (isPureNumericId(title)) {
      violations.push({
        file,
        entityId,
        field: 'title',
        value: title,
        reason: 'Title is a pure numeric ID',
      });
    } else if (isUnknownPlaceholder(title)) {
      violations.push({
        file,
        entityId,
        field: 'title',
        value: title,
        reason: 'Title is the placeholder "Unknown"',
      });
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: DisplayNameViolation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for raw machine IDs in entity display fields...${c.reset}\n`);

  let yamlFiles: string[];
  try {
    yamlFiles = readdirSync(ENTITIES_DIR).filter(f => f.endsWith('.yaml'));
  } catch {
    console.log(`${c.dim}Skipping: could not read entities directory at ${ENTITIES_DIR}${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: DisplayNameViolation[] = [];
  let totalEntities = 0;

  for (const file of yamlFiles) {
    const filePath = join(ENTITIES_DIR, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue; // Skip unreadable files
    }

    let entities: YamlEntity[];
    try {
      const parsed = parseYaml(content);
      if (!Array.isArray(parsed)) continue;
      entities = parsed as YamlEntity[];
    } catch {
      continue; // Skip malformed YAML
    }

    for (const entity of entities) {
      totalEntities++;
      const violations = checkEntity(entity, file);
      allViolations.push(...violations);
    }
  }

  if (allViolations.length === 0) {
    console.log(`${c.green}No raw machine IDs found in display fields (${totalEntities} entities checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} display name issue(s):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file} → ${v.entityId}${c.reset}`);
      console.log(`    ${c.dim}${v.field}: "${v.value}"${c.reset}`);
      console.log(`    ${c.dim}Reason: ${v.reason}${c.reset}\n`);
    }
    console.log(`${c.dim}Fix: replace machine IDs with human-readable names in entity YAML files.${c.reset}`);
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-display-names')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
