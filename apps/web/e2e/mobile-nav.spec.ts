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
    // Find the mobile menu trigger (usually the last button or one with menu icon)
    const menuButtons = page.locator("header button");
    const lastBtn = menuButtons.last();
    await lastBtn.click();

    // Should show navigation links
    await expect(
      page.locator("a", { hasText: "Organizations" })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("a", { hasText: "People" })
    ).toBeVisible();
  });
});
