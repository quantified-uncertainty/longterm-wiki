/**
 * E2E test: Claims table column visibility
 *
 * Run: npx playwright test e2e/claims-table-columns.spec.ts
 * Requires dev server running on port 3001.
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:3001";

test.describe("Claims table column visibility", () => {
  test.beforeEach(async ({ page }) => {
    // Clear any persisted column prefs
    await page.goto(`${BASE}/claims/explore`);
    await page.evaluate(() => localStorage.removeItem("claims-table-column-visibility"));
    await page.reload();
    await page.waitForSelector("table");
  });

  test("column toggle dropdown appears", async ({ page }) => {
    const columnsBtn = page.getByRole("button", { name: "Columns", exact: true });
    await expect(columnsBtn).toBeVisible();
  });

  test("preset buttons are visible", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Default", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Quality", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Structured", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "All Columns", exact: true })).toBeVisible();
  });

  test("Quality preset shows Markup and Has Related columns", async ({ page }) => {
    // Default should NOT show these columns
    await expect(page.locator("th").filter({ hasText: "Markup" })).toBeHidden();
    await expect(page.locator("th").filter({ hasText: "Has Related" })).toBeHidden();

    // Click Quality preset
    await page.getByRole("button", { name: "Quality" }).click();

    // Now they should appear
    await expect(page.locator("th").filter({ hasText: "Markup" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "Has Related" })).toBeVisible();
  });

  test("toggling individual columns via dropdown", async ({ page }) => {
    // Open the Columns dropdown
    await page.getByRole("button", { name: "Columns", exact: true }).click();

    // Find the "Type" checkbox and uncheck it
    const typeCheckbox = page.locator("label").filter({ hasText: "Type" }).locator("input[type=checkbox]");
    await expect(typeCheckbox).toBeChecked();
    await typeCheckbox.click();

    // Type column header should be gone
    await expect(page.locator("th").filter({ hasText: "Type" })).toBeHidden();

    // Re-check it
    await typeCheckbox.click();
    await expect(page.locator("th").filter({ hasText: "Type" })).toBeVisible();
  });

  test("column preferences persist after refresh", async ({ page }) => {
    // Click Quality preset
    await page.getByRole("button", { name: "Quality" }).click();
    await expect(page.locator("th").filter({ hasText: "Markup" })).toBeVisible();

    // Reload
    await page.reload();
    await page.waitForSelector("table");

    // Markup column should still be visible
    await expect(page.locator("th").filter({ hasText: "Markup" })).toBeVisible();
  });

  test("Default preset resets columns", async ({ page }) => {
    // Switch to All Columns first
    await page.getByRole("button", { name: "All Columns" }).click();
    await expect(page.locator("th").filter({ hasText: "Markup" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "Inference" })).toBeVisible();

    // Click Default
    await page.getByRole("button", { name: "Default" }).click();

    // Quality columns should be hidden again
    await expect(page.locator("th").filter({ hasText: "Markup" })).toBeHidden();
    await expect(page.locator("th").filter({ hasText: "Inference" })).toBeHidden();
  });

  test("expanded row works with varying column counts", async ({ page }) => {
    // Start with Default columns
    await page.getByRole("button", { name: "Default" }).click();

    // Click first data row to expand
    const firstRow = page.locator("table tbody tr").first();
    await firstRow.click();

    // Expanded detail should appear
    await expect(page.locator("text=Full Claim:").first()).toBeVisible();

    // Switch to All Columns while expanded
    await page.getByRole("button", { name: "All Columns" }).click();

    // Expanded detail should still be visible
    await expect(page.locator("text=Full Claim:").first()).toBeVisible();
  });
});
