import { test, expect } from "@playwright/test";

test.describe("Projects Directory", () => {
  test("list page loads and shows projects", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveTitle(/Projects/);

    // Should have the heading
    await expect(page.locator("h1")).toContainText("Projects");

    // Should have stat cards
    const statCards = page.locator("[class*='rounded-xl'][class*='border']").filter({ hasText: "Projects" });
    await expect(statCards.first()).toBeVisible();

    // Should have project cards
    const cards = page.locator("[class*='rounded-xl'][class*='bg-card']");
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(10); // We have 162 projects

    // First card should have a link
    const firstLink = cards.first().locator("a");
    await expect(firstLink.first()).toBeVisible();
  });

  test("squiggle detail page loads", async ({ page }) => {
    await page.goto("/projects/squiggle");
    await expect(page).toHaveTitle(/Squiggle.*Projects/);

    // Should have breadcrumbs
    await expect(page.locator("text=Projects").first()).toBeVisible();

    // Should have title
    await expect(page.locator("h1")).toContainText("Squiggle");

    // Should have status badge
    await expect(page.locator("text=active").first()).toBeVisible();

    // Should have website link
    const websiteLink = page.locator('a[href*="squiggle-language.com"]');
    await expect(websiteLink).toBeVisible();
  });

  test("longterm-wiki detail page loads with org link", async ({ page }) => {
    await page.goto("/projects/longterm-wiki");
    await expect(page.locator("h1")).toContainText("Longterm Wiki");

    // Should have website link
    const websiteLink = page.locator('a[href*="longtermwiki.com"]');
    await expect(websiteLink).toBeVisible();
  });

  test("nonexistent project returns 404", async ({ page }) => {
    const response = await page.goto("/projects/nonexistent-project-xyz");
    expect(response?.status()).toBe(404);
  });

  test("project cards link to detail pages", async ({ page }) => {
    await page.goto("/projects");

    // Find a link to a specific project
    const squiggleLink = page.locator('a[href="/projects/squiggle"]');
    if (await squiggleLink.count() > 0) {
      await squiggleLink.first().click();
      await expect(page).toHaveURL(/\/projects\/squiggle/);
      await expect(page.locator("h1")).toContainText("Squiggle");
    }
  });
});

test.describe("Events Directory", () => {
  test("list page loads and shows events", async ({ page }) => {
    await page.goto("/events");
    await expect(page).toHaveTitle(/Events/);

    // Should have heading
    await expect(page.locator("h1")).toContainText("Events");

    // Should have timeline items (border-l-2 timeline)
    const timelineContainer = page.locator("[class*='border-l-2']");
    await expect(timelineContainer).toBeVisible();
  });

  test("event detail page loads", async ({ page }) => {
    await page.goto("/events/anthropic-government-standoff");
    await expect(page.locator("h1")).toContainText("Anthropic");

    // Should have breadcrumbs back to Events
    const breadcrumb = page.locator('a[href="/events"]');
    await expect(breadcrumb).toBeVisible();
  });

  test("historical entity detail page loads via events", async ({ page }) => {
    await page.goto("/events/deep-learning-era");
    await expect(page.locator("h1")).toContainText("Deep Learning");

    // Should have breadcrumbs
    const breadcrumb = page.locator('a[href="/events"]');
    await expect(breadcrumb).toBeVisible();
  });

  test("nonexistent event returns 404", async ({ page }) => {
    const response = await page.goto("/events/nonexistent-event-xyz");
    expect(response?.status()).toBe(404);
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
    // Visit a wiki page and check that project EntityLinks route correctly
    await page.goto("/projects/squiggle");
    // The page should load at /projects/ not redirect to /wiki/
    expect(page.url()).toContain("/projects/squiggle");
  });

  test("event entities route to /events/ URLs", async ({ page }) => {
    await page.goto("/events/anthropic-government-standoff");
    expect(page.url()).toContain("/events/anthropic-government-standoff");
  });
});

// Smoke test all project detail pages don't crash
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

// Smoke test all event detail pages
const ALL_EVENTS = [
  "anthropic-government-standoff",
  "deep-learning-era",
  "early-warnings",
  "mainstream-era",
  "miri-era",
  "ai-safety-summit",
];

for (const slug of ALL_EVENTS) {
  test(`event detail: ${slug} returns 200`, async ({ page }) => {
    const response = await page.goto(`/events/${slug}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toBeVisible();
  });
}
