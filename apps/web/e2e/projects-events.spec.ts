import { test, expect } from "@playwright/test";

test.describe("Projects Directory", () => {
  test("list page loads and shows projects", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveTitle(/Projects/);
    await expect(page.locator("h1")).toContainText("Projects");

    // Should have project cards
    const cards = page.locator("[class*='rounded-xl'][class*='bg-card']");
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(5);
  });

  test("squiggle detail page loads", async ({ page }) => {
    await page.goto("/projects/squiggle");
    await expect(page).toHaveTitle(/Squiggle.*Projects/);
    await expect(page.locator("h1")).toContainText("Squiggle");
    await expect(page.locator("text=active").first()).toBeVisible();
  });

  test("longterm-wiki detail page loads", async ({ page }) => {
    await page.goto("/projects/longterm-wiki");
    await expect(page.locator("h1")).toContainText("Longterm Wiki");
  });

  test("nonexistent project returns 404", async ({ page }) => {
    const response = await page.goto("/projects/nonexistent-project-xyz");
    expect(response?.status()).toBe(404);
  });

  test("project cards link to detail pages", async ({ page }) => {
    await page.goto("/projects");
    const squiggleLink = page.locator('a[href="/projects/squiggle"]');
    await expect(squiggleLink.first()).toBeVisible();
    await squiggleLink.first().click();
    await expect(page).toHaveURL(/\/projects\/squiggle/);
  });
});

test.describe("Navigation", () => {
  test("nav bar has Projects link", async ({ page }) => {
    await page.goto("/");
    const navLink = page.locator('nav a[href="/projects"]');
    await expect(navLink).toBeVisible();
  });
});

test.describe("Entity linking", () => {
  test("project entities route to /projects/ URLs", async ({ page }) => {
    await page.goto("/projects/squiggle");
    expect(page.url()).toContain("/projects/squiggle");
  });
});

const SAMPLE_PROJECTS = [
  "squiggle",
  "metaforecast",
  "forecastbench",
  "longterm-wiki",
  "stampy-aisafety-info",
  "grokipedia",
];

for (const slug of SAMPLE_PROJECTS) {
  test(`project detail: ${slug} returns 200`, async ({ page }) => {
    const response = await page.goto(`/projects/${slug}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toBeVisible();
  });
}
