/**
 * E2E test: Explore page search ranking
 *
 * Verifies that exact title matches rank above partial matches.
 * This has broken multiple times — this test prevents regressions.
 *
 * Run: npx playwright test e2e/explore-search-ranking.spec.ts
 * Requires: dev server on port 3001 (or `pnpm start` via Playwright webServer config)
 */
import { test, expect } from "@playwright/test";

test.describe("Explore search ranking", () => {
  test("exact title match 'Anthropic' ranks first when searching for 'Anthropic'", async ({
    page,
  }) => {
    await page.goto("/wiki?tag=Anthropic");

    // ContentCard renders as <a> (Next.js Link) with <h3> for the title,
    // inside a CSS grid container.
    const firstCardTitle = page.locator(".grid > a h3").first();
    await expect(firstCardTitle).toBeVisible({ timeout: 10_000 });

    // The first card's title should be exactly "Anthropic",
    // not "Anthropic-Pentagon..." or "AI Alignment"
    await expect(firstCardTitle).toHaveText("Anthropic");
  });

  test("search input reflects the tag parameter", async ({ page }) => {
    await page.goto("/wiki?tag=Anthropic");

    const searchInput = page.locator("input[type='text'][placeholder*='Search']");
    await expect(searchInput).toHaveValue("Anthropic");
  });
});
