/**
 * PageCauseEffectGraph - Automatically renders cause-effect graph for a page
 *
 * Takes a slug (e.g., "adoption", "recursive-ai-capabilities") and:
 * 1. Maps it to the corresponding entity ID
 * 2. Fetches the causeEffectGraph data from that entity
 * 3. Renders the graph if one exists
 *
 * Usage: <PageCauseEffectGraph slug="adoption" />
 *
 * This is a DRY alternative to manually specifying:
 * <TransitionModelContent entityId="tmc-adoption" showRatings={false} ... />
 */

import React from 'react';
import { getTypedEntityById } from '@/data';
import CauseEffectGraph from './CauseEffectGraph';

// Map page slugs to entity IDs
// This allows pages to just specify their slug without knowing the entity ID format
const SLUG_TO_ENTITY: Record<string, string> = {
  // AI Capabilities factor sub-items
  'adoption': 'tmc-adoption',
  'compute': 'tmc-compute',
  'algorithms': 'tmc-algorithms',

  // AI Uses factor sub-items
  'recursive-ai-capabilities': 'tmc-recursive-ai',
  'industries': 'tmc-industries',
  'governments': 'tmc-governments',
  'coordination': 'tmc-coordination',

  // AI Ownership factor sub-items
  'companies': 'tmc-companies',
  'countries': 'tmc-countries',
  'shareholders': 'tmc-shareholders',

  // Civilizational Competence factor sub-items
  'adaptability': 'tmc-adaptability',
  'civ-epistemics': 'tmc-civ-epistemics',
  'civ-governance': 'tmc-civ-governance',

  // Misalignment Potential factor sub-items
  'ai-governance': 'tmc-ai-governance',
  'lab-safety-practices': 'tmc-lab-safety',
  'technical-ai-safety': 'tmc-technical-ai-safety',

  // Misuse Potential factor sub-items
  'biological-threat-exposure': 'biological-threat-exposure',
  'cyber-threat-exposure': 'cyber-threat-exposure',
  'robot-threat-exposure': 'tmc-robot-threat',
  'surprise-threat-exposure': 'tmc-surprise-threat',

  // Transition Turbulence factor sub-items
  'economic-stability': 'economic-stability',
  'racing-intensity': 'racing-intensity',

  // Lock-in scenario sub-items
  'economic-power': 'tmc-economic-power',
  'political-power': 'tmc-political-power',
  'values': 'tmc-values',
  'epistemics': 'tmc-epistemics',
  'suffering-lock-in': 'tmc-suffering-lock-in',

  // AI Takeover scenario sub-items
  'gradual': 'tmc-gradual',
  'rapid': 'tmc-rapid',

  // Parameters (use entity ID directly)
  'international-coordination': 'international-coordination',
  'societal-trust': 'societal-trust',
  'epistemic-health': 'epistemic-health',
  'information-authenticity': 'information-authenticity',
  'ai-control-concentration': 'ai-control-concentration',
  'human-agency': 'human-agency',
  'human-expertise': 'human-expertise',
  'human-oversight-quality': 'human-oversight-quality',
  'alignment-robustness': 'alignment-robustness',
  'safety-capability-gap': 'safety-capability-gap',
  'interpretability-coverage': 'interpretability-coverage',
  'regulatory-capacity': 'regulatory-capacity',
  'institutional-quality': 'institutional-quality',
  'reality-coherence': 'reality-coherence',
  'preference-authenticity': 'preference-authenticity',
  'safety-culture-strength': 'safety-culture-strength',
  'coordination-capacity': 'coordination-capacity',
  'societal-resilience': 'societal-resilience',
};

interface CauseEffectNode {
  id: string;
  label: string;
  description?: string;
  type: 'leaf' | 'cause' | 'intermediate' | 'effect';
  confidence?: number;
  details?: string;
  sources?: string[];
  relatedConcepts?: string[];
  entityRef?: string;
}

interface CauseEffectEdge {
  id?: string;
  source: string;
  target: string;
  strength?: 'weak' | 'medium' | 'strong';
  confidence?: 'low' | 'medium' | 'high';
  effect?: 'increases' | 'decreases' | 'mixed';
  label?: string;
}

interface CauseEffectGraphData {
  title?: string;
  description?: string;
  primaryNodeId?: string;
  nodes: CauseEffectNode[];
  edges: CauseEffectEdge[];
}

interface EntityWithGraph {
  id: string;
  causeEffectGraph?: CauseEffectGraphData;
}

interface PageCauseEffectGraphProps {
  /** Page slug (e.g., "adoption", "recursive-ai-capabilities") */
  slug: string;
  /** Optional: Override the calculated height */
  height?: number;
  /** Optional: Show title above graph */
  showTitle?: boolean;
  /** Optional: Show description below title */
  showDescription?: boolean;
}

export function PageCauseEffectGraph({
  slug,
  height,
  showTitle = true,
  showDescription = true,
}: PageCauseEffectGraphProps) {
  // Map slug to entity ID
  const entityId = SLUG_TO_ENTITY[slug] || slug;

  // Fetch entity data
  const rawEntity = getTypedEntityById(entityId);

  if (!rawEntity) {
    // Silently return nothing if entity not found
    // This allows the component to be used on pages that might not have graphs yet
    return null;
  }

  const entity = rawEntity as unknown as EntityWithGraph;

  if (!entity.causeEffectGraph || entity.causeEffectGraph.nodes.length === 0) {
    // No graph data - return nothing
    return null;
  }

  const graph = entity.causeEffectGraph;

  // Calculate dynamic height based on layer count
  const layerCount = new Set(graph.nodes.map(n => n.type)).size;
  const calculatedHeight = height || Math.min(800, Math.max(400, 100 + (layerCount * 150)));

  return (
    <div className="page-cause-effect-graph">
      {showTitle && graph.title && (
        <h3 style={{ marginBottom: '0.5rem' }}>{graph.title}</h3>
      )}
      {showDescription && graph.description && (
        <p style={{
          color: 'hsl(var(--muted-foreground))',
          fontSize: '0.9rem',
          marginBottom: '1rem',
        }}>
          {graph.description}
        </p>
      )}
      <CauseEffectGraph
        height={calculatedHeight}
        hideListView={true}
        selectedNodeId={graph.primaryNodeId}
        entityId={entityId}
        graphConfig={{
          hideGroupBackgrounds: true,
          useDagre: true,
          typeLabels: {
            leaf: 'Root Causes',
            cause: 'Derived',
            intermediate: 'Direct Factors',
            effect: 'Target',
          },
        }}
        initialNodes={graph.nodes.map((node) => ({
          id: node.id,
          type: 'causeEffect' as const,
          position: { x: 0, y: 0 },
          data: {
            label: node.label,
            description: node.description || '',
            type: node.type,
            ...(node.confidence !== undefined && { confidence: node.confidence }),
            details: node.details || '',
            sources: node.sources || [],
            relatedConcepts: node.relatedConcepts || [],
          },
        }))}
        initialEdges={graph.edges.map((edge) => ({
          id: edge.id || `e-${edge.source}-${edge.target}`,
          source: edge.source,
          target: edge.target,
          data: {
            strength: edge.strength || 'medium',
            confidence: edge.confidence || 'medium',
            effect: edge.effect || 'increases',
          },
          label: edge.label,
        }))}
      />
    </div>
  );
}

export default PageCauseEffectGraph;
