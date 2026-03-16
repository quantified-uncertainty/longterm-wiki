import { test, expect } from "@playwright/test";

test.describe("Header dropdown menus", () => {
  test("Entities dropdown shows items on click", async ({ page }) => {
    await page.goto("/");

    const entitiesButton = page.locator("header button", {
      hasText: "Entities",
    });
    await entitiesButton.click();

    const dropdown = page.locator("header a", { hasText: "Organizations" });
    await expect(dropdown).toBeVisible();
    await expect(
      page.locator("header a", { hasText: "People" })
    ).toBeVisible();
    await expect(
      page.locator("header a", { hasText: "AI Models" })
    ).toBeVisible();
  });

  test("Research dropdown shows items on click", async ({ page }) => {
    await page.goto("/");

    const researchButton = page.locator("header button", {
      hasText: "Research",
    });
    await researchButton.click();

    await expect(
      page.locator("header a", { hasText: "Risks" })
    ).toBeVisible();
    await expect(
      page.locator("header a", { hasText: "Benchmarks" })
    ).toBeVisible();
  });

  test("dropdown items are not clipped by overflow", async ({ page }) => {
    await page.goto("/");

    const entitiesButton = page.locator("header button", {
      hasText: "Entities",
    });
    await entitiesButton.click();

    // The dropdown link should be visible and within the viewport
    const orgLink = page.locator("header a", { hasText: "Organizations" });
    await expect(orgLink).toBeVisible();

    const box = await orgLink.boundingBox();
    expect(box).not.toBeNull();
    // The dropdown item should be below the header (not clipped)
    expect(box!.y).toBeGreaterThan(40);
    expect(box!.height).toBeGreaterThan(0);
  });

  test("dropdown link navigates correctly", async ({ page }) => {
    await page.goto("/");

    const entitiesButton = page.locator("header button", {
      hasText: "Entities",
    });
    await entitiesButton.click();

    await page.locator("header a", { hasText: "Organizations" }).click();
    await expect(page).toHaveURL(/\/organizations/, { timeout: 15000 });
  });
});
