// Frontier AI Labs Comparison Table
// Editorial ratings of major frontier AI developers on safety-relevant
// dimensions. Hand-curated, opinionated. Notes anchor each rating in
// observable signals (publications, RSPs, departures, public statements).

import frontierLabsData from "./frontier-labs.json";

export interface RatedField {
  level: string;
  note: string;
}

export interface LabLink {
  label: string;
  url: string;
}

export type FrontierLabCategory =
  | "us-frontier"
  | "frontier-china"
  | "frontier-europe"
  | "specialized"
  | "historical";

export interface FrontierLab {
  id: string;
  name: string;
  description: string;
  category: FrontierLabCategory;
  entityId?: string;

  capabilityTier: RatedField;
  safetyInvestment: RatedField;
  racePostureRestraint: RatedField;
  transparency: RatedField;
  govEngagement: RatedField;
  leadershipSafetyAlignment: RatedField;
  employeeSafetyCulture: RatedField;
  rspQuality: RatedField;

  notableSignals: string[];
  links: LabLink[];
}

export const FRONTIER_LAB_CATEGORIES: { id: FrontierLabCategory; label: string }[] = [
  { id: "us-frontier", label: "US frontier" },
  { id: "frontier-china", label: "China frontier" },
  { id: "frontier-europe", label: "Europe frontier" },
  { id: "specialized", label: "Specialized / enterprise" },
  { id: "historical", label: "Historical / absorbed" },
];

export const frontierLabs: FrontierLab[] = frontierLabsData as FrontierLab[];
