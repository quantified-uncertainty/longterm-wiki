import { test, expect } from "@playwright/test";

test.describe("FactBase pages", () => {
  test("/factbase loads directly", async ({ page }) => {
    // /factbase now renders the FactBase overview page directly
    const response = await page.goto("/factbase");
    expect(response?.status()).toBe(200);
    expect(page.url()).toMatch(/\/factbase$/);
    await expect(page.locator("h1").first()).toContainText("FactBase", { timeout: 10000 });
  });

  test("/sources loads", async ({ page }) => {
    const response = await page.goto("/sources");
    expect(response?.status()).toBe(200);

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 10000 });
  });
});
