import { test, expect } from "@playwright/test";

test.describe("Header dropdown menus", () => {
  test("Entities dropdown shows items on click", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    const entitiesButton = page.locator("header button", {
      hasText: "Entities",
    });
    await expect(entitiesButton).toBeVisible({ timeout: 10000 });
    await entitiesButton.click();

    const dropdown = page.locator("header a", { hasText: "Organizations" });
    await expect(dropdown).toBeVisible({ timeout: 10000 });
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
      page.locator("header a", { hasText: "Research Areas" })
    ).toBeVisible();
    await expect(
      page.locator("header a", { hasText: "Benchmarks" })
    ).toBeVisible();
  });

  test("Policy dropdown surfaces Safety Scorecards (QUA-840)", async ({ page }) => {
    await page.goto("/");

    const policyButton = page.locator("header button", { hasText: "Policy" });
    await expect(policyButton).toBeVisible({ timeout: 10000 });
    await policyButton.click();

    const scorecardsLink = page.locator("header a", {
      hasText: "Safety Scorecards",
    });
    await expect(scorecardsLink).toBeVisible({ timeout: 10000 });
    await expect(scorecardsLink).toHaveAttribute("href", "/scorecards");

    await expect(
      page.locator("header a", { hasText: "Legislation" })
    ).toBeVisible();
    await expect(
      page.locator("header a", { hasText: "Politicians" })
    ).toBeVisible();
  });

  test("Safety Scorecards link navigates to /scorecards (QUA-840)", async ({
    page,
  }) => {
    await page.goto("/");

    await page.locator("header button", { hasText: "Policy" }).click();
    await page.locator("header a", { hasText: "Safety Scorecards" }).click();
    await expect(page).toHaveURL(/\/scorecards/, { timeout: 15000 });
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
