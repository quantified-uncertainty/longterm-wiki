import { test, expect, type Page } from "@playwright/test";

/**
 * Render Quality Audit
 *
 * Catches display anti-patterns that indicate broken formatting, raw data leaks,
 * or rendering failures. Complements no-raw-ids.spec.ts (which checks for entity
 * ID leaks) by checking for formatting and display quality issues.
 *
 * Anti-patterns detected:
 *  - Raw large numbers (7+ digits) that should be formatted (e.g., "380000000000" → "$380B")
 *  - Raw JSON objects dumped into visible text
 *  - JavaScript artifacts: "undefined", "NaN", "[object Object]"
 *  - Empty stat cards (visible card container with no value)
 *
 * All assertions use expect.soft() to report all failures per page rather than
 * stopping at the first one.
 *
 * Phase 2 of Discussion #3768 (Rendering Quality & Test Infrastructure).
 */

// ─── Anti-pattern definitions ────────────────────────────────────────────────

interface AntiPattern {
  name: string;
  /** Test function: returns array of matches found in text. Empty = pass. */
  test: (text: string) => string[];
}

const ANTI_PATTERNS: AntiPattern[] = [
  {
    name: "raw large number (7+ consecutive digits)",
    test: (text) => {
      // Match 7+ consecutive digits that aren't part of known safe patterns.
      // We split by lines and check each line to give better context.
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        // Skip lines that look like code blocks or metadata
        if (line.trim().startsWith("```") || line.trim().startsWith("//")) continue;

        const found = line.match(/\d{7,}/g);
        if (!found) continue;

        for (const m of found) {
          // Safe patterns to exclude:
          // - Entity IDs like E1234 (preceded by E)
          // - Dates like 2024-01-15 or 20240115
          // - Phone-like patterns
          // - sid_ prefixed IDs
          // - Zip codes (5 digits) — already excluded by 7+ threshold
          const idx = line.indexOf(m);
          const before = line.slice(Math.max(0, idx - 5), idx);
          const after = line.slice(idx + m.length, idx + m.length + 5);

          // Skip if preceded by E (entity ID like E12345678)
          if (before.endsWith("E")) continue;
          // Skip if part of a date pattern (YYYY-MM-DD or YYYYMMDD)
          if (/\d{4}-\d{2}-\d{2}/.test(line.slice(Math.max(0, idx - 5), idx + m.length + 5))) continue;
          // Skip if inside what looks like an ID (alphanumeric mix)
          if (/[a-zA-Z]/.test(before.slice(-1)) || /[a-zA-Z]/.test(after.charAt(0))) continue;
          // Skip if preceded by sid_ or f_ (internal IDs)
          if (/sid_|f_/.test(before)) continue;
          // Skip if it looks like a year range (e.g., "20200101")
          if (m.length === 8 && /^20\d{6}$/.test(m)) continue;

          matches.push(m);
        }
      }
      return matches;
    },
  },
  {
    name: "raw JSON object in visible text",
    test: (text) => {
      // Match {"fieldName": patterns — indicates JSON.stringify() leaked into UI
      const matches = text.match(/\{"[a-zA-Z_]+"\s*:/g);
      return matches ? [...new Set(matches)] : [];
    },
  },
  {
    name: "JavaScript artifact (undefined/NaN/[object Object])",
    test: (text) => {
      const matches: string[] = [];
      // Check for "undefined" as a standalone word (not inside code blocks)
      if (/\bundefined\b/.test(text)) {
        // Exclude common prose usage like "undefined behavior"
        const lines = text.split("\n").filter(
          (l) => /\bundefined\b/.test(l) && !/undefined behavior|left undefined|remains undefined/i.test(l)
        );
        if (lines.length > 0) matches.push("undefined");
      }
      if (/\bNaN\b/.test(text)) {
        // Exclude mentions in technical content
        const lines = text.split("\n").filter(
          (l) => /\bNaN\b/.test(l) && !/NaN propagat|NaN value|NaN check|isNaN/i.test(l)
        );
        if (lines.length > 0) matches.push("NaN");
      }
      if (/\[object Object\]/.test(text)) {
        matches.push("[object Object]");
      }
      return matches;
    },
  },
];

// ─── Pages to audit ──────────────────────────────────────────────────────────

/** Organization detail pages with stat cards and financial data. */
const ORG_PAGES = [
  "/organizations/anthropic",
  "/organizations/openai",
  "/organizations/google-deepmind",
  "/organizations/meta-ai",
  "/organizations/microsoft",
];

/** People detail pages with role/affiliation data. */
const PEOPLE_PAGES = [
  "/people/dario-amodei",
  "/people/sam-altman",
  "/people/demis-hassabis",
];

/** Directory index pages with tables of formatted data. */
const DIRECTORY_PAGES = [
  "/organizations",
  "/people",
  "/grants",
  "/ai-models",
  "/legislation",
];

