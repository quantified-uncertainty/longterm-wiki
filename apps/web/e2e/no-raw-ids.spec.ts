import { test, expect, type Page } from "@playwright/test";

/**
 * No Raw Entity IDs in Rendered Pages
 *
 * This test suite catches a class of bug where raw entity IDs (like `sid_ENI8sgChDQ`)
 * leak into the visible UI instead of being resolved to human-readable names.
 *
 * This has recurred on:
 *  - FactBase entity pages (equity-positions, board-seats, key-persons tables)
 *  - Organization pages (People tab, Equity tab)
 *  - Directory listing pages
 *
 * The tests load various page types and scan all visible text for patterns that
 * indicate an unresolved ID or rendering failure.
 */

// ─── Patterns that should NEVER appear in user-visible page text ────────────

const RAW_ID_PATTERNS = [
  {
    name: "sid_ stableId",
    // sid_ followed by 3+ alphanumeric chars — the main offender
    pattern: /\bsid_[A-Za-z0-9]{3,}\b/,
  },
  {
    name: "[object Object]",
    // React/JS rendering bug where an object is coerced to string
    pattern: /\[object Object\]/,
  },
];

// ─── Helper: assert no raw IDs in visible text ─────────────────────────────

/**
 * Navigate to a URL and assert that no raw entity ID patterns appear in visible text.
 *
 * Uses `innerText` which only includes text visible to the user — this excludes:
 *  - Script and style tags
 *  - Hidden elements (display: none, visibility: hidden)
 *  - Collapsed <details> content (e.g., "Internal Metadata" sections that
 *    legitimately show IDs for developers)
 *
 * We scope to `<main>` to avoid matching IDs in:
 *  - Navigation menus (which may contain URL fragments)
 *  - Footer metadata
 *  - Dev-mode debug overlays
 */
/** Navigate to a URL and wait for main content. */
async function loadPage(page: Page, url: string) {
  const response = await page.goto(url, {
    waitUntil: "networkidle",
    timeout: 45000,
  });
  expect(response?.status(), `Expected ${url} to return a successful status`).toBeLessThan(400);
  const main = page.locator("main, article, [role='main']").first();
  await expect(main).toBeVisible({ timeout: 15000 });
}

/** Get visible text from the main content area. */
function getMainText(page: Page) {
  return page.evaluate(() => {
    const mainEl = document.querySelector("main") || document.body;
    return mainEl.innerText;
  });
}

/** Check text for raw ID patterns and report with context snippets. */
function checkTextForRawIds(text: string, url: string, label?: string) {
  for (const { name, pattern } of RAW_ID_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, "g"));
    if (matches) {
      const unique = [...new Set(matches)];
      const snippets = unique.slice(0, 5).map((m) => {
        const idx = text.indexOf(m);
        return `  "...${text.slice(Math.max(0, idx - 40), idx + m.length + 40).replace(/\n/g, "\\n")}..."`;
      });
      const extra = unique.length > 5 ? `\n  ... and ${unique.length - 5} more` : "";
      const suffix = label ? ` (${label})` : "";
      expect.soft(unique, `Found ${unique.length} raw ${name} in ${url}${suffix}:\n${snippets.join("\n")}${extra}`).toHaveLength(0);
    }
  }
}

async function assertNoRawIds(page: Page, url: string) {
  await loadPage(page, url);
  const text = await getMainText(page);
  checkTextForRawIds(text, url);
}

/**
 * Variant that clicks through tabs before scanning — tab content is
 * lazily rendered and won't be visible without clicking.
 */
async function assertNoRawIdsWithTabs(page: Page, url: string) {
  await loadPage(page, url);

  const tabs = page.locator("[role='tab'], button[data-state]");
  const tabCount = await tabs.count();
  const texts: string[] = [];

  if (tabCount > 1) {
    for (let i = 0; i < tabCount; i++) {
      const tab = tabs.nth(i);
      const state = await tab.getAttribute("data-state");
      if (state !== "active" && (await tab.isVisible())) {
        await tab.click();
        await page.waitForTimeout(500);
      }
      texts.push(await getMainText(page));
    }
  } else {
    texts.push(await getMainText(page));
  }

  checkTextForRawIds(texts.join("\n"), url, `across ${tabCount} tabs`);
}

// ─── Test suites by page type ───────────────────────────────────────────────

/**
 * FactBase entity pages — the ORIGINAL bug location.
 *
 * These pages render tables of equity-positions, board-seats, key-persons,
 * and other structured data. The bug occurs when entity references in these
 * tables are not resolved to human-readable names, showing raw `sid_` IDs.
 */
