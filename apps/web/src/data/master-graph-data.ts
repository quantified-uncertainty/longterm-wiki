/**
 * Master Graph Data Loader
 *
 * Loads the unified AI Transition Model graph and provides
 * category-level data for overview views.
 *
 * Ported from apps/longterm/src/data/master-graph-data.ts
 * Uses fs.readFileSync instead of Vite ?raw imports, with lazy loading pattern
 */

import fs from 'fs';
import path from 'path';
import { loadYaml } from '@lib/yaml';
import type { Edge } from '@xyflow/react';
import type { CauseEffectEdgeData } from '@/components/wiki/CauseEffectGraph/types';

// Lazy-loaded raw YAML content from repo-root data directory
let _rawYaml: string | null = null;
function getRawYaml(): string {
  if (!_rawYaml) {
    const yamlPath = path.join(process.cwd(), '../data/graphs/ai-transition-model-master.yaml');
    _rawYaml = fs.readFileSync(yamlPath, 'utf-8');
  }
  return _rawYaml;
}

// Types for the YAML structure
interface SubItem {
  id: string;
  label: string;
}

interface Category {
  id: string;
  label: string;
  type: 'cause' | 'intermediate' | 'effect';
  subgroup?: string;
  order?: number;
  description?: string;
  entityRef?: string;
  subItems?: SubItem[];
}

interface CategoryEdge {
  source: string;
  target: string;
  strength?: 'weak' | 'medium' | 'strong';
  effect?: 'increases' | 'decreases' | 'mixed';
  label?: string;
}

interface MasterGraphYaml {
  id: string;
  title: string;
  description?: string;
  version?: string;
  categories: Category[];
  categoryEdges: CategoryEdge[];
  detailedNodes: unknown[];
  detailedEdges: unknown[];
  subgraphs?: unknown[];
}

// Parse and cache
let cachedData: MasterGraphYaml | null = null;

function getData(): MasterGraphYaml {
  if (!cachedData) {
    cachedData = loadYaml<MasterGraphYaml>(getRawYaml());
  }
  return cachedData;
}

/**
 * Get overview-level edges (between categories)
 */
export function getOverviewEdges(): Edge<CauseEffectEdgeData>[] {
  const data = getData();

  return data.categoryEdges.map((edge, i) => ({
    id: `cat-${i}-${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    data: {
      strength: edge.strength || 'medium',
      effect: edge.effect || 'increases',
    },
    label: edge.label,
  }));
}

/**
 * Get categories (for grouping in detailed view)
 */
export function getCategories(): Category[] {
  return getData().categories;
}
