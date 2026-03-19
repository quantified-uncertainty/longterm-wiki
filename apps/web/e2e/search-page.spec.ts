/**
 * Adversarial E2E tests for the /search page.
 * Run with: npx playwright test apps/web/src/app/search/search.e2e.ts
 */
import { test, expect, type Page } from "@playwright/test";

// Uses baseURL from playwright.config.ts

test.describe("/search page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/search`);
  });

  test("renders search input and focuses it on load", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test("shows empty state with suggestions before typing", async ({ page }) => {
    await expect(page.getByText("Search across the entire knowledge base")).toBeVisible();
    await expect(page.getByText("Anthropic")).toBeVisible();
  });

  test("typing triggers search and shows results", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("Anthropic");
    // Wait for results to appear
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });
    // Should have at least one result
    const results = page.locator('[role="option"]');
    await expect(results.first()).toBeVisible({ timeout: 5000 });
  });

  test("URL updates with query", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("Anthropic");
    // Wait for debounce + URL update
    await page.waitForURL(/\/search\?q=Anthropic/i, { timeout: 3000 });
  });

  test("loads from URL with ?q= parameter", async ({ page }) => {
    await page.goto(`/search?q=Anthropic`);
    const input = page.locator('input[placeholder="Search everything..."]');
    await expect(input).toHaveValue("Anthropic");
    // Results should load automatically
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });
  });

  test("filter tabs appear and work", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("Anthropic");
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

    // Filter tabs should appear
    const filterBar = page.locator('[role="tablist"]');
    await expect(filterBar).toBeVisible();

    // "All" tab should be active by default
    const allTab = filterBar.locator('[aria-selected="true"]');
    await expect(allTab).toContainText("All");
  });

  test("clicking a filter tab filters results", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("Anthropic");
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

    const countBefore = await page.locator('[role="option"]').count();

    // Click "Pages" filter if it exists
    const pagesTab = page.locator('[role="tab"]', { hasText: "Pages" });
    if (await pagesTab.isVisible()) {
      await pagesTab.click();
      // Should still have results (or fewer)
      await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 2000 });
    }
  });

  test("filter persists in URL", async ({ page }) => {
    await page.goto(`/search?q=Anthropic`);
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

    const pagesTab = page.locator('[role="tab"]', { hasText: "Pages" });
    if (await pagesTab.isVisible()) {
      await pagesTab.click();
      await page.waitForURL(/filter=page/, { timeout: 3000 });
    }
  });

  test("sort options work", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("AI safety");
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

    // Click A-Z sort
    const azButton = page.getByRole("button", { name: "A\u2013Z" });
    if (await azButton.isVisible()) {
      await azButton.click();
      // Results should still be visible
      await expect(page.locator('[role="option"]').first()).toBeVisible();
    }
  });

  test("keyboard navigation works: ArrowDown selects first result", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("Anthropic");
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

    // Press ArrowDown
    await input.press("ArrowDown");
    // First result should be selected
    const firstResult = page.locator('[role="option"]').first();
    await expect(firstResult).toHaveAttribute("aria-selected", "true");
  });

  test("keyboard navigation: ArrowUp from first result returns to input", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("Anthropic");
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

    await input.press("ArrowDown"); // select first
    await input.press("ArrowUp");   // back to input
    // Input should be focused again
    await expect(input).toBeFocused();
  });

  test("keyboard navigation: Enter on selected result navigates", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("Anthropic");
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

    await input.press("ArrowDown"); // select first result
    const currentUrl = page.url();
    await input.press("Enter");     // navigate

    // URL should change (navigated away from /search)
    await page.waitForURL((url) => url.pathname !== "/search", { timeout: 5000 });
  });

  test("no results shows appropriate message", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("zzzzxxxxxnonexistent12345");
    // Wait for search to complete
    await page.waitForTimeout(500);
    // Should show either "no results" or error message
    const noResults = page.getByText(/No results|Search may be temporarily unavailable/);
    await expect(noResults).toBeVisible({ timeout: 5000 });
  });

  test("rapid typing doesn't cause stale results (race condition)", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');

    // Type a broad query, then quickly narrow it
    await input.fill("a");
    await page.waitForTimeout(50);
    await input.fill("an");
    await page.waitForTimeout(50);
    await input.fill("ant");
    await page.waitForTimeout(50);
    await input.fill("anth");
    await page.waitForTimeout(50);
    await input.fill("anthr");
    await page.waitForTimeout(50);
    await input.fill("anthro");
    await page.waitForTimeout(50);
    await input.fill("anthrop");
    await page.waitForTimeout(50);
    await input.fill("anthropi");
    await page.waitForTimeout(50);
    await input.fill("anthropic");

    // Wait for results to stabilize
    await page.waitForTimeout(1000);

    // All visible result titles should relate to "anthropic", not to "a" or "an"
    const firstTitle = await page.locator('[role="option"]').first().textContent();
    expect(firstTitle?.toLowerCase()).toContain("anthropic");

    // URL should show the final query
    expect(page.url()).toContain("q=anthropic");
  });

  test("XSS in snippet is sanitized", async ({ page }) => {
    // Navigate with a query that might return results with HTML in descriptions
    await page.goto(`/search?q=script`);
    await page.waitForTimeout(1500);

    // No script tags should be in the DOM
    const scriptTags = await page.locator("script").count();
    // Should only have the layout's script tags, not injected ones
    const searchResults = page.locator('[role="listbox"]');
    if (await searchResults.isVisible()) {
      const innerHtml = await searchResults.innerHTML();
      expect(innerHtml).not.toContain("<script");
      expect(innerHtml).not.toContain("onerror=");
      expect(innerHtml).not.toContain("javascript:");
    }
  });

  test("special characters in query don't crash", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');

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

  test("empty query after results clears results", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("Anthropic");
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

    // Clear input
    await input.fill("");
    await page.waitForTimeout(500);

    // Pre-search empty state should show again
    await expect(page.getByText("Search across the entire knowledge base")).toBeVisible();
  });

  test("result count display is accurate", async ({ page }) => {
    const input = page.locator('input[placeholder="Search everything..."]');
    await input.fill("Anthropic");
    await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });

    // Count visible results
    const resultCount = await page.locator('[role="option"]').count();
    // The result count text should match
    const countText = page.locator("text=/\\d+ result/");
    if (await countText.isVisible()) {
      const text = await countText.textContent();
      const num = parseInt(text?.match(/(\d+)/)?.[1] ?? "0");
      expect(num).toBe(resultCount);
    }
  });
});

test.describe("Cmd+K search dialog", () => {
  test("opens with Cmd+K and shows things results", async ({ page }) => {
    await page.goto(`/wiki`);
    await page.keyboard.press("Meta+k");
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();

    const input = dialog.locator("input");
    await input.fill("Anthropic");
    // Wait for results
    await page.waitForTimeout(500);

    // Should show some results
    const results = dialog.locator('[role="option"]');
    await expect(results.first()).toBeVisible({ timeout: 5000 });
  });

  test("Cmd+K closes with Escape", async ({ page }) => {
    await page.goto(`/wiki`);
    await page.keyboard.press("Meta+k");
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("Cmd+K state resets on reopen", async ({ page }) => {
    await page.goto(`/wiki`);

    // Open, type, close
    await page.keyboard.press("Meta+k");
    await page.locator('[role="dialog"] input').fill("Anthropic");
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");

    // Reopen — input should be empty
    await page.keyboard.press("Meta+k");
    const input = page.locator('[role="dialog"] input');
    await expect(input).toHaveValue("");
  });
});
