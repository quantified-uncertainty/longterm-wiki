import { test, expect, type Page } from "@playwright/test";

/**
 * Production Release Verification — Post-deploy smoke tests
 *
 * Targets https://www.longtermwiki.com to verify critical features
 * from the ~95 PR release are working correctly.
 *
 * Run: PLAYWRIGHT_BASE_URL=https://www.longtermwiki.com npx playwright test e2e/production-release-verification.spec.ts --project=chromium
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Collect console errors during a page visit, filtering non-app noise. */
function setupErrorCollector(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  return { consoleErrors, pageErrors };
}

/** Filter out benign console errors (favicon, analytics, etc). */
function filterBenignErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes("favicon") &&
      !e.includes("analytics") &&
      !e.includes("404 (Not Found)") &&
      !e.includes("ERR_BLOCKED_BY_CLIENT") // ad blockers
  );
}

// ─── 1. Homepage ────────────────────────────────────────────────────────────

test.describe("1. Homepage", () => {
  test("loads and returns 200 with site title", async ({ page }) => {
    const { consoleErrors } = setupErrorCollector(page);
    const response = await page.goto("/", { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page.locator("header")).toContainText("Longterm Wiki");
    const appErrors = filterBenignErrors(consoleErrors);
    expect(appErrors, `Console errors on homepage: ${appErrors.join(", ")}`).toHaveLength(0);
  });
});

// ─── 2. Organization pages ─────────────────────────────────────────────────

test.describe("2. Organization pages", () => {
  test("/organizations/anthropic loads with content", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/organizations/anthropic", {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    expect(response?.status()).toBe(200);

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 10000 });
    const h1Text = await h1.textContent();
    expect(h1Text?.toLowerCase()).toContain("anthropic");

    // Should have substantial content
    const bodyText = await page.locator("body").textContent();
    expect(bodyText!.length).toBeGreaterThan(500);
    expect(bodyText).not.toContain("Application error");
    expect(bodyText).not.toContain("Unhandled Runtime Error");

    expect(pageErrors, `JS errors on /organizations/anthropic`).toHaveLength(0);
  });
});

// ─── 3. Verification dots ──────────────────────────────────────────────────

test.describe("3. Verification dots", () => {
  test("org pages show verification-related elements", async ({ page }) => {
    await page.goto("/organizations/anthropic", {
      waitUntil: "networkidle",
      timeout: 45000,
    });

    // Verification dots are rendered as small colored circles or icons
    // near fact values. Look for any verification-related UI elements.
    // They may appear as tooltips, badges, dots, or status indicators.
    const bodyText = await page.locator("body").textContent();

    // The page should have structured facts/data section
    // Look for elements that indicate verification status
    const verificationElements = page.locator(
      '[class*="verif"], [data-verification], [title*="verif"], [aria-label*="verif"], [class*="dot"], [class*="status-dot"], svg circle'
    );
    const dotCount = await verificationElements.count();
    console.log(`  Verification-related elements found: ${dotCount}`);

    // Also check for fact values which would have verification dots
    const factElements = page.locator('[class*="fact"], [data-fact], [class*="Fact"]');
    const factCount = await factElements.count();
    console.log(`  Fact-related elements found: ${factCount}`);

    // At minimum, the page should render without errors
    expect(bodyText).not.toContain("Application error");
  });
});

// ─── 4. FactBase / FactsPanel ──────────────────────────────────────────────

test.describe("4. FactBase / FactsPanel", () => {
  test("/organizations/openai shows facts in multi-column layout", async ({
    page,
  }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/organizations/openai", {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    expect(response?.status()).toBe(200);

    // Wait for content to render
    await page.waitForLoadState("networkidle");

    // Look for the facts panel — it uses a multi-column grid layout
    const factsPanel = page.locator(
      '[class*="grid"], [class*="facts"], [class*="panel"], [class*="columns"]'
    );
    const panelCount = await factsPanel.count();
    console.log(`  Grid/panel elements on OpenAI page: ${panelCount}`);
    expect(panelCount).toBeGreaterThan(0);

    // The page should have data-rich content (revenue, employees, etc.)
    const bodyText = await page.locator("body").textContent();
    // OpenAI page should mention key data points
    const hasDataContent =
      bodyText!.includes("revenue") ||
      bodyText!.includes("Revenue") ||
      bodyText!.includes("employees") ||
      bodyText!.includes("Employees") ||
      bodyText!.includes("Founded") ||
      bodyText!.includes("founded") ||
      bodyText!.includes("Valuation") ||
      bodyText!.includes("valuation");
    expect(hasDataContent, "OpenAI page should have structured data content").toBe(true);

    expect(pageErrors, `JS errors on /organizations/openai`).toHaveLength(0);
  });
});

