// AI Evaluation Types Table Data

import evalTypesData from "./eval-types.json";

export type RiskCoverage = {
  risk: string;
  strength: "strong" | "partial" | "weak";
  note?: string;
};

export type EvalType = {
  id: string;
  name: string;
  description: string;
  category: string;
  // Signal quality
  signalReliability: { level: string; note: string };
  coverageDepth: { level: string; note: string };
  goodhartRisk: { level: string; note: string };
  // Risk coverage
  riskCoverage: RiskCoverage[];
  // Strategic properties
  timing: { when: string; note: string };
  archDependence: { level: string; note: string };
  actionability: { level: string; note: string };
  scalability: { level: string; note: string };
  // Landscape
  labs: string[];
  examples: string[];
  keyPapers: string[];
  // Assessment
  strategicPros: string[];
  strategicCons: string[];
};

export const EVAL_CATEGORIES = [
  "Capability Evals",
  "Alignment Evals",
  "Epistemic Evals",
  "Control Evals",
  "Interpretability Evals",
  "Red Teaming",
  "Research Evals",
  "Societal Evals",
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

// Data loaded from eval-types.json
export const evalTypes: EvalType[] = evalTypesData as EvalType[];
