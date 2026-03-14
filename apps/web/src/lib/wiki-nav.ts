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
import { getKBEntities, getKBFacts } from "@/data/kb";
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
  if (!slug) return slug;
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
 *
 * @param excludeIds - Optional set of page IDs to exclude from navigation.
 */
function buildSectionNav(
  filePathPrefix: string,
  sectionKey: string,
  excludeIds?: Set<string>,
): NavSection[] {
  const pages = getAllPages().filter(
    (p) =>
      p.filePath &&
      p.filePath.startsWith(`${filePathPrefix}/`) &&
      !isIndexFile(p.filePath) &&
      (!excludeIds || !excludeIds.has(p.id))
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

  // Top section — include Overview link only if an index page exists
  const indexSlug = `__index__/${filePathPrefix}`;
  const hasIndexPage = !!getPageById(indexSlug);
  const topItems = hasIndexPage
    ? [{ label: "Overview", href: indexHref(filePathPrefix) }]
    : [];

  const sections: NavSection[] = [
    {
      title: sectionTitle,
      defaultOpen: true,
      items: topItems,
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
 *
 * @param defaultOpen - Whether sections start expanded (default: true).
 *   Set to false for secondary sections like metrics in the combined reference nav.
 */
export function getKbSectionNav(
  sectionKey: string,
  defaultOpen = true,
): NavSection[] {
  const nav = buildSectionNav(`knowledge-base/${sectionKey}`, sectionKey);
  if (!defaultOpen && nav.length > 0) {
    for (const section of nav) {
      section.defaultOpen = false;
    }
  }
  return nav;
}

// ============================================================================
// ABOUT NAV (user-facing pages)
// ============================================================================

/** Slugs that belong to the "About" section rather than "Internal". */
const ABOUT_PAGE_SLUGS = new Set([
  "about-this-wiki",
  "longterm-vision",
  "longterm-strategy",
  "project-roadmap",
  "longtermwiki-value-proposition",
]);

/** Check whether an entity path belongs to the About section. */
export function isAboutPage(entityPath: string): boolean {
  if (!entityPath.startsWith("/internal/")) return false;
  const slug = entityPath.replace(/^\/internal\//, "").replace(/\/$/, "");
  return ABOUT_PAGE_SLUGS.has(slug);
}

/** Resolve a slug to its /wiki/E<id> URL, falling back to /internal/ path */
function internalHref(slug: string, fallback?: string): string {
  const resolved = getEntityHref(slug);
  if (resolved.startsWith("/wiki/E")) return resolved;
  return fallback || resolved;
}

/**
 * Build "About" sidebar navigation for user-facing pages
 * (About, Vision, Strategy, Roadmap, Value Proposition).
 */
export function getAboutNav(): NavSection[] {
  return [
    {
      title: "About",
      defaultOpen: true,
      items: [
        { label: "About This Wiki", href: internalHref("about-this-wiki") },
        { label: "Vision", href: internalHref("longterm-vision") },
        { label: "Strategy", href: internalHref("longterm-strategy") },
        { label: "Roadmap", href: internalHref("project-roadmap") },
        { label: "Value Proposition", href: internalHref("longtermwiki-value-proposition") },
      ],
    },
  ];
}

// ============================================================================
// INTERNAL NAV
// ============================================================================

/**
 * Build internal navigation with auto-discovered MDX pages + hardcoded dashboards.
 *
 * MDX content pages are discovered via buildSectionNav() and grouped by subcategory.
 * React dashboard pages (which have no entity in the database) are hardcoded.
 * About pages are excluded (they use a separate sidebar via getAboutNav()).
 */
export function getInternalNav(): NavSection[] {
  return [
    {
      title: "Overview",
      defaultOpen: true,
      items: [
        { label: "Internal Home", href: internalHref("__index__/internal", "/wiki/E779") },
      ],
    },
    {
      title: "Dashboards",
      defaultOpen: true,
      items: [
        { label: "System Health", href: internalHref("system-health-dashboard") },
        { label: "PR Dashboard", href: internalHref("pr-dashboard") },
        { label: "Pages", href: internalHref("page-coverage-dashboard") },
        { label: "Entities & Pages", href: internalHref("entities-dashboard") },
        { label: "Page Changes", href: internalHref("page-changes-dashboard") },
        { label: "Update Schedule", href: internalHref("update-schedule-dashboard") },
        { label: "Suggested Pages", href: internalHref("suggested-pages-dashboard") },
        { label: "Improve Runs", href: internalHref("improve-runs-dashboard") },
        { label: "Agent Activity", href: internalHref("agent-activity-dashboard") },
        { label: "Auto-Update Runs", href: internalHref("auto-update-runs-dashboard") },
        { label: "Auto-Update News", href: internalHref("auto-update-news-dashboard") },
        { label: "Groundskeeper Runs", href: internalHref("groundskeeper-runs-dashboard") },
        { label: "Grants", href: internalHref("grants-dashboard") },
        { label: "Divisions", href: internalHref("divisions-dashboard") },
        { label: "Funding Programs", href: internalHref("funding-programs-dashboard") },
        { label: "People Coverage", href: internalHref("people-coverage-dashboard") },
        { label: "Things", href: internalHref("things-dashboard") },
      ],
    },
    {
      title: "Citations",
      items: [
        { label: "Fact Dashboard", href: internalHref("fact-dashboard") },
        { label: "KB Fact Verifications", href: internalHref("kb-fact-verifications-dashboard") },
        { label: "Citation Accuracy", href: internalHref("citation-accuracy-dashboard") },
        { label: "Citation Content", href: internalHref("citation-content-dashboard") },
        { label: "Hallucination Risk", href: internalHref("hallucination-risk-dashboard") },
        { label: "Hallucination Evals", href: internalHref("hallucination-evals-dashboard") },
      ],
    },
    {
      title: "Style Guides",
      items: [
        { label: "Common Writing Principles", href: internalHref("common-writing-principles") },
        { label: "Page Types", href: internalHref("page-types") },
        { label: "Knowledge Base", href: internalHref("knowledge-base") },
        { label: "Risk Pages", href: internalHref("risk-style-guide") },
        { label: "Response Pages", href: internalHref("response-style-guide") },
        { label: "Models", href: internalHref("models-style-guide") },
        { label: "Stub Pages", href: internalHref("stub-style-guide") },
        { label: "Rating System", href: internalHref("rating-system") },
        { label: "Mermaid Diagrams", href: internalHref("mermaid-diagrams") },
        { label: "Canonical Facts & Calc", href: internalHref("canonical-facts") },
        { label: "Page Coverage Guide", href: internalHref("coverage-guide") },
        { label: "Cause-Effect Diagrams", href: internalHref("cause-effect-diagrams") },
        { label: "Research Reports", href: internalHref("research-reports") },
        { label: "Doc Maintenance", href: internalHref("documentation-maintenance") },
        { label: "Anthropic Refactor Notes", href: internalHref("anthropic-pages-refactor-notes") },
      ],
    },
    {
      title: "Research",
      items: [
        { label: "Reports Index", href: internalHref("__index__/internal/reports", "/wiki/E780") },
        { label: "AI Research Workflows", href: internalHref("ai-research-workflows") },
        { label: "Causal Diagram Visualization", href: internalHref("causal-diagram-visualization") },
        { label: "Controlled Vocabulary", href: internalHref("controlled-vocabulary") },
        { label: "Cross-Link Automation", href: internalHref("cross-link-automation-proposal") },
        { label: "Diagram Naming", href: internalHref("diagram-naming-research") },
        { label: "Page Creator Pipeline", href: internalHref("page-creator-pipeline") },
        { label: "Gap Analysis (Feb 2026)", href: internalHref("gap-analysis-2026-02") },
        { label: "Consistency Audit (Feb 2026)", href: internalHref("website-consistency-audit-2026-02") },
        { label: "Importance Ranking", href: internalHref("importance-ranking") },
        { label: "Page Length Research", href: internalHref("page-length-research") },
      ],
    },
    {
      title: "Architecture & Reference",
      items: [
        { label: "Architecture", href: internalHref("architecture") },
        { label: "Wiki Generation Architecture", href: internalHref("wiki-generation-architecture") },
        { label: "Content Pipeline Architecture", href: internalHref("content-pipeline-architecture") },
        { label: "Fact System Strategy", href: internalHref("fact-system-strategy") },
        { label: "Citation Architecture", href: internalHref("citation-architecture") },
        { label: "Verification Tiers", href: internalHref("content-verification-tiers") },
        { label: "Knowledge Graph Ontology", href: internalHref("knowledge-graph-ontology") },
        { label: "Structured Data Architecture", href: internalHref("structured-data-architecture") },
        { label: "Schema Overview", href: internalHref("__index__/internal/schema", "/wiki/E781") },
        { label: "Entity Reference", href: internalHref("entities") },
        { label: "Server Environments", href: internalHref("wiki-server-architecture") },
        { label: "Server Communication", href: internalHref("server-communication-investigation") },
        { label: "Schema Diagrams", href: internalHref("diagrams") },
        { label: "Automation Tools", href: internalHref("automation-tools") },
        { label: "Content Database", href: internalHref("content-database") },
        { label: "DB Schema Overview", href: internalHref("db-schema-overview") },
      ],
    },
  ];
}

// ============================================================================
// KB DATA SECTION NAV (public structured data pages)
// ============================================================================

/**
 * Build sidebar navigation for the /kb/ section (public structured data).
 * Uses numeric entity IDs directly for stability (the slugs in the wiki-server
 * ID registry differ from the page-level slugs assigned by build-data).
 */
export function getKBDataNav(): NavSection[] {
  // Build top entities list sorted by structured fact count
  const entities = getKBEntities();
  const entityItems: { label: string; href: string; count: number }[] = [];
  for (const entity of entities) {
    const facts = getKBFacts(entity.id);
    const structured = facts.filter((f) => f.propertyId !== "description");
    if (structured.length > 0) {
      entityItems.push({
        label: `${entity.name} (${structured.length})`,
        href: `/kb/entity/${entity.id}`,
        count: structured.length,
      });
    }
  }
  entityItems.sort((a, b) => b.count - a.count);

  return [
    {
      title: "KB Data",
      defaultOpen: true,
      items: [
        { label: "Overview", href: "/wiki/E1019" },
        { label: "Facts Explorer", href: "/wiki/E1020" },
        { label: "Properties", href: "/wiki/E1021" },
        { label: "Entity Coverage", href: "/wiki/E1022" },
        { label: "Records Explorer", href: "/wiki/E1026" },
        // Resources (E1043) and Publications (E1044) moved to /sources/ section
      ],
    },
    {
      title: "Top Entities",
      items: entityItems.slice(0, 30).map(({ label, href }) => ({
        label,
        href,
      })),
    },
  ];
}

// ============================================================================
// DETECT WHICH SIDEBAR TO SHOW
// ============================================================================

export type WikiSidebarType = "models" | "internal" | "about" | "kb-data" | "kb" | "section" | null;

/**
 * Determine which sidebar to show based on the entity path.
 * Returns null if no sidebar should be shown.
 */
export function detectSidebarType(entityPath: string): WikiSidebarType {
  if (!entityPath) return null;

  // Models and metrics get a combined reference sidebar.
  // Must check before the generic /knowledge-base/ pattern below,
  // otherwise these paths would match the broader "kb" type.
  if (
    entityPath.startsWith("/knowledge-base/models/") ||
    entityPath.startsWith("/knowledge-base/metrics/")
  ) {
    return "models";
  }

  // About pages live under /internal/ but get their own sidebar.
  // Must check before the generic /internal/ pattern below.
  if (isAboutPage(entityPath)) {
    return "about";
  }

  if (entityPath.startsWith("/internal/") || entityPath === "/internal") {
    return "internal";
  }

  // KB Data section — public structured data pages at /kb/
  if (entityPath.startsWith("/kb/") || entityPath === "/kb") {
    return "kb-data";
  }

  // Any knowledge-base subsection gets a sidebar (no hardcoded list needed)
  if (entityPath.startsWith("/knowledge-base/")) {
    const parts = entityPath.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return "kb";
    }
  }

  // Any other top-level path with child pages gets a generic section sidebar.
  // No hardcoded list — buildSectionNav discovers pages from the data layer.
  const firstSegment = entityPath.split("/").filter(Boolean)[0];
  if (firstSegment) {
    return "section";
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
 * Extract the top-level section key from an entity path.
 * e.g., "/project/changelog/" → "project"
 */
function extractSection(entityPath: string): string | null {
  const parts = entityPath.split("/").filter(Boolean);
  return parts.length >= 1 ? parts[0] : null;
}

/**
 * Build sidebar navigation for any top-level section.
 * Uses the generic buildSectionNav which reads page data and groups by subcategory.
 * Returns empty array if the section has no pages (no sidebar will render).
 */
function getSectionNav(sectionKey: string): NavSection[] {
  return buildSectionNav(sectionKey, sectionKey);
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
      // Combined models + metrics sidebar; metrics collapsed by default
      return [
        ...getKbSectionNav("models"),
        ...getKbSectionNav("metrics", false),
      ];
    case "about":
      return getAboutNav();
    case "internal":
      return getInternalNav();
    case "kb-data":
      return getKBDataNav();
    case "kb": {
      const section = entityPath ? extractKbSection(entityPath) : null;
      return section ? getKbSectionNav(section) : [];
    }
    case "section": {
      const section = entityPath ? extractSection(entityPath) : null;
      return section ? getSectionNav(section) : [];
    }
    default:
      return [];
  }
}