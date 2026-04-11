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

// Mock the factbase module (imported by wiki-nav.ts)
vi.mock("@/data/factbase", () => ({
  getKBEntities: () => [],
  getKBFacts: () => [],
}));

// Mock the data layer before importing wiki-nav
vi.mock("@/data", () => {
  // Controlled test data — mutated per-test via setMockPages/setMockRegistry
  let pages: any[] = [];
  let idRegistry = { byWikiId: {} as Record<string, string>, bySlug: {} as Record<string, string> };
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

// Mock the factbase data layer
vi.mock("@/data/factbase", () => ({
  getKBEntities: () => [],
  getKBFacts: () => [],
}));

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
    summary: null,
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
    expect(detectSidebarType("/internal/entities")).toBe("internal");
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
      byWikiId: {
        E900: "update-schedule-dashboard",
      },
      bySlug: {
        "update-schedule-dashboard": "E900",
      },
    });
    setMockPages([]);
  });

  it("returns hardcoded sections matching three-bases model", () => {
    const sections = getInternalNav();
    const titles = sections.map(s => s.title);
    expect(titles).toContain("Overview");
    expect(titles).toContain("Research");
    expect(titles).toContain("Verification");
    expect(titles).toContain("FactBase");
    expect(titles).toContain("TableBase");
    expect(titles).toContain("WikiBase");
    expect(titles).toContain("System");
    expect(titles).toContain("Style Guides");
    expect(titles).toContain("Reports");
    expect(titles).toContain("Architecture");
    expect(titles).toContain("Reference");
    // No duplicate section names
    const counts = new Map<string, number>();
    for (const t of titles) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, c] of counts) {
      expect(c, `Section "${t}" appears ${c} times`).toBe(1);
    }
  });

  it("data layer sections have defaultOpen: true", () => {
    const sections = getInternalNav();
    for (const title of ["Research", "Verification", "FactBase", "TableBase", "WikiBase"]) {
      const section = sections.find(s => s.title === title);
      expect(section?.defaultOpen).toBe(true);
    }
  });

  it("migrated dashboards use internalHref (resolve to /wiki/E<id>)", () => {
    const sections = getInternalNav();
    const wikiBase = sections.find(s => s.title === "WikiBase")!;

    const updatesItem = wikiBase.items.find(i => i.label === "Update Schedule");
    expect(updatesItem).toBeDefined();
    expect(updatesItem!.href).toBe("/wiki/E900");
  });

  it("Data Quality is in System (cross-cutting, not layer-specific)", () => {
    const sections = getInternalNav();
    const system = sections.find(s => s.title === "System")!;
    expect(system.items.find(i => i.label === "Data Quality")).toBeDefined();
  });

  it("Data Sources is in TableBase (tracks PG pipelines)", () => {
    const sections = getInternalNav();
    const tableBase = sections.find(s => s.title === "TableBase")!;
    expect(tableBase.items.find(i => i.label === "Data Sources")).toBeDefined();
  });

  it("verification section contains citation and hallucination dashboards", () => {
    const sections = getInternalNav();
    const verification = sections.find(s => s.title === "Verification")!;

    for (const label of ["Citation Accuracy", "Citation Content", "Hallucination Risk", "Source Checks"]) {
      const item = verification.items.find(i => i.label === label);
      expect(item).toBeDefined();
      expect(item!.href).toMatch(/^\/wiki\//);
    }
  });

  it("Style Guides section contains expected entries", () => {
    const sections = getInternalNav();
    const styleGuides = sections.find(s => s.title === "Style Guides")!;
    const labels = styleGuides.items.map(i => i.label);
    expect(labels).toContain("Common Writing Principles");
    expect(labels).toContain("Rating System");
    expect(labels).toContain("Canonical Facts & Calc");
  });

  it("Architecture section contains expected entries", () => {
    const sections = getInternalNav();
    const arch = sections.find(s => s.title === "Architecture")!;
    const labels = arch.items.map(i => i.label);
    expect(labels).toContain("Architecture");
    expect(labels).toContain("Knowledge Graph");
    expect(labels).toContain("Data Architecture");
  });

  it("Reference section contains expected entries", () => {
    const sections = getInternalNav();
    const ref = sections.find(s => s.title === "Reference")!;
    const labels = ref.items.map(i => i.label);
    expect(labels).toContain("Automation Tools");
    expect(labels).toContain("Content Database");
    expect(labels).toContain("Schema Diagrams");
  });
});

// ---------------------------------------------------------------------------
// getWikiNav dispatch
// ---------------------------------------------------------------------------