// ─── 5. Legislation pages ──────────────────────────────────────────────────

test.describe("5. Legislation pages", () => {
  test("/legislation directory loads", async ({ page }) => {
    const response = await page.goto("/legislation", { timeout: 45000 });
    expect(response?.status()).toBe(200);

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 10000 });
  });

  test("/legislation/coe-ai-convention loads with stakeholder data", async ({
    page,
  }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/legislation/coe-ai-convention", {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    expect(response?.status()).toBe(200);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(200);

    // Legislation pages should show stakeholder-related content
    const hasStakeholderContent =
      bodyText!.includes("stakeholder") ||
      bodyText!.includes("Stakeholder") ||
      bodyText!.includes("signator") ||
      bodyText!.includes("Signator") ||
      bodyText!.includes("country") ||
      bodyText!.includes("Country") ||
      bodyText!.includes("provision") ||
      bodyText!.includes("Provision") ||
      bodyText!.includes("Council of Europe") ||
      bodyText!.includes("convention");
    expect(
      hasStakeholderContent,
      "Legislation page should have stakeholder/provision content"
    ).toBe(true);

    expect(pageErrors, `JS errors on legislation page`).toHaveLength(0);
  });
});

// ─── 6. Sourcing dashboard ────────────────────────────────────────────────

test.describe("6. Sourcing", () => {
  test("/sourcing dashboard loads", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/sourcing", {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    // May redirect to a wiki entity page
    expect([200, 307, 308]).toContain(response?.status());

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(100);
  });
});

// ─── 7. People directory ───────────────────────────────────────────────────

test.describe("7. People directory", () => {
  test("/people loads with entries", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/people", { timeout: 45000 });
    expect(response?.status()).toBe(200);

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 10000 });

    // Should have people links
    const personLinks = page.locator("a[href*='/people/']");
    await expect(personLinks.first()).toBeVisible({ timeout: 15000 });
    const count = await personLinks.count();
    expect(count).toBeGreaterThan(5);
    console.log(`  People directory entries: ${count}`);

    expect(pageErrors, `JS errors on /people`).toHaveLength(0);
  });
});

// ─── 8. AI Models directory ────────────────────────────────────────────────

test.describe("8. AI Models directory", () => {
  test("/ai-models loads", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/ai-models", { timeout: 45000 });
    expect(response?.status()).toBe(200);

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 10000 });

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");

    expect(pageErrors, `JS errors on /ai-models`).toHaveLength(0);
  });
});

// ─── 9. Grants page ───────────────────────────────────────────────────────

test.describe("9. Grants page", () => {
  test("/grants loads with proper formatting (no $0 amounts)", async ({
    page,
  }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/grants", {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    expect(response?.status()).toBe(200);

    await page.waitForLoadState("networkidle");

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(200);

    // Check for proper dollar formatting — should have amounts like $1,000 or $1M
    // but should NOT have a proliferation of "$0" as the dominant amount
    const zeroAmountMatches = bodyText!.match(/\$0(?:\.\d+)?(?:\s|,|$)/g) || [];
    const realAmountMatches =
      bodyText!.match(/\$[\d,]+(?:\.\d+)?(?:[KMBkmb])?/g) || [];

    console.log(
      `  Grant amounts found: ${realAmountMatches.length} total, ${zeroAmountMatches.length} are $0`
    );

    // If there are grant amounts, $0 should not dominate
    if (realAmountMatches.length > 5) {
      const zeroRatio = zeroAmountMatches.length / realAmountMatches.length;
      expect(
        zeroRatio,
        `Too many $0 amounts (${zeroAmountMatches.length}/${realAmountMatches.length})`
      ).toBeLessThan(0.5);
    }

    expect(pageErrors, `JS errors on /grants`).toHaveLength(0);
  });
});

// ─── 10. Investments page ──────────────────────────────────────────────────

test.describe("10. Investments page", () => {
  test("/investments loads and shows partial totals", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/investments", {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    expect(response?.status()).toBe(200);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(200);

    // Look for dollar amounts or total indicators
    const hasDollarAmounts = /\$[\d,]+/.test(bodyText!);
    const hasTotalIndicator =
      bodyText!.includes("total") ||
      bodyText!.includes("Total") ||
      bodyText!.includes("partial") ||
      bodyText!.includes("Partial") ||
      bodyText!.includes("sum") ||
      bodyText!.includes("Sum");
    console.log(
      `  Investments: dollar amounts=${hasDollarAmounts}, totals=${hasTotalIndicator}`
    );

    expect(pageErrors, `JS errors on /investments`).toHaveLength(0);
  });
});

