#!/usr/bin/env node

/**
 * Generate Mermaid diagrams from actual YAML data
 *
 * Reads entities and generates relationship diagrams showing
 * how entities are actually connected.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(ROOT, 'data');
const OUTPUT_DIR = join(ROOT, 'internal');

interface Entity {
  id: string;
  title?: string;
  type: string;
  relatedEntries?: RelatedEntry[];
}

interface RelatedEntry {
  id: string;
  type: string;
  relationship?: string;
}

interface GraphNode {
  id: string;
  label: string;
  type: string;
}

interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

interface DiagramDef {
  name: string;
  fn: () => string;
}

/**
 * Load all entities from YAML files
 */
function loadEntities(): Entity[] {
  const entitiesDir = join(DATA_DIR, 'entities');
  const files = readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  const entities: Entity[] = [];

  for (const file of files) {
    const content = readFileSync(join(entitiesDir, file), 'utf-8');
    const data = parseYaml(content);
    if (Array.isArray(data)) {
      entities.push(...data);
    }
  }

  return entities;
}

/**
 * Generate a diagram of entity relationships by type
 */
function generateTypeDistributionDiagram(entities: Entity[]): string {
  const typeCounts: Record<string, number> = {};
  for (const e of entities) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }

  // Sort by count descending
  const sorted = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1]);

  let diagram = `%% Entity Type Distribution (${entities.length} total entities)
%% Auto-generated from YAML data

pie showData
    title Entity Types
`;

  for (const [type, count] of sorted) {
    diagram += `    "${type}" : ${count}\n`;
  }

  return diagram;
}

/**
 * Generate a relationship graph for a specific entity type
 */
function generateRelationshipGraph(entities: Entity[], focusType: string, maxNodes = 30): string {
  // Get entities of the focus type that have relationships
  const focusEntities = entities
    .filter(e => e.type === focusType && e.relatedEntries?.length)
    .slice(0, maxNodes);

  if (focusEntities.length === 0) {
    return `%% No ${focusType} entities with relationships found`;
  }

  const entityMap = new Map(entities.map(e => [e.id, e]));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const entity of focusEntities) {
    const safeId = entity.id.replace(/-/g, '_');
    nodes.set(safeId, { id: safeId, label: entity.title || entity.id, type: entity.type });

    for (const rel of (entity.relatedEntries || []).slice(0, 5)) {
      const target = entityMap.get(rel.id);
      const targetSafeId = rel.id.replace(/-/g, '_');

      if (target) {
        nodes.set(targetSafeId, { id: targetSafeId, label: target.title || rel.id, type: rel.type });
        edges.push({
          from: safeId,
          to: targetSafeId,
          label: rel.relationship || 'related',
        });
      }
    }
  }

  let diagram = `%% Relationships for ${focusType} entities
%% Auto-generated from YAML data

flowchart LR
`;

  // Add nodes by type
  const nodesByType: Record<string, GraphNode[]> = {};
  for (const node of nodes.values()) {
    if (!nodesByType[node.type]) nodesByType[node.type] = [];
    nodesByType[node.type].push(node);
  }

  for (const [type, typeNodes] of Object.entries(nodesByType)) {
    const safeType = type.replace(/-/g, '_');
    diagram += `    subgraph ${safeType}["${type}"]\n`;
    for (const node of typeNodes) {
      // Truncate long labels
      const shortLabel = node.label.length > 25 ? node.label.slice(0, 22) + '...' : node.label;
      diagram += `        ${node.id}["${shortLabel}"]\n`;
    }
    diagram += `    end\n\n`;
  }

  // Add edges
  for (const edge of edges) {
    const safeLabel = edge.label.replace(/-/g, ' ');
    diagram += `    ${edge.from} -->|${safeLabel}| ${edge.to}\n`;
  }

  return diagram;
}

/**
 * Generate a summary of relationship types in use
 */
