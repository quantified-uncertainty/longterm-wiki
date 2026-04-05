import { test, expect } from "@playwright/test";

test.describe("Mobile navigation", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("desktop nav links are hidden on mobile", async ({ page }) => {
    await page.goto("/");
    const desktopNav = page.locator("header button", { hasText: "Entities" });
    await expect(desktopNav).not.toBeVisible();
  });

  test("mobile menu button is visible", async ({ page }) => {
    await page.goto("/");
    // MobileNav renders a hamburger button
    const menuBtn = page.locator("header button").last();
    await expect(menuBtn).toBeVisible();
  });

  test("mobile menu opens and shows links", async ({ page }) => {
    await page.goto("/");
    // Find the mobile menu trigger by its aria-label
    const menuBtn = page.locator('button[aria-label="Open navigation menu"]');
    await menuBtn.click();

    // Should show navigation links within the mobile nav
    const mobileNav = page.locator('nav[aria-label="Mobile navigation"]');
    await expect(mobileNav).toBeVisible({ timeout: 5000 });
    await expect(
      mobileNav.locator("a", { hasText: "Organizations" })
    ).toBeVisible();
    await expect(
      mobileNav.locator("a", { hasText: "People" })
    ).toBeVisible();
  });
});
