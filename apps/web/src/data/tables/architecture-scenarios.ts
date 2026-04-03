/**
 * Intelligence Paradigms / Architecture Scenarios Table Data
 *
 * This file contains data for AI architecture scenarios and intelligence paradigms
 * used in the ArchitectureScenariosTableView table.
 * Separates base architectures (what the model is) from deployment patterns (how it's used).
 */

import scenariosData from "./architecture-scenarios.json";

// Types
export type SafetyOutlook = "favorable" | "mixed" | "challenging" | "unknown";
export type Category = "deployment" | "base-arch" | "alt-compute" | "non-ai";

export interface Link {
  title: string;
  url?: string;
}

export interface LabLink {
  name: string;
  url?: string;
}

export interface Scenario {
  id: string;
  category: Category;
  name: string;
  pageUrl?: string;
  description: string;
  likelihood: string;
  likelihoodNote: string;
  timeline: string;
  safetyOutlook: {
    rating: SafetyOutlook;
    score?: number;
    summary: string;
    keyRisks: string[];
    keyOpportunities: string[];
  };
  whitebox: { level: string; note: string };
  training: { level: string; note: string };
  predictability: { level: string; note: string };
  reprConvergence: { level: string; note: string };
  modularity: { level: string; note: string };
  formalVerifiable: { level: string; note: string };
  researchTractability: { level: string; note: string };
  labs: LabLink[];
  examples: Link[];
  keyPapers: Link[];
  safetyPros: string[];
  safetyCons: string[];
}

// Category metadata
export const CATEGORIES: Record<Category, { label: string; description: string }> = {
  deployment: { label: "Deployment Patterns", description: "How models are orchestrated and used" },
  "base-arch": { label: "Base Architectures", description: "Core neural network architectures" },
  "alt-compute": { label: "Alternative Compute", description: "Non-standard computing substrates" },
  "non-ai": { label: "Non-AI Paradigms", description: "Intelligence enhancement without traditional AI" },
};

// Category order for sorting/grouping
export const CATEGORY_ORDER: Category[] = ["deployment", "base-arch", "alt-compute", "non-ai"];

// Data loaded from architecture-scenarios.json
export const scenarios: Scenario[] = scenariosData as Scenario[];