describe("getWikiNav dispatch", () => {
  beforeEach(() => {
    setMockPages([]);
    setMockRegistry({ byWikiId: {}, bySlug: {} });
  });

  it("returns internal nav for 'internal' type", () => {
    const nav = getWikiNav("internal");
    expect(nav[0].title).toBe("Overview");
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
  // in the hardcoded sidebar sections (Dashboards, Citations, etc.).
  // -----------------------------------------------------------------------

  it("every React dashboard page directory is in the sidebar or migrated to MDX", () => {
    if (!fs.existsSync(APP_INTERNAL_DIR)) return;

    // Get all directory entries that contain a page.tsx
    const dashboardDirs: string[] = [];
    for (const entry of fs.readdirSync(APP_INTERNAL_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Skip the catch-all route (handles MDX pages)
      if (entry.name.startsWith("[[")) continue;
      // Skip pages not yet migrated to Pattern A (no entity ID allocated)
      if (entry.name === "sourcing-coverage") continue; // #3634

      const pagePath = path.join(APP_INTERNAL_DIR, entry.name, "page.tsx");
      if (fs.existsSync(pagePath)) {
        // Skip pages that are just redirects (migrated to MDX stubs or consolidated)
        const pageSource = fs.readFileSync(pagePath, "utf-8");
        if (/redirect\(["'][^"']+["']\)/.test(pageSource)) continue;

        dashboardDirs.push(entry.name);
      }
    }

    // Parse all hrefs and internalHref() calls from the full getInternalNav function
    const navSource = fs.readFileSync(
      path.join(REPO_ROOT, "apps/web/src/lib/wiki-nav.ts"),
      "utf-8",
    );

    const navBlock = navSource.match(
      /export function getInternalNav\(\)[\s\S]*?^}/m,
    );
    if (!navBlock) {
      throw new Error("Could not find getInternalNav() in wiki-nav.ts");
    }

    const hrefMatches = [...navBlock[0].matchAll(/href:\s*["']([^"']+)["']/g)];
    const sidebarHrefs = new Set(hrefMatches.map(m => m[1]));

    const internalHrefMatches = [...navBlock[0].matchAll(/internalHref\(["']([^"']+)["']/g)];

    const missing: string[] = [];
    for (const dir of dashboardDirs) {
      const expectedHref = `/internal/${dir}`;
      const found = sidebarHrefs.has(expectedHref) ||
        sidebarHrefs.has(`/${dir}`) ||
        internalHrefMatches.some(m => m[1] === dir);

      if (!found) {
        missing.push(dir);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `${missing.length} React dashboard page(s) missing from sidebar:\n` +
        missing.map(d => `  - apps/web/src/app/internal/${d}/page.tsx`).join("\n") +
        `\n\nAdd an entry to getInternalNav() in wiki-nav.ts, or migrate to MDX stub.`
      );
    }
  });

  // -----------------------------------------------------------------------
  // Test: Every migrated dashboard has a valid MDX stub and redirect
  // -----------------------------------------------------------------------

  it("every redirect page.tsx points to an EID that exists in database.json", () => {
    if (!fs.existsSync(APP_INTERNAL_DIR)) return;

    const dbPath = path.join(DATA_DIR, "database.json");
    if (!fs.existsSync(dbPath)) return;

    const db = loadJson<{
      idRegistry: { byWikiId: Record<string, string> };
    }>(dbPath);

    const errors: string[] = [];
    for (const entry of fs.readdirSync(APP_INTERNAL_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pagePath = path.join(APP_INTERNAL_DIR, entry.name, "page.tsx");
      if (!fs.existsSync(pagePath)) continue;

      const source = fs.readFileSync(pagePath, "utf-8");
      const redirectMatch = source.match(/redirect\(["']\/wiki\/(E\d+)["']\)/);
      if (!redirectMatch) continue;

      const eid = redirectMatch[1];
      if (!db.idRegistry.byWikiId[eid]) {
        errors.push(`${entry.name}/page.tsx redirects to /wiki/${eid} but ${eid} not in database`);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Redirect(s) point to unregistered EIDs:\n` +
        errors.map(e => `  - ${e}`).join("\n")
      );
    }
  });

  it("every migrated dashboard MDX stub has contentFormat: dashboard", () => {
    if (!fs.existsSync(APP_INTERNAL_DIR)) return;

    // Load DB once before the loop to avoid repeated JSON parses
    const dbPath = path.join(DATA_DIR, "database.json");
    if (!fs.existsSync(dbPath)) return;

    const db = loadJson<{
      idRegistry: { byWikiId: Record<string, string> };
      pages: Array<{ id: string; contentFormat: string; subcategory: string; filePath?: string }>;
    }>(dbPath);

    const errors: string[] = [];
    for (const entry of fs.readdirSync(APP_INTERNAL_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pagePath = path.join(APP_INTERNAL_DIR, entry.name, "page.tsx");
      if (!fs.existsSync(pagePath)) continue;

      const source = fs.readFileSync(pagePath, "utf-8");
      const redirectMatch = source.match(/redirect\(["']\/wiki\/(E\d+)["']\)/);
      if (!redirectMatch) continue;

      const eid = redirectMatch[1];
      const slug = db.idRegistry.byWikiId[eid];
      if (!slug) continue;

      const page = db.pages.find(p => p.id === slug);
      if (!page) {
        errors.push(`${entry.name}: slug '${slug}' not found in pages`);
        continue;
      }

      // Skip pages that live outside /internal/ (e.g., KB pages redirected from legacy /internal/ URLs)
      if (page.filePath && !page.filePath.startsWith("internal/")) continue;

      if (page.contentFormat !== "dashboard") {
        errors.push(`${entry.name}: MDX stub '${slug}' has contentFormat '${page.contentFormat}' (expected 'dashboard')`);
      }
      if (page.subcategory !== "dashboards") {
        errors.push(`${entry.name}: MDX stub '${slug}' has subcategory '${page.subcategory}' (expected 'dashboards')`);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Migrated dashboard MDX stub(s) have incorrect metadata:\n` +
        errors.map(e => `  - ${e}`).join("\n")
      );
    }
  });

  it("every migrated dashboard redirect has a corresponding content component file", () => {
    if (!fs.existsSync(APP_INTERNAL_DIR)) return;

    // Load DB to check whether redirect targets are internal dashboards
    const dbPath = path.join(DATA_DIR, "database.json");
    if (!fs.existsSync(dbPath)) return;

    const db = loadJson<{
      idRegistry: { byWikiId: Record<string, string> };
      pages: Array<{ id: string; filePath?: string }>;
    }>(dbPath);

    const errors: string[] = [];
    for (const entry of fs.readdirSync(APP_INTERNAL_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pagePath = path.join(APP_INTERNAL_DIR, entry.name, "page.tsx");
      if (!fs.existsSync(pagePath)) continue;

      const source = fs.readFileSync(pagePath, "utf-8");
      const redirectMatch = source.match(/redirect\(["']\/wiki\/(E\d+)["']\)/);
      if (!redirectMatch) continue;

      // Skip redirects to non-internal pages (e.g., legacy URLs redirecting to /kb/)
      const eid = redirectMatch[1];
      const slug = db.idRegistry.byWikiId[eid];
      if (slug) {
        const page = db.pages.find(p => p.id === slug);
        if (page?.filePath && !page.filePath.startsWith("internal/")) continue;
      }

      // This is a migrated dashboard — it should have a *-content.tsx file
      // UNLESS it's a pure backward-compat redirect to a dashboard whose
      // content component lives in a different directory (e.g., entity-sourcing).
      const dirPath = path.join(APP_INTERNAL_DIR, entry.name);
      const files = fs.readdirSync(dirPath);
      const hasContentFile = files.some(f => f.endsWith("-content.tsx"));

      if (!hasContentFile) {
        // Check if the target slug's content component exists in another internal directory
        const targetSlug = slug;
        if (targetSlug) {
          const altDirName = targetSlug.replace(/-dashboard$/, "");
          const altDir = path.join(APP_INTERNAL_DIR, altDirName);
          if (fs.existsSync(altDir)) {
            const altFiles = fs.readdirSync(altDir);
            if (altFiles.some(f => f.endsWith("-content.tsx"))) continue;
          }
          // Also check the public app directory (content may have been moved public)
          const publicDir = path.join(APP_INTERNAL_DIR, "..", altDirName);
          if (fs.existsSync(publicDir)) {
            const publicFiles = fs.readdirSync(publicDir);
            if (publicFiles.some(f => f.endsWith("-content.tsx"))) continue;
          }
        }
        errors.push(`${entry.name}/ has redirect but no *-content.tsx component file`);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Migrated dashboard(s) missing content component files:\n` +
        errors.map(e => `  - ${e}`).join("\n")
      );
    }
  });

  // -----------------------------------------------------------------------
  // Test: No hardcoded dashboard links point to non-existent directories
  // (catches stale entries after dashboard pages are removed).
  // -----------------------------------------------------------------------

  it("no hardcoded /internal/ links point to non-existent pages", () => {
    if (!fs.existsSync(APP_INTERNAL_DIR)) return;

    const navSource = fs.readFileSync(
      path.join(REPO_ROOT, "apps/web/src/lib/wiki-nav.ts"),
      "utf-8",
    );

    const navBlock = navSource.match(
      /export function getInternalNav\(\)[\s\S]*?^}/m,
    );
    if (!navBlock) return;

    const hrefMatches = [...navBlock[0].matchAll(/href:\s*["']\/internal\/([^"']+)["']/g)];

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
        `${stale.length} sidebar link(s) point to non-existent pages:\n` +
        stale.map(h => `  - ${h}`).join("\n") +
        `\n\nRemove these from getInternalNav() in wiki-nav.ts.`
      );
    }
  });
});
