/**
 * E2E test: PR Dashboard (E1011)
 *
 * Run: npx playwright test e2e/pr-dashboard.spec.ts
 * Requires dev server running on port 3001.
 */
import { test, expect } from "@playwright/test";

const DASHBOARD_URL = "http://localhost:3001/wiki/E1011";
const REDIRECT_URL = "http://localhost:3001/internal/pr-dashboard";

test.describe("PR Dashboard", () => {
  test("redirect from /internal/pr-dashboard resolves to /wiki/E1011", async ({
    page,
  }) => {
    await page.goto(REDIRECT_URL);
    await expect(page).toHaveURL(DASHBOARD_URL);
  });

  test("page title and heading render", async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await expect(page).toHaveTitle(/PR Dashboard/);
    await expect(page.getByRole("heading", { name: "PR Dashboard" })).toBeVisible();
  });

  test("DataSourceBanner is present", async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    // Banner shows either "Live data from wiki-server" or "Local fallback data"
    const banner = page.locator("text=wiki-server").or(page.locator("text=fallback"));
    await expect(banner.first()).toBeVisible();
  });

  test("Kanban columns or empty state renders (not a blank page)", async ({
    page,
  }) => {
    await page.goto(DASHBOARD_URL);

    // Either the stats bar or the empty state must be present
    const statsOrEmpty = page
      .getByText(/Open PRs:|No open pull requests/)
      .first();
    await expect(statsOrEmpty).toBeVisible();
  });

  test("sidebar contains PR Dashboard link (visible from a sibling page)", async ({
    page,
  }) => {
    // Navigate to a different internal page so the sidebar link to E1011 is active
    await page.goto("http://localhost:3001/wiki/E927"); // System Health dashboard
    // The sidebar should have a link to the PR Dashboard
    const navLink = page.locator('a[href="/wiki/E1011"]');
    await expect(navLink.first()).toBeVisible();
  });

  test("PR cards link to GitHub when PRs are present", async ({ page }) => {
    await page.goto(DASHBOARD_URL);

    // Only check PR links if there are cards
    const prLinks = page.locator('a[href*="/pull/"]');
    const count = await prLinks.count();
    if (count > 0) {
      await expect(prLinks.first()).toBeVisible();
      const href = await prLinks.first().getAttribute("href");
      expect(href).toMatch(/github\.com.*\/pull\/\d+/);
    }
  });
});
