#!/usr/bin/env npx tsx

/**
 * Generate Mermaid diagrams from Zod schemas
 *
 * Reads app/src/data/schema.ts and produces visual diagrams of:
 * - Entity types and their relationships
 * - Schema structure (fields, types)
 * - Relationship type taxonomy
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  EntityType,
  RelationshipType,
  Entity,
  Resource,
  Publication,
  RelatedEntry,
  CustomField,
  EntitySource,
} from '../../data/schema.ts';

import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');
const OUTPUT_DIR = join(ROOT, 'internal');

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Extract enum values from a Zod enum
 */
function getEnumValues(zodEnum) {
  return zodEnum.options;
}

/**
 * Extract field info from a Zod object schema
 */
function getObjectFields(zodObject) {
  const shape = zodObject.shape;
  const fields = [];

  for (const [key, value] of Object.entries(shape)) {
    let type = 'unknown';
    let optional = false;
    let isArray = false;
    let isEnum = false;
    let enumValues = [];

    let current = value;

    // Unwrap optional
    if (current._def?.typeName === 'ZodOptional') {
      optional = true;
      current = current._def.innerType;
    }

    // Check for nullable
    if (current._def?.typeName === 'ZodNullable') {
      optional = true;
      current = current._def.innerType;
    }

    // Check for array
    if (current._def?.typeName === 'ZodArray') {
      isArray = true;
      current = current._def.type;
    }

    // Check for union (pick first type)
    if (current._def?.typeName === 'ZodUnion') {
      const options = current._def.options;
      current = options[0];
      type = 'union';
    }

    // Get base type
    if (current._def?.typeName === 'ZodString') {
      type = 'string';
    } else if (current._def?.typeName === 'ZodNumber') {
      type = 'number';
    } else if (current._def?.typeName === 'ZodBoolean') {
      type = 'boolean';
    } else if (current._def?.typeName === 'ZodEnum') {
      type = 'enum';
      isEnum = true;
      enumValues = current._def.values.slice(0, 5); // First 5 values
    } else if (current._def?.typeName === 'ZodObject') {
      type = 'object';
    }

    fields.push({
      name: key,
      type,
      optional,
      isArray,
      isEnum,
      enumValues,
    });
  }

  return fields;
}

// =============================================================================
// DIAGRAM 1: Entity Type Hierarchy
// =============================================================================

function generateEntityTypesDiagram() {
  const types = getEnumValues(EntityType);

  // Group by category
  const groups = {
    'Core Content': ['risk', 'risk-factor', 'capability', 'concept', 'concepts', 'crux', 'argument'],
    'Safety & Responses': ['safety-agenda', 'safety-approaches', 'intervention', 'policy', 'policies'],
    'Organizations': ['organization', 'lab', 'lab-frontier', 'lab-research', 'lab-startup', 'lab-academic', 'funder'],
    'People & Cases': ['researcher', 'case-study'],
    'Analysis': ['model', 'models', 'analysis', 'scenario', 'parameter', 'metric', 'factor-subitem'],
    'Other': ['resource', 'historical', 'events'],
  };

  let diagram = `%% Auto-generated from app/src/data/schema.ts
%% Entity Types grouped by category

flowchart TD
    subgraph Legend
        direction LR
        L1[Entity Type]
    end

`;

  for (const [groupName, groupTypes] of Object.entries(groups)) {
    const safeGroupName = groupName.replace(/[^a-zA-Z0-9]/g, '');
    diagram += `    subgraph ${safeGroupName}["${groupName}"]\n`;
    diagram += `        direction TB\n`;
    for (const t of groupTypes) {
      if (types.includes(t)) {
        const safeId = t.replace(/-/g, '_');
        diagram += `        ${safeId}["${t}"]\n`;
      }
    }
    diagram += `    end\n\n`;
  }

  return diagram;
}

// =============================================================================
// DIAGRAM 2: Relationship Types Taxonomy
// =============================================================================

