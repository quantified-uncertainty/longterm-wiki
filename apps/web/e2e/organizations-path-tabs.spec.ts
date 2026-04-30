import { test, expect } from "@playwright/test";

/**
 * QUA-878 — path-based tabs on /organizations/[slug].
 *
 * Verifies the routing-precedence claim from `tabs.test.ts`:
 *   - bare `/organizations/<slug>/<tab-id>` → catch-all renders the tab
 *   - `/organizations/<slug>/divisions/<div-slug>` → division detail (sub-record route wins)
 *   - `/organizations/<slug>/data` → data sub-page (sub-record route wins)
 *   - `/organizations/<slug>?tab=<id>` → 308 to path form
 *   - `/organizations/<slug>/<bogus>` → 200 with "Unknown tab" notice
 *
 * Routing precedence is a load-bearing Next.js 15 behavior — the static-metadata
 * tabs.test.ts unit test cannot validate it. This e2e covers the gap.
 */

test.describe("/organizations path-based tabs (QUA-878)", () => {
  test("every tab id resolves at /organizations/<slug>/<tab>", async ({ page }) => {
    // Probe a representative subset (full enumeration lives in the render-audit
    // spec, QUA-879). Tabs picked to cover all six tab-groups: entity, about,
    // business, governance, output, data.
    const tabs = [
      "people",
      "timeline",
      "divisions",
      "funding-rounds",
      "policy",
      "scorecards",
      "publications",
      "facts",
      "database",
    ];
    for (const tab of tabs) {
      const response = await page.goto(`/organizations/anthropic/${tab}`, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status(), `tab=${tab}`).toBe(200);

      const activeTrigger = page.locator(
        `[data-tab-id="${tab}"][data-state="active"]`,
      );
      await expect(activeTrigger, `tab=${tab} active state`).toHaveCount(1);
    }
  });

  test("bare /organizations/<slug> renders the default Overview tab", async ({ page }) => {
    const response = await page.goto("/organizations/anthropic", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    await expect(
      page.locator('[data-tab-id="overview"][data-state="active"]'),
    ).toHaveCount(1);
  });

  test("legacy ?tab=<id> 308-redirects to the path form", async ({ page }) => {
    const response = await page.goto("/organizations/anthropic?tab=people", {
      waitUntil: "domcontentloaded",
    });
    // After following the 308, the final URL should be the path form.
    expect(page.url()).toMatch(/\/organizations\/anthropic\/people/);
    expect(response?.status()).toBe(200);
    await expect(
      page.locator('[data-tab-id="people"][data-state="active"]'),
    ).toHaveCount(1);
  });

  test("unknown tab segment renders default tab + UnknownTabNotice", async ({ page }) => {
    const response = await page.goto(
      "/organizations/anthropic/this-is-not-a-real-tab",
      { waitUntil: "domcontentloaded" },
    );
    expect(response?.status()).toBe(200);
    // Default tab is active.
    await expect(
      page.locator('[data-tab-id="overview"][data-state="active"]'),
    ).toHaveCount(1);
    // Notice mentions the bogus segment.
    await expect(
      page.getByText("this-is-not-a-real-tab", { exact: false }),
    ).toBeVisible();
  });

  test("sub-record route /data wins over the catch-all", async ({ page }) => {
    const response = await page.goto("/organizations/anthropic/data", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    // The data sub-page renders OrgDataBody (not the tabbed shell). Heuristic:
    // the breadcrumb suffix is "Data" and there's no Radix tablist.
    await expect(page.getByRole("heading", { name: "Anthropic" })).toBeVisible();
    // No path-mode tab triggers should be present (they exist only on the
    // tabbed shell).
    await expect(page.locator('[data-tab-id]')).toHaveCount(0);
  });

  test("sub-record route /divisions/<divSlug> wins over the catch-all", async ({ page }) => {
    // Anthropic's "alignment" division is a stable ID for this test (from
    // data/personnel and existing div-page.tsx routing).
    const response = await page.goto(
      "/organizations/anthropic/divisions/alignment",
      { waitUntil: "domcontentloaded" },
    );
    expect(response?.status()).toBe(200);
    // The division detail page has its own breadcrumbs and no path-mode tabs.
    await expect(page.locator('[data-tab-id]')).toHaveCount(0);
  });

  test("bare /divisions (no divSlug) falls through to the catch-all", async ({ page }) => {
    const response = await page.goto("/organizations/anthropic/divisions", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    // The catch-all renders the Divisions tab as active.
    await expect(
      page.locator('[data-tab-id="divisions"][data-state="active"]'),
    ).toHaveCount(1);
  });

  test("slug alias preserves a known tab segment in the redirect", async ({ page }) => {
    // google-deepmind aliases to deepmind via next.config.ts. The catch-all
    // forwards `/people` so the deep link resolves to the canonical org's
    // People tab.
    await page.goto("/organizations/google-deepmind/people", {
      waitUntil: "domcontentloaded",
    });
    expect(page.url()).toMatch(/\/organizations\/deepmind\/people$/);
    await expect(
      page.locator('[data-tab-id="people"][data-state="active"]'),
    ).toHaveCount(1);
  });
});
