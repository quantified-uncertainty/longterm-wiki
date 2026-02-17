/**
 * Wiki sidebar navigation data builders.
 *
 * Server-side only: reads from the database to build NavSection[] arrays
 * for pages that need contextual sidebar navigation.
 *
 * Navigation is fully data-driven: section titles come from index page
 * frontmatter, subcategory groupings are derived from page.subcategory,
 * and labels are formatted from slugs. No hardcoded section configs.
 *
 * Uses the shared data layer from @/data — no direct fs reads.
 */

import { getEntityHref, getAllPages, getPageById } from "@/data";
import type { NavSection } from "./internal-nav";

// Re-export NavSection so consumers can import from one place
export type { NavSection } from "./internal-nav";

// ============================================================================
// UTILITIES
// ============================================================================

/** Check if a filePath is an index file (should be excluded from sidebar nav). */
function isIndexFile(filePath: string): boolean {
  return filePath.endsWith("index.mdx") || filePath.endsWith("index.md");
}

/** Convert a kebab-case slug to a Title Case label. */
function formatLabel(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Resolve an index page slug to its /wiki/E<id> URL, with fallback. */
function indexHref(prefix: string): string {
  const slug = `__index__/${prefix}`;
  const resolved = getEntityHref(slug);
  if (resolved.startsWith("/wiki/E")) return resolved;
  return `/wiki/${prefix}`;
}

/**
 * Look up the index page title for a section.
 * Falls back to formatting the section key if no index page exists.
 */
function getSectionTitle(prefix: string, sectionKey: string): string {
  const indexSlug = `__index__/${prefix}`;
  const indexPage = getPageById(indexSlug);
  return indexPage?.title || formatLabel(sectionKey);
}

// ============================================================================
// GENERIC SUBCATEGORY-GROUPED NAV BUILDER
// ============================================================================

/**
 * Build sidebar navigation for any section by reading page data.
 * Groups pages by subcategory, deriving labels from slugs.
 * Section title comes from the index page's frontmatter title.
 */
function buildSectionNav(
  filePathPrefix: string,
  sectionKey: string,
): NavSection[] {
  const pages = getAllPages().filter(
    (p) =>
      p.filePath &&
      p.filePath.startsWith(`${filePathPrefix}/`) &&
      !isIndexFile(p.filePath)
  );

  if (pages.length === 0) return [];

  const sectionTitle = getSectionTitle(filePathPrefix, sectionKey);

  // Group pages by subcategory
  const groups = new Map<string, { id: string; title: string }[]>();
  const ungrouped: { id: string; title: string }[] = [];

  for (const page of pages) {
    const item = { id: page.id, title: page.title };
    if (page.subcategory) {
      const list = groups.get(page.subcategory) || [];
      list.push(item);
      groups.set(page.subcategory, list);
    } else {
      ungrouped.push(item);
    }
  }

  // Sort items within each group alphabetically
  for (const list of groups.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title));
  }
  ungrouped.sort((a, b) => a.title.localeCompare(b.title));

  function toNavItems(items: { id: string; title: string }[]) {
    return items.map((item) => ({
      label: item.title,
      href: getEntityHref(item.id),
    }));
  }

  // Top section with overview link
  const sections: NavSection[] = [
    {
      title: sectionTitle,
      defaultOpen: true,
      items: [{ label: "Overview", href: indexHref(filePathPrefix) }],
    },
  ];

  if (groups.size > 0) {
    // Build sections sorted alphabetically by subcategory label
    const sortedGroups = [...groups.entries()].sort((a, b) =>
      formatLabel(a[0]).localeCompare(formatLabel(b[0]))
    );

    for (const [subcat, items] of sortedGroups) {
      sections.push({
        title: formatLabel(subcat),
        items: toNavItems(items),
      });
    }

    // Uncategorized pages go in "Other"
    if (ungrouped.length > 0) {
      sections.push({
        title: "Other",
        items: toNavItems(ungrouped),
      });
    }
  } else {
    // No subcategories — flat list under the section title
    sections[0].items.push(...toNavItems(ungrouped));
  }

  return sections;
}

// ============================================================================
// KNOWLEDGE-BASE SECTION NAV (generic, data-driven)
// ============================================================================

/**
 * Build sidebar navigation for a knowledge-base section.
 * Reads section title from the index page, groups by subcategory,
 * and derives all labels from the page data.
 */
export function getKbSectionNav(sectionKey: string): NavSection[] {
  return buildSectionNav(`knowledge-base/${sectionKey}`, sectionKey);
}

// ============================================================================
// ANALYTICAL MODELS NAV (uses generic builder)
// ============================================================================

export function getModelsNav(): NavSection[] {
  return buildSectionNav("knowledge-base/models", "models");
}

// ============================================================================
// KEY METRICS NAV
// ============================================================================

export function getMetricsNav(): NavSection[] {
  const nav = buildSectionNav("knowledge-base/metrics", "metrics");
  // Metrics section starts collapsed since it's secondary to models
  if (nav.length > 0) {
    for (const section of nav) {
      section.defaultOpen = false;
    }
  }
  return nav;
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

  // Models and metrics keep their combined reference sidebar
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

  // Any knowledge-base subsection gets a sidebar (no hardcoded list needed)
  if (entityPath.startsWith("/knowledge-base/")) {
    const parts = entityPath.split("/").filter(Boolean);
    if (parts.length >= 2) {
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
  return parts.length >= 2 ? parts[1] : null;
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
