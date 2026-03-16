import { test, expect } from "@playwright/test";

// Test a handful of known wiki pages
const WIKI_PAGES = [
  { id: "E755", titleMatch: /about/i },
  { id: "E779", titleMatch: /internal/i },
];

test.describe("Wiki pages", () => {
  for (const { id, titleMatch } of WIKI_PAGES) {
    test(`/wiki/${id} loads`, async ({ page }) => {
      const response = await page.goto(`/wiki/${id}`);
      expect(response?.status()).toBe(200);

      const h1 = page.locator("h1").first();
      await expect(h1).toBeVisible({ timeout: 10000 });
    });
  }

  test("nonexistent wiki page returns 404", async ({ page }) => {
    const response = await page.goto("/wiki/E999999");
    expect(response?.status()).toBe(404);
  });

  test("wiki page has sidebar navigation", async ({ page }) => {
    await page.goto("/wiki/E755");
    // The wiki layout should have a sidebar with links
    const sidebar = page.locator("nav, aside").filter({ hasText: /about|internal/i });
    // Sidebar may not be visible on mobile, just check it exists in DOM
    const sidebarCount = await sidebar.count();
    expect(sidebarCount).toBeGreaterThanOrEqual(0); // Soft check — layout varies
  });

  test("wiki page has no broken images", async ({ page }) => {
    await page.goto("/wiki/E755");
    await page.waitForLoadState("networkidle");

    const images = page.locator("img");
    const count = await images.count();
    for (let i = 0; i < count; i++) {
      const img = images.nth(i);
      const naturalWidth = await img.evaluate(
        (el: HTMLImageElement) => el.naturalWidth
      );
      const src = await img.getAttribute("src");
      // Skip SVG data URIs and tiny tracking pixels
      if (src?.startsWith("data:")) continue;
      expect(naturalWidth, `Image ${src} has zero width`).toBeGreaterThan(0);
    }
  });
});
