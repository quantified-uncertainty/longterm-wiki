// Deployment Architectures data loader

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// Lazy-loaded YAML content from repo-root data directory
let _rawYaml: string | null = null;
function getGraphYaml(): string {
  if (!_rawYaml) {
    const yamlPath = path.join(process.cwd(), '../data/graphs/deployment-architectures.yaml');
    _rawYaml = fs.readFileSync(yamlPath, 'utf-8');
  }
  return _rawYaml;
}

interface RawSubItem {
  id?: string;
  label?: string;
  description?: string;
}

interface RawNode {
  id: string;
  label: string;
  description?: string;
  type: 'cause' | 'intermediate' | 'effect';
  order?: number;
  subgroup?: string;
  subItems?: RawSubItem[];
}

interface RawEdge {
  id: string;
  source: string;
  target: string;
  strength?: 'strong' | 'medium' | 'weak';
  effect?: 'increases' | 'decreases';
}

interface RawGraphData {
  nodes: RawNode[];
  edges: RawEdge[];
}

// Lazy-loaded parsed data
let _rawData: RawGraphData | null = null;
function getRawData(): RawGraphData {
  if (!_rawData) {
    _rawData = yaml.load(getGraphYaml()) as RawGraphData;
  }
  return _rawData;
}

export interface DeploymentProperty {
  id: string;
  label: string;
  description?: string;
  sentiment: 'positive' | 'negative' | 'neutral';
}

export interface DeploymentArchitecture {
  id: string;
  label: string;
  description?: string;
  adoption: string;
  timeline: string;
  properties: DeploymentProperty[];
}

export function getDeploymentArchitectures(): DeploymentArchitecture[] {
  const rawData = getRawData();
  const architectures: DeploymentArchitecture[] = [];
  const effectNodes = rawData.nodes.filter(n => n.type === 'effect');

  for (const effect of effectNodes) {
    // Find all edges pointing to this effect
    const incomingEdges = rawData.edges.filter(e => e.target === effect.id);

    const properties: DeploymentProperty[] = [];

    for (const edge of incomingEdges) {
      const sourceNode = rawData.nodes.find(n => n.id === edge.source);
      if (!sourceNode) continue;

      properties.push({
        id: sourceNode.id,
        label: sourceNode.label,
        description: sourceNode.description,
        sentiment: edge.effect === 'decreases' ? 'negative' : 'positive',
      });
    }

    // Extract adoption and timeline from subItems
    let adoption = '';
    let timeline = '';

    if (effect.subItems) {
      for (const item of effect.subItems) {
        if (item.label?.includes('Adoption:')) {
          adoption = item.label.replace('Adoption: ', '');
        }
        if (item.label?.includes('Timeline:')) {
          timeline = item.label.replace('Timeline: ', '');
        }
      }
    }

    architectures.push({
      id: effect.id,
      label: effect.label,
      description: effect.description,
      adoption,
      timeline,
      properties,
    });
  }

  return architectures;
}

// Property categories for structured display
export const PROPERTY_CATEGORIES = [
  { key: 'agency', label: 'Agency Level' },
  { key: 'decomposition', label: 'Decomposition' },
  { key: 'oversight', label: 'Oversight Mechanism' },
  { key: 'whitebox', label: 'White-box Access' },
] as const;

// Get a normalized property rating for matrix view
export function getPropertyRating(architecture: DeploymentArchitecture, propertyKey: string): {
  level: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' | 'PARTIAL' | 'MINIMAL' | 'VARIABLE' | 'NONE';
  sentiment: 'positive' | 'negative' | 'neutral';
} {
  const prop = architecture.properties.find(p => p.id.includes(propertyKey));
  if (!prop) return { level: 'UNKNOWN', sentiment: 'neutral' };

  const label = prop.label.toUpperCase();

  if (label.includes('HIGH') && !label.includes('MEDIUM')) {
    return { level: 'HIGH', sentiment: 'positive' };
  }
  if (label.includes('MEDIUM-HIGH')) {
    return { level: 'MEDIUM', sentiment: 'positive' };
  }
  if (label.includes('MEDIUM')) {
    return { level: 'MEDIUM', sentiment: 'neutral' };
  }
  if (label.includes('LOW-MEDIUM')) {
    return { level: 'LOW', sentiment: 'neutral' };
  }
  if (label.includes('LOW')) {
    return { level: 'LOW', sentiment: 'negative' };
  }
  if (label.includes('PARTIAL')) {
    return { level: 'PARTIAL', sentiment: 'neutral' };
  }
  if (label.includes('MINIMAL')) {
    return { level: 'MINIMAL', sentiment: 'positive' };
  }
  if (label.includes('VARIABLE')) {
    return { level: 'VARIABLE', sentiment: 'neutral' };
  }
  if (label.includes('NONE') || label.includes('N/A')) {
    return { level: 'NONE', sentiment: 'neutral' };
  }
  if (label.includes('UNKNOWN') || label.includes('UNCERTAIN')) {
    return { level: 'UNKNOWN', sentiment: 'neutral' };
  }

  return { level: 'UNKNOWN', sentiment: 'neutral' };
}

export function getRawDeploymentData(): RawGraphData {
  return getRawData();
}
