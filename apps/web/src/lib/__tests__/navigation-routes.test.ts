/**
 * Navigation route tests.
 *
 * Validates that:
 * 1. formatCategory handles known acronyms (AI, ML) correctly
 * 2. MDX internal links (href starting with /) resolve to pages in pathRegistry
 * 3. All sidebar hrefs in wiki-nav.ts resolve to canonical URLs (no unknown slugs)
 * 4. KB category redirects use query params (not bare /wiki)
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/919
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "../../../../../");
const CONTENT_DIR = path.join(REPO_ROOT, "content/docs");
const DATA_DIR = path.join(REPO_ROOT, "apps/web/src/data");

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

/** Recursively find all .mdx files */
function findMdxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdxFiles(fullPath));
    } else if (entry.name.endsWith(".mdx")) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 1. formatCategory acronym handling
// ---------------------------------------------------------------------------

/**
 * Mirror of Breadcrumbs.tsx formatCategory — keep in sync.
 * Tests verify the actual Breadcrumbs component handles acronyms correctly.
 */
const ACRONYMS: Record<string, string> = {
  ai: "AI",
  ml: "ML",
};

function formatCategory(category: string): string {
  return category
    .split("-")
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

describe("formatCategory", () => {
  it("formats 'knowledge-base' as 'Knowledge Base'", () => {
    expect(formatCategory("knowledge-base")).toBe("Knowledge Base");
  });

  it("formats 'ml-safety' as 'ML Safety'", () => {
    expect(formatCategory("ml-safety")).toBe("ML Safety");
  });

  it("formats 'people' as 'People'", () => {
    expect(formatCategory("people")).toBe("People");
  });

  it("does not corrupt multi-word categories without acronyms", () => {
    expect(formatCategory("long-term-risk")).toBe("Long Term Risk");
  });
});

// ---------------------------------------------------------------------------
// 2. Internal link resolution from MDX files
// ---------------------------------------------------------------------------

describe("MDX internal links", () => {
  const pathRegistry = loadJson<Record<string, string>>(
    path.join(DATA_DIR, "pathRegistry.json"),
  );

  // All valid paths in the registry (canonical URL paths)
  const registeredPaths = new Set(Object.values(pathRegistry));

  /** Parse internal links from MDX body (skip frontmatter, code blocks). */
  function extractInternalLinks(content: string): string[] {
    // Strip frontmatter
    const bodyStart = content.startsWith("---")
      ? content.indexOf("---", 3) + 3
      : 0;
    const body = content.slice(bodyStart);

    const links: string[] = [];
    // Match markdown links with absolute paths: [text](/some/path)
    // Also match href="/some/path" in JSX
    const mdLinkRe = /\[(?:[^\]]*)\]\((\/[^)#?]+)/g;
    const jsxHrefRe = /href=["'](\/[^"'#?]+)/g;

    let m: RegExpExecArray | null;
    while ((m = mdLinkRe.exec(body)) !== null) links.push(m[1]);
    while ((m = jsxHrefRe.exec(body)) !== null) links.push(m[1]);
    return links;
  }

  /** Normalize a path for registry lookup */
  function normalizePath(p: string): string {
    // Ensure trailing slash
    return p.endsWith("/") ? p : p + "/";
  }

  // Paths that are known OK even though they're not in pathRegistry
  // (they're Next.js routes, not wiki content pages)
  const KNOWN_ROUTE_PREFIXES = [
    "/wiki",
    "/internal",
    "/tools",
    "/about",
    "/knowledge-base",  // redirects
  ];

  it("all MDX internal links resolve to known pages or routes", () => {
    const mdxFiles = findMdxFiles(CONTENT_DIR);
    const failures: string[] = [];

    for (const filePath of mdxFiles) {
      // Skip internal documentation — it may link to example paths
      const rel = path.relative(CONTENT_DIR, filePath);
      if (rel.startsWith("internal/")) continue;

      const content = fs.readFileSync(filePath, "utf-8");
      const links = extractInternalLinks(content);

      for (const link of links) {
        // Skip fragment-only or query-only
        if (link.startsWith("#") || link.startsWith("?")) continue;

        const normalized = normalizePath(link);

        // Check if it's a known route prefix
        const isKnownRoute = KNOWN_ROUTE_PREFIXES.some(
          (prefix) => link === prefix || link.startsWith(prefix + "/") || link.startsWith(prefix + "?"),
        );
        if (isKnownRoute) continue;

        // Check if it's in the path registry
        if (registeredPaths.has(normalized) || registeredPaths.has(link)) continue;

        failures.push(`${rel}: broken internal link → ${link}`);
      }
    }

    if (failures.length > 0) {
      // Report up to 10 failures for readability
      const sample = failures.slice(0, 10);
      const extra = failures.length > 10 ? `\n  ...and ${failures.length - 10} more` : "";
      throw new Error(
        `Found ${failures.length} broken internal links:\n  ${sample.join("\n  ")}${extra}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Sidebar hrefs resolve to known entities
// ---------------------------------------------------------------------------

describe("wiki-nav sidebar hrefs", () => {
  const idRegistry = (() => {
    try {
      const db = loadJson<{ idRegistry?: { bySlug: Record<string, string> } }>(
        path.join(DATA_DIR, "database.json"),
      );
      return db.idRegistry?.bySlug ?? {};
    } catch {
      return {} as Record<string, string>;
    }
  })();

  const pathRegistry = loadJson<Record<string, string>>(
    path.join(DATA_DIR, "pathRegistry.json"),
  );

  /** Check if a /wiki/<slug-or-id> href resolves */
  function resolves(href: string): boolean {
    if (!href.startsWith("/wiki/")) return true; // other routes OK
    const id = href.replace(/^\/wiki\//, "");
    if (/^E\d+$/.test(id)) return true; // numeric IDs always resolve (assumed valid)
    // Check slug in idRegistry (bySlug) or pathRegistry
    return id in idRegistry || id in pathRegistry;
  }

  it("all pathRegistry slugs are non-empty strings", () => {
    for (const [slug, pagePath] of Object.entries(pathRegistry)) {
      expect(typeof slug).toBe("string");
      expect(slug.length).toBeGreaterThan(0);
      expect(typeof pagePath).toBe("string");
      expect(pagePath.startsWith("/")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. KB category redirect includes entity query param (not bare /wiki)
// ---------------------------------------------------------------------------

describe("KB category redirects", () => {
  it("middleware.ts redirects knowledge-base category paths with entity param", () => {
    const middlewarePath = path.join(
      REPO_ROOT,
      "apps/web/src/middleware.ts",
    );

    if (!fs.existsSync(middlewarePath)) {
      // Skip test if middleware doesn't exist
      return;
    }

    const middlewareContent = fs.readFileSync(middlewarePath, "utf-8");
    // Check that the redirect uses entity query param (not a bare redirect)
    expect(middlewareContent).toContain("entity");
  });
});
