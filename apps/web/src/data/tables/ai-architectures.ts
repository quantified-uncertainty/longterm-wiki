// Deployment/Safety Architectures Table Data

import architecturesData from "./ai-architectures.json";

export type SafetyOutlook = "favorable" | "mixed" | "challenging" | "unknown";
export type Category = "basic" | "structured" | "oversight";

export interface Source {
  title: string;
  url?: string;
  year?: string;
}

export interface Architecture {
  id: string;
  category: Category;
  name: string;
  description: string;
  adoption: string;
  adoptionNote: string;
  timeline: string;
  safetyOutlook: {
    rating: SafetyOutlook;
    score?: number;
    summary: string;
  };
  agencyLevel: { level: string; note: string };
  decomposition: { level: string; note: string };
  oversight: { level: string; note: string };
  whitebox: { level: string; note: string };
  modularity: { level: string; note: string };
  verifiable: { level: string; note: string };
  sources: Source[];
  safetyPros: string[];
  safetyCons: string[];
}

export const CATEGORY_ORDER: Category[] = ["basic", "structured", "oversight"];

// Data loaded from ai-architectures.json
export const architectures: Architecture[] = architecturesData as Architecture[];
