import { test, expect } from "@playwright/test";

// Use platform-appropriate shortcut: Meta+k on macOS, Control+k on Linux/Windows
const isMac = process.platform === "darwin";
const searchShortcut = isMac ? "Meta+k" : "Control+k";

test.describe("Search dialog (Cmd+K)", () => {
  test("opens on keyboard shortcut", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(500); // Wait for hydration
    await page.keyboard.press(searchShortcut);
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
  });

  test("closes on Escape", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(500);
    await page.keyboard.press(searchShortcut);
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test("opens via search button click", async ({ page }) => {
    await page.goto("/");
    // The search button has text "Search" and a keyboard shortcut hint
    const searchBtn = page.locator('header button', { hasText: "Search" }).last();
    await searchBtn.click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
  });
});
