#!/usr/bin/env node

/**
 * Type Consistency Validation Script
 *
 * Validates that UI components properly handle all entity types defined in schema.
 * This catches cases where new types are added to schema.ts but UI code isn't updated.
 *
 * Usage: node scripts/validate-types.mjs
 */

import { readFileSync } from 'fs';
import { getColors } from '../lib/output.mjs';

const colors = getColors();

/**
 * Extract EntityType values from schema.ts
 */
function getSchemaEntityTypes() {
  const schemaContent = readFileSync('data/schema.ts', 'utf-8');

  // Find the EntityType z.enum definition
  const enumMatch = schemaContent.match(/export const EntityType = z\.enum\(\[([\s\S]*?)\]\)/);
  if (!enumMatch) {
    throw new Error('Could not find EntityType enum in schema.ts');
  }

  // Extract the quoted strings
  const types = enumMatch[1].match(/'([^']+)'/g);
  if (!types) {
    throw new Error('Could not parse EntityType values');
  }

  return types.map(t => t.replace(/'/g, ''));
}

/**
 * Extract typeLabels keys from InfoBox.tsx
 */
function getInfoBoxTypeLabels() {
  const infoboxContent = readFileSync('src/components/wiki/InfoBox.tsx', 'utf-8');

  // Find the typeLabels object
  const labelsMatch = infoboxContent.match(/const typeLabels[^{]*\{([\s\S]*?)\};/);
  if (!labelsMatch) {
    throw new Error('Could not find typeLabels in InfoBox.tsx');
  }

  // Extract the keys (types in quotes)
  const types = labelsMatch[1].match(/'([^']+)':/g);
  if (!types) {
    throw new Error('Could not parse typeLabels keys');
  }

  return types.map(t => t.replace(/[':]/g, ''));
}

function main() {
  console.log(`${colors.blue}🔍 Validating type consistency...${colors.reset}\n`);

  let errors = 0;

  try {
    const schemaTypes = getSchemaEntityTypes();
    const infoboxTypes = getInfoBoxTypeLabels();

    console.log(`Schema EntityTypes: ${schemaTypes.length}`);
    console.log(`InfoBox typeLabels: ${infoboxTypes.length}\n`);

    // Check for types in schema but missing from InfoBox
    const schemaSet = new Set(schemaTypes);
    const infoboxSet = new Set(infoboxTypes);

    const missingInInfoBox = schemaTypes.filter(t => !infoboxSet.has(t));
    const extraInInfoBox = infoboxTypes.filter(t => !schemaSet.has(t));

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
    const infoboxContent = readFileSync('src/components/wiki/InfoBox.tsx', 'utf-8');
    if (!infoboxContent.includes("from '../../data/schema'") &&
        !infoboxContent.includes('from "../../data/schema"')) {
      console.log(`${colors.yellow}⚠️  InfoBox.tsx should import EntityType from schema.ts to ensure type safety${colors.reset}`);
    }

  } catch (err) {
    console.log(`${colors.red}❌ Error: ${err.message}${colors.reset}`);
    errors++;
  }

  console.log(`\n${'─'.repeat(60)}`);

  if (errors === 0) {
    console.log(`${colors.green}✅ Type consistency validation passed!${colors.reset}`);
  } else {
    console.log(`${colors.red}❌ ${errors} type consistency error(s)${colors.reset}`);
  }

  process.exit(errors > 0 ? 1 : 0);
}

main();
