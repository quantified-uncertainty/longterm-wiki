/**
 * Wiki sidebar navigation data builders.
 *
 * Server-side only: reads from the database to build NavSection[] arrays
 * for pages that need contextual sidebar navigation.
 *
 * Supported sidebar contexts:
 * - Knowledge-base sections (risks, responses, organizations, etc.)
 * - Analytical Models & Key Metrics
 * - AI Transition Model
 * - Internal pages
 *
 * Uses the shared data layer from @/data — no direct fs reads.
 */

import { getEntityHref, getAllPages } from "@/data";
import type { NavSection } from "./internal-nav";

// Re-export NavSection so consumers can import from one place
export type { NavSection } from "./internal-nav";

/** Check if a filePath is an index file (should be excluded from sidebar nav). */
function isIndexFile(filePath: string): boolean {
  return filePath.endsWith("index.mdx") || filePath.endsWith("index.md");
}

/** Resolve an index page slug to its /wiki/E<id> URL, with fallback. */
function indexHref(sectionKey: string): string {
  const slug = `__index__/knowledge-base/${sectionKey}`;
  const resolved = getEntityHref(slug);
  // If it resolved to a numeric ID, use that
  if (resolved.startsWith("/wiki/E")) return resolved;
  // Fallback: direct path
  return `/wiki/knowledge-base/${sectionKey}`;
}

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
      !isIndexFile(p.filePath)
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
      !isIndexFile(p.filePath)
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
      !isIndexFile(p.filePath)
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
// KNOWLEDGE-BASE SECTION SIDEBARS
// ============================================================================

/**
 * Configuration for a knowledge-base section sidebar.
 * Sections with subcategoryGroups get grouped navigation;
 * sections without get a flat alphabetical list.
 */
interface KbSectionConfig {
  title: string;
  subcategoryGroups?: { title: string; subcategories: string[] }[];
}

/**
 * Sidebar configurations for knowledge-base sections.
 * Models and metrics are excluded — they use their own specialized nav builders.
 */
const KB_SECTIONS: Record<string, KbSectionConfig> = {
  risks: {
    title: "AI Risks",
    subcategoryGroups: [
      { title: "Accident Risks", subcategories: ["accident"] },
      { title: "Misuse Risks", subcategories: ["misuse"] },
      { title: "Structural Risks", subcategories: ["structural"] },
      { title: "Epistemic Risks", subcategories: ["epistemic"] },
      { title: "Economic Risks", subcategories: ["economic"] },
    ],
  },
  responses: {
    title: "Responses",
    subcategoryGroups: [
      {
        title: "Alignment",
        subcategories: [
          "alignment",
          "alignment-deployment",
          "alignment-evaluation",
          "alignment-interpretability",
          "alignment-policy",
          "alignment-theoretical",
          "alignment-training",
        ],
      },
      {
        title: "Governance",
        subcategories: [
          "governance",
          "governance-compute-governance",
          "governance-industry",
          "governance-international",
          "governance-legislation",
        ],
      },
      {
        title: "Epistemic Tools",
        subcategories: [
          "epistemic-tools",
          "epistemic-tools-approaches",
          "epistemic-tools-tools",
        ],
      },
      { title: "Biosecurity", subcategories: ["biosecurity"] },
      { title: "Field Building", subcategories: ["field-building"] },
      { title: "Institutions", subcategories: ["institutions"] },
      { title: "Legal Frameworks", subcategories: ["legal-frameworks"] },
      {
        title: "Organizational Practices",
        subcategories: ["organizational-practices"],
      },
      { title: "Resilience", subcategories: ["resilience"] },
    ],
  },
  organizations: {
    title: "Organizations",
    subcategoryGroups: [
      { title: "Labs", subcategories: ["labs"] },
      { title: "Safety Organizations", subcategories: ["safety-orgs"] },
      { title: "Funders", subcategories: ["funders"] },
      { title: "Government", subcategories: ["government"] },
      { title: "Community Building", subcategories: ["community-building"] },
      {
        title: "Epistemic Organizations",
        subcategories: ["epistemic-orgs"],
      },
      { title: "Biosecurity", subcategories: ["biosecurity-orgs"] },
      { title: "Political Advocacy", subcategories: ["political-advocacy"] },
      { title: "Finance", subcategories: ["finance", "venture-capital"] },
    ],
  },
  people: { title: "People" },
  capabilities: { title: "Capabilities" },
  "intelligence-paradigms": { title: "Intelligence Paradigms" },
  debates: { title: "Debates" },
  cruxes: { title: "Cruxes" },
  "future-projections": { title: "Future Projections" },
  worldviews: { title: "Worldviews" },
  history: { title: "History" },
  incidents: { title: "Incidents" },
  forecasting: { title: "Forecasting" },
};

