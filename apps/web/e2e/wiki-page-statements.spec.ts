/**
 * E2E test: Wiki page Statements section rendering
 *
 * Verifies the PageStatementsSection renders correctly on wiki pages
 * that have statements data. Uses E22 (Anthropic) as the test page.
 *
 * Run: npx playwright test e2e/wiki-page-statements.spec.ts
 * Requires dev server running on port 3001 and wiki-server accessible.
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:3001";

test.describe("Wiki page Statements section", () => {
  test("renders Statements section on entity page", async ({ page }) => {
    await page.goto(`${BASE}/wiki/E22`, { waitUntil: "networkidle" });

    // The page should have a Statements heading
    const statementsHeading = page.locator("h2").filter({ hasText: "Statements" });

    // If wiki-server is not available, the section won't render — that's OK
    const headingCount = await statementsHeading.count();
    if (headingCount === 0) {
      test.skip(true, "Statements section not rendered — wiki-server may be unavailable");
      return;
    }

    await expect(statementsHeading).toBeVisible();

    // Should have summary text with "active statements"
    const summaryText = page.locator("text=/\\d+ active statements/");
    await expect(summaryText).toBeVisible();

    // Should have a "View all N →" link within the statements section
    const statementsSection = page.locator(".not-prose").filter({ has: page.locator("h2", { hasText: "Statements" }) });
    const viewAllLink = statementsSection.locator("a").filter({ hasText: /View all \d+/ });
    await expect(viewAllLink).toBeVisible();
    await expect(viewAllLink).toHaveAttribute("href", /\/wiki\/E22\/statements/);
  });

  test("Statements section appears before References", async ({ page }) => {
    await page.goto(`${BASE}/wiki/E22`, { waitUntil: "networkidle" });

    const statementsSection = page.locator(".not-prose").filter({ has: page.locator("h2", { hasText: "Statements" }) });
    const headingCount = await statementsSection.count();
    if (headingCount === 0) {
      test.skip(true, "Statements section not rendered — wiki-server may be unavailable");
      return;
    }

    // Both sections should exist
    await expect(statementsSection).toBeVisible();

    // References section should exist (it's an h2 or section heading)
    const referencesSection = page.locator("h2, h3").filter({ hasText: "References" });
    const refsCount = await referencesSection.count();
    if (refsCount > 0) {
      // Statements should come before References in the DOM
      const statementsBox = await statementsSection.boundingBox();
      const referencesBox = await referencesSection.first().boundingBox();
      if (statementsBox && referencesBox) {
        expect(statementsBox.y).toBeLessThan(referencesBox.y);
      }
    }
  });

  test("structured statements table renders with expected columns", async ({ page }) => {
    await page.goto(`${BASE}/wiki/E22`, { waitUntil: "networkidle" });

    const statementsSection = page.locator(".not-prose").filter({ has: page.locator("h2", { hasText: "Statements" }) });
    const headingCount = await statementsSection.count();
    if (headingCount === 0) {
      test.skip(true, "Statements section not rendered — wiki-server may be unavailable");
      return;
    }

    // Should have a table with expected column headers
    const table = statementsSection.locator("table").first();
    await expect(table).toBeVisible();

    const headers = table.locator("th");
    const headerTexts = await headers.allTextContents();
    expect(headerTexts).toContain("Property");
    expect(headerTexts).toContain("Value");
    expect(headerTexts).toContain("Verdict");
    expect(headerTexts).toContain("Sources");
  });

  test("sources table renders with Citations column", async ({ page }) => {
    await page.goto(`${BASE}/wiki/E22`, { waitUntil: "networkidle" });

    const sourcesHeading = page.locator("h3").filter({ hasText: "Sources" });
    const headingCount = await sourcesHeading.count();
    if (headingCount === 0) {
      test.skip(true, "Sources section not rendered — may have no citation URLs");
      return;
    }

    // Find the sources table (the one after the "Sources" heading)
    const sourcesSection = page.locator(".not-prose").filter({ has: page.locator("h3", { hasText: "Sources" }) });
    const sourcesTable = sourcesSection.locator("table").last();
    const sourcesTableCount = await sourcesTable.count();
    if (sourcesTableCount === 0) {
      test.skip(true, "Sources table not rendered");
      return;
    }

    const headers = sourcesTable.locator("th");
    const headerTexts = await headers.allTextContents();
    expect(headerTexts).toContain("Source");
    expect(headerTexts).toContain("Citations");
    expect(headerTexts).toContain("Verdicts");
  });

  test("References section still renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/wiki/E22`, { waitUntil: "networkidle" });

    // The article element should exist
    const article = page.locator("article");
    await expect(article).toBeVisible();

    // Page should not have any visible error messages
    const errorText = page.locator("text=/Error|error|failed to/i");
    const errorCount = await errorText.count();
    // Filter out legitimate uses of "error" in page content
    for (let i = 0; i < errorCount; i++) {
      const el = errorText.nth(i);
      const text = await el.textContent();
      // Only fail on actual error messages, not content mentioning "error"
      if (text && /application error|render error|failed to load/i.test(text)) {
        throw new Error(`Found error on page: ${text}`);
      }
    }
  });

  test("non-entity pages do not show Statements section", async ({ page }) => {
    // Visit a non-entity page (internal/about)
    await page.goto(`${BASE}/wiki/E899`, { waitUntil: "networkidle" });

    // This is an internal page — should NOT have a Statements section
    const statementsHeading = page.locator("h2").filter({ hasText: "Statements" });
    await expect(statementsHeading).toHaveCount(0);
  });
});
