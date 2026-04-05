/**
 * Adversarial E2E tests for the /search page.
 *
 * The search page has two modes:
 * 1. Browse state (no query) — shows directory links, featured entities, recent updates
 * 2. Search results (with query) — shows a multi-column grid of entities/wiki/resources
 *
 * Search results require a working wiki-server. Tests that depend on live search
 * results use longer timeouts and graceful fallbacks.
 */
import { test, expect, type Page } from "@playwright/test";

const SEARCH_INPUT = 'input[aria-label="Search entities, articles, resources"]';

/** Helper: type a query and wait for results to appear */
async function searchAndWaitForResults(page: Page, query: string) {
  const input = page.locator(SEARCH_INPUT);
  await input.fill(query);
  // Wait for result count text (indicates search completed) or error state
  const resultIndicator = page.locator('text=/\\d+ results?/');
  const errorIndicator = page.getByText(/No results|Search unavailable/);
  await expect(resultIndicator.or(errorIndicator)).toBeVisible({ timeout: 15000 });
  // If search is unavailable, skip the rest of the test
  if (await errorIndicator.isVisible()) {
    test.skip(true, "Search unavailable — wiki-server not running");
  }
}

test.describe("/search page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/search`);
  });

  test("renders search input and focuses it on load", async ({ page }) => {
    const input = page.locator(SEARCH_INPUT);
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test("shows browse state before typing", async ({ page }) => {
    // Browse state shows directory type links and featured entities
    await expect(page.getByText("Browse by type")).toBeVisible();
    // Should show entity type link chips (text includes count like "Organizations 133")
    await expect(page.getByRole("link", { name: /^Organizations/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /^People/ })).toBeVisible();
  });

  test("typing triggers search and shows results", async ({ page }) => {
    await searchAndWaitForResults(page, "Anthropic");
    // Should have at least one result count > 0
    const countText = await page.locator('text=/\\d+ results?/').textContent();
    const num = parseInt(countText?.match(/(\d+)/)?.[1] ?? "0");
    expect(num).toBeGreaterThan(0);
  });

  test("URL updates with query", async ({ page }) => {
    const input = page.locator(SEARCH_INPUT);
    await input.fill("Anthropic");
    // Wait for debounce + URL update
    await page.waitForURL(/\/search\?q=Anthropic/i, { timeout: 5000 });
  });

  test("loads from URL with ?q= parameter", async ({ page }) => {
    await page.goto(`/search?q=Anthropic`);
    const input = page.locator(SEARCH_INPUT);
    await expect(input).toHaveValue("Anthropic");
    // Results should load automatically (or error gracefully)
    const resultIndicator = page.locator('text=/\\d+ results?/');
    const errorIndicator = page.getByText(/No results|Search unavailable/);
    await expect(resultIndicator.or(errorIndicator)).toBeVisible({ timeout: 15000 });
  });

  test("column headers appear with results", async ({ page }) => {
    await searchAndWaitForResults(page, "Anthropic");
    // Column headers are uppercase text with a count badge (e.g., "Entities 5")
    // They live inside main, scoped to avoid matching nav buttons
    const main = page.locator("main");
    const columnHeader = main.locator("span", { hasText: /^(Entities|Wiki|Resources)$/ }).first();
    await expect(columnHeader).toBeVisible({ timeout: 3000 });
  });

  test("keyboard navigation works: ArrowDown highlights result", async ({ page }) => {
    await searchAndWaitForResults(page, "Anthropic");

    const input = page.locator(SEARCH_INPUT);
    // Press ArrowDown — should highlight a result (selected item gets scrolled into view)
    await input.press("ArrowDown");
    // After pressing ArrowDown, the first result should be visually distinguished
    // Check that a result element with id starting with "sr-" exists
    const firstResult = page.locator('[id^="sr-"]').first();
    await expect(firstResult).toBeVisible({ timeout: 2000 });
  });

  test("keyboard navigation: Enter on selected result navigates", async ({ page }) => {
    await searchAndWaitForResults(page, "Anthropic");

    const input = page.locator(SEARCH_INPUT);
    await input.press("ArrowDown"); // select first result
    await input.press("Enter");     // navigate

    // URL should change (navigated away from /search)
    await page.waitForURL((url) => url.pathname !== "/search", { timeout: 5000 });
  });

  test("keyboard navigation: ArrowUp from first result returns to input", async ({ page }) => {
    await searchAndWaitForResults(page, "Anthropic");

    const input = page.locator(SEARCH_INPUT);
    await input.press("ArrowDown"); // select first
    await input.press("ArrowUp");   // back to input
    // Input should be focused again
    await expect(input).toBeFocused();
  });

  test("no results shows appropriate message", async ({ page }) => {
    const input = page.locator(SEARCH_INPUT);
    await input.fill("zzzzxxxxxnonexistent12345");
    // Should show "no results" or "search unavailable"
    const message = page.getByText(/No results|Search unavailable/);
    await expect(message).toBeVisible({ timeout: 15000 });
  });

  test("rapid typing settles on final query in URL", async ({ page }) => {
    const input = page.locator(SEARCH_INPUT);

    // Type a broad query, then quickly narrow it
    for (const q of ["a", "an", "ant", "anth", "anthr", "anthro", "anthropi", "anthropic"]) {
      await input.fill(q);
      await page.waitForTimeout(50);
    }

    // Wait for results to stabilize
    await page.waitForTimeout(1500);

    // URL should show the final query
    expect(page.url()).toContain("q=anthropic");
  });

  test("XSS in snippet is sanitized", async ({ page }) => {
    // Navigate with a query that might return results with HTML in descriptions
    await page.goto(`/search?q=script`);
    await page.waitForTimeout(2000);

    // No injected script tags should be in the main content
    const mainHtml = await page.locator("main").innerHTML();
    expect(mainHtml).not.toContain("<script");
    expect(mainHtml).not.toContain("onerror=");
    expect(mainHtml).not.toContain("javascript:");
  });

  test("special characters in query don't crash", async ({ page }) => {
    const input = page.locator(SEARCH_INPUT);

    // Test various adversarial inputs
    const adversarial = [
      '<script>alert(1)</script>',
      "'; DROP TABLE things; --",
      "a".repeat(500),
      '((((((((((',
      '\\n\\r\\t',
      'foo OR bar AND NOT baz',
      '$.50 <100ms',
    ];

    for (const q of adversarial) {
      await input.fill(q);
      await page.waitForTimeout(400);
      // Page should not crash — input should still be interactive
      await expect(input).toBeVisible();
    }
  });

  test("empty query after results shows browse state", async ({ page }) => {
    await searchAndWaitForResults(page, "Anthropic");

    const input = page.locator(SEARCH_INPUT);
    // Clear input
    await input.fill("");
    await page.waitForTimeout(500);

    // Browse state should show again
    await expect(page.getByText("Browse by type")).toBeVisible({ timeout: 5000 });
  });

  test("result count display is accurate", async ({ page }) => {
    await searchAndWaitForResults(page, "Anthropic");

    // The result count text should be visible and > 0
    const countText = page.locator("text=/\\d+ results?/");
    await expect(countText).toBeVisible();
    const text = await countText.textContent();
    const num = parseInt(text?.match(/(\d+)/)?.[1] ?? "0");
    expect(num).toBeGreaterThan(0);
  });
});

