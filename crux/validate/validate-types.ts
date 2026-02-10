#!/usr/bin/env node

/**
 * Type Consistency Validation Script
 *
 * Validates that UI components properly handle all entity types defined in schema.
 * This catches cases where new types are added to schema.ts but UI code isn't updated.
 *
 * Usage: node scripts/validate-types.ts
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { getColors } from '../lib/output.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

const colors = getColors();

/**
 * Extract EntityType values from schema.ts
 */
function getSchemaEntityTypes(): string[] {
  const schemaContent: string = readFileSync('data/schema.ts', 'utf-8');

  // Find the EntityType z.enum definition
  const enumMatch: RegExpMatchArray | null = schemaContent.match(/export const EntityType = z\.enum\(\[([\s\S]*?)\]\)/);
  if (!enumMatch) {
    throw new Error('Could not find EntityType enum in schema.ts');
  }

  // Extract the quoted strings
  const types: RegExpMatchArray | null = enumMatch[1].match(/'([^']+)'/g);
  if (!types) {
    throw new Error('Could not parse EntityType values');
  }

  return types.map((t: string) => t.replace(/'/g, ''));
}

/**
 * Extract typeLabels keys from InfoBox.tsx
 */
function getInfoBoxTypeLabels(): string[] {
  const infoboxContent: string = readFileSync('src/components/wiki/InfoBox.tsx', 'utf-8');

  // Find the typeLabels object
  const labelsMatch: RegExpMatchArray | null = infoboxContent.match(/const typeLabels[^{]*\{([\s\S]*?)\};/);
  if (!labelsMatch) {
    throw new Error('Could not find typeLabels in InfoBox.tsx');
  }

  // Extract the keys (types in quotes)
  const types: RegExpMatchArray | null = labelsMatch[1].match(/'([^']+)':/g);
  if (!types) {
    throw new Error('Could not parse typeLabels keys');
  }

  return types.map((t: string) => t.replace(/[':]/g, ''));
}

export function runCheck(_options?: ValidatorOptions): ValidatorResult {
  // Skip if running from the repo root (Next.js app uses entity-ontology.ts, not InfoBox typeLabels)
  if (!existsSync('src/components/wiki/InfoBox.tsx')) {
    console.log(`${colors.dim}Skipping type consistency check: not applicable for Next.js app (uses entity-ontology.ts)${colors.reset}`);
    return { passed: true, errors: 0, warnings: 0 };
  }

  console.log(`${colors.blue}🔍 Validating type consistency...${colors.reset}\n`);

  let errors: number = 0;

  try {
    const schemaTypes: string[] = getSchemaEntityTypes();
    const infoboxTypes: string[] = getInfoBoxTypeLabels();

    console.log(`Schema EntityTypes: ${schemaTypes.length}`);
    console.log(`InfoBox typeLabels: ${infoboxTypes.length}\n`);

    // Check for types in schema but missing from InfoBox
    const schemaSet = new Set<string>(schemaTypes);
    const infoboxSet = new Set<string>(infoboxTypes);

    const missingInInfoBox: string[] = schemaTypes.filter((t: string) => !infoboxSet.has(t));
    const extraInInfoBox: string[] = infoboxTypes.filter((t: string) => !schemaSet.has(t));

    if (missingInInfoBox.length > 0) {
      console.log(`${colors.red}❌ Types in schema.ts but missing from InfoBox.tsx typeLabels:${colors.reset}`);
      for (const type of missingInInfoBox) {
        console.log(`   - ${type}`);
      }
      errors += missingInInfoBox.length;
    }

    if (extraInInfoBox.length > 0) {
      console.log(`${colors.yellow}⚠️  Types in InfoBox.tsx but not in schema.ts (may be intentional):${colors.reset}`);
      for (const type of extraInInfoBox) {
        console.log(`   - ${type}`);
      }
    }

    // Check that InfoBox imports EntityType from schema
    const infoboxContent: string = readFileSync('src/components/wiki/InfoBox.tsx', 'utf-8');
    if (!infoboxContent.includes("from '../../data/schema'") &&
        !infoboxContent.includes('from "../../data/schema"')) {
      console.log(`${colors.yellow}⚠️  InfoBox.tsx should import EntityType from schema.ts to ensure type safety${colors.reset}`);
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`${colors.red}❌ Error: ${message}${colors.reset}`);
    errors++;
  }

  console.log(`\n${'─'.repeat(60)}`);

  if (errors === 0) {
    console.log(`${colors.green}✅ Type consistency validation passed!${colors.reset}`);
  } else {
    console.log(`${colors.red}❌ ${errors} type consistency error(s)${colors.reset}`);
  }

  return { passed: errors === 0, errors, warnings: 0 };
}

function main(): void {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
