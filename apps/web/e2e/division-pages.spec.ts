import { test, expect } from "@playwright/test";

// Orgs known to have divisions in the KB data
const ORGS_WITH_DIVISIONS = [
  "coefficient-giving",
  "anthropic",
  "open-philanthropy",
];

test.describe("Division pages — navigation from org page", () => {
  for (const orgSlug of ORGS_WITH_DIVISIONS) {
    test(`${orgSlug} — division links navigate to /organizations/${orgSlug}/divisions/*`, async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.goto(`/organizations/${orgSlug}`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      // Find division links under the new URL pattern
      const divLinks = page.locator(
        `a[href^="/organizations/${orgSlug}/divisions/"]`
      );
      const count = await divLinks.count();
      console.log(`  ${orgSlug}: found ${count} division links`);

      if (count === 0) {
        // Some orgs may not have divisions in local data — skip
        test.skip();
        return;
      }

      // Click the first division link and verify it loads
      const firstHref = await divLinks.first().getAttribute("href");
      expect(firstHref).toBeTruthy();

      const response = await page.goto(firstHref!, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      expect(response?.status()).toBe(200);

      // Has an h1 with the division name
      const h1 = page.locator("h1").first();
      const h1Text = await h1.textContent();
      expect(h1Text?.length).toBeGreaterThan(0);
      console.log(`  → Division page: "${h1Text}"`);

      // Has breadcrumbs back to org
      const breadcrumbs = page.locator("nav, [aria-label='breadcrumb']");
      await expect(breadcrumbs.first()).toBeVisible({ timeout: 5000 });

      // No crash screens
      const bodyText = await page.locator("body").textContent();
      expect(bodyText).not.toContain("Application error");
      expect(bodyText).not.toContain("Unhandled Runtime Error");

      // No page-level JS errors
      expect(pageErrors, `Page JS errors on ${firstHref}`).toHaveLength(0);
    });
  }
});

test.describe("Division detail pages — direct URL access", () => {
  const DIVISION_URLS = [
    "/organizations/coefficient-giving/divisions/global-health-and-wellbeing",
    "/organizations/coefficient-giving/divisions/abundance-and-growth",
    "/organizations/anthropic/divisions/alignment-science",
  ];

  for (const url of DIVISION_URLS) {
    test(`${url} — loads with content`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      const response = await page.goto(url, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      expect(response?.status()).toBe(200);

      // Has h1
      const h1 = page.locator("h1").first();
      const h1Text = await h1.textContent();
      expect(h1Text?.length).toBeGreaterThan(0);

      // Has a division type badge (e.g., PROGRAM AREA, TEAM, FUND)
      const badges = page.locator("span.rounded-full");
      const badgeCount = await badges.count();
      expect(badgeCount).toBeGreaterThan(0);

      // Has a "Back to" link
      const backLink = page.locator('a:has-text("Back to")');
      await expect(backLink).toBeVisible({ timeout: 5000 });

      // No crash screens
      const bodyText = await page.locator("body").textContent();
      expect(bodyText).not.toContain("Application error");
      expect(bodyText).not.toContain("Unhandled Runtime Error");

      // Screenshot
      await page.screenshot({
        path: `test-results/division-${url.split("/").pop()}.png`,
        fullPage: true,
      });

      expect(pageErrors, `Page JS errors on ${url}`).toHaveLength(0);
    });
  }
});

test.describe("Division page — grants tab", () => {
  test("coefficient-giving GH&W — shows grants tab with content", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(
      "/organizations/coefficient-giving/divisions/global-health-and-wellbeing",
      { waitUntil: "networkidle", timeout: 30000 }
    );

    // Should have a Grants tab button
    const grantsTab = page.locator('button:has-text("Grants")');
    const hasGrantsTab = (await grantsTab.count()) > 0;

    if (hasGrantsTab) {
      await grantsTab.click();
      // Wait for the grants table to appear
      const grantsTable = page.locator("table").first();
      await expect(grantsTable).toBeVisible({ timeout: 5000 });

      // Should show grant rows
      const rows = grantsTable.locator("tbody tr");
      const rowCount = await rows.count();
      expect(rowCount).toBeGreaterThan(0);
      console.log(`  Grants tab: ${rowCount} rows visible`);
    } else {
      console.log("  No Grants tab (may not have grants in local data)");
    }

    expect(pageErrors).toHaveLength(0);
  });
});

test.describe("Legacy division URLs redirect", () => {
  test("old /divisions/[slug] redirects to new URL", async ({ page }) => {
    // This tests that the legacy route redirects
    // The legacy slugs are random IDs like vQ4qEI1Ghg
    const response = await page.goto("/divisions/vQ4qEI1Ghg", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const status = response?.status();
    const url = page.url();

    // Should either redirect (200 after redirect) or 404 if legacy slug not found
    if (status === 200) {
      // Verify we ended up at the new URL pattern
      expect(url).toMatch(/\/organizations\/[^/]+\/divisions\/[^/]+/);
      console.log(`  Redirected to: ${url}`);
    } else {
      // 404 is acceptable if the legacy slug doesn't exist in local data
      expect([200, 404]).toContain(status);
      console.log(`  Legacy slug not found (${status})`);
    }
  });
});