function generateRelationshipTypesDiagram() {
  const types = getEnumValues(RelationshipType);

  // Group by semantic category
  const groups = {
    'Causal': ['causes', 'cause', 'leads-to', 'drives', 'driver', 'driven-by', 'contributes-to', 'affects', 'amplifies', 'shaped-by'],
    'Mitigation': ['mitigates', 'mitigated-by', 'mitigation', 'blocks', 'addresses'],
    'Structural': ['requires', 'enables', 'child-of', 'composed-of', 'component'],
    'Analysis': ['measures', 'measured-by', 'analyzes', 'analyzed-by', 'models'],
    'Classification': ['related', 'example', 'manifestation', 'mechanism', 'outcome', 'consequence', 'key-factor', 'prerequisite', 'scenario', 'sub-scenario'],
    'Meta': ['supersedes', 'supports', 'increases', 'decreases', 'research', 'vulnerable-technique'],
  };

  let diagram = `%% Auto-generated from app/src/data/schema.ts
%% Relationship Types grouped by semantic category

flowchart LR
`;

  for (const [groupName, groupTypes] of Object.entries(groups)) {
    const safeGroupName = groupName.replace(/[^a-zA-Z0-9]/g, '');
    diagram += `    subgraph ${safeGroupName}["${groupName}"]\n`;
    diagram += `        direction TB\n`;
    for (const t of groupTypes) {
      if (types.includes(t)) {
        const safeId = 'rel_' + t.replace(/-/g, '_');
        diagram += `        ${safeId}["${t}"]\n`;
      }
    }
    diagram += `    end\n\n`;
  }

  return diagram;
}

// =============================================================================
// DIAGRAM 3: Entity Schema Structure (ER Diagram)
// =============================================================================

function generateEntitySchemaDiagram() {
  const entityFields = getObjectFields(Entity);
  const resourceFields = getObjectFields(Resource);
  const publicationFields = getObjectFields(Publication);

  let diagram = `%% Auto-generated from app/src/data/schema.ts
%% Schema structure as ER diagram

erDiagram
    Entity {
`;

  for (const field of entityFields.slice(0, 15)) { // Limit to key fields
    const typeStr = field.isArray ? `${field.type}[]` : field.type;
    const optStr = field.optional ? 'optional' : 'required';
    diagram += `        ${field.type} ${field.name} "${optStr}"\n`;
  }

  diagram += `    }

    Resource {
`;

  for (const field of resourceFields.slice(0, 12)) {
    diagram += `        ${field.type} ${field.name}\n`;
  }

  diagram += `    }

    Publication {
`;

  for (const field of publicationFields) {
    diagram += `        ${field.type} ${field.name}\n`;
  }

  diagram += `    }

    Entity ||--o{ RelatedEntry : "relatedEntries"
    Entity ||--o{ EntitySource : "sources"
    Entity ||--o{ CustomField : "customFields"
    Entity }o--|| Resource : "resources[]"
    Resource }o--|| Publication : "publication_id"
`;

  return diagram;
}

// =============================================================================
// DIAGRAM 4: Class Diagram of Main Types
// =============================================================================

function generateClassDiagram() {
  const entityFields = getObjectFields(Entity);
  const relatedEntryFields = getObjectFields(RelatedEntry);

  let diagram = `%% Auto-generated from app/src/data/schema.ts
%% Class diagram showing main schema types

classDiagram
    class Entity {
`;

  for (const field of entityFields) {
    const typeStr = field.isArray ? `${field.type}[]` : field.type;
    const marker = field.optional ? '?' : '';
    diagram += `        +${typeStr}${marker} ${field.name}\n`;
  }

  diagram += `    }

    class RelatedEntry {
`;

  for (const field of relatedEntryFields) {
    const marker = field.optional ? '?' : '';
    diagram += `        +${field.type}${marker} ${field.name}\n`;
  }

  diagram += `    }

    class EntitySource {
        +string title
        +string? url
        +string? author
        +string? date
    }

    class CustomField {
        +string label
        +string value
    }

    Entity "1" *-- "0..*" RelatedEntry : relatedEntries
    Entity "1" *-- "0..*" EntitySource : sources
    Entity "1" *-- "0..*" CustomField : customFields
`;

  return diagram;
}