/** Wiki content pages with inline facts and computed values. */
const WIKI_PAGES = [
  "/wiki/E755", // About page
  "/wiki/E779", // Internal overview
  "/wiki/E100", // Anthropic wiki page
];

/** The browse page with search and entity browsing. */
const BROWSE_PAGES = ["/browse"];

const ALL_PAGES = [
  ...ORG_PAGES,
  ...PEOPLE_PAGES,
  ...DIRECTORY_PAGES,
  ...WIKI_PAGES,
  ...BROWSE_PAGES,
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Navigate to a URL and wait for main content to be visible. */
async function loadPage(page: Page, url: string) {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  expect(response?.status(), `Expected ${url} to return a successful status`).toBeLessThan(400);
  // Wait for main content
  const main = page.locator("main, article, [role='main']").first();
  await expect(main).toBeVisible({ timeout: 15000 });
  // Give client components time to hydrate
  await page.waitForTimeout(1000);
}

/** Get visible text from the main content area, excluding code blocks. */
async function getMainText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const mainEl = document.querySelector("main") || document.body;
    // Remove code/pre elements before extracting text — they legitimately contain numbers/artifacts
    const clone = mainEl.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll("code, pre, time, script, style, [data-testid='metadata']")) {
      el.remove();
    }
    return clone.innerText;
  });
}

/** Run all anti-pattern checks on text from a URL. */
function checkAntiPatterns(text: string, url: string, label?: string) {
  for (const { name, test: testFn } of ANTI_PATTERNS) {
    const matches = testFn(text);
    if (matches.length > 0) {
      const preview = matches.slice(0, 3).join(", ");
      const extra = matches.length > 3 ? ` (+${matches.length - 3} more)` : "";
      const suffix = label ? ` (${label})` : "";
      expect.soft(
        matches,
        `Found ${matches.length} ${name} in ${url}${suffix}: ${preview}${extra}`
      ).toHaveLength(0);
    }
  }
}

/** Load a page, click through all tabs, and check each tab's content. */
async function auditPageWithTabs(page: Page, url: string) {
  await loadPage(page, url);

  const tabs = page.locator("[role='tab'], button[data-state]");
  const tabCount = await tabs.count();

  if (tabCount > 1) {
    for (let i = 0; i < tabCount; i++) {
      const tab = tabs.nth(i);
      const state = await tab.getAttribute("data-state");
      const tabLabel = (await tab.textContent())?.trim() ?? `tab ${i}`;
      if (state !== "active" && (await tab.isVisible())) {
        await tab.click();
        await page.waitForTimeout(500);
      }
      const text = await getMainText(page);
      checkAntiPatterns(text, url, tabLabel);
    }
  } else {
    const text = await getMainText(page);
    checkAntiPatterns(text, url);
  }
}

// ─── Empty stat card check ───────────────────────────────────────────────────

/** Check for stat cards that have no value content (empty or whitespace-only). */
async function checkEmptyStatCards(page: Page, url: string) {
  // Stat cards follow a common pattern: rounded border container with a label and value
  const statCards = page.locator(".rounded-xl.border, .rounded-lg.border").filter({
    has: page.locator(".text-xl, .text-2xl, .text-3xl, .tabular-nums"),
  });

  const count = await statCards.count();
  for (let i = 0; i < count; i++) {
    const card = statCards.nth(i);
    const valueEl = card.locator(".text-xl, .text-2xl, .text-3xl, .tabular-nums").first();
    const text = (await valueEl.textContent())?.trim() ?? "";
    expect.soft(
      text.length > 0,
      `Empty stat card value in ${url} (card ${i + 1} of ${count})`
    ).toBe(true);
  }
}

// ─── Test suites ─────────────────────────────────────────────────────────────

test.describe("Render quality audit — organization pages", () => {
  for (const url of ORG_PAGES) {
    test(`${url}`, async ({ page }) => {
      await auditPageWithTabs(page, url);
      await checkEmptyStatCards(page, url);
    });
  }
});

test.describe("Render quality audit — people pages", () => {
  for (const url of PEOPLE_PAGES) {
    test(`${url}`, async ({ page }) => {
      await auditPageWithTabs(page, url);
    });
  }
});

test.describe("Render quality audit — directory pages", () => {
  for (const url of DIRECTORY_PAGES) {
    test(`${url}`, async ({ page }) => {
      await loadPage(page, url);
      const text = await getMainText(page);
      checkAntiPatterns(text, url);
    });
  }
});

test.describe("Render quality audit — wiki pages", () => {
  for (const url of WIKI_PAGES) {
    test(`${url}`, async ({ page }) => {
      await loadPage(page, url);
      const text = await getMainText(page);
      checkAntiPatterns(text, url);
    });
  }
});

test.describe("Render quality audit — browse page", () => {
  for (const url of BROWSE_PAGES) {
    test(`${url}`, async ({ page }) => {
      await loadPage(page, url);
      const text = await getMainText(page);
      checkAntiPatterns(text, url);
    });
  }
});
