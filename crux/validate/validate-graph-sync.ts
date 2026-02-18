#!/usr/bin/env node
/**
 * Validate that all nodes in individual entity diagrams exist in the master graph.
 *
 * This ensures the master graph stays the single source of truth for node definitions.
 *
 * Usage:
 *   node scripts/validate-graph-sync.ts
 *
 * Exit codes:
 *   0 - All nodes are synced
 *   1 - Missing nodes found
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

// AI Transition Model entities are split across multiple files
const ENTITY_FILES: string[] = [
  'data/entities/ai-transition-model-factors.yaml',
  'data/entities/ai-transition-model-metrics.yaml',
  'data/entities/ai-transition-model-parameters.yaml',
  'data/entities/ai-transition-model-scenarios.yaml',
  'data/entities/ai-transition-model-subitems.yaml',
];
const MASTER_GRAPH_PATH: string = 'data/graphs/ai-transition-model-master.yaml';

interface CauseEffectNode {
  id: string;
  label: string;
  [key: string]: unknown;
}

interface Entity {
  id: string;
  causeEffectGraph?: {
    nodes?: CauseEffectNode[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface MasterGraphCategory {
  id: string;
  subItems?: Array<{ id: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface MasterGraphDetailedNode {
  id: string;
  [key: string]: unknown;
}

interface MasterGraph {
  categories?: MasterGraphCategory[];
  detailedNodes?: MasterGraphDetailedNode[];
  [key: string]: unknown;
}

interface MissingNode {
  nodeId: string;
  nodeLabel: string;
  entityId: string;
}

export function runCheck(_options?: ValidatorOptions): ValidatorResult {
  // Load and combine all entity files
  const entities: Entity[] = [];
  for (const filePath of ENTITY_FILES) {
    if (existsSync(filePath)) {
      const content = yaml.load(readFileSync(filePath, 'utf8'), { schema: yaml.JSON_SCHEMA }) as Entity[] | undefined;
      if (Array.isArray(content)) {
        entities.push(...content);
      }
    }
  }

  const masterYaml: string = readFileSync(MASTER_GRAPH_PATH, 'utf8');
  const masterGraph = yaml.load(masterYaml, { schema: yaml.JSON_SCHEMA }) as MasterGraph;

  // Extract all node IDs from master graph
  const masterNodeIds = new Set<string>();

  for (const cat of masterGraph.categories || []) {
    masterNodeIds.add(cat.id);
    for (const sub of cat.subItems || []) {
      masterNodeIds.add(sub.id);
    }
  }

  for (const node of masterGraph.detailedNodes || []) {
    masterNodeIds.add(node.id);
  }

  // Find missing nodes
  const missingNodes: MissingNode[] = [];

  for (const entity of entities) {
    if (!entity.causeEffectGraph?.nodes) continue;

    for (const node of entity.causeEffectGraph.nodes) {
      if (!masterNodeIds.has(node.id)) {
        missingNodes.push({
          nodeId: node.id,
          nodeLabel: node.label,
          entityId: entity.id,
        });
      }
    }
  }

  if (missingNodes.length === 0) {
    console.log('✓ Graph sync validation passed');
    console.log(`  Master graph: ${masterNodeIds.size} nodes`);
    console.log(`  All individual diagram nodes found in master graph`);
    return { passed: true, errors: 0, warnings: 0 };
  } else {
    console.error('✗ Graph sync validation FAILED');
    console.error(`  Found ${missingNodes.length} nodes in individual diagrams not in master graph:\n`);

    // Group by entity
    const byEntity = new Map<string, MissingNode[]>();
    for (const m of missingNodes) {
      if (!byEntity.has(m.entityId)) byEntity.set(m.entityId, []);
      byEntity.get(m.entityId)!.push(m);
    }

    for (const [entityId, nodes] of byEntity) {
      console.error(`  ${entityId}:`);
      for (const n of nodes) {
        console.error(`    - ${n.nodeId} ("${n.nodeLabel}")`);
      }
    }

    console.error(`\nTo fix: manually add the missing nodes to ${MASTER_GRAPH_PATH}`);
    return { passed: false, errors: missingNodes.length, warnings: 0 };
  }
}

function main(): void {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
