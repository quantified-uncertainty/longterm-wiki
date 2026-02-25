/**
 * Wiki sidebar navigation tests.
 *
 * Two layers of testing:
 *
 * 1. Unit tests (mocked data): Verify the nav-building logic — subcategory grouping,
 *    About-page exclusion, index-file filtering, empty sections, etc.
 *
 * 2. Integration tests (real database.json + filesystem): Verify that every internal
 *    MDX page actually appears in the sidebar, and every React dashboard directory
 *    is in the hardcoded dashboard list. These catch "forgot to add to sidebar" regressions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

// ============================================================================
// PART 1: UNIT TESTS (mocked @/data)
// ============================================================================

// Mock the data layer before importing wiki-nav
vi.mock("@/data", () => {
  // Controlled test data — mutated per-test via setMockPages/setMockRegistry
  let pages: any[] = [];
  let idRegistry = { byNumericId: {} as Record<string, string>, bySlug: {} as Record<string, string> };
  let pageIndex: Record<string, any> = {};

  return {
    getAllPages: () => pages,
    getPageById: (id: string) => pageIndex[id],
    getEntityHref: (id: string) => {
      const numId = idRegistry.bySlug[id];
      return numId ? `/wiki/${numId}` : `/wiki/${id}`;
    },
    getIdRegistry: () => idRegistry,

    // Test helpers — not real exports, but accessible via the mock
    __setMockPages: (p: any[]) => {
      pages = p;
      pageIndex = {};
      for (const pg of p) pageIndex[pg.id] = pg;
    },
    __setMockRegistry: (r: any) => {
      idRegistry = r;
    },
  };
});

// Import after mocking
import {
  getInternalNav,
  getAboutNav,
  getWikiNav,
  detectSidebarType,
  isAboutPage,
  getKbSectionNav,
} from "../wiki-nav";

// Access test helpers from the mock
import * as dataModule from "@/data";
const setMockPages = (dataModule as any).__setMockPages as (p: any[]) => void;
const setMockRegistry = (dataModule as any).__setMockRegistry as (r: any) => void;

/** Create a minimal Page object for testing */
function makePage(overrides: {
  id: string;
  filePath: string;
  title: string;
  subcategory?: string;
}) {
  return {
    id: overrides.id,
    filePath: overrides.filePath,
    title: overrides.title,
    path: `/${overrides.filePath.replace(".mdx", "")}`,
    subcategory: overrides.subcategory ?? null,
    quality: null,
    readerImportance: null,
    researchImportance: null,
    tacticalValue: null,
    contentFormat: "article",
    tractability: null,
    neglectedness: null,
    uncertainty: null,
    causalLevel: null,
    lastUpdated: null,
    llmSummary: null,
    description: null,
    ratings: {},
    category: "internal",
    wordCount: 100,
    backlinkCount: 0,
  };
}

// ---------------------------------------------------------------------------
// detectSidebarType (pure function, no mocking needed)
// ---------------------------------------------------------------------------

