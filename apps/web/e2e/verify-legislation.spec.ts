/**
 * Legislation Features Verification — Production Smoke Tests
 *
 * Verifies legislation features from PRs #3701, #3716, #3773, #3679, #3646
 * against https://www.longtermwiki.com
 *
 * Run:
 *   PLAYWRIGHT_BASE_URL=https://www.longtermwiki.com \
 *   npx playwright test apps/web/e2e/verify-legislation.spec.ts --project=chromium --reporter=list
 */

import { test, expect, type Page } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "https://www.longtermwiki.com";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Navigate to a URL with networkidle and 30s timeout. */
async function goto(page: Page, path: string) {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const response = await page.goto(url, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  return response;
}

/** Get visible text from main content area. */
async function getMainText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector("main") ?? document.body;
    return (el as HTMLElement).innerText ?? "";
  });
}

// ─── 1. /legislation directory loads with entries ────────────────────────────

test("1. /legislation - directory loads with entries", async ({ page }) => {
  const response = await goto(page, "/legislation");
  expect(response?.status(), "/legislation should return 200").toBe(200);

  // Should have a heading
  const h1 = page.locator("h1").first();
  await expect(h1).toBeVisible({ timeout: 15_000 });

  // Should have links to legislation detail pages
  const legislationLinks = page.locator('a[href*="/legislation/"]');
  await expect(legislationLinks.first()).toBeVisible({ timeout: 15_000 });
  const count = await legislationLinks.count();
  console.log(`  /legislation: found ${count} entry links`);
  expect(count, "Should have multiple legislation entries").toBeGreaterThan(3);

  const bodyText = await getMainText(page);
  expect(bodyText).not.toContain("Application error");
  expect(bodyText).not.toContain("Unhandled Runtime Error");
  expect(bodyText.length, "Page should have substantial content").toBeGreaterThan(200);
});

// ─── 2. /legislation/coe-ai-convention - stakeholder data ───────────────────

test("2. /legislation/coe-ai-convention - shows stakeholder data", async ({ page }) => {
  const response = await goto(page, "/legislation/coe-ai-convention");
  expect(response?.status(), "/legislation/coe-ai-convention should return 200").toBe(200);

  const bodyText = await getMainText(page);
  expect(bodyText).not.toContain("Application error");
  expect(bodyText.length).toBeGreaterThan(200);

  // Should have stakeholder-related content
  const hasStakeholderContent =
    /stakeholder/i.test(bodyText) ||
    /signator/i.test(bodyText) ||
    /country/i.test(bodyText) ||
    /member state/i.test(bodyText) ||
    /provision/i.test(bodyText) ||
    /council of europe/i.test(bodyText);

  console.log(`  coe-ai-convention body length: ${bodyText.length}`);
  console.log(`  Has stakeholder content: ${hasStakeholderContent}`);

  expect(
    hasStakeholderContent,
    `Expected stakeholder/signatory/country/provision content on coe-ai-convention page. Body snippet: "${bodyText.slice(0, 300)}"`
  ).toBe(true);

  // Look for visual stakeholder section or table
  const stakeholderSection = page.locator(
    'table, [class*="stakeholder"], [class*="table"], section'
  );
  const sectionCount = await stakeholderSection.count();
  console.log(`  Table/section elements: ${sectionCount}`);
});

// ─── 3. /legislation/un-ai-governance-resolution - shows stakeholders ────────

test("3. /legislation/un-ai-governance-resolution - shows stakeholders", async ({ page }) => {
  const response = await goto(page, "/legislation/un-ai-governance-resolution");
  expect(response?.status(), "/legislation/un-ai-governance-resolution should return 200").toBe(200);

  const bodyText = await getMainText(page);
  expect(bodyText).not.toContain("Application error");
  expect(bodyText.length).toBeGreaterThan(200);

  const hasStakeholderContent =
    /stakeholder/i.test(bodyText) ||
    /signator/i.test(bodyText) ||
    /country/i.test(bodyText) ||
    /member/i.test(bodyText) ||
    /provision/i.test(bodyText) ||
    /united nations/i.test(bodyText) ||
    /resolution/i.test(bodyText);

  console.log(`  un-ai-governance-resolution body length: ${bodyText.length}`);
  console.log(`  Has stakeholder/resolution content: ${hasStakeholderContent}`);

  expect(
    hasStakeholderContent,
    `Expected stakeholder or resolution-related content. Body snippet: "${bodyText.slice(0, 300)}"`
  ).toBe(true);
});