// =============================================================================
// DIAGRAM 5: Data Flow Overview
// =============================================================================

function generateDataFlowDiagram() {
  return `%% Auto-generated overview of data architecture
%% Shows how YAML data flows through the system

flowchart TD
    subgraph Sources["YAML Data Sources"]
        E1[entities/*.yaml]
        E2[resources/*.yaml]
        E3[publications.yaml]
        E4[parameter-graph.yaml]
    end

    subgraph Schema["Zod Schema Validation"]
        S1[Entity Schema]
        S2[Resource Schema]
        S3[Publication Schema]
    end

    subgraph Build["Build Pipeline"]
        B1[build-data.mjs]
        B2[database.json]
    end

    subgraph Validation["Validation Suite"]
        V1[validate-yaml-schema.mjs]
        V2[validate-data.mjs]
        V3[validate-all.mjs]
    end

    subgraph UI["UI Components"]
        U1[DataInfoBox]
        U2[ResourceCard]
        U3[CauseEffectGraph]
    end

    E1 --> V1
    E2 --> V1
    E3 --> V1

    V1 --> S1
    V1 --> S2
    V1 --> S3

    E1 --> B1
    E2 --> B1
    E3 --> B1
    E4 --> B1

    B1 --> B2
    B2 --> U1
    B2 --> U2
    B2 --> U3

    V1 --> V3
    V2 --> V3

    style Sources fill:#e1f5fe
    style Schema fill:#fff3e0
    style Build fill:#e8f5e9
    style Validation fill:#fce4ec
    style UI fill:#f3e5f5
`;
}

// =============================================================================
// Generate all diagrams
// =============================================================================

const diagrams = [
  { name: 'entity-types', fn: generateEntityTypesDiagram, title: 'Entity Types Hierarchy' },
  { name: 'relationship-types', fn: generateRelationshipTypesDiagram, title: 'Relationship Types Taxonomy' },
  { name: 'schema-er', fn: generateEntitySchemaDiagram, title: 'Schema ER Diagram' },
  { name: 'schema-class', fn: generateClassDiagram, title: 'Schema Class Diagram' },
  { name: 'data-flow', fn: generateDataFlowDiagram, title: 'Data Flow Architecture' },
];

console.log('Generating schema diagrams...\n');

for (const { name, fn, title } of diagrams) {
  const diagram = fn();
  const filename = join(OUTPUT_DIR, `${name}.mmd`);
  writeFileSync(filename, diagram);
  console.log(`✓ ${title} -> ${filename}`);
}

// Generate a combined markdown file with all diagrams
let combinedMd = `# Schema Visualizations

Auto-generated from \`app/src/data/schema.ts\` using \`tooling/generate/generate-schema-diagrams.mjs\`

Generated: ${new Date().toISOString()}

---

`;

for (const { name, fn, title } of diagrams) {
  const diagram = fn();
  combinedMd += `## ${title}

\`\`\`mermaid
${diagram}
\`\`\`

---

`;
}

// Add statistics
const entityTypes = getEnumValues(EntityType);
const relationshipTypes = getEnumValues(RelationshipType);

combinedMd += `## Statistics

| Metric | Count |
|--------|-------|
| Entity Types | ${entityTypes.length} |
| Relationship Types | ${relationshipTypes.length} |
| Entity Fields | ${getObjectFields(Entity).length} |
| Resource Fields | ${getObjectFields(Resource).length} |

### All Entity Types

${entityTypes.map(t => `- \`${t}\``).join('\n')}

### All Relationship Types

${relationshipTypes.map(t => `- \`${t}\``).join('\n')}
`;

writeFileSync(join(OUTPUT_DIR, 'schema-diagrams.md'), combinedMd);
console.log(`\n✓ Combined documentation -> ${join(OUTPUT_DIR, 'schema-diagrams.md')}`);

console.log('\nDone!');
