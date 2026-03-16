import { test, expect } from "@playwright/test";

test.describe("FactBase pages", () => {
  test("/factbase redirects", async ({ page }) => {
    // /factbase issues a 307 redirect to the wiki entity page
    const response = await page.request.get("/factbase", {
      maxRedirects: 0,
    });
    expect([307, 308]).toContain(response.status());
  });

  test("/sources loads", async ({ page }) => {
    const response = await page.goto("/sources");
    expect(response?.status()).toBe(200);

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 10000 });
  });
});
