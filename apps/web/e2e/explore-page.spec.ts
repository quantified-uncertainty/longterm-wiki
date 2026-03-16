import { test, expect } from "@playwright/test";

test.describe("Explore page (/wiki)", () => {
  test("loads and shows page content", async ({ page }) => {
    await page.goto("/wiki");
    await expect(page).toHaveTitle(/Longterm Wiki/);
  });

  test("has search input", async ({ page }) => {
    await page.goto("/wiki");
    const searchInput = page.locator('input[type="text"], input[type="search"]').first();
    await expect(searchInput).toBeVisible();
  });

  test("displays entity cards or table rows", async ({ page }) => {
    await page.goto("/wiki");
    // Should have either cards or table rows with content
    const items = page.locator("a[href*='/wiki/']");
    await expect(items.first()).toBeVisible({ timeout: 10000 });
    const count = await items.count();
    expect(count).toBeGreaterThan(5);
  });

  test("search filters results", async ({ page }) => {
    await page.goto("/wiki?q=anthropic");
    await page.waitForLoadState("networkidle");
    // Should have at least one result mentioning anthropic
    const content = await page.locator("main").textContent();
    expect(content?.toLowerCase()).toContain("anthropic");
  });
});