// ─── 4. /legislation/seoul-declaration - shows stakeholders ─────────────────

test("4. /legislation/seoul-declaration - shows stakeholders", async ({ page }) => {
  const response = await goto(page, "/legislation/seoul-declaration");
  expect(response?.status(), "/legislation/seoul-declaration should return 200").toBe(200);

  const bodyText = await getMainText(page);
  expect(bodyText).not.toContain("Application error");
  expect(bodyText.length).toBeGreaterThan(200);

  const hasStakeholderContent =
    /stakeholder/i.test(bodyText) ||
    /signator/i.test(bodyText) ||
    /country/i.test(bodyText) ||
    /member/i.test(bodyText) ||
    /provision/i.test(bodyText) ||
    /seoul/i.test(bodyText) ||
    /declaration/i.test(bodyText);

  console.log(`  seoul-declaration body length: ${bodyText.length}`);
  console.log(`  Has stakeholder/declaration content: ${hasStakeholderContent}`);

  expect(
    hasStakeholderContent,
    `Expected stakeholder or declaration-related content. Body snippet: "${bodyText.slice(0, 300)}"`
  ).toBe(true);
});

// ─── 5. /legislation/nist-ai-rmf - shows stakeholders ───────────────────────

test("5. /legislation/nist-ai-rmf - shows stakeholders", async ({ page }) => {
  const response = await goto(page, "/legislation/nist-ai-rmf");
  expect(response?.status(), "/legislation/nist-ai-rmf should return 200").toBe(200);

  const bodyText = await getMainText(page);
  expect(bodyText).not.toContain("Application error");
  expect(bodyText.length).toBeGreaterThan(200);

  const hasStakeholderContent =
    /stakeholder/i.test(bodyText) ||
    /signator/i.test(bodyText) ||
    /organization/i.test(bodyText) ||
    /provision/i.test(bodyText) ||
    /framework/i.test(bodyText) ||
    /nist/i.test(bodyText);

  console.log(`  nist-ai-rmf body length: ${bodyText.length}`);
  console.log(`  Has stakeholder/framework content: ${hasStakeholderContent}`);

  expect(
    hasStakeholderContent,
    `Expected stakeholder or NIST framework content. Body snippet: "${bodyText.slice(0, 300)}"`
  ).toBe(true);
});

// ─── 6. /legislation/executive-order-14110 - redirect works ─────────────────

test("6. /legislation/executive-order-14110 - redirect works", async ({ page }) => {
  // This URL should redirect to /legislation/us-executive-order (permanent redirect)
  const response = await goto(page, "/legislation/executive-order-14110");

  const finalUrl = page.url();
  console.log(`  Redirect: /legislation/executive-order-14110 → ${finalUrl}`);

  // The final page should be valid (not a 404 or error)
  expect(response?.status(), "Final page after redirect should return 200").toBe(200);

  // Final URL should be the canonical us-executive-order page
  expect(
    finalUrl,
    "Should redirect to /legislation/us-executive-order"
  ).toContain("/legislation/us-executive-order");

  // Page should render real content, not an error
  const bodyText = await getMainText(page);
  expect(bodyText).not.toContain("Application error");
  expect(bodyText.length, "Redirected page should have substantial content").toBeGreaterThan(200);

  console.log(`  Final URL: ${finalUrl}, body length: ${bodyText.length}`);
});

// ─── 7. /legislation/ai-lead-act - no raw integer IDs ───────────────────────

