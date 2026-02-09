/**
 * ATMPage - Full page component for AI Transition Model entities
 *
 * Renders a complete page from YAML data with optional custom content.
 * Simplifies MDX files to just frontmatter + component call.
 *
 * Usage (minimal page):
 *   <ATMPage entityId="tmc-compute" />
 *
 * Usage (with custom content):
 *   <ATMPage entityId="tmc-compute">
 *     Custom tables, prose, etc.
 *   </ATMPage>
 */

import React from 'react';
import { getTypedEntityById } from '@/data';
import { TransitionModelContent } from './TransitionModelContent';
import { Backlinks } from './Backlinks';

interface ATMPageProps {
  /** Entity ID (e.g., "tmc-compute", "racing-intensity") */
  entityId: string;
  /** Custom content to render between description and structured data */
  children?: React.ReactNode;
  /** Show description from YAML as intro (default: true) */
  showDescription?: boolean;
  /** Show backlinks section at bottom (default: true) */
  showBacklinks?: boolean;
  /** Props to pass through to TransitionModelContent */
  showRatings?: boolean;
  showScope?: boolean;
  showDebates?: boolean;
  showRelated?: boolean;
  showInfluences?: boolean;
  showCurrentAssessment?: boolean;
  showInterventions?: boolean;
  showEstimates?: boolean;
  showWarningIndicators?: boolean;
  showCauseEffectGraph?: boolean;
}

export function ATMPage({
  entityId,
  children,
  showDescription = true,
  showBacklinks = true,
  showRatings = true,
  showScope = true,
  showDebates = true,
  showRelated = true,
  showInfluences = true,
  showCurrentAssessment = true,
  showInterventions = true,
  showEstimates = true,
  showWarningIndicators = true,
  showCauseEffectGraph = true,
}: ATMPageProps) {
  // Normalize entityId - add tmc- prefix if needed for lookup
  const lookupId = entityId.startsWith('tmc-') ? entityId : `tmc-${entityId}`;
  const entity = getTypedEntityById(lookupId) || getTypedEntityById(entityId);

  if (!entity) {
    return (
      <div className="p-4 bg-destructive/10 border border-destructive rounded-lg text-destructive">
        Entity &quot;{entityId}&quot; not found. Check the entityId matches an entry in ai-transition-model.yaml.
      </div>
    );
  }

  // Extract backlinks ID (strip tmc- prefix for backlinks lookup)
  const backlinksId = entityId.replace(/^tmc-/, '');

  return (
    <div className="flex flex-col gap-6">
      {/* Description as intro prose */}
      {showDescription && entity.description && (
        <div className="text-base leading-relaxed">
          <p className="m-0">{entity.description}</p>
        </div>
      )}

      {/* Custom content from MDX children */}
      {children && (
        <div className="my-4">
          {children}
        </div>
      )}

      {/* Divider before structured content */}
      {(showDescription || children) && <hr className="border-0 border-t border-border my-2" />}

      {/* Structured data from YAML via TransitionModelContent */}
      <TransitionModelContent
        entityId={lookupId}
        showDescription={false}
        showRatings={showRatings}
        showScope={showScope}
        showDebates={showDebates}
        showRelated={showRelated}
        showInfluences={showInfluences}
        showCurrentAssessment={showCurrentAssessment}
        showInterventions={showInterventions}
        showEstimates={showEstimates}
        showWarningIndicators={showWarningIndicators}
        showCauseEffectGraph={showCauseEffectGraph}
        showBacklinks={false}
      />

      {/* Backlinks */}
      {showBacklinks && (
        <>
          <hr className="border-0 border-t border-border my-2" />
          <Backlinks entityId={backlinksId} />
        </>
      )}
    </div>
  );
}

export default ATMPage;