/** Set of KB section keys that have their own sidebar config. */
export const KB_SECTION_KEYS = new Set(Object.keys(KB_SECTIONS));

/**
 * Build sidebar navigation for a knowledge-base section.
 * Pages are grouped by subcategory when configured, otherwise shown as a flat list.
 */
export function getKbSectionNav(sectionKey: string): NavSection[] {
  const config = KB_SECTIONS[sectionKey];
  if (!config) return [];

  const pages = getAllPages().filter(
    (p) =>
      p.filePath &&
      p.filePath.startsWith(`knowledge-base/${sectionKey}/`) &&
      !isIndexFile(p.filePath)
  );

  // Top section with overview link
  const sections: NavSection[] = [
    {
      title: config.title,
      defaultOpen: true,
      items: [{ label: "Overview", href: indexHref(sectionKey) }],
    },
  ];

  if (config.subcategoryGroups) {
    // Track which pages have been assigned to a group
    const assignedIds = new Set<string>();

    for (const group of config.subcategoryGroups) {
      const groupPages = pages.filter(
        (p) => p.subcategory && group.subcategories.includes(p.subcategory)
      );
      if (groupPages.length === 0) continue;

      for (const p of groupPages) assignedIds.add(p.id);

      sections.push({
        title: group.title,
        items: groupPages
          .map((p) => ({ label: p.title, href: getEntityHref(p.id) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      });
    }

    // Pages without a matching subcategory
    const uncategorized = pages.filter((p) => !assignedIds.has(p.id));
    if (uncategorized.length > 0) {
      sections.push({
        title: "Other",
        items: uncategorized
          .map((p) => ({ label: p.title, href: getEntityHref(p.id) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      });
    }
  } else {
    // Flat list — all pages in one section
    const items = pages
      .map((p) => ({ label: p.title, href: getEntityHref(p.id) }))
      .sort((a, b) => a.label.localeCompare(b.label));

    if (items.length > 0) {
      sections[0].items.push(...items);
    }
  }

  return sections;
}

// ============================================================================
// INTERNAL NAV
// ============================================================================

/**
 * Build internal navigation with resolved /wiki/E<id> URLs.
 * For MDX content pages, uses getEntityHref() to produce canonical /wiki/E<id> links.
 * For React dashboard pages (no entity), keeps /internal/ URLs.
 */
export function getInternalNav(): NavSection[] {
  /** Resolve a slug to its /wiki/E<id> URL, falling back to /internal/ path */
  function href(slug: string, internalPath?: string): string {
    const resolved = getEntityHref(slug);
    // getEntityHref always returns /wiki/...; if the slug had a numericId it will be /wiki/E<id>
    // If slug is not found in registry, it returns /wiki/<slug> which won't resolve — use fallback
    if (resolved.startsWith("/wiki/E")) return resolved;
    return internalPath || resolved;
  }

  return [
    {
      title: "Overview",
      defaultOpen: true,
      items: [
        { label: "Internal Home", href: href("__index__/internal", "/wiki/E779") },
        { label: "About This Wiki", href: href("about-this-wiki") },
        { label: "Vision", href: href("longterm-vision") },
        { label: "Strategy", href: href("longterm-strategy") },
        { label: "Roadmap", href: href("project-roadmap") },
        { label: "Value Proposition", href: href("longtermwiki-value-proposition") },
      ],
    },
    {
      title: "Dashboards & Tools",
      defaultOpen: true,
      items: [
        { label: "Enhancement Queue", href: href("enhancement-queue") },
        { label: "Suggested Pages", href: "/internal/suggested-pages" },
        { label: "Update Schedule", href: "/internal/updates" },
        { label: "Page Changes", href: "/internal/page-changes" },
        { label: "Fact Dashboard", href: "/internal/facts" },
        { label: "Automation Tools", href: href("automation-tools") },
        { label: "Content Database", href: href("content-database") },
        { label: "Importance Rankings", href: "/internal/importance-rankings" },
        { label: "Page Similarity", href: "/internal/similarity" },
        { label: "Interventions", href: "/internal/interventions" },
        { label: "Proposals", href: "/internal/proposals" },
      ],
    },
    {
      title: "Style Guides",
      items: [
        { label: "Common Writing Principles", href: href("common-writing-principles") },
        { label: "Page Types", href: href("page-types") },
        { label: "Knowledge Base", href: href("knowledge-base") },
        { label: "Risk Pages", href: href("risk-style-guide") },
        { label: "Response Pages", href: href("response-style-guide") },
        { label: "Models", href: href("models-style-guide") },
        { label: "Stub Pages", href: href("stub-style-guide") },
        { label: "Rating System", href: href("rating-system") },
        { label: "Mermaid Diagrams", href: href("mermaid-diagrams") },
        { label: "Cause-Effect Diagrams", href: href("cause-effect-diagrams") },
        { label: "Research Reports", href: href("research-reports") },
        { label: "AI Transition Model", href: href("ai-transition-model-style-guide") },
      ],
    },
    {
      title: "Research",
      items: [
        { label: "Reports Index", href: href("__index__/internal/reports", "/wiki/E780") },
        { label: "AI Research Workflows", href: href("ai-research-workflows") },
        { label: "Causal Diagram Visualization", href: href("causal-diagram-visualization") },
        { label: "Controlled Vocabulary", href: href("controlled-vocabulary") },
        { label: "Cross-Link Automation", href: href("cross-link-automation-proposal") },
        { label: "Diagram Naming", href: href("diagram-naming-research") },
        { label: "Page Creator Pipeline", href: href("page-creator-pipeline") },
        { label: "Gap Analysis (Feb 2026)", href: href("gap-analysis-2026-02") },
      ],
    },
    {
      title: "Architecture & Schema",
      items: [
        { label: "Architecture", href: href("architecture") },
        { label: "Wiki Generation Architecture", href: href("wiki-generation-architecture") },
        { label: "Schema Overview", href: href("__index__/internal/schema", "/wiki/E781") },
        { label: "Entity Reference", href: href("entities") },
        { label: "Schema Diagrams", href: href("diagrams") },
      ],
    },
  ];
}

// ============================================================================
// DETECT WHICH SIDEBAR TO SHOW
// ============================================================================

export type WikiSidebarType = "models" | "atm" | "internal" | "kb" | null;

/**
 * Determine which sidebar to show based on the entity path.
 * Returns null if no sidebar should be shown.
 */
export function detectSidebarType(entityPath: string): WikiSidebarType {
  if (!entityPath) return null;

  // Models and metrics keep their specialized sidebar
  if (
    entityPath.startsWith("/knowledge-base/models/") ||
    entityPath.startsWith("/knowledge-base/metrics/")
  ) {
    return "models";
  }

  if (entityPath.startsWith("/ai-transition-model/")) {
    return "atm";
  }

  if (entityPath.startsWith("/internal/") || entityPath === "/internal") {
    return "internal";
  }

  // All other knowledge-base sections with a configured sidebar
  if (entityPath.startsWith("/knowledge-base/")) {
    const parts = entityPath.split("/").filter(Boolean);
    // Need at least "knowledge-base" + section name (e.g., "risks")
    if (parts.length >= 2 && KB_SECTION_KEYS.has(parts[1])) {
      return "kb";
    }
  }

  return null;
}

/**
 * Extract the KB section key from an entity path.
 * e.g., "/knowledge-base/risks/scheming" → "risks"
 */
export function extractKbSection(entityPath: string): string | null {
  if (!entityPath.startsWith("/knowledge-base/")) return null;
  const parts = entityPath.split("/").filter(Boolean);
  if (parts.length >= 2 && KB_SECTION_KEYS.has(parts[1])) {
    return parts[1];
  }
  return null;
}

/**
 * Get the nav sections for a given sidebar type.
 * For "kb" type, entityPath is required to determine which section.
 */
export function getWikiNav(
  type: WikiSidebarType,
  entityPath?: string,
): NavSection[] {
  switch (type) {
    case "models":
      return getReferenceNav();
    case "atm":
      return getAtmNav();
    case "internal":
      return getInternalNav();
    case "kb": {
      const section = entityPath ? extractKbSection(entityPath) : null;
      return section ? getKbSectionNav(section) : [];
    }
    default:
      return [];
  }
}