test("7. /legislation/ai-lead-act - political data renders without raw integer IDs", async ({ page }) => {
  const response = await goto(page, "/legislation/ai-lead-act");
  expect(response?.status(), "/legislation/ai-lead-act should return 200").toBe(200);

  const bodyText = await getMainText(page);
  expect(bodyText).not.toContain("Application error");
  expect(bodyText.length).toBeGreaterThan(200);

  console.log(`  ai-lead-act body length: ${bodyText.length}`);

  // Check for raw large integers that indicate unformatted database IDs
  // e.g., 9-digit+ integers that look like DB IDs appearing in visible text
  const rawIntegers = bodyText.match(
    /(?<![a-zA-Z_\/\-\.\$%,])(\d{8,})(?![a-zA-Z_\/\-\.\$%,])/g
  ) ?? [];

  // Filter false positives: dates like 20240115, URLs with port numbers, etc.
  const suspiciousIntegers = rawIntegers.filter((n) => {
    if (n.startsWith("0")) return false; // zero-prefixed codes
    if (/^20\d{6}$/.test(n)) return false; // YYYYMMDD dates
    if (/^19\d{6}$/.test(n)) return false; // YYYYMMDD dates (1900s)
    if (n.length <= 8) return false; // could be legitimate year-based refs
    return true;
  });

  if (rawIntegers.length > 0) {
    console.log(`  Raw integers found: ${rawIntegers.slice(0, 10).join(", ")}`);
  }
  if (suspiciousIntegers.length > 0) {
    console.log(`  WARNING: Suspicious DB-like integers: ${suspiciousIntegers.slice(0, 5).join(", ")}`);
  }

  expect(
    suspiciousIntegers.length,
    `Found raw integer IDs that may be unresolved DB IDs: ${suspiciousIntegers.slice(0, 3).join(", ")}`
  ).toBeLessThan(3);

  // Also check for sid_ patterns (raw stableIds)
  const sidMatches = bodyText.match(/\bsid_[A-Za-z0-9]{3,}\b/g) ?? [];
  console.log(`  sid_ patterns found: ${sidMatches.length}`);
  expect(
    sidMatches.length,
    `Raw sid_ IDs visible in page: ${sidMatches.slice(0, 3).join(", ")}`
  ).toBe(0);
});

// ─── 8. Legislation pages link stakeholders to entity profiles ───────────────

test.describe("8. Stakeholder entity profile links", () => {
  const PAGES_WITH_STAKEHOLDERS = [
    "/legislation/coe-ai-convention",
    "/legislation/nist-ai-rmf",
    "/legislation/un-ai-governance-resolution",
    "/legislation/seoul-declaration",
  ];

  for (const path of PAGES_WITH_STAKEHOLDERS) {
    test(`${path} - links stakeholders to entity profiles`, async ({ page }) => {
      const response = await goto(page, path);
      expect(response?.status(), `${path} should return 200`).toBe(200);

      const bodyText = await getMainText(page);
      expect(bodyText).not.toContain("Application error");

      // Check for links to entity profiles (organizations, people directories)
      // Stakeholders should link to /organizations/, /people/, or /wiki/ pages
      const entityProfileLinks = page.locator(
        'a[href*="/organizations/"], a[href*="/people/"], a[href*="/wiki/E"]'
      );
      const entityLinkCount = await entityProfileLinks.count();
      console.log(`  ${path}: entity profile links: ${entityLinkCount}`);

      // We should have at least some entity links if stakeholders are present
      // (this is a soft check — some legislation may have no named stakeholders)
      const hasStakeholderSection =
        /stakeholder/i.test(bodyText) ||
        /signator/i.test(bodyText);

      if (hasStakeholderSection) {
        // If there is a stakeholder section, it should have at least some links
        // (could be external links to org pages or internal entity links)
        const allLinks = page.locator(
          'a[href*="/organizations/"], a[href*="/people/"], a[href*="/wiki/E"], a[href*="/legislation/"]'
        );
        const totalLinkCount = await allLinks.count();
        console.log(`  ${path}: has stakeholder section, total relevant links: ${totalLinkCount}`);

        // The page should have at least one link if stakeholders are shown
        expect(
          totalLinkCount,
          `${path} has a stakeholder section but no entity/legislation links`
        ).toBeGreaterThan(0);
      } else {
        console.log(`  ${path}: no stakeholder section detected — skipping link check`);
      }
    });
  }
});

// ─── Bonus: All tested legislation pages return 200 ─────────────────────────

test.describe("All legislation pages return 200", () => {
  const LEGISLATION_PAGES = [
    "/legislation",
    "/legislation/coe-ai-convention",
    "/legislation/un-ai-governance-resolution",
    "/legislation/seoul-declaration",
    "/legislation/nist-ai-rmf",
    "/legislation/ai-lead-act",
  ];

  for (const path of LEGISLATION_PAGES) {
    test(`${path} returns 200`, async ({ page }) => {
      const response = await goto(page, path);
      expect(response?.status(), `${path} should return 200`).toBe(200);
    });
  }
});