function generateRelationshipUsageDiagram(entities: Entity[]): string {
  const relCounts: Record<string, number> = {};

  for (const entity of entities) {
    for (const rel of (entity.relatedEntries || [])) {
      const relType = rel.relationship || 'related';
      relCounts[relType] = (relCounts[relType] || 0) + 1;
    }
  }

  const sorted = Object.entries(relCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20); // Top 20

  let diagram = `%% Relationship Type Usage
%% Auto-generated from YAML data

xychart-beta
    title "Top 20 Relationship Types by Usage"
    x-axis [${sorted.map(([t]) => `"${t}"`).join(', ')}]
    y-axis "Count" 0 --> ${sorted[0][1] + 10}
    bar [${sorted.map(([, c]) => c).join(', ')}]
`;

  return diagram;
}

/**
 * Generate cross-type relationship diagram
 */
function generateCrossTypeRelationships(entities: Entity[]): string {
  // Count relationships between entity types
  const typePairs: Record<string, number> = {};
  const entityMap = new Map(entities.map(e => [e.id, e]));

  for (const entity of entities) {
    for (const rel of (entity.relatedEntries || [])) {
      const target = entityMap.get(rel.id);
      if (target) {
        const pair = `${entity.type}|${target.type}`;
        typePairs[pair] = (typePairs[pair] || 0) + 1;
      }
    }
  }

  // Get top connections
  const sorted = Object.entries(typePairs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  // Build adjacency for sankey
  let diagram = `%% Cross-Type Entity Relationships
%% Shows which entity types are most connected

flowchart LR
`;

  const nodeTypes = new Set<string>();
  for (const [pair] of sorted) {
    const [from, to] = pair.split('|');
    nodeTypes.add(from);
    nodeTypes.add(to);
  }

  // Add type nodes
  for (const type of nodeTypes) {
    const safeId = type.replace(/-/g, '_');
    diagram += `    ${safeId}["${type}"]\n`;
  }

  diagram += '\n';

  // Add edges with thickness based on count
  for (const [pair, count] of sorted) {
    const [from, to] = pair.split('|');
    const fromSafe = from.replace(/-/g, '_');
    const toSafe = to.replace(/-/g, '_');
    if (fromSafe !== toSafe && count >= 3) {
      diagram += `    ${fromSafe} -->|${count}| ${toSafe}\n`;
    }
  }

  return diagram;
}

// =============================================================================
// Main
// =============================================================================

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Generating data-driven diagrams...\n');

  const entities = loadEntities();
  console.log(`Loaded ${entities.length} entities`);

  const diagrams: DiagramDef[] = [
    { name: 'type-distribution', fn: () => generateTypeDistributionDiagram(entities) },
    { name: 'risk-relationships', fn: () => generateRelationshipGraph(entities, 'risk', 15) },
    { name: 'policy-relationships', fn: () => generateRelationshipGraph(entities, 'policy', 15) },
    { name: 'organization-relationships', fn: () => generateRelationshipGraph(entities, 'organization', 15) },
    { name: 'relationship-usage', fn: () => generateRelationshipUsageDiagram(entities) },
    { name: 'cross-type-connections', fn: () => generateCrossTypeRelationships(entities) },
  ];

  // Generate individual files
  for (const { name, fn } of diagrams) {
    const diagram = fn();
    const filename = join(OUTPUT_DIR, `data-${name}.mmd`);
    writeFileSync(filename, diagram);
    console.log(`✓ ${name} -> ${filename}`);
  }

  // Generate combined markdown
  let combined = `# Data-Driven Schema Diagrams

Auto-generated from actual YAML entity data.

Generated: ${new Date().toISOString()}

Total entities: ${entities.length}

---

`;

  for (const { name, fn } of diagrams) {
    const title = name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    combined += `## ${title}

\`\`\`mermaid
${fn()}
\`\`\`

---

`;
  }

  writeFileSync(join(OUTPUT_DIR, 'data-diagrams.md'), combined);
  console.log(`\n✓ Combined -> ${join(OUTPUT_DIR, 'data-diagrams.md')}`);

  console.log('\nDone!');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
