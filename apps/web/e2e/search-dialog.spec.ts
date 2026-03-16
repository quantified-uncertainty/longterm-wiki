import { test, expect } from "@playwright/test";

test.describe("Search dialog (Cmd+K)", () => {
  test("opens on Cmd+K", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Meta+k");
    const dialog = page.locator("[role='dialog'], [data-search-dialog]").first();
    // Fallback: look for a search input that appeared
    const searchInput = page.locator("input[placeholder*='earch']").first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });
  });

  test("closes on Escape", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Meta+k");
    const searchInput = page.locator("input[placeholder*='earch']").first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Escape");
    await expect(searchInput).not.toBeVisible({ timeout: 3000 });
  });

  test("opens via search button click", async ({ page }) => {
    await page.goto("/");
    const searchBtn = page.locator("header button[title*='Search']");
    await searchBtn.click();
    const searchInput = page.locator("input[placeholder*='earch']").first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });
  });
});
