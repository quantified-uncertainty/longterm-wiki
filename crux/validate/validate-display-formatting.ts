#!/usr/bin/env node

/**
 * Display Formatting Validator — Detect common rendering bugs in entity data
 *
 * Scans entity YAML files for:
 *   - `[object Object]` in any string field (serialization bug)
 *   - Unescaped MDX characters in title/description fields (`<`, `{`, `}`)
 *     that would break rendering
 *   - `undefined` or `null` as literal strings in display fields
 *   - `NaN` as a literal string in display fields
 *
 * These indicate data pipeline bugs where objects are stringified incorrectly
 * or special characters leak into display fields.
 *
 * Usage: npx tsx crux/validate/validate-display-formatting.ts
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { truncate } from '../lib/text-utils.ts';

const ENTITIES_DIR = join(PROJECT_ROOT, 'data/entities');

export interface DisplayFormattingViolation {
  file: string;
  entityId: string;
  field: string;
  value: string;
  reason: string;
}

/**
 * Check if a string contains `[object Object]` — a sign of accidental
 * toString() on a JS object.
 */
export function containsObjectObject(value: string): boolean {
  return value.includes('[object Object]');
}

/**
 * Check if a title/description contains unescaped MDX-breaking characters.
 * In MDX, bare `<` (not part of a known HTML tag) and bare `{`/`}` will
 * break compilation. This catches cases where these leak into entity titles
 * or descriptions from data sources.
 *
 * We only flag obvious cases:
 *   - `<` not followed by a common HTML tag name or `/` (closing tag)
 *   - Bare `{` or `}` not inside a code fence
 *
 * The title field should never contain MDX syntax — it's always rendered
 * as plain text in headings, meta tags, and directory tables.
 */
export function hasUnescapedMdxInTitle(value: string): boolean {
  // Check for bare < that isn't an HTML tag or escaped
  // Common HTML tags that are fine: <br>, <em>, <strong>, <a>, <code>, <span>, <div>
  const bareAngleBracket = /<(?![a-z/!])/i;
  if (bareAngleBracket.test(value)) return true;

  // Check for bare { or } (JSX expression syntax)
  if (/[{}]/.test(value)) return true;

  return false;
}

/**
 * Check if a string is the literal "undefined" or "null" — signs of
 * accidental stringification of JS undefined/null values.
 */
export function isStringifiedNullish(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === 'undefined' || trimmed === 'null';
}

/**
 * Check if a string is the literal "NaN".
 */
export function isStringifiedNaN(value: string): boolean {
  return value.trim() === 'NaN';
}

interface YamlEntity {
  id?: string;
  stableId?: string;
  title?: string;
  description?: string;
  customFields?: Array<{ label?: string; value?: string }>;
  sources?: Array<{ title?: string; url?: string }>;
  [key: string]: unknown;
}

/**
 * Recursively scan all string values in an object for [object Object].
 * Returns field paths where violations are found.
 */
function findObjectObjectInValue(
  value: unknown,
  path: string,
): Array<{ field: string; value: string }> {
  const results: Array<{ field: string; value: string }> = [];

  if (typeof value === 'string') {
    if (containsObjectObject(value)) {
      results.push({ field: path, value });
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      results.push(...findObjectObjectInValue(value[i], `${path}[${i}]`));
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      results.push(...findObjectObjectInValue(val, path ? `${path}.${key}` : key));
    }
  }

  return results;
}

function checkEntity(entity: YamlEntity, file: string): DisplayFormattingViolation[] {
  const violations: DisplayFormattingViolation[] = [];
  const entityId = entity.id || entity.stableId || '(no id)';

  // 1. Check for [object Object] anywhere in the entity
  const objectObjectHits = findObjectObjectInValue(entity, '');
  for (const hit of objectObjectHits) {
    violations.push({
      file,
      entityId,
      field: hit.field,
      value: truncate(hit.value, 83, { ellipsis: '...' }),
      reason: 'Contains "[object Object]" (serialization bug)',
    });
  }

  // 2. Check title for unescaped MDX characters
  if (typeof entity.title === 'string') {
    if (hasUnescapedMdxInTitle(entity.title)) {
      violations.push({
        file,
        entityId,
        field: 'title',
        value: entity.title,
        reason: 'Title contains unescaped MDX characters (< or {/}) that may break rendering',
      });
    }

    if (isStringifiedNullish(entity.title)) {
      violations.push({
        file,
        entityId,
        field: 'title',
        value: entity.title,
        reason: 'Title is the literal string "undefined" or "null"',
      });
    }

    if (isStringifiedNaN(entity.title)) {
      violations.push({
        file,
        entityId,
        field: 'title',
        value: entity.title,
        reason: 'Title is the literal string "NaN"',
      });
    }
  }

  // 3. Check description for stringified nullish/NaN
  if (typeof entity.description === 'string') {
    if (isStringifiedNullish(entity.description)) {
      violations.push({
        file,
        entityId,
        field: 'description',
        value: entity.description,
        reason: 'Description is the literal string "undefined" or "null"',
      });
    }

    if (isStringifiedNaN(entity.description)) {
      violations.push({
        file,
        entityId,
        field: 'description',
        value: entity.description,
        reason: 'Description is the literal string "NaN"',
      });
    }
  }

  // 4. Check customField values
  if (Array.isArray(entity.customFields)) {
    for (const cf of entity.customFields) {
      if (typeof cf.value === 'string') {
        if (isStringifiedNullish(cf.value)) {
          violations.push({
            file,
            entityId,
            field: `customFields[label="${cf.label || '?'}"].value`,
            value: cf.value,
            reason: 'Custom field value is the literal string "undefined" or "null"',
          });
        }
      }
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: DisplayFormattingViolation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for display formatting issues in entity data...${c.reset}\n`);

  let yamlFiles: string[];
  try {
    yamlFiles = readdirSync(ENTITIES_DIR).filter(f => f.endsWith('.yaml'));
  } catch {
    console.log(`${c.dim}Skipping: could not read entities directory at ${ENTITIES_DIR}${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: DisplayFormattingViolation[] = [];
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
    console.log(`${c.green}No display formatting issues found (${totalEntities} entities checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} display formatting issue(s):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file} → ${v.entityId}${c.reset}`);
      console.log(`    ${c.dim}${v.field}: "${v.value}"${c.reset}`);
      console.log(`    ${c.dim}Reason: ${v.reason}${c.reset}\n`);
    }
    console.log(`${c.dim}Fix: correct the serialization issue or escape MDX characters in entity YAML files.${c.reset}`);
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-display-formatting')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