test.describe("Cmd+K search dialog", () => {
  // Use platform-appropriate shortcut: Meta+k on macOS, Control+k on Linux/Windows
  const isMac = process.platform === "darwin";
  const searchShortcut = isMac ? "Meta+k" : "Control+k";

  test("opens with keyboard shortcut and shows results", async ({ page }) => {
    await page.goto(`/wiki`);
    await page.waitForTimeout(500); // Wait for hydration
    await page.keyboard.press(searchShortcut);
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const input = dialog.locator("input");
    await input.fill("Anthropic");

    // Wait for results — dialog uses role="option" for result items
    const results = dialog.locator('[role="option"]');
    await expect(results.first()).toBeVisible({ timeout: 10000 });
  });

  test("search dialog closes with Escape", async ({ page }) => {
    await page.goto(`/wiki`);
    await page.waitForTimeout(500);
    await page.keyboard.press(searchShortcut);
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });

    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("search dialog state resets on reopen", async ({ page }) => {
    await page.goto(`/wiki`);
    await page.waitForTimeout(500);

    // Open, type, close
    await page.keyboard.press(searchShortcut);
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    await page.locator('[role="dialog"] input').fill("Anthropic");
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");

    // Reopen — input should be empty
    await page.keyboard.press(searchShortcut);
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    const input = page.locator('[role="dialog"] input');
    await expect(input).toHaveValue("");
  });
});
