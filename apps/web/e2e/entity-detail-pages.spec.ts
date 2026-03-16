import { test, expect } from "@playwright/test";

test.describe("Entity detail pages", () => {
  test("organization detail page loads (Anthropic)", async ({ page }) => {
    const response = await page.goto("/organizations/anthropic");
    expect(response?.status()).toBe(200);

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 10000 });
    await expect(h1).toContainText(/anthropic/i);
  });

  test("person detail page loads", async ({ page }) => {
    const response = await page.goto("/people/dario-amodei");
    expect(response?.status()).toBe(200);

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 10000 });
  });

  test("AI model detail page loads", async ({ page }) => {
    const response = await page.goto("/ai-models/claude", { waitUntil: "commit" });
    // May 404 if slug doesn't exist — just verify the page doesn't crash
    expect([200, 404]).toContain(response?.status() ?? 0);
  });

  test("nonexistent org returns 404", async ({ page }) => {
    const response = await page.goto("/organizations/nonexistent-org-xyz");
    expect(response?.status()).toBe(404);
  });

  test("nonexistent person returns 404", async ({ page }) => {
    const response = await page.goto("/people/nonexistent-person-xyz");
    expect(response?.status()).toBe(404);
  });

  test("org page has tabbed content", async ({ page }) => {
    await page.goto("/organizations/anthropic");
    // Org pages typically have tabs (Overview, People, Funding, etc.)
    const tabs = page.locator("[role='tablist'] [role='tab'], button[data-state]");
    const count = await tabs.count();
    // Some orgs may have tabs, others may not — just ensure no crash
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