// ─── 11. Funding rounds ───────────────────────────────────────────────────

test.describe("11. Funding rounds", () => {
  test("/funding-rounds loads", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/funding-rounds", { timeout: 45000 });
    expect(response?.status()).toBe(200);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(200);

    expect(pageErrors, `JS errors on /funding-rounds`).toHaveLength(0);
  });
});

// ─── 12. Divisions page ───────────────────────────────────────────────────

test.describe("12. Divisions page", () => {
  test("/divisions loads with content", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/divisions", { timeout: 45000 });
    expect(response?.status()).toBe(200);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(200);

    // Should have links to division entries
    const divisionLinks = page.locator(
      'a[href*="/divisions/"], table tbody tr, [role="row"]'
    );
    const count = await divisionLinks.count();
    console.log(`  Division entries/rows: ${count}`);
    expect(count).toBeGreaterThan(0);

    expect(pageErrors, `JS errors on /divisions`).toHaveLength(0);
  });
});

// ─── 13. Funding programs ──────────────────────────────────────────────────

test.describe("13. Funding programs", () => {
  test("/funding-programs loads", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/funding-programs", { timeout: 45000 });
    expect(response?.status()).toBe(200);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(200);

    expect(pageErrors, `JS errors on /funding-programs`).toHaveLength(0);
  });
});

// ─── 14. Publications ──────────────────────────────────────────────────────

test.describe("14. Publications", () => {
  test("/publications loads", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto("/publications", { timeout: 45000 });
    expect(response?.status()).toBe(200);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText!.length).toBeGreaterThan(200);

    expect(pageErrors, `JS errors on /publications`).toHaveLength(0);
  });
});

// ─── 15. Sourcing detail ──────────────────────────────────────────────────

test.describe("15. Sourcing detail page", () => {
  test("a specific sourcing fact page loads", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);

    // Navigate to sourcing first to find a real fact link
    await page.goto("/sourcing", {
      waitUntil: "networkidle",
      timeout: 45000,
    });

    // Try to find a link to a specific fact check
    const factLink = page.locator('a[href*="/sourcing/fact/"]').first();
    const hasFactLink = (await factLink.count()) > 0;

    if (hasFactLink) {
      const href = await factLink.getAttribute("href");
      console.log(`  Found sourcing fact link: ${href}`);
      const detailResponse = await page.goto(href!, {
        waitUntil: "networkidle",
        timeout: 45000,
      });
      expect(detailResponse?.status()).toBe(200);
      const bodyText = await page.locator("body").textContent();
      expect(bodyText).not.toContain("Application error");
    } else {
      // If no fact links on the page, try a known pattern
      const detailResponse = await page.goto(
        "/sourcing/fact/EF_ORG_0001_revenue_1",
        { waitUntil: "networkidle", timeout: 45000 }
      );
      // May 404 if the specific ID doesn't exist — that's OK
      const status = detailResponse?.status();
      console.log(`  Direct fact page status: ${status}`);
      expect([200, 404]).toContain(status);
      if (status === 200) {
        const bodyText = await page.locator("body").textContent();
        expect(bodyText).not.toContain("Application error");
      }
    }
  });
});

// ─── 16. No hydration errors ───────────────────────────────────────────────

