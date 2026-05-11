// AGI Bottlenecks Table Data
// QUA-1124

import agiBottlenecksData from "./agi-bottlenecks.json";

export type AGIBottleneck = {
  id: string;
  name: string;
  description: string;
  category: string;
  tightness: { level: string; note: string };
  trajectory: { direction: string; note: string };
  timeToRelieve: { horizon: string; note: string };
  costToExpand: { level: string; note: string };
  controllers: string[];
  geographicConcentration: { level: string; note: string };
  notes: string;
};

export const AGI_BOTTLENECK_CATEGORIES = [
  "Compute & Chips",
  "Physical Infrastructure",
  "Data & Algorithms",
  "Capital & Talent",
  "Governance",
] as const;

export type AGIBottleneckCategory = (typeof AGI_BOTTLENECK_CATEGORIES)[number];

export const agiBottlenecks: AGIBottleneck[] = agiBottlenecksData as AGIBottleneck[];
