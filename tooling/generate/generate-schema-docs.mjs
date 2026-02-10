#!/usr/bin/env node
/**
 * Generate schema documentation from schema.ts
 *
 * Reads the EntityType and RelationshipType enums from schema.ts
 * and generates a Mermaid-based MDX documentation page.
 *
 * Usage: node tooling/generate/generate-schema-docs.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

// Read schema.ts and extract enums
const schemaPath = join(ROOT, 'app/src/data/schema.ts');
const schemaContent = readFileSync(schemaPath, 'utf-8');

// Extract EntityType enum values
function extractEnum(content, enumName) {
  const regex = new RegExp(`export const ${enumName}\\s*=\\s*z\\.enum\\(\\[([\\s\\S]*?)\\]\\)`, 'm');
  const match = content.match(regex);
  if (!match) {
    console.error(`Could not find ${enumName} enum`);
    return [];
  }

  const enumBlock = match[1];
  const values = [];

  // Match each string value with optional comment
  const valueRegex = /'([^']+)'(?:,?\s*\/\/\s*(.*))?/g;
  let valueMatch;
  while ((valueMatch = valueRegex.exec(enumBlock)) !== null) {
    values.push({
      value: valueMatch[1],
      comment: valueMatch[2]?.trim() || null
    });
  }

  return values;
}

const entityTypes = extractEnum(schemaContent, 'EntityType');
const relationshipTypes = extractEnum(schemaContent, 'RelationshipType');

// Categorize entity types
const entityCategories = {
  'Core Content': ['risk', 'risk-factor', 'capability', 'concept', 'concepts', 'crux', 'argument', 'case-study'],
  'Safety & Responses': ['safety-agenda', 'safety-approaches', 'intervention', 'policy', 'policies'],
  'Organizations': ['organization', 'lab', 'lab-frontier', 'lab-research', 'lab-startup', 'lab-academic', 'funder'],
  'Analysis': ['model', 'models', 'scenario', 'parameter', 'metric', 'analysis'],
  'AI Transition Model': ['ai-transition-model-factor', 'ai-transition-model-subitem', 'ai-transition-model-parameter', 'ai-transition-model-metric', 'ai-transition-model-scenario'],
  'Other': ['researcher', 'resource', 'historical', 'events']
};

// Categorize relationship types
const relationshipCategories = {
  'Causal': ['causes', 'cause', 'drives', 'driver', 'driven-by', 'affects', 'amplifies', 'leads-to', 'contributes-to', 'shaped-by'],
  'Mitigation': ['mitigates', 'mitigated-by', 'mitigation', 'blocks', 'addresses'],
  'Structural': ['requires', 'enables', 'child-of', 'composed-of', 'component', 'prerequisite'],
  'Measurement': ['measures', 'measured-by', 'analyzes', 'analyzed-by', 'models', 'increases', 'decreases', 'supports'],
  'Classification': ['related', 'example', 'mechanism', 'outcome', 'consequence', 'manifestation', 'key-factor', 'scenario', 'sub-scenario', 'supersedes', 'research', 'vulnerable-technique']
};

// Generate Mermaid chart for entity types
function generateEntityMermaid() {
  let chart = 'flowchart TD\n';

  for (const [category, types] of Object.entries(entityCategories)) {
    const safeId = category.replace(/[^a-zA-Z]/g, '');
    chart += `    subgraph ${safeId}["${category}"]\n`;
    chart += `        direction TB\n`;

    for (const type of types) {
      if (entityTypes.some(e => e.value === type)) {
        const safeNodeId = type.replace(/-/g, '_');
        chart += `        ${safeNodeId}["${type}"]\n`;
      }
    }

    chart += `    end\n\n`;
  }

  return chart.trim();
}

// Generate Mermaid chart for relationship types
function generateRelationshipMermaid() {
  let chart = 'flowchart LR\n';

  for (const [category, types] of Object.entries(relationshipCategories)) {
    const safeId = category.replace(/[^a-zA-Z]/g, '');
    chart += `    subgraph ${safeId}["${category}"]\n`;

    for (const type of types) {
      if (relationshipTypes.some(r => r.value === type)) {
        const safeNodeId = type.replace(/-/g, '_');
        chart += `        ${safeNodeId}["${type}"]\n`;
      }
    }

    chart += `    end\n\n`;
  }

  return chart.trim();
}

// Generate entity type table
function generateEntityTable() {
  let table = '| Type | Description |\n|------|-------------|\n';

  for (const entity of entityTypes) {
    const desc = entity.comment || '-';
    table += `| \`${entity.value}\` | ${desc} |\n`;
  }

  return table;
}

// Generate relationship type table
function generateRelationshipTable() {
  let table = '| Type | Description |\n|------|-------------|\n';

  for (const rel of relationshipTypes) {
    const desc = rel.comment || '-';
    table += `| \`${rel.value}\` | ${desc} |\n`;
  }

  return table;
}

// Generate the full MDX content
const mdxContent = `---
title: Schema Reference
description: Auto-generated documentation of entity types and relationships
sidebar:
  order: 1
---

{/* AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY */}
{/* Regenerate with: node tooling/generate/generate-schema-docs.mjs */}

This documentation is auto-generated from \`app/src/data/schema.ts\`.

**Last generated:** ${new Date().toISOString().split('T')[0]}

## Entity Types Overview

<Mermaid chart={\`
${generateEntityMermaid()}
\`} />

## Relationship Types Overview

<Mermaid chart={\`
${generateRelationshipMermaid()}
\`} />

## Entity Types (${entityTypes.length} total)

${generateEntityTable()}

## Relationship Types (${relationshipTypes.length} total)

${generateRelationshipTable()}

## Data Flow

<Mermaid chart={\`
flowchart TD
    subgraph Sources["YAML Data Sources"]
        E1[entities/*.yaml]
        E2[resources/*.yaml]
        E3[publications.yaml]
        E4[graphs/*.yaml]
    end

    subgraph Validation["Schema Validation"]
        V1[Zod Schemas]
        V2[validate-yaml-schema.mjs]
    end

    subgraph Build["Build Pipeline"]
        B1[build-data.mjs]
        B2[database.json]
        B3[pathRegistry.json]
    end

    subgraph UI["UI Components"]
        U1[EntityLink]
        U2[DataInfoBox]
        U3[CauseEffectGraph]
    end

    E1 --> V2
    E2 --> V2
    E3 --> V2
    E4 --> V2
    V2 --> V1
    V1 --> B1
    B1 --> B2
    B1 --> B3
    B2 --> U1
    B2 --> U2
    B2 --> U3
\`} />

## Regenerating This Page

\`\`\`bash
node tooling/generate/generate-schema-docs.mjs
\`\`\`

This script reads \`app/src/data/schema.ts\` and extracts:
- \`EntityType\` enum values and comments
- \`RelationshipType\` enum values and comments

The categories shown in the diagrams are defined in the script itself.
`;

// Write to file
const outputPath = join(ROOT, 'content/docs/internal/schema/diagrams.mdx');
writeFileSync(outputPath, mdxContent);

console.log(`✓ Generated schema docs at ${outputPath}`);
console.log(`  - ${entityTypes.length} entity types`);
console.log(`  - ${relationshipTypes.length} relationship types`);