describe("detectSidebarType", () => {
  it("returns 'internal' for /internal/ paths", () => {
    expect(detectSidebarType("/internal/")).toBe("internal");
    expect(detectSidebarType("/internal/architecture")).toBe("internal");
    expect(detectSidebarType("/internal/facts")).toBe("internal");
  });

  it("returns 'about' for About page paths", () => {
    expect(detectSidebarType("/internal/about-this-wiki")).toBe("about");
    expect(detectSidebarType("/internal/longterm-vision")).toBe("about");
    expect(detectSidebarType("/internal/project-roadmap")).toBe("about");
  });

  it("returns 'models' for knowledge-base/models paths", () => {
    expect(detectSidebarType("/knowledge-base/models/gpt-4")).toBe("models");
  });

  it("returns 'kb' for other knowledge-base paths", () => {
    expect(detectSidebarType("/knowledge-base/risks/scheming")).toBe("kb");
  });

  it("returns null for empty path", () => {
    expect(detectSidebarType("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isAboutPage
// ---------------------------------------------------------------------------

describe("isAboutPage", () => {
  it("returns true for all About slugs", () => {
    expect(isAboutPage("/internal/about-this-wiki")).toBe(true);
    expect(isAboutPage("/internal/longterm-vision")).toBe(true);
    expect(isAboutPage("/internal/longterm-strategy")).toBe(true);
    expect(isAboutPage("/internal/project-roadmap")).toBe(true);
    expect(isAboutPage("/internal/longtermwiki-value-proposition")).toBe(true);
  });

  it("returns false for non-About internal pages", () => {
    expect(isAboutPage("/internal/architecture")).toBe(false);
    expect(isAboutPage("/internal/canonical-facts")).toBe(false);
  });

  it("returns false for non-internal paths", () => {
    expect(isAboutPage("/knowledge-base/risks/scheming")).toBe(false);
    expect(isAboutPage("/about-this-wiki")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getInternalNav — unit tests with mocked data
// ---------------------------------------------------------------------------

describe("getInternalNav (mocked data)", () => {
  beforeEach(() => {
    setMockRegistry({
      byNumericId: {
        E1: "architecture",
        E2: "canonical-facts",
        E3: "gap-analysis",
        E4: "automation-tools",
        E5: "about-this-wiki",
        E6: "__index__/internal",
      },
      bySlug: {
        architecture: "E1",
        "canonical-facts": "E2",
        "gap-analysis": "E3",
        "automation-tools": "E4",
        "about-this-wiki": "E5",
        "__index__/internal": "E6",
      },
    });
  });

  it("auto-discovers pages grouped by subcategory", () => {
    setMockPages([
      makePage({ id: "__index__/internal", filePath: "internal/index.md", title: "Internal" }),
      makePage({ id: "architecture", filePath: "internal/architecture.mdx", title: "Architecture", subcategory: "architecture" }),
      makePage({ id: "canonical-facts", filePath: "internal/canonical-facts.mdx", title: "Canonical Facts", subcategory: "style-guides" }),
      makePage({ id: "gap-analysis", filePath: "internal/gap-analysis.mdx", title: "Gap Analysis", subcategory: "research" }),
      makePage({ id: "automation-tools", filePath: "internal/automation-tools.mdx", title: "Automation Tools" }),
    ]);

    const sections = getInternalNav();

    // First section is always Dashboards
    expect(sections[0].title).toBe("Dashboards & Tools");

    // Second is top-level (from index page)
    expect(sections[1].title).toBe("Internal");
    expect(sections[1].items.some(i => i.label === "Overview")).toBe(true);

    // Find subcategory sections
    const titles = sections.map(s => s.title);
    expect(titles).toContain("Architecture");
    expect(titles).toContain("Style Guides");
    expect(titles).toContain("Research");
    expect(titles).toContain("Other"); // automation-tools has no subcategory
  });

  it("excludes About pages from internal nav", () => {
    setMockPages([
      makePage({ id: "architecture", filePath: "internal/architecture.mdx", title: "Architecture", subcategory: "architecture" }),
      makePage({ id: "about-this-wiki", filePath: "internal/about-this-wiki.mdx", title: "About This Wiki" }),
    ]);

    const sections = getInternalNav();
    const allLabels = sections.flatMap(s => s.items.map(i => i.label));
    expect(allLabels).not.toContain("About This Wiki");
    expect(allLabels).toContain("Architecture");
  });

  it("excludes index files from nav items", () => {
    setMockPages([
      makePage({ id: "__index__/internal", filePath: "internal/index.md", title: "Internal" }),
      makePage({ id: "architecture", filePath: "internal/architecture.mdx", title: "Architecture", subcategory: "architecture" }),
    ]);

    const sections = getInternalNav();
    const allLabels = sections.flatMap(s => s.items.map(i => i.label));
    // Index page should NOT appear as a regular item (only as Overview link)
    expect(allLabels).not.toContain("Internal");
  });

  it("includes pages from subdirectories (reports, schema)", () => {
    setMockPages([
      makePage({ id: "ai-research-workflows", filePath: "internal/reports/ai-research-workflows.mdx", title: "AI Research Workflows", subcategory: "research" }),
      makePage({ id: "diagrams", filePath: "internal/schema/diagrams.mdx", title: "Schema Diagrams", subcategory: "architecture" }),
    ]);

    const sections = getInternalNav();
    const allLabels = sections.flatMap(s => s.items.map(i => i.label));
    expect(allLabels).toContain("AI Research Workflows");
    expect(allLabels).toContain("Schema Diagrams");
  });

  it("returns dashboards section even when no MDX pages exist", () => {
    setMockPages([]);
    const sections = getInternalNav();
    expect(sections.length).toBeGreaterThanOrEqual(1);
    expect(sections[0].title).toBe("Dashboards & Tools");
    expect(sections[0].items.length).toBeGreaterThan(0);
  });

  it("dashboard section has defaultOpen: true", () => {
    setMockPages([]);
    const sections = getInternalNav();
    expect(sections[0].defaultOpen).toBe(true);
  });

  it("does not duplicate pages across sections", () => {
    setMockPages([
      makePage({ id: "architecture", filePath: "internal/architecture.mdx", title: "Architecture", subcategory: "architecture" }),
      makePage({ id: "canonical-facts", filePath: "internal/canonical-facts.mdx", title: "Canonical Facts", subcategory: "style-guides" }),
    ]);

    const sections = getInternalNav();
    const allHrefs = sections.flatMap(s => s.items.map(i => i.href));
    const uniqueHrefs = new Set(allHrefs);
    expect(allHrefs.length).toBe(uniqueHrefs.size);
  });

  it("sorts items within each subcategory alphabetically", () => {
    setMockPages([
      makePage({ id: "z-page", filePath: "internal/z-page.mdx", title: "Z Page", subcategory: "style-guides" }),
      makePage({ id: "a-page", filePath: "internal/a-page.mdx", title: "A Page", subcategory: "style-guides" }),
      makePage({ id: "m-page", filePath: "internal/m-page.mdx", title: "M Page", subcategory: "style-guides" }),
    ]);

    const sections = getInternalNav();
    const sgSection = sections.find(s => s.title === "Style Guides");
    expect(sgSection).toBeDefined();
    const labels = sgSection!.items.map(i => i.label);
    expect(labels).toEqual(["A Page", "M Page", "Z Page"]);
  });

  it("a new page with subcategory appears automatically without code changes", () => {
    // Simulate adding a brand-new page — no code changes needed
    setMockPages([
      makePage({ id: "architecture", filePath: "internal/architecture.mdx", title: "Architecture", subcategory: "architecture" }),
      makePage({ id: "brand-new-doc", filePath: "internal/brand-new-doc.mdx", title: "Brand New Doc", subcategory: "architecture" }),
    ]);

    setMockRegistry({
      byNumericId: { E1: "architecture", E99: "brand-new-doc" },
      bySlug: { architecture: "E1", "brand-new-doc": "E99" },
    });

    const sections = getInternalNav();
    const allLabels = sections.flatMap(s => s.items.map(i => i.label));
    expect(allLabels).toContain("Brand New Doc");
  });

  it("a new page without subcategory appears in Other", () => {
    setMockPages([
      makePage({ id: "orphan-page", filePath: "internal/orphan-page.mdx", title: "Orphan Page" }),
      makePage({ id: "categorized", filePath: "internal/categorized.mdx", title: "Categorized", subcategory: "architecture" }),
    ]);

    const sections = getInternalNav();
    const otherSection = sections.find(s => s.title === "Other");
    expect(otherSection).toBeDefined();
    expect(otherSection!.items.some(i => i.label === "Orphan Page")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getWikiNav dispatch
// ---------------------------------------------------------------------------

describe("getWikiNav dispatch", () => {
  beforeEach(() => {
    setMockPages([]);
    setMockRegistry({ byNumericId: {}, bySlug: {} });
  });

  it("returns internal nav for 'internal' type", () => {
    const nav = getWikiNav("internal");
    expect(nav[0].title).toBe("Dashboards & Tools");
  });

  it("returns about nav for 'about' type", () => {
    const nav = getWikiNav("about");
    expect(nav[0].title).toBe("About");
  });

  it("returns empty for null type", () => {
    expect(getWikiNav(null)).toEqual([]);
  });
});

// ============================================================================
// PART 2: INTEGRATION TESTS (real filesystem + database.json)
// ============================================================================

describe("internal sidebar completeness (real data)", () => {
  const REPO_ROOT = path.resolve(__dirname, "../../../../../");
  const DATA_DIR = path.join(REPO_ROOT, "apps/web/src/data");
  const CONTENT_DIR = path.join(REPO_ROOT, "content/docs/internal");
  const APP_INTERNAL_DIR = path.join(REPO_ROOT, "apps/web/src/app/internal");

  /** Load JSON from disk */
  function loadJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  }

  /** Recursively find all .mdx and .md files */
  function findContentFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findContentFiles(fullPath));
      } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
    return results;
  }

  // About page slugs (these are excluded from internal sidebar intentionally)
  const ABOUT_SLUGS = new Set([
    "about-this-wiki",
    "longterm-vision",
    "longterm-strategy",
    "project-roadmap",
    "longtermwiki-value-proposition",
  ]);

  // -----------------------------------------------------------------------
  // Test: Every internal MDX page (non-index, non-About) is in the database
  // with a subcategory, ensuring it will appear in the auto-discovered sidebar.
  // -----------------------------------------------------------------------

  it("every internal MDX page (non-index, non-About) has a subcategory", () => {
    const files = findContentFiles(CONTENT_DIR);
    const missing: string[] = [];

    for (const filePath of files) {
      const basename = path.basename(filePath, path.extname(filePath));
      if (basename === "index") continue;
      if (ABOUT_SLUGS.has(basename)) continue;

      const content = fs.readFileSync(filePath, "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const hasSubcategory = /^subcategory:\s*\S+/m.test(fmMatch[1]);
      if (!hasSubcategory) {
        const rel = path.relative(CONTENT_DIR, filePath);
        missing.push(rel);
      }
    }

    // Allow a few dashboard-adjacent pages without subcategory (they go to "Other")
    // But flag them so we're aware
    if (missing.length > 0) {
      // These are known pages that intentionally have no subcategory
      const KNOWN_NO_SUBCATEGORY = new Set([
        "automation-tools.mdx",
        "content-database.mdx",
        "enhancement-queue.mdx",
      ]);

      const unexpected = missing.filter(f => !KNOWN_NO_SUBCATEGORY.has(f));
      if (unexpected.length > 0) {
        throw new Error(
          `${unexpected.length} internal MDX page(s) missing subcategory frontmatter ` +
          `(they will appear in "Other" instead of a named section):\n` +
          unexpected.map(f => `  - ${f}`).join("\n") +
          `\n\nAdd 'subcategory: <group>' to their frontmatter. ` +
          `Valid groups: architecture, style-guides, research`
        );
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test: Every internal MDX page appears in the database pages list
  // (which is what buildSectionNav reads from).
  // -----------------------------------------------------------------------

  it("every internal MDX page appears in database.json", () => {
    const dbPath = path.join(DATA_DIR, "database.json");
    if (!fs.existsSync(dbPath)) return; // skip if no build

    const db = loadJson<{ pages: Array<{ id: string; filePath: string }> }>(dbPath);
    const dbFilePaths = new Set(db.pages.map(p => p.filePath));

    const files = findContentFiles(CONTENT_DIR);
    const missing: string[] = [];

    for (const filePath of files) {
      // Convert absolute path to the filePath format used in database.json
      // e.g., content/docs/internal/architecture.mdx → internal/architecture.mdx
      const rel = path.relative(path.join(REPO_ROOT, "content/docs"), filePath);

      // Strip extension for .md files since build may normalize
      const withoutExt = rel.replace(/\.(mdx|md)$/, "");
      const withMdx = withoutExt + ".mdx";
      const withMd = withoutExt + ".md";

      if (!dbFilePaths.has(rel) && !dbFilePaths.has(withMdx) && !dbFilePaths.has(withMd) && !dbFilePaths.has(withoutExt)) {
        missing.push(rel);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `${missing.length} internal MDX file(s) not found in database.json ` +
        `(run 'pnpm build-data:content' to rebuild):\n` +
        missing.map(f => `  - ${f}`).join("\n")
      );
    }
  });

  // -----------------------------------------------------------------------
  // Test: Every React dashboard directory has a corresponding entry
  // in the hardcoded "Dashboards & Tools" section.
  // -----------------------------------------------------------------------

  it("every React dashboard page directory is in the hardcoded dashboard list or migrated to MDX", () => {
    if (!fs.existsSync(APP_INTERNAL_DIR)) return;

    // Get all directory entries that contain a page.tsx
    const dashboardDirs: string[] = [];
    for (const entry of fs.readdirSync(APP_INTERNAL_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Skip the catch-all route (handles MDX pages)
      if (entry.name.startsWith("[[")) continue;

      const pagePath = path.join(APP_INTERNAL_DIR, entry.name, "page.tsx");
      if (fs.existsSync(pagePath)) {
        // Skip pages that are just redirects (migrated to MDX stubs)
        const pageSource = fs.readFileSync(pagePath, "utf-8");
        if (/redirect\(["']\/wiki\/E\d+["']\)/.test(pageSource)) continue;

        dashboardDirs.push(entry.name);
      }
    }

    // Get all hrefs from the Dashboards & Tools section
    // We can't call getInternalNav() in this context (mocked @/data),
    // so we read the source file and parse the hardcoded hrefs.
    const navSource = fs.readFileSync(
      path.join(REPO_ROOT, "apps/web/src/lib/wiki-nav.ts"),
      "utf-8",
    );

    // Extract hrefs from the dashboardSection block
    const dashboardBlock = navSource.match(
      /title:\s*"Dashboards & Tools"[\s\S]*?items:\s*\[([\s\S]*?)\]/,
    );

    if (!dashboardBlock) {
      throw new Error("Could not find 'Dashboards & Tools' section in wiki-nav.ts");
    }

    const hrefMatches = [...dashboardBlock[1].matchAll(/href:\s*["']([^"']+)["']/g)];
    const sidebarHrefs = new Set(hrefMatches.map(m => m[1]));

    // Also get hrefs from internalHref() calls (for MDX-backed dashboard pages)
    const internalHrefMatches = [...dashboardBlock[1].matchAll(/internalHref\(["']([^"']+)["']\)/g)];
    // These resolve to entity hrefs, but the slug tells us the page identity

    const missing: string[] = [];
    for (const dir of dashboardDirs) {
      const expectedHref = `/internal/${dir}`;
      // Check if the directory's path appears in the sidebar hrefs
      const found = sidebarHrefs.has(expectedHref) ||
        sidebarHrefs.has(`/${dir}`) || // some like /claims are at root
        internalHrefMatches.some(m => m[1] === dir);

      if (!found) {
        missing.push(dir);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `${missing.length} React dashboard page(s) missing from sidebar "Dashboards & Tools" section:\n` +
        missing.map(d => `  - apps/web/src/app/internal/${d}/page.tsx`).join("\n") +
        `\n\nAdd an entry to the dashboardSection in wiki-nav.ts getInternalNav(), or migrate to MDX stub.`
      );
    }
  });

  // -----------------------------------------------------------------------
  // Test: No hardcoded dashboard links point to non-existent directories
  // (catches stale entries after dashboard pages are removed).
  // -----------------------------------------------------------------------

  it("no hardcoded dashboard links point to non-existent pages", () => {
    if (!fs.existsSync(APP_INTERNAL_DIR)) return;

    const navSource = fs.readFileSync(
      path.join(REPO_ROOT, "apps/web/src/lib/wiki-nav.ts"),
      "utf-8",
    );

    const dashboardBlock = navSource.match(
      /title:\s*"Dashboards & Tools"[\s\S]*?items:\s*\[([\s\S]*?)\]/,
    );
    if (!dashboardBlock) return;

    const hrefMatches = [...dashboardBlock[1].matchAll(/href:\s*["']\/internal\/([^"']+)["']/g)];

    const stale: string[] = [];
    for (const m of hrefMatches) {
      const dir = m[1];
      const dirPath = path.join(APP_INTERNAL_DIR, dir);
      const pagePath = path.join(dirPath, "page.tsx");

      // It's OK if the directory doesn't exist as a React page —
      // it might be an MDX page served by the catch-all route.
      // But if neither exists, it's stale.
      if (!fs.existsSync(pagePath)) {
        // Check if it's an MDX page
        const mdxPath = path.join(REPO_ROOT, "content/docs/internal", `${dir}.mdx`);
        const mdPath = path.join(REPO_ROOT, "content/docs/internal", `${dir}.md`);
        if (!fs.existsSync(mdxPath) && !fs.existsSync(mdPath)) {
          stale.push(`/internal/${dir}`);
        }
      }
    }

    if (stale.length > 0) {
      throw new Error(
        `${stale.length} dashboard link(s) point to non-existent pages:\n` +
        stale.map(h => `  - ${h}`).join("\n") +
        `\n\nRemove these from the dashboardSection in wiki-nav.ts.`
      );
    }
  });
});