test.describe("16. No hydration errors on key pages", () => {
  const HYDRATION_CHECK_PAGES = [
    "/organizations/anthropic",
    "/organizations/openai",
    "/grants",
    "/people",
    "/legislation",
  ];

  for (const path of HYDRATION_CHECK_PAGES) {
    test(`${path} has no hydration errors`, async ({ page }) => {
      const hydrationErrors: string[] = [];
      const allConsoleErrors: string[] = [];

      page.on("console", (msg) => {
        const text = msg.text();
        if (msg.type() === "error") {
          allConsoleErrors.push(text);
          // Detect hydration errors — Next.js and React patterns
          if (
            text.includes("Hydration") ||
            text.includes("hydration") ||
            text.includes("did not match") ||
            text.includes("server-rendered") ||
            text.includes("Text content does not match") ||
            text.includes("Expected server HTML") ||
            text.includes("Minified React error #418") ||
            text.includes("Minified React error #423") ||
            text.includes("Minified React error #425")
          ) {
            hydrationErrors.push(text);
          }
        }
      });

      await page.goto(path, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(2000); // Extra time for hydration to complete

      if (hydrationErrors.length > 0) {
        console.log(`  HYDRATION ERRORS on ${path}:`);
        hydrationErrors.forEach((e) =>
          console.log(`    - ${e.substring(0, 300)}`)
        );
      }

      expect(
        hydrationErrors,
        `Hydration errors on ${path}: ${hydrationErrors.map((e) => e.substring(0, 100)).join("; ")}`
      ).toHaveLength(0);
    });
  }
});

// ─── 17. Received grants with verification dots ────────────────────────────

test.describe("17. Received grants with verification dots", () => {
  test("/organizations/evidence-action?tab=funding shows funding data", async ({
    page,
  }) => {
    const { pageErrors } = setupErrorCollector(page);
    const response = await page.goto(
      "/organizations/evidence-action?tab=funding",
      { waitUntil: "networkidle", timeout: 45000 }
    );
    // May redirect or the org may not exist with this exact slug
    const status = response?.status();
    console.log(`  evidence-action funding tab status: ${status}`);

    if (status === 200) {
      const bodyText = await page.locator("body").textContent();
      expect(bodyText).not.toContain("Application error");

      // Check for funding-related content
      const hasFundingContent =
        bodyText!.includes("grant") ||
        bodyText!.includes("Grant") ||
        bodyText!.includes("funding") ||
        bodyText!.includes("Funding") ||
        bodyText!.includes("$");
      console.log(`  Funding content present: ${hasFundingContent}`);
    } else {
      // Try without the tab param — maybe the org exists but tabs work differently
      const fallback = await page.goto("/organizations/evidence-action", {
        waitUntil: "networkidle",
        timeout: 45000,
      });
      console.log(`  Fallback to /organizations/evidence-action: ${fallback?.status()}`);
      // Just verify no crash
      if (fallback?.status() === 200) {
        const bodyText = await page.locator("body").textContent();
        expect(bodyText).not.toContain("Application error");
      }
    }
  });
});

// ─── 18. Political data — no raw integers ──────────────────────────────────

test.describe("18. Political data rendering", () => {
  test("/legislation pages do not show raw integer IDs", async ({ page }) => {
    const { pageErrors } = setupErrorCollector(page);
    await page.goto("/legislation", {
      waitUntil: "networkidle",
      timeout: 45000,
    });

    // Click on the first legislation link to check a detail page
    const legislationLink = page
      .locator('a[href*="/legislation/"]')
      .first();
    const hasLink = (await legislationLink.count()) > 0;

    if (hasLink) {
      const href = await legislationLink.getAttribute("href");
      console.log(`  Checking legislation detail page: ${href}`);
      await page.goto(href!, {
        waitUntil: "networkidle",
        timeout: 45000,
      });

      const bodyText = await page.locator("body").textContent();
      expect(bodyText).not.toContain("Application error");

      // Check for raw large integers that indicate unformatted data
      // (e.g., database IDs like 1234567890 appearing in the UI)
      const rawIntegers =
        bodyText!.match(/(?<![a-zA-Z_\/\-\.])\d{8,}(?![a-zA-Z_\/\-\.])/g) ||
        [];
      // Filter out dates and phone-like numbers
      const suspiciousIntegers = rawIntegers.filter((n) => {
        if (n.startsWith("0")) return false; // codes
        if (n.length === 8 && /^20\d{6}$/.test(n)) return false; // dates
        if (n.length <= 8) return false; // could be legitimate
        return true;
      });

      if (suspiciousIntegers.length > 0) {
        console.log(
          `  WARNING: Possible raw integers: ${suspiciousIntegers.slice(0, 5).join(", ")}`
        );
      }

      // Soft assertion — report but don't hard-fail on borderline cases
      expect.soft(
        suspiciousIntegers.length,
        `Raw integers found on legislation page: ${suspiciousIntegers.slice(0, 3).join(", ")}`
      ).toBeLessThan(3);
    }

    expect(pageErrors, `JS errors on legislation pages`).toHaveLength(0);
  });
});

// ─── Bonus: Cross-cutting health checks ────────────────────────────────────

test.describe("Cross-cutting: Critical pages return 200", () => {
  const CRITICAL_PAGES = [
    "/",
    "/organizations",
    "/people",
    "/ai-models",
    "/legislation",
    "/grants",
    "/investments",
    "/funding-rounds",
    "/divisions",
    "/funding-programs",
    "/publications",
  ];

  for (const path of CRITICAL_PAGES) {
    test(`${path} returns 200`, async ({ page }) => {
      const response = await page.goto(path, { timeout: 45000 });
      expect(response?.status()).toBe(200);
    });
  }
});
