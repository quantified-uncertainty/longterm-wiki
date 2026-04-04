// AI Safety Approaches Comparison Table
// Evaluates safety techniques on whether they actually make the world safer
// vs. primarily enabling more capable (potentially dangerous) systems

import safetyApproachesData from "./safety-approaches.json";

export type RatingLevel =
  | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NEGLIGIBLE'  // For safety uplift
  | 'DOMINANT' | 'SIGNIFICANT' | 'SOME' | 'NEUTRAL' | 'TAX'  // For capability uplift
  | 'HARMFUL' | 'UNCLEAR' | 'HELPFUL'  // For net effect
  | 'NONE' | 'WEAK' | 'PARTIAL' | 'STRONG'  // For robustness
  | 'NO' | 'UNLIKELY' | 'UNKNOWN' | 'MAYBE' | 'YES'  // For scalability
  | 'NEGATIVE' | 'MODERATE' | 'CORE'  // For incentives
  | 'EXPERIMENTAL' | 'WIDESPREAD' | 'UNIVERSAL'  // For adoption
  | 'N/A' | '???';

export interface RatedProperty {
  level: string;
  note: string;
}

export type MechanismType = 'Training' | 'Architecture' | 'Evaluation' | 'Governance' | 'Runtime' | 'Research' | 'Theoretical';
export type FailureMode = 'Misalignment' | 'Misuse' | 'Accident' | 'Deception' | 'Power-seeking' | 'Capability-control' | 'Multiple';

// Recommendation levels for research prioritization
export type RecommendationLevel =
  | 'DEFUND'      // Actively counterproductive; reduce investment
  | 'REDUCE'      // Overfunded relative to safety value
  | 'MAINTAIN'    // About right
  | 'INCREASE'    // Underfunded; should grow
  | 'PRIORITIZE'; // Among most important; needs much more

// Differential progress levels
export type DifferentialLevel =
  | 'SAFETY-DOMINANT'    // Safety benefit >> capability benefit
  | 'SAFETY-LEANING'     // Safety benefit > capability benefit
  | 'BALANCED'           // Roughly equal
  | 'CAPABILITY-LEANING' // Capability benefit > safety benefit
  | 'CAPABILITY-DOMINANT'; // Capability benefit >> safety benefit

// Architecture relevance levels
export type ArchitectureRelevanceLevel =
  | 'CRITICAL'       // Essential for this architecture
  | 'HIGH'           // Very relevant
  | 'MEDIUM'         // Somewhat relevant
  | 'LOW'            // Limited relevance
  | 'NOT_APPLICABLE'; // Doesn't apply to this architecture

// Architecture IDs from architecture-scenarios.yaml
export type ArchitectureId =
  | 'scaled-transformers'
  | 'scaffolded-agents'
  | 'ssm-based'
  | 'hybrid-neurosymbolic'
  | 'novel-unknown';

export interface ArchitectureRelevance {
  architectureId: ArchitectureId;
  relevance: ArchitectureRelevanceLevel;
  note: string;
}

export interface SafetyApproach {
  id: string;
  name: string;
  description: string;
  category: 'training' | 'interpretability' | 'evaluation' | 'architectural' | 'governance' | 'theoretical';

  // Core tradeoff columns
  safetyUplift: RatedProperty;      // How much does this reduce catastrophic risk?
  capabilityUplift: RatedProperty;  // Does it make AI more capable/useful?
  netWorldSafety: RatedProperty;    // Given both, is the world safer?
  labIncentive: RatedProperty;      // Do labs have commercial reason to do this?

  // Quantitative columns
  researchInvestment: {
    amount: string;  // e.g., "$1B+/yr", "$10-50M/yr"
    note: string;
  };
  differentialProgress: {
    level: DifferentialLevel;
    note: string;
  };
  recommendation: {
    level: RecommendationLevel;
    note: string;
  };

  // Mechanism
  mechanism: MechanismType;
  failureModeTargeted: FailureMode[];

  // Critical assessment
  scalability: RatedProperty;        // Does it work as AI gets smarter?
  deceptionRobust: RatedProperty;    // Does it work against deceptive AI?
  siReady: RatedProperty;            // Works for superintelligent AI?

  // Context
  currentAdoption: RatedProperty;
  keyPapers: string[];
  keyLabs: string[];
  mainCritiques: string[];

  // Architecture relevance
  architectureRelevance?: ArchitectureRelevance[];
}

// Data loaded from safety-approaches.json
export const SAFETY_APPROACHES: SafetyApproach[] = safetyApproachesData as SafetyApproach[];

// Category definitions for grouping
export const CATEGORIES = [
  { id: 'training', label: 'Training & Alignment', color: '#3b82f6' },
  { id: 'interpretability', label: 'Interpretability & Transparency', color: '#8b5cf6' },
  { id: 'evaluation', label: 'Evaluation & Red-teaming', color: '#f59e0b' },
  { id: 'architectural', label: 'Architectural & Runtime', color: '#10b981' },
  { id: 'governance', label: 'Governance & External', color: '#ef4444' },
  { id: 'theoretical', label: 'Theoretical & Research', color: '#6366f1' },
] as const;

// Helper to get approaches by category
export function getApproachesByCategory(category: string): SafetyApproach[] {
  return SAFETY_APPROACHES.filter(a => a.category === category);
}
