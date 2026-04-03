/**
 * Accident Risks Table Data
 *
 * This file contains data for AI accident risks with explicit overlap handling.
 * Key design decisions:
 * - abstractionLevel: Distinguishes theoretical frameworks from behaviors from outcomes
 * - relatedRisks: Explicit relationships (requires, enables, overlaps, manifestation-of)
 * - pageSlug: Links to existing knowledge-base pages where available
 */

import accidentRisksData from "./accident-risks.json";

export type AbstractionLevel =
  | 'THEORETICAL' // Foundational concepts/frameworks (mesa-optimization, instrumental convergence)
  | 'MECHANISM' // How failures occur (deceptive alignment, goal misgeneralization)
  | 'BEHAVIOR' // Observable manifestations (scheming, power-seeking, reward hacking)
  | 'OUTCOME'; // Resulting states (treacherous turn, corrigibility failure)

export type RelationshipType =
  | 'requires' // This risk requires the other to be present
  | 'enables' // This risk can lead to/enable the other
  | 'overlaps' // Significant conceptual overlap
  | 'manifestation-of' // This is a behavioral manifestation of the other
  | 'special-case-of'; // This is a specific instance of a more general risk

export type EvidenceLevel =
  | 'THEORETICAL' // Argued from first principles, no empirical evidence yet
  | 'DEMONSTRATED_LAB' // Shown in controlled experiments
  | 'OBSERVED_CURRENT' // Occurring in deployed systems
  | 'SPECULATIVE'; // Hypothesized but not well-established theoretically

export type TimelineRelevance =
  | 'CURRENT' // Relevant to today's systems
  | 'NEAR_TERM' // 1-3 years
  | 'MEDIUM_TERM' // 3-10 years
  | 'LONG_TERM' // 10+ years or requires AGI
  | 'UNCERTAIN';

export type SeverityLevel =
  | 'LOW' // Annoying but not dangerous
  | 'MEDIUM' // Can cause real harm in specific contexts
  | 'HIGH' // Can cause significant harm
  | 'CATASTROPHIC' // Could cause civilizational-scale harm
  | 'EXISTENTIAL'; // Could lead to human extinction or permanent disempowerment

export type DetectabilityLevel =
  | 'EASY' // Obvious when it occurs
  | 'MODERATE' // Detectable with effort
  | 'DIFFICULT' // Requires sophisticated techniques
  | 'VERY_DIFFICULT' // May be fundamentally hard to detect
  | 'UNKNOWN';

export interface RiskRelationship {
  riskId: string;
  type: RelationshipType;
  note?: string;
}

export interface AccidentRisk {
  id: string;
  name: string;
  shortDescription: string;
  abstractionLevel: AbstractionLevel;
  category: string;
  pageSlug?: string; // Link to existing knowledge-base page

  // Overlap handling
  relatedRisks: RiskRelationship[];
  overlapNote?: string; // Explicit note about how this overlaps with others

  // Assessment
  evidenceLevel: EvidenceLevel;
  evidenceNote: string;
  timeline: TimelineRelevance;
  timelineNote: string;
  severity: SeverityLevel;
  severityNote: string;
  detectability: DetectabilityLevel;
  detectabilityNote: string;

  // Key questions
  keyQuestion: string;

  // Sources
  keyPapers?: string[];
}

// Data loaded from accident-risks.json
export const accidentRisks: AccidentRisk[] = accidentRisksData as AccidentRisk[];

// Category order for display
export const riskCategories = [
  'Theoretical Frameworks',
  'Alignment Failures',
  'Specification Problems',
  'Deceptive Behaviors',
  'Instrumental Behaviors',
  'Capability Concerns',
  'Catastrophic Scenarios',
  'Human-AI Interaction',
];

// Abstraction level descriptions
export const abstractionLevelDescriptions: Record<AbstractionLevel, string> = {
  THEORETICAL: 'Foundational concepts and frameworks',
  MECHANISM: 'How failures occur',
  BEHAVIOR: 'Observable manifestations',
  OUTCOME: 'Resulting states and scenarios',
};

// Get related risks for a given risk
function getRelatedRisks(
  riskId: string
): { risk: AccidentRisk; relationship: RiskRelationship }[] {
  const risk = accidentRisks.find((r) => r.id === riskId);
  if (!risk) return [];

  return risk.relatedRisks
    .map((rel) => {
      const relatedRisk = accidentRisks.find((r) => r.id === rel.riskId);
      if (!relatedRisk) return null;
      return { risk: relatedRisk, relationship: rel };
    })
    .filter((r): r is { risk: AccidentRisk; relationship: RiskRelationship } => r !== null);
}