test.describe("FactBase entity pages — no raw IDs", () => {
  // Major AI orgs with rich FactBase data (many related entities)
  const FACTBASE_ENTITIES = [
    "anthropic",
    "openai",
    "deepmind",
    "meta-ai",
    "microsoft",
    "nvidia",
  ];

  for (const entity of FACTBASE_ENTITIES) {
    test(`/factbase/entity/${entity}`, async ({ page }) => {
      await assertNoRawIds(page, `/factbase/entity/${entity}`);
    });
  }
});

/**
 * Organization directory detail pages.
 *
 * Org pages have multiple tabs (Overview, People, Equity, Funding, etc.)
 * that render entity references — people names, investor names, etc.
 * We click through tabs to ensure all tab content is checked.
 */
test.describe("Organization pages — no raw IDs", () => {
  // Key orgs known to have rich tabbed content
  const KEY_ORGS = [
    "anthropic",
    "openai",
    "deepmind",
    "miri",
    "arc",
    "open-philanthropy",
    "conjecture",
    "ssi",
    "uk-aisi",
    "meta-ai",
  ];

  for (const org of KEY_ORGS) {
    test(`/organizations/${org} (with tabs)`, async ({ page }) => {
      await assertNoRawIdsWithTabs(page, `/organizations/${org}`);
    });
  }
});

/**
 * People detail pages.
 *
 * Person pages show affiliations, roles, and linked organizations —
 * all of which involve entity reference resolution.
 */
test.describe("People pages — no raw IDs", () => {
  const PEOPLE = [
    "dario-amodei",
    "sam-altman",
    "demis-hassabis",
    "jan-leike",
    "paul-christiano",
  ];

  for (const person of PEOPLE) {
    test(`/people/${person}`, async ({ page }) => {
      await assertNoRawIds(page, `/people/${person}`);
    });
  }
});

/**
 * Directory listing pages.
 *
 * These render tables/grids of many entities. If the name resolver fails,
 * every row could show a raw ID.
 */
test.describe("Directory listing pages — no raw IDs", () => {
  const DIRECTORIES = [
    "/organizations",
    "/people",
    "/ai-models",
    "/grants",
    "/investments",
    "/funding-rounds",
    "/funding-programs",
    "/projects",
    "/events",
    "/benchmarks",
    "/legislation",
    "/sources",
  ];

  for (const dir of DIRECTORIES) {
    test(`${dir}`, async ({ page }) => {
      await assertNoRawIds(page, dir);
    });
  }
});

/**
 * Wiki content pages (MDX).
 *
 * MDX pages use <EntityLink> components that resolve IDs to names.
 * A build-data failure could cause these to render raw IDs.
 * We test a few high-traffic pages with many entity references.
 */
test.describe("Wiki pages — no raw IDs", () => {
  const WIKI_PAGES = [
    // About page — links to many entities
    "/wiki/E755",
    // Internal overview — references many internal entities
    "/wiki/E779",
  ];

  for (const url of WIKI_PAGES) {
    test(`${url}`, async ({ page }) => {
      await assertNoRawIds(page, url);
    });
  }
});

/**
 * Internal dashboard pages that render entity data.
 *
 * Dashboards are developer-facing but should still show human-readable names.
 * A raw ID here usually means a lookup function is broken, which affects
 * public pages too.
 *
 * Note: these pages require a running wiki-server for full data.
 * They may render partially without one, so we check what's visible.
 */
test.describe("Internal dashboard pages — no raw IDs", () => {
  const DASHBOARDS = [
    "/internal/entities",
    "/internal/facts",
  ];

  for (const url of DASHBOARDS) {
    test(`${url}`, async ({ page }) => {
      // Dashboards may fail to load fully without wiki-server;
      // skip if the page can't load (assertNoRawIds checks status internally)
      try {
        await assertNoRawIds(page, url);
      } catch {
        // Dashboard may be unavailable in CI without wiki-server — skip gracefully
        test.skip();
      }
    });
  }
});

/**
 * Project and event detail pages.
 *
 * These pages reference organizations and people — another vector for
 * raw ID leaks.
 */
test.describe("Project & event pages — no raw IDs", () => {
  const DETAIL_PAGES = [
    "/projects/squiggle",
    "/projects/longterm-wiki",
    "/projects/metaforecast",
  ];

  for (const url of DETAIL_PAGES) {
    test(`${url}`, async ({ page }) => {
      await assertNoRawIds(page, url);
    });
  }
});
