import { test, expect } from "@playwright/test";

const DIRECTORY_PAGES = [
  { path: "/organizations", heading: /organizations/i },
  { path: "/people", heading: /people/i },
  { path: "/ai-models", heading: /ai.?models/i },
  { path: "/risks", heading: /risk/i },
  { path: "/benchmarks", heading: /benchmark/i },
  { path: "/legislation", heading: /legislation/i },
  { path: "/projects", heading: /project/i },
  { path: "/grants", heading: /grant/i },
  { path: "/funding-programs", heading: /funding/i },
  { path: "/sources", heading: /source|publication/i },
];

test.describe("Directory pages load", () => {
  for (const { path, heading } of DIRECTORY_PAGES) {
    test(`${path} loads without errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      const response = await page.goto(path, { timeout: 45000 });
      expect(response?.status()).toBe(200);

      // Should have a heading matching the directory type
      const h1 = page.locator("h1").first();
      await expect(h1).toBeVisible({ timeout: 15000 });

      // Filter out non-app errors (favicon, etc)
      const appErrors = errors.filter(
        (e) => !e.includes("favicon") && !e.includes("404")
      );
      expect(appErrors).toHaveLength(0);
    });
  }
});

test.describe("Directory pages have content", () => {
  test("/organizations shows org entries", async ({ page }) => {
    await page.goto("/organizations", { timeout: 45000 });
    // Org table is client-rendered; wait for any table row or link to appear
    const tableBody = page.locator("table tbody, [role='table']").first();
    await expect(tableBody).toBeVisible({ timeout: 20000 });
  });

  test("/people shows person entries", async ({ page }) => {
    await page.goto("/people");
    const personLinks = page.locator("a[href*='/people/']");
    await expect(personLinks.first()).toBeVisible({ timeout: 10000 });
    const count = await personLinks.count();
    expect(count).toBeGreaterThan(5);
  });
});
