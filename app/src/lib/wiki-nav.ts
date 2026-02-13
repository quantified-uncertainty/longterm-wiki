/**
 * Wiki sidebar navigation data builders.
 *
 * Server-side only: reads from the database to build NavSection[] arrays
 * for pages that need contextual sidebar navigation (Analytical Models,
 * AI Transition Model, Key Metrics).
 *
 * Uses the shared data layer from @/data — no direct fs reads.
 */

import { getEntityHref, getAllPages } from "@/data";
import type { NavSection } from "./internal-nav";

// Re-export NavSection so consumers can import from one place
export type { NavSection } from "./internal-nav";

// ============================================================================
// MODEL CATEGORY LABELS
// ============================================================================

const MODEL_CATEGORY_LABELS: Record<string, string> = {
  "analysis-models": "Analysis Models",
  "cascade-models": "Cascade Models",
  "domain-models": "Domain Models",
  "dynamics-models": "Dynamics Models",
  "framework-models": "Framework Models",
  "governance-models": "Governance Models",
  "impact-models": "Impact Models",
  "intervention-models": "Intervention Models",
  "race-models": "Race Models",
  "risk-models": "Risk Models",
  "safety-models": "Safety Models",
  "societal-models": "Societal Models",
  "threshold-models": "Threshold Models",
  "timeline-models": "Timeline Models",
};

const MODEL_CATEGORY_ORDER = [
  "domain-models",
  "timeline-models",
  "cascade-models",
  "societal-models",
  "risk-models",
  "framework-models",
  "analysis-models",
  "threshold-models",
  "dynamics-models",
  "impact-models",
  "race-models",
  "intervention-models",
  "safety-models",
  "governance-models",
];

// ============================================================================
// ANALYTICAL MODELS NAV
// ============================================================================

export function getModelsNav(): NavSection[] {
  const pages = getAllPages().filter(
    (p) =>
      p.filePath &&
      p.filePath.startsWith("knowledge-base/models/") &&
      !p.filePath.endsWith("index.mdx")
  );

  // Group by subcategory (set during content flattening)
  const groups: Record<string, { id: string; title: string }[]> = {};
  for (const page of pages) {
    const category = page.subcategory; // e.g., "risk-models"
    if (!category) continue;
    if (!groups[category]) groups[category] = [];
    groups[category].push({ id: page.id, title: page.title });
  }

  // Sort items within each group alphabetically
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.title.localeCompare(b.title));
  }

  // Build sections in specified order
  const sections: NavSection[] = [];
  for (const category of MODEL_CATEGORY_ORDER) {
    const items = groups[category];
    if (!items || items.length === 0) continue;
    sections.push({
      title: MODEL_CATEGORY_LABELS[category] || category,
      items: items.map((item) => ({
        label: item.title,
        href: getEntityHref(item.id),
      })),
    });
  }

  return sections;
}

// ============================================================================
// KEY METRICS NAV
// ============================================================================

export function getMetricsNav(): NavSection[] {
  const pages = getAllPages().filter(
    (p) =>
      p.filePath &&
      p.filePath.startsWith("knowledge-base/metrics/") &&
      !p.filePath.endsWith("index.mdx")
  );

  const items = pages
    .map((p) => ({ label: p.title, href: getEntityHref(p.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return items.length > 0
    ? [{ title: "Key Metrics", defaultOpen: false, items }]
    : [];
}

// ============================================================================
// AI TRANSITION MODEL NAV
// ============================================================================

// ATM section grouping based on subcategory values (set during content flattening)
const ATM_SECTIONS: {
  title: string;
  subcategories: string[];
  defaultOpen?: boolean;
}[] = [
  {
    title: "Outcomes",
    subcategories: ["outcomes"],
  },
  {
    title: "Scenarios",
    subcategories: [
      "scenarios",
      "scenarios-ai-takeover",
      "scenarios-human-catastrophe",
      "scenarios-long-term-lockin",
    ],
  },
  {
    title: "AI Factors",
    subcategories: [
      "factors",
      "factors-ai-capabilities",
      "factors-ai-uses",
      "factors-ai-ownership",
      "factors-misalignment-potential",
    ],
  },
  {
    title: "Civilizational Factors",
    subcategories: [
      "factors-civilizational-competence",
      "factors-transition-turbulence",
      "factors-misuse-potential",
    ],
  },
  {
    title: "Quantitative Models",
    subcategories: ["models"],
  },
];

export function getAtmNav(): NavSection[] {
  const pages = getAllPages().filter(
    (p) =>
      p.filePath &&
      p.filePath.startsWith("ai-transition-model/") &&
      !p.filePath.endsWith("index.mdx")
  );

  // Top-level items (overview, parameter table)
  const topItems = [
    { label: "Overview", href: "/wiki/ai-transition-model" },
    { label: "Parameter Table", href: "/wiki/table" },
  ];

  const sections: NavSection[] = [
    { title: "AI Transition Model", defaultOpen: true, items: topItems },
  ];

  for (const section of ATM_SECTIONS) {
    const sectionPages = pages.filter(
      (p) => p.subcategory && section.subcategories.includes(p.subcategory)
    );
    if (sectionPages.length === 0) continue;

    const items = sectionPages
      .map((p) => ({ label: p.title, href: getEntityHref(p.id) }))
      .sort((a, b) => a.label.localeCompare(b.label));

    sections.push({
      title: section.title,
      defaultOpen: section.defaultOpen,
      items,
    });
  }

  return sections;
}

// ============================================================================
// COMBINED REFERENCE NAV (Models + Metrics)
// ============================================================================

export function getReferenceNav(): NavSection[] {
  return [...getModelsNav(), ...getMetricsNav()];
}

// ============================================================================
// DETECT WHICH SIDEBAR TO SHOW
// ============================================================================

export type WikiSidebarType = "models" | "atm" | null;

/**
 * Determine which sidebar to show based on the entity path.
 * Returns null if no sidebar should be shown.
 */
export function detectSidebarType(entityPath: string): WikiSidebarType {
  if (!entityPath) return null;

  if (
    entityPath.startsWith("/knowledge-base/models/") ||
    entityPath.startsWith("/knowledge-base/metrics/")
  ) {
    return "models";
  }

  if (entityPath.startsWith("/ai-transition-model/")) {
    return "atm";
  }

  return null;
}

/**
 * Get the nav sections for a given sidebar type.
 */
export function getWikiNav(type: WikiSidebarType): NavSection[] {
  switch (type) {
    case "models":
      return getReferenceNav();
    case "atm":
      return getAtmNav();
    default:
      return [];
  }
}

/**
 * Get the sidebar title for a given sidebar type.
 */
function getWikiSidebarTitle(type: WikiSidebarType): string {
  switch (type) {
    case "models":
      return "Reference";
    case "atm":
      return "AI Transition Model";
    default:
      return "";
  }
}
